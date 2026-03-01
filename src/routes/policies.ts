import { Hono } from 'hono';
import type { Env, PolicyRow } from '../types';
import { generateId } from '../lib/utils';

export const policyRoutes = new Hono<{ Bindings: Env }>();

// GET /api/policies — List policies
policyRoutes.get('/', async (c) => {
	const { tenant_id, event_type, active } = c.req.query();

	let sql = 'SELECT * FROM policies WHERE 1=1';
	const params: (string | number)[] = [];

	if (tenant_id) {
		sql += ' AND tenant_id = ?';
		params.push(tenant_id);
	} else {
		sql += ' AND tenant_id IS NULL';
	}

	if (event_type) {
		sql += ' AND event_type = ?';
		params.push(event_type);
	}

	if (active !== undefined) {
		sql += ' AND is_active = ?';
		params.push(active === 'true' ? 1 : 0);
	}

	sql += ' ORDER BY priority ASC';

	const { results } = await c.env.DB.prepare(sql).bind(...params).all<PolicyRow>();
	return c.json({ policies: results || [] });
});

// POST /api/policies — Create policy
policyRoutes.post('/', async (c) => {
	const body = await c.req.json<{
		name: string;
		description?: string;
		event_type: string;
		tool_matcher?: string;
		condition_type: string;
		condition_config: string;
		action?: string;
		action_config?: string;
		priority?: number;
		tenant_id?: string;
	}>();

	if (!body.name || !body.event_type || !body.condition_type || !body.condition_config) {
		return c.json({ error: 'name, event_type, condition_type, and condition_config are required' }, 400);
	}

	const id = generateId('pol');

	await c.env.DB.prepare(`
		INSERT INTO policies (id, name, description, event_type, tool_matcher, condition_type, condition_config, action, action_config, priority, tenant_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		id,
		body.name,
		body.description || null,
		body.event_type,
		body.tool_matcher || null,
		body.condition_type,
		body.condition_config,
		body.action || 'deny',
		body.action_config || null,
		body.priority || 100,
		body.tenant_id || null
	).run();

	// Invalidate cache
	await c.env.CACHE.delete(`policies:active:${body.event_type}`);

	const policy = await c.env.DB.prepare('SELECT * FROM policies WHERE id = ?').bind(id).first<PolicyRow>();
	return c.json({ policy }, 201);
});

// PUT /api/policies/:id — Update policy
policyRoutes.put('/:id', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<Partial<{
		name: string;
		description: string;
		event_type: string;
		tool_matcher: string;
		condition_type: string;
		condition_config: string;
		action: string;
		action_config: string;
		priority: number;
		is_active: number;
	}>>();

	const existing = await c.env.DB.prepare('SELECT * FROM policies WHERE id = ?').bind(id).first<PolicyRow>();
	if (!existing) {
		return c.json({ error: 'Policy not found' }, 404);
	}

	const updates: string[] = [];
	const params: (string | number)[] = [];

	const fields: (keyof typeof body)[] = ['name', 'description', 'event_type', 'tool_matcher', 'condition_type', 'condition_config', 'action', 'action_config', 'priority', 'is_active'];

	for (const field of fields) {
		if (body[field] !== undefined) {
			updates.push(`${field} = ?`);
			params.push(body[field] as string | number);
		}
	}

	if (updates.length === 0) {
		return c.json({ error: 'No fields to update' }, 400);
	}

	updates.push("updated_at = datetime('now')");
	params.push(id);

	await c.env.DB.prepare(`UPDATE policies SET ${updates.join(', ')} WHERE id = ?`)
		.bind(...params).run();

	// Invalidate cache for this event type
	await c.env.CACHE.delete(`policies:active:${existing.event_type}`);
	if (body.event_type && body.event_type !== existing.event_type) {
		await c.env.CACHE.delete(`policies:active:${body.event_type}`);
	}

	const policy = await c.env.DB.prepare('SELECT * FROM policies WHERE id = ?').bind(id).first<PolicyRow>();
	return c.json({ policy });
});

// DELETE /api/policies/:id — Deactivate policy
policyRoutes.delete('/:id', async (c) => {
	const id = c.req.param('id');

	const existing = await c.env.DB.prepare('SELECT * FROM policies WHERE id = ?').bind(id).first<PolicyRow>();
	if (!existing) {
		return c.json({ error: 'Policy not found' }, 404);
	}

	await c.env.DB.prepare("UPDATE policies SET is_active = 0, updated_at = datetime('now') WHERE id = ?")
		.bind(id).run();

	await c.env.CACHE.delete(`policies:active:${existing.event_type}`);

	return c.json({ success: true });
});
