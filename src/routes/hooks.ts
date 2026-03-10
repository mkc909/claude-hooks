import { Hono } from 'hono';
import type { Env, PreToolUsePayload, PostToolUsePayload, UserPromptSubmitPayload, StopPayload, HookPayload } from '../types';
import { generateId, truncate, summarizeToolInput, extractFilePath, safeStringify, extractProjectName } from '../lib/utils';
import { evaluatePolicies } from '../services/policy-engine';
import { upsertSession, endSession, incrementToolCalls } from '../services/session-manager';
import { extractProgress } from '../services/progress-extractor';
import { evaluateActionRules } from '../services/action-engine';
import { HookEvents, Tools, IdPrefixes } from '../config/manifest';
import { SIMPLE_EVENT_ROUTES } from '../config/route-registry';

export const hookRoutes = new Hono<{ Bindings: Env }>();

// --------------------------------------------------------------------------
// Payload parsing middleware — validates JSON + session_id, returns 400 on bad input
// --------------------------------------------------------------------------
hookRoutes.use('*', async (c, next) => {
	try {
		// Pre-parse body so downstream handlers don't throw on malformed JSON
		await c.req.json();
	} catch {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'Invalid or missing JSON body',
		}, 400);
	}
	await next();
});

/**
 * Safely parse hook payload. Returns null and a 400 response if session_id is missing.
 */
function requireSessionId(payload: HookPayload): string {
	if (!payload.session_id || typeof payload.session_id !== 'string') {
		throw new PayloadError('Missing required field: session_id');
	}
	return payload.session_id;
}

class PayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PayloadError';
	}
}

// Catch PayloadError and return 400
hookRoutes.onError((err, c) => {
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
// POST /hooks/session-start — SessionStart
// --------------------------------------------------------------------------
hookRoutes.post('/session-start', async (c) => {
	const payload = await c.req.json<HookPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		upsertSession(c.env.DB, sessionId, payload.cwd, payload.permission_mode)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/prompt — UserPromptSubmit
// --------------------------------------------------------------------------
hookRoutes.post('/prompt', async (c) => {
	const payload = await c.req.json<UserPromptSubmitPayload>();
	const sessionId = requireSessionId(payload);

	// Ensure session exists
	c.executionCtx.waitUntil(
		upsertSession(c.env.DB, sessionId, payload.cwd, payload.permission_mode)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	// Log prompt
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO prompts (id, session_id, prompt_text, prompt_length)
			VALUES (?, ?, ?, ?)
		`).bind(
			generateId(IdPrefixes.PROMPT),
			sessionId,
			truncate(payload.prompt, 500),
			payload.prompt?.length || 0
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/pre-tool-use — PreToolUse (CAN BLOCK)
// --------------------------------------------------------------------------
hookRoutes.post('/pre-tool-use', async (c) => {
	const payload = await c.req.json<PreToolUsePayload>();
	const sessionId = requireSessionId(payload);
	const toolName = payload.tool_name || 'unknown';
	const toolInput = payload.tool_input || {};
	const toolUseId = payload.tool_use_id || null;

	// Evaluate security policies
	const decision = await evaluatePolicies(c.env, payload);

	// Log tool event (async, don't block response)
	const eventId = generateId(IdPrefixes.TOOL_EVENT);
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, file_path, decision, decision_reason, policy_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			eventId,
			sessionId,
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

	// Increment session tool call counter
	c.executionCtx.waitUntil(
		incrementToolCalls(c.env.DB, sessionId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	// Return decision
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
// POST /hooks/post-tool-use — PostToolUse
// --------------------------------------------------------------------------
hookRoutes.post('/post-tool-use', async (c) => {
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
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, output_summary, file_path, success)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
		`).bind(
			eventId,
			sessionId,
			HookEvents.POST_TOOL_USE,
			toolName,
			toolUseId,
			inputSummary,
			truncate(safeStringify(payload.tool_response), 1000),
			filePath
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: sessionId,
			event_type: HookEvents.POST_TOOL_USE,
			tool_name: toolName,
			input_summary: inputSummary || undefined,
			file_path: filePath || undefined,
			success: true,
		}).catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/post-tool-failure — PostToolUseFailure
// --------------------------------------------------------------------------
hookRoutes.post('/post-tool-failure', async (c) => {
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
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, output_summary, file_path, success)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		`).bind(
			eventId,
			sessionId,
			HookEvents.POST_TOOL_USE_FAILURE,
			toolName,
			toolUseId,
			inputSummary,
			truncate(safeStringify(payload.tool_response), 1000),
			filePath
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: sessionId,
			event_type: HookEvents.POST_TOOL_USE_FAILURE,
			tool_name: toolName,
			input_summary: inputSummary || undefined,
			file_path: filePath || undefined,
			success: false,
		}).catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/stop — Stop (CAN BLOCK)
// --------------------------------------------------------------------------
hookRoutes.post('/stop', async (c) => {
	const payload = await c.req.json<StopPayload>();
	const sessionId = requireSessionId(payload);

	// Log stop event
	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, input_summary, success)
			VALUES (?, ?, ?, ?, NULL, ?, 1)
		`).bind(
			generateId(IdPrefixes.TOOL_EVENT),
			sessionId,
			HookEvents.STOP,
			Tools.STOP,
			truncate(payload.last_assistant_message, 500)
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: sessionId,
			event_type: HookEvents.STOP,
			success: true,
		}).catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/subagent-start — SubagentStart
// --------------------------------------------------------------------------
hookRoutes.post('/subagent-start', async (c) => {
	const payload = await c.req.json<HookPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, ?, ?, NULL, 1)
		`).bind(generateId(IdPrefixes.TOOL_EVENT), sessionId, HookEvents.SUBAGENT_START, Tools.SUBAGENT).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/subagent-stop — SubagentStop
// --------------------------------------------------------------------------
hookRoutes.post('/subagent-stop', async (c) => {
	const payload = await c.req.json<HookPayload>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, ?, ?, NULL, 1)
		`).bind(generateId(IdPrefixes.TOOL_EVENT), sessionId, HookEvents.SUBAGENT_STOP, Tools.SUBAGENT).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/session-end — SessionEnd
// --------------------------------------------------------------------------
hookRoutes.post('/session-end', async (c) => {
	const payload = await c.req.json<HookPayload>();
	const sessionId = requireSessionId(payload);

	// End session
	c.executionCtx.waitUntil(
		endSession(c.env.DB, sessionId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	// Extract progress (async)
	c.executionCtx.waitUntil(
		extractProgress(c.env, sessionId)
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	// Trigger action rules for SessionEnd
	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: sessionId,
			event_type: HookEvents.SESSION_END,
		}).catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/worktree-create — WorktreeCreate
// --------------------------------------------------------------------------
hookRoutes.post('/worktree-create', async (c) => {
	const payload = await c.req.json<HookPayload & { name?: string; branch?: string; path?: string }>();
	const sessionId = requireSessionId(payload);

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO worktrees (id, session_id, name, branch, path, project, status)
			VALUES (?, ?, ?, ?, ?, ?, 'active')
		`).bind(
			generateId(IdPrefixes.WORKTREE),
			sessionId,
			payload.name || null,
			payload.branch || null,
			payload.path || payload.cwd || '',
			payload.cwd ? extractProjectName(payload.cwd) : null
		).run()
			.catch(e => console.error('[hooks] waitUntil error:', e))
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/worktree-remove — WorktreeRemove
// --------------------------------------------------------------------------
hookRoutes.post('/worktree-remove', async (c) => {
	const payload = await c.req.json<HookPayload & { path?: string }>();
	const sessionId = requireSessionId(payload);

	if (payload.path) {
		c.executionCtx.waitUntil(
			c.env.DB.prepare(`
				UPDATE worktrees SET status = 'cleaned', removed_at = datetime('now')
				WHERE session_id = ? AND path = ? AND status = 'active'
			`).bind(sessionId, payload.path).run()
				.catch(e => console.error('[hooks] waitUntil error:', e))
		);
	}

	return c.json({});
});

// --------------------------------------------------------------------------
// Simple event handlers — generated from route registry
// --------------------------------------------------------------------------
for (const route of SIMPLE_EVENT_ROUTES) {
	hookRoutes.post(`/${route.path}`, async (c) => {
		const payload = await c.req.json<HookPayload>();
		const sessionId = requireSessionId(payload);

		c.executionCtx.waitUntil(
			c.env.DB.prepare(`
				INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
				VALUES (?, ?, ?, ?, NULL, 1)
			`).bind(generateId(IdPrefixes.TOOL_EVENT), sessionId, route.event, route.defaultToolName).run()
				.catch(e => console.error('[hooks] waitUntil error:', e))
		);

		return c.json({});
	});
}
