import { Hono } from 'hono';
import type { Env, ActionRuleRow, ActionLogRow } from '../types';
import { generateId } from '../lib/utils';
import { invalidateRulesCache } from '../services/action-engine';

export const actionRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/action-rules — List action rules
// ---------------------------------------------------------------------------
actionRoutes.get('/action-rules', async (c) => {
	const { trigger_event, active } = c.req.query();

	let sql = 'SELECT * FROM action_rules WHERE 1=1';
	const params: (string | number)[] = [];

	if (trigger_event) {
		sql += ' AND trigger_event = ?';
		params.push(trigger_event);
	}

	if (active !== undefined) {
		sql += ' AND is_active = ?';
		params.push(active === 'true' ? 1 : 0);
	}

	sql += ' ORDER BY created_at ASC';

	const { results } = await c.env.DB.prepare(sql).bind(...params).all<ActionRuleRow>();
	return c.json({ action_rules: results || [] });
});

// ---------------------------------------------------------------------------
// POST /api/action-rules — Create action rule
// ---------------------------------------------------------------------------
actionRoutes.post('/action-rules', async (c) => {
	const body = await c.req.json<{
		name: string;
		description?: string;
		trigger_event: string;
		trigger_condition?: string;
		action_type: string;
		action_config: string;
		cooldown_seconds?: number;
		tenant_id?: string;
	}>();

	if (!body.name || !body.trigger_event || !body.action_type || !body.action_config) {
		return c.json(
			{ error: 'name, trigger_event, action_type, and action_config are required' },
			400
		);
	}

	// Validate action_config is valid JSON
	try {
		JSON.parse(body.action_config);
	} catch {
		return c.json({ error: 'action_config must be valid JSON' }, 400);
	}

	const triggerCondition = body.trigger_condition || '{}';

	// Validate trigger_condition is valid JSON
	try {
		JSON.parse(triggerCondition);
	} catch {
		return c.json({ error: 'trigger_condition must be valid JSON' }, 400);
	}

	const id = generateId('ar');

	await c.env.DB.prepare(`
		INSERT INTO action_rules (id, name, description, trigger_event, trigger_condition, action_type, action_config, cooldown_seconds, tenant_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		id,
		body.name,
		body.description || null,
		body.trigger_event,
		triggerCondition,
		body.action_type,
		body.action_config,
		body.cooldown_seconds ?? 300,
		body.tenant_id || null
	).run();

	// Invalidate cache for this trigger event
	await invalidateRulesCache(c.env, body.trigger_event);

	const rule = await c.env.DB.prepare('SELECT * FROM action_rules WHERE id = ?')
		.bind(id).first<ActionRuleRow>();

	return c.json({ action_rule: rule }, 201);
});

// ---------------------------------------------------------------------------
// PUT /api/action-rules/:id — Update action rule
// ---------------------------------------------------------------------------
actionRoutes.put('/action-rules/:id', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<Partial<{
		name: string;
		description: string;
		trigger_event: string;
		trigger_condition: string;
		action_type: string;
		action_config: string;
		cooldown_seconds: number;
		is_active: number;
	}>>();

	const existing = await c.env.DB.prepare('SELECT * FROM action_rules WHERE id = ?')
		.bind(id).first<ActionRuleRow>();

	if (!existing) {
		return c.json({ error: 'Action rule not found' }, 404);
	}

	// Validate JSON fields if provided
	if (body.action_config !== undefined) {
		try {
			JSON.parse(body.action_config);
		} catch {
			return c.json({ error: 'action_config must be valid JSON' }, 400);
		}
	}

	if (body.trigger_condition !== undefined) {
		try {
			JSON.parse(body.trigger_condition);
		} catch {
			return c.json({ error: 'trigger_condition must be valid JSON' }, 400);
		}
	}

	const updates: string[] = [];
	const params: (string | number)[] = [];

	const fields: (keyof typeof body)[] = [
		'name',
		'description',
		'trigger_event',
		'trigger_condition',
		'action_type',
		'action_config',
		'cooldown_seconds',
		'is_active',
	];

	for (const field of fields) {
		if (body[field] !== undefined) {
			updates.push(`${field} = ?`);
			params.push(body[field] as string | number);
		}
	}

	if (updates.length === 0) {
		return c.json({ error: 'No fields to update' }, 400);
	}

	params.push(id);

	await c.env.DB.prepare(`UPDATE action_rules SET ${updates.join(', ')} WHERE id = ?`)
		.bind(...params).run();

	// Invalidate cache for original and new trigger event types
	await invalidateRulesCache(c.env, existing.trigger_event);
	if (body.trigger_event && body.trigger_event !== existing.trigger_event) {
		await invalidateRulesCache(c.env, body.trigger_event);
	}

	const rule = await c.env.DB.prepare('SELECT * FROM action_rules WHERE id = ?')
		.bind(id).first<ActionRuleRow>();

	return c.json({ action_rule: rule });
});

// ---------------------------------------------------------------------------
// DELETE /api/action-rules/:id — Deactivate action rule
// ---------------------------------------------------------------------------
actionRoutes.delete('/action-rules/:id', async (c) => {
	const id = c.req.param('id');

	const existing = await c.env.DB.prepare('SELECT * FROM action_rules WHERE id = ?')
		.bind(id).first<ActionRuleRow>();

	if (!existing) {
		return c.json({ error: 'Action rule not found' }, 404);
	}

	await c.env.DB.prepare('UPDATE action_rules SET is_active = 0 WHERE id = ?')
		.bind(id).run();

	await invalidateRulesCache(c.env, existing.trigger_event);

	return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/action-log — List action execution history with filters
// ---------------------------------------------------------------------------
actionRoutes.get('/action-log', async (c) => {
	const {
		session_id,
		action_type,
		trigger_event,
		result,
		since,
		until,
		limit = '50',
		offset = '0',
	} = c.req.query();

	let sql = 'SELECT * FROM action_log WHERE 1=1';
	const params: (string | number)[] = [];

	if (session_id) {
		sql += ' AND trigger_session_id = ?';
		params.push(session_id);
	}

	if (action_type) {
		sql += ' AND action_type = ?';
		params.push(action_type);
	}

	if (trigger_event) {
		sql += ' AND trigger_event = ?';
		params.push(trigger_event);
	}

	if (result) {
		sql += ' AND result = ?';
		params.push(result);
	}

	if (since) {
		sql += ' AND created_at >= ?';
		params.push(since);
	}

	if (until) {
		sql += ' AND created_at <= ?';
		params.push(until);
	}

	sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
	params.push(Number(limit), Number(offset));

	const { results } = await c.env.DB.prepare(sql).bind(...params).all<ActionLogRow>();
	return c.json({ action_log: results || [] });
});

// ---------------------------------------------------------------------------
// GET /api/action-log/:id — Get action log detail
// ---------------------------------------------------------------------------
actionRoutes.get('/action-log/:id', async (c) => {
	const id = c.req.param('id');

	const entry = await c.env.DB.prepare('SELECT * FROM action_log WHERE id = ?')
		.bind(id).first<ActionLogRow>();

	if (!entry) {
		return c.json({ error: 'Action log entry not found' }, 404);
	}

	return c.json({ action_log_entry: entry });
});
