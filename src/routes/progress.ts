import { Hono } from 'hono';
import type { Env } from '../types';
import { getProjectProgress } from '../services/progress-extractor';

export const progressRoutes = new Hono<{ Bindings: Env }>();

// GET /api/progress — Cross-project status dashboard
progressRoutes.get('/', async (c) => {
	const { status, since, limit = '50' } = c.req.query();

	const projects = await getProjectProgress(c.env.DB, {
		status,
		since,
		limit: Number(limit),
	});

	return c.json({ projects });
});

// GET /api/progress/summary — Aggregated dashboard data
progressRoutes.get('/summary', async (c) => {
	const today = new Date().toISOString().slice(0, 10);

	// Sessions today
	const sessionsResult = await c.env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ?"
	).bind(today).first<{ cnt: number }>();

	// Tool calls today
	const toolsResult = await c.env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM tool_events WHERE created_at >= ?"
	).bind(today).first<{ cnt: number }>();

	// Unique projects today
	const projectsResult = await c.env.DB.prepare(
		"SELECT COUNT(DISTINCT project) as cnt FROM sessions WHERE started_at >= ? AND project IS NOT NULL"
	).bind(today).first<{ cnt: number }>();

	// Policies triggered today
	const policiesResult = await c.env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM tool_events WHERE created_at >= ? AND decision = 'deny'"
	).bind(today).first<{ cnt: number }>();

	// Deploys today (from project_status)
	const deploysResult = await c.env.DB.prepare(
		"SELECT deploy_status, COUNT(*) as cnt FROM project_status WHERE extracted_at >= ? AND deploy_status IS NOT NULL GROUP BY deploy_status"
	).bind(today).all<{ deploy_status: string; cnt: number }>();

	const deploys = {
		success: 0,
		failed: 0,
	};
	for (const row of deploysResult.results || []) {
		if (row.deploy_status === 'success') deploys.success = row.cnt;
		if (row.deploy_status === 'failed') deploys.failed = row.cnt;
	}

	// Top projects (most sessions today)
	const topProjectsResult = await c.env.DB.prepare(`
		SELECT project, COUNT(*) as sessions, SUM(total_tool_calls) as tool_calls
		FROM sessions
		WHERE started_at >= ? AND project IS NOT NULL
		GROUP BY project
		ORDER BY sessions DESC
		LIMIT 10
	`).bind(today).all<{ project: string; sessions: number; tool_calls: number }>();

	return c.json({
		date: today,
		sessions_today: sessionsResult?.cnt || 0,
		tool_calls_today: toolsResult?.cnt || 0,
		active_projects: projectsResult?.cnt || 0,
		policies_triggered: policiesResult?.cnt || 0,
		deploys_today: deploys.success,
		deploys_failed: deploys.failed,
		top_projects: topProjectsResult.results || [],
	});
});

// GET /api/progress/:project — Single project history
progressRoutes.get('/:project', async (c) => {
	const project = c.req.param('project');
	const { limit = '20' } = c.req.query();

	const { results } = await c.env.DB.prepare(
		'SELECT * FROM project_status WHERE project = ? ORDER BY extracted_at DESC LIMIT ?'
	).bind(project, Number(limit)).all();

	return c.json({ project, history: results || [] });
});
