import { Hono } from 'hono';
import type { Env, PreToolUsePayload, PostToolUsePayload, HookPayload, StopPayload, UserPromptSubmitPayload } from '../types';
import { generateId, truncate, summarizeToolInput, extractFilePath, safeStringify } from '../lib/utils';
import { evaluatePolicies } from '../services/policy-engine';
import { upsertSession, endSession, incrementToolCalls } from '../services/session-manager';

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
		"SELECT id FROM tenant_api_keys WHERE tenant_id = ? AND api_key = ? AND is_active = 1"
	).bind(tenantId, token).first();

	if (row) {
		// Cache for 5 minutes
		await c.env.CACHE.put(cacheKey, token, { expirationTtl: 300 });
		return true;
	}

	return false;
}

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

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/session-start
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/session-start', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		upsertSession(c.env.DB, payload.session_id, payload.cwd, payload.permission_mode, tenantId)
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/prompt
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/prompt', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<UserPromptSubmitPayload>();

	c.executionCtx.waitUntil(upsertSession(c.env.DB, payload.session_id, payload.cwd, payload.permission_mode, tenantId));

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO prompts (id, session_id, prompt_text, prompt_length)
			VALUES (?, ?, ?, ?)
		`).bind(
			generateId('prm'),
			payload.session_id,
			truncate(payload.prompt, 500),
			payload.prompt?.length || 0
		).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/pre-tool-use (CAN BLOCK)
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/pre-tool-use', async (c) => {
	const tenantId = c.req.param('tenantId');
	const payload = await c.req.json<PreToolUsePayload>();

	// Evaluate tenant-scoped policies
	const decision = await evaluatePolicies(c.env, payload, tenantId);

	const eventId = generateId('te');
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, file_path, decision, decision_reason, policy_id)
			VALUES (?, ?, 'PreToolUse', ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			eventId,
			payload.session_id,
			payload.tool_name,
			payload.tool_use_id,
			summarizeToolInput(payload.tool_name, payload.tool_input),
			extractFilePath(payload.tool_name, payload.tool_input),
			decision.decision,
			decision.reason || null,
			decision.policyId || null
		).run()
	);

	c.executionCtx.waitUntil(incrementToolCalls(c.env.DB, payload.session_id));

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
	const payload = await c.req.json<PostToolUsePayload>();

	const inputSummary = summarizeToolInput(payload.tool_name, payload.tool_input);
	const filePath = extractFilePath(payload.tool_name, payload.tool_input);

	const eventId = generateId('te');
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, output_summary, file_path, success)
			VALUES (?, ?, 'PostToolUse', ?, ?, ?, ?, ?, 1)
		`).bind(
			eventId,
			payload.session_id,
			payload.tool_name,
			payload.tool_use_id,
			inputSummary,
			truncate(safeStringify(payload.tool_response), 1000),
			filePath
		).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/post-tool-failure
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/post-tool-failure', async (c) => {
	const payload = await c.req.json<PostToolUsePayload>();

	const inputSummary = summarizeToolInput(payload.tool_name, payload.tool_input);
	const filePath = extractFilePath(payload.tool_name, payload.tool_input);

	const eventId = generateId('te');
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, output_summary, file_path, success)
			VALUES (?, ?, 'PostToolUseFailure', ?, ?, ?, ?, ?, 0)
		`).bind(
			eventId,
			payload.session_id,
			payload.tool_name,
			payload.tool_use_id,
			inputSummary,
			truncate(safeStringify(payload.tool_response), 1000),
			filePath
		).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/stop
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/stop', async (c) => {
	const payload = await c.req.json<StopPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, success)
			VALUES (?, ?, 'Stop', 'Stop', NULL, ?, 1)
		`).bind(
			generateId('te'),
			payload.session_id,
			truncate(payload.last_assistant_message, 500)
		).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /tenant/:tenantId/session-end
// --------------------------------------------------------------------------
tenantHookRoutes.post('/:tenantId/session-end', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(endSession(c.env.DB, payload.session_id));

	return c.json({});
});

// --------------------------------------------------------------------------
// Generic handler for events that only need logging
// --------------------------------------------------------------------------
const simpleEvents = [
	'subagent-start', 'subagent-stop', 'worktree-create', 'worktree-remove',
	'permission-request', 'notification', 'config-change', 'pre-compact',
	'task-completed', 'teammate-idle',
] as const;

const eventTypeMap: Record<string, { eventType: string; toolName: string }> = {
	'subagent-start': { eventType: 'SubagentStart', toolName: 'Subagent' },
	'subagent-stop': { eventType: 'SubagentStop', toolName: 'Subagent' },
	'worktree-create': { eventType: 'WorktreeCreate', toolName: 'Worktree' },
	'worktree-remove': { eventType: 'WorktreeRemove', toolName: 'Worktree' },
	'permission-request': { eventType: 'PermissionRequest', toolName: 'Permission' },
	'notification': { eventType: 'Notification', toolName: 'Notification' },
	'config-change': { eventType: 'ConfigChange', toolName: 'Config' },
	'pre-compact': { eventType: 'PreCompact', toolName: 'Compact' },
	'task-completed': { eventType: 'TaskCompleted', toolName: 'Task' },
	'teammate-idle': { eventType: 'TeammateIdle', toolName: 'Teammate' },
};

for (const event of simpleEvents) {
	const { eventType, toolName } = eventTypeMap[event];
	tenantHookRoutes.post(`/:tenantId/${event}`, async (c) => {
		const payload = await c.req.json<HookPayload>();

		c.executionCtx.waitUntil(
			c.env.DB.prepare(`
				INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
				VALUES (?, ?, ?, ?, NULL, 1)
			`).bind(generateId('te'), payload.session_id, eventType, toolName).run()
		);

		return c.json({});
	});
}
