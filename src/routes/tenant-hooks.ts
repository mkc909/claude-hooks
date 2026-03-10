import { Hono } from 'hono';
import type { Env, PreToolUsePayload, PostToolUsePayload, HookPayload, StopPayload, UserPromptSubmitPayload } from '../types';
import { generateId, truncate, summarizeToolInput, extractFilePath, safeStringify } from '../lib/utils';
import { evaluatePolicies } from '../services/policy-engine';
import { upsertSession, endSession, incrementToolCalls } from '../services/session-manager';
import { extractProgress } from '../services/progress-extractor';
import { evaluateActionRules } from '../services/action-engine';
import { HookEvents, Tools, IdPrefixes } from '../config/manifest';
import { SIMPLE_EVENT_ROUTES } from '../config/route-registry';

/**
 * Multi-tenant hook routes for CloudClaw customers.
 * Scoped by tenant_id — each tenant gets isolated session/event data
 * and tenant-specific policies.
 */
export const tenantHookRoutes = new Hono<{ Bindings: Env }>();

/**
 * Tenant authentication middleware.
 * Verifies the tenant API key against CloudClaw's tenant registry.
 * Falls back to a shared tenant hook secret for simpler setups.
 */
async function verifyTenantAccess(c: { env: Env; req: { header: (name: string) => string | undefined } }, tenantId: string): Promise<boolean> {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) return false;

	const token = authHeader.slice(7);

	// Check tenant-specific key from KV cache first
	const cacheKey = `tenant_key:${tenantId}`;
	const cachedKey = await c.env.CACHE.get(cacheKey);
	if (cachedKey && cachedKey === token) return true;

	// Verify against D1 (tenant_api_keys table or policies table)
	const row = await c.env.DB.prepare(
		"SELECT id FROM tenant_api_keys WHERE tenant_id = ? AND api_key = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))"
	).bind(tenantId, token).first();

	if (row) {
		// Cache for 5 minutes
		await c.env.CACHE.put(cacheKey, token, { expirationTtl: 300 });
		return true;
	}

	return false;
}

class PayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PayloadError';
	}
}

function requireSessionId(payload: HookPayload): string {
	if (!payload.session_id || typeof payload.session_id !== 'string') {
		throw new PayloadError('Missing required field: session_id');
	}
	return payload.session_id;
}

// --------------------------------------------------------------------------
// Payload parsing middleware — validates JSON body
// --------------------------------------------------------------------------
tenantHookRoutes.use('/:tenantId/*', async (c, next) => {
	// Only validate JSON for POST requests (not the auth middleware pass-through)
	if (c.req.method === 'POST') {
		try {
			await c.req.json();
		} catch {
			return c.json({
				type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
				status: 400,
				title: 'Bad Request',
				detail: 'Invalid or missing JSON body',
			}, 400);
		}
	}
	await next();
});

// --------------------------------------------------------------------------
// Tenant auth middleware (applied to all tenant routes)
// --------------------------------------------------------------------------
tenantHookRoutes.use('/:tenantId/*', async (c, next) => {
	const tenantId = c.req.param('tenantId');

	const authorized = await verifyTenantAccess(c, tenantId);
	if (!authorized) {
		return c.json({ error: 'Invalid tenant credentials' }, 403);
	}

	await next();
});

// Catch PayloadError and return 400
tenantHookRoutes.onError((err, c) => {
	if (err instanceof PayloadError) {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: err.message,
		}, 400);
	}
	console.error('[hooks] Unhandled error:', err);
	return c.json({
		type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500',
		status: 500,
		title: 'Internal Server Error',
		detail: 'An unexpected error occurred',
	}, 500);
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/session-start
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/session-start', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<HookPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		upsertSession(c.env.DB, sessionId, payload.cwd, payload.permission_mode, tenantId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/prompt
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/prompt', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<UserPromptSubmitPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		upsertSession(c.env.DB, sessionId, payload.cwd, payload.permission_mode, tenantId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO prompts (id, session_id, tenant_id, prompt_text, prompt_length)
			VALUES (?, ?, ?, ?, ?)
		`).bind(
			generateId(IdPrefixes.PROMPT),
			sessionId,
			tenantId,
			truncate(payload.prompt, 500),
			payload.prompt?.length || 0
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/pre-tool-use (CAN BLOCK)
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/pre-tool-use', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<PreToolUsePayload>();
	const sessionId = requireSessionId(payload);
	const toolName = payload.tool_name || 'unknown';
	const toolInput = payload.tool_input || {};
	const toolUseId = payload.tool_use_id || null;

	// Evaluate tenant-scoped policies
	const decision = await evaluatePolicies(c.env, payload, tenantId);

	const eventId = generateId(IdPrefixes.TOOL_EVENT);
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, tenant_id, event_type, tool_name, tool_use_id, input_summary, file_path, decision, decision_reason, policy_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			eventId,
			sessionId,
			tenantId,
			HookEvents.PRE_TOOL_USE,
			toolName,
			toolUseId,
			summarizeToolInput(toolName, toolInput),
			extractFilePath(toolName, toolInput),
			decision.decision,
			decision.reason || null,
			decision.policyId || null
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	c.executionCtx.waitUntil(
		incrementToolCalls(c.env.DB, sessionId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	if (!decision.allowed) {
		return c.json({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: decision.decision,
				permissionDecisionReason: decision.reason,
			},
		});
	}

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/post-tool-use
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/post-tool-use', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<PostToolUsePayload>();
	const sessionId = requireSessionId(payload);
	const toolName = payload.tool_name || 'unknown';
	const toolInput = payload.tool_input || {};
	const toolUseId = payload.tool_use_id || null;

	const inputSummary = summarizeToolInput(toolName, toolInput);
	const filePath = extractFilePath(toolName, toolInput);

	const eventId = generateId(IdPrefixes.TOOL_EVENT);
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, tenant_id, event_type, tool_name, tool_use_id, input_summary, output_summary, file_path, success)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		`).bind(
			eventId,
			sessionId,
			tenantId,
			HookEvents.POST_TOOL_USE,
			toolName,
			toolUseId,
			inputSummary,
			truncate(safeStringify(payload.tool_response), 1000),
			filePath
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/post-tool-failure
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/post-tool-failure', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<PostToolUsePayload>();
	const sessionId = requireSessionId(payload);
	const toolName = payload.tool_name || 'unknown';
	const toolInput = payload.tool_input || {};
	const toolUseId = payload.tool_use_id || null;

	const inputSummary = summarizeToolInput(toolName, toolInput);
	const filePath = extractFilePath(toolName, toolInput);

	const eventId = generateId(IdPrefixes.TOOL_EVENT);
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, tenant_id, event_type, tool_name, tool_use_id, input_summary, output_summary, file_path, success)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		`).bind(
			eventId,
			sessionId,
			tenantId,
			HookEvents.POST_TOOL_USE_FAILURE,
			toolName,
			toolUseId,
			inputSummary,
			truncate(safeStringify(payload.tool_response), 1000),
			filePath
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/stop
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/stop', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<StopPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, tenant_id, event_type, tool_name, tool_use_id, input_summary, success)
			VALUES (?, ?, ?, ?, ?, NULL, ?, 1)
		`).bind(
			generateId(IdPrefixes.TOOL_EVENT),
			sessionId,
			tenantId,
			HookEvents.STOP,
			Tools.STOP,
			truncate(payload.last_assistant_message, 500)
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/session-end
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/session-end', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<HookPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		endSession(c.env.DB, sessionId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	// Extract progress (async)
	c.executionCtx.waitUntil(
		extractProgress(c.env, sessionId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	// Trigger action rules for SessionEnd (tenant-scoped)
	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: sessionId,
			event_type: HookEvents.SESSION_END,
		}, tenantId).catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// Simple event handlers — generated from route registry
// --------------------------------------------------------------------------
for (const route of SIMPLE_EVENT_ROUTES) {
	tenantHookRoutes.post(`/:tenantId/${route.path}`, async (c) => {
		const tenantId = c.req.param('tenantId');
		const payload = await c.req.json<HookPayload>();
		const sessionId = requireSessionId(payload);

		c.executionCtx.waitUntil(
			c.env.DB.prepare(`
				INSERT INTO tool_events (id, session_id, tenant_id, event_type, tool_name, tool_use_id, success)
				VALUES (?, ?, ?, ?, ?, NULL, 1)
			`).bind(generateId(IdPrefixes.TOOL_EVENT), sessionId, tenantId, route.event, route.defaultToolName).run()
				.catch(e => console.error('[hooks] waitUntil error:', e))
		);

		return c.json({});
	});
}
