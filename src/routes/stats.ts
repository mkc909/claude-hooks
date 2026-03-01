import { Hono } from 'hono';
import type { Env } from '../types';

export const statsRoutes = new Hono<{ Bindings: Env }>();

// GET /api/stats — Aggregate statistics
statsRoutes.get('/', async (c) => {
	const { days = '7' } = c.req.query();
	const daysAgo = new Date();
	daysAgo.setDate(daysAgo.getDate() - Number(days));
	const since = daysAgo.toISOString().slice(0, 10);

	// Tool usage by type
	const toolUsage = await c.env.DB.prepare(`
		SELECT tool_name, COUNT(*) as count
		FROM tool_events
		WHERE created_at >= ?
		GROUP BY tool_name
		ORDER BY count DESC
	`).bind(since).all<{ tool_name: string; count: number }>();

	// Sessions per day
	const sessionsPerDay = await c.env.DB.prepare(`
		SELECT DATE(started_at) as day, COUNT(*) as count
		FROM sessions
		WHERE started_at >= ?
		GROUP BY DATE(started_at)
		ORDER BY day DESC
	`).bind(since).all<{ day: string; count: number }>();

	// Tool calls per day
	const toolCallsPerDay = await c.env.DB.prepare(`
		SELECT DATE(created_at) as day, COUNT(*) as count
		FROM tool_events
		WHERE created_at >= ?
		GROUP BY DATE(created_at)
		ORDER BY day DESC
	`).bind(since).all<{ day: string; count: number }>();

	// Policies triggered
	const policiesTriggered = await c.env.DB.prepare(`
		SELECT p.name as policy_name, COUNT(*) as count
		FROM tool_events te
		JOIN policies p ON te.policy_id = p.id
		WHERE te.created_at >= ? AND te.decision = 'deny'
		GROUP BY p.name
		ORDER BY count DESC
	`).bind(since).all<{ policy_name: string; count: number }>();

	// Total counts
	const totalSessions = await c.env.DB.prepare(
		'SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ?'
	).bind(since).first<{ cnt: number }>();

	const totalToolCalls = await c.env.DB.prepare(
		'SELECT COUNT(*) as cnt FROM tool_events WHERE created_at >= ?'
	).bind(since).first<{ cnt: number }>();

	const totalPrompts = await c.env.DB.prepare(
		'SELECT COUNT(*) as cnt FROM prompts WHERE created_at >= ?'
	).bind(since).first<{ cnt: number }>();

	return c.json({
		period: { since, days: Number(days) },
		totals: {
			sessions: totalSessions?.cnt || 0,
			tool_calls: totalToolCalls?.cnt || 0,
			prompts: totalPrompts?.cnt || 0,
		},
		tool_usage: toolUsage.results || [],
		sessions_per_day: sessionsPerDay.results || [],
		tool_calls_per_day: toolCallsPerDay.results || [],
		policies_triggered: policiesTriggered.results || [],
	});
});
