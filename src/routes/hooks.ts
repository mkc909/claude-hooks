import { Hono } from 'hono';
import type { Env, PreToolUsePayload, PostToolUsePayload, UserPromptSubmitPayload, StopPayload, HookPayload } from '../types';
import { generateId, truncate, summarizeToolInput, extractFilePath, safeStringify } from '../lib/utils';
import { evaluatePolicies } from '../services/policy-engine';
import { upsertSession, endSession, incrementToolCalls } from '../services/session-manager';
import { extractProgress } from '../services/progress-extractor';
import { evaluateActionRules } from '../services/action-engine';

export const hookRoutes = new Hono<{ Bindings: Env }>();

// --------------------------------------------------------------------------
// POST /hooks/session-start — SessionStart
// --------------------------------------------------------------------------
hookRoutes.post('/session-start', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		upsertSession(c.env.DB, payload.session_id, payload.cwd, payload.permission_mode)
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/prompt — UserPromptSubmit
// --------------------------------------------------------------------------
hookRoutes.post('/prompt', async (c) => {
	const payload = await c.req.json<UserPromptSubmitPayload>();

	// Ensure session exists
	c.executionCtx.waitUntil(upsertSession(c.env.DB, payload.session_id, payload.cwd, payload.permission_mode));

	// Log prompt
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
// POST /hooks/pre-tool-use — PreToolUse (CAN BLOCK)
// --------------------------------------------------------------------------
hookRoutes.post('/pre-tool-use', async (c) => {
	const payload = await c.req.json<PreToolUsePayload>();

	// Evaluate security policies
	const decision = await evaluatePolicies(c.env, payload);

	// Log tool event (async, don't block response)
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

	// Increment session tool call counter
	c.executionCtx.waitUntil(incrementToolCalls(c.env.DB, payload.session_id));

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

	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: payload.session_id,
			event_type: 'PostToolUse',
			tool_name: payload.tool_name,
			input_summary: inputSummary || undefined,
			file_path: filePath || undefined,
			success: true,
		})
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/post-tool-failure — PostToolUseFailure
// --------------------------------------------------------------------------
hookRoutes.post('/post-tool-failure', async (c) => {
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

	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: payload.session_id,
			event_type: 'PostToolUseFailure',
			tool_name: payload.tool_name,
			input_summary: inputSummary || undefined,
			file_path: filePath || undefined,
			success: false,
		})
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/stop — Stop (CAN BLOCK)
// --------------------------------------------------------------------------
hookRoutes.post('/stop', async (c) => {
	const payload = await c.req.json<StopPayload>();

	// Log stop event
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

	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: payload.session_id,
			event_type: 'Stop',
			success: true,
		})
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/subagent-start — SubagentStart
// --------------------------------------------------------------------------
hookRoutes.post('/subagent-start', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'SubagentStart', 'Subagent', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/subagent-stop — SubagentStop
// --------------------------------------------------------------------------
hookRoutes.post('/subagent-stop', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'SubagentStop', 'Subagent', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/session-end — SessionEnd
// --------------------------------------------------------------------------
hookRoutes.post('/session-end', async (c) => {
	const payload = await c.req.json<HookPayload>();

	// End session
	c.executionCtx.waitUntil(endSession(c.env.DB, payload.session_id));

	// Extract progress (async)
	c.executionCtx.waitUntil(extractProgress(c.env, payload.session_id));

	// Trigger action rules for SessionEnd
	c.executionCtx.waitUntil(
		evaluateActionRules(c.env, {
			session_id: payload.session_id,
			event_type: 'SessionEnd',
		})
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/worktree-create — WorktreeCreate
// --------------------------------------------------------------------------
hookRoutes.post('/worktree-create', async (c) => {
	const payload = await c.req.json<HookPayload & { name?: string; branch?: string; path?: string }>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO worktrees (id, session_id, name, branch, path, project, status)
			VALUES (?, ?, ?, ?, ?, ?, 'active')
		`).bind(
			generateId('wt'),
			payload.session_id,
			payload.name || null,
			payload.branch || null,
			payload.path || payload.cwd || '',
			payload.cwd ? (await import('../lib/utils')).extractProjectName(payload.cwd) : null
		).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/worktree-remove — WorktreeRemove
// --------------------------------------------------------------------------
hookRoutes.post('/worktree-remove', async (c) => {
	const payload = await c.req.json<HookPayload & { path?: string }>();

	if (payload.path) {
		c.executionCtx.waitUntil(
			c.env.DB.prepare(`
				UPDATE worktrees SET status = 'cleaned', removed_at = datetime('now')
				WHERE session_id = ? AND path = ? AND status = 'active'
			`).bind(payload.session_id, payload.path).run()
		);
	}

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/permission-request — PermissionRequest
// --------------------------------------------------------------------------
hookRoutes.post('/permission-request', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'PermissionRequest', 'Permission', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/notification — Notification
// --------------------------------------------------------------------------
hookRoutes.post('/notification', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'Notification', 'Notification', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/config-change — ConfigChange
// --------------------------------------------------------------------------
hookRoutes.post('/config-change', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'ConfigChange', 'Config', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/pre-compact — PreCompact
// --------------------------------------------------------------------------
hookRoutes.post('/pre-compact', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'PreCompact', 'Compact', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/task-completed — TaskCompleted
// --------------------------------------------------------------------------
hookRoutes.post('/task-completed', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'TaskCompleted', 'Task', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});

// --------------------------------------------------------------------------
// POST /hooks/teammate-idle — TeammateIdle
// --------------------------------------------------------------------------
hookRoutes.post('/teammate-idle', async (c) => {
	const payload = await c.req.json<HookPayload>();

	c.executionCtx.waitUntil(
		c.env.DB.prepare(`
			INSERT INTO tool_events (id, session_id, event_type, tool_name, tool_use_id, success)
			VALUES (?, ?, 'TeammateIdle', 'Teammate', NULL, 1)
		`).bind(generateId('te'), payload.session_id).run()
	);

	return c.json({});
});
