import { Hono } from 'hono';
import type { Env, ToolEventRow } from '../types';
import { listSessions, getSession } from '../services/session-manager';

export const sessionRoutes = new Hono<{ Bindings: Env }>();

// GET /api/sessions — List sessions with filters
sessionRoutes.get('/', async (c) => {
	const { user_id, project, since, until, limit = '50', offset = '0' } = c.req.query();

	const result = await listSessions(c.env.DB, {
		user_id,
		project,
		since,
		until,
		limit: Number(limit),
		offset: Number(offset),
	});

	return c.json(result);
});

// GET /api/sessions/:id — Session detail
sessionRoutes.get('/:id', async (c) => {
	const id = c.req.param('id');
	const session = await getSession(c.env.DB, id);

	if (!session) {
		return c.json({ error: 'Session not found' }, 404);
	}

	return c.json({ session });
});

// GET /api/sessions/:id/timeline — Chronological event timeline
sessionRoutes.get('/:id/timeline', async (c) => {
	const id = c.req.param('id');
	const session = await getSession(c.env.DB, id);

	if (!session) {
		return c.json({ error: 'Session not found' }, 404);
	}

	const { results: events } = await c.env.DB.prepare(
		'SELECT * FROM tool_events WHERE session_id = ? ORDER BY created_at ASC'
	).bind(id).all<ToolEventRow>();

	const { results: prompts } = await c.env.DB.prepare(
		'SELECT * FROM prompts WHERE session_id = ? ORDER BY created_at ASC'
	).bind(id).all();

	return c.json({
		session,
		events: events || [],
		prompts: prompts || [],
	});
});
