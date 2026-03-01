import { Hono } from 'hono';
import type { Env } from './types';
import { hookAuth, adminAuth } from './middleware/auth';
import { hookRoutes } from './routes/hooks';
import { sessionRoutes } from './routes/sessions';
import { policyRoutes } from './routes/policies';
import { progressRoutes } from './routes/progress';
import { statsRoutes } from './routes/stats';
import { actionRoutes } from './routes/actions';
import { searchRoutes, askRoutes } from './routes/search';
import { manifestRoutes } from './routes/manifest';
import { tenantHookRoutes } from './routes/tenant-hooks';

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Health check (public)
// ---------------------------------------------------------------------------
app.get('/health', async (c) => {
	try {
		await c.env.DB.prepare('SELECT 1').first();
		return c.json({
			status: 'healthy',
			service: 'claude-hooks',
			version: '1.0.0',
			timestamp: new Date().toISOString(),
		});
	} catch {
		return c.json({ status: 'unhealthy', service: 'claude-hooks' }, 500);
	}
});

// ---------------------------------------------------------------------------
// Hook receiver routes (hook secret auth)
// ---------------------------------------------------------------------------
app.route('/hooks', (() => {
	const hooks = new Hono<{ Bindings: Env }>();
	hooks.use('*', hookAuth());
	hooks.route('/', hookRoutes);
	return hooks;
})());

// ---------------------------------------------------------------------------
// Multi-tenant hook routes (CloudClaw integration — tenant API key auth)
// ---------------------------------------------------------------------------
app.route('/hooks/tenant', tenantHookRoutes);

// ---------------------------------------------------------------------------
// Admin API routes (admin API key auth)
// ---------------------------------------------------------------------------
app.route('/api', (() => {
	const api = new Hono<{ Bindings: Env }>();
	api.use('*', adminAuth());
	api.route('/sessions', sessionRoutes);
	api.route('/policies', policyRoutes);
	api.route('/progress', progressRoutes);
	api.route('/stats', statsRoutes);
	api.route('/search', searchRoutes);
	api.route('/ask', askRoutes);
	api.route('/manifest', manifestRoutes);
	api.route('/', actionRoutes);
	return api;
})());

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.notFound((c) => {
	return c.json({
		type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404',
		status: 404,
		title: 'Not Found',
		detail: `No route found for ${c.req.method} ${c.req.path}`,
	}, 404);
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return c.json({
		type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500',
		status: 500,
		title: 'Internal Server Error',
		detail: 'An unexpected error occurred',
	}, 500);
});

// ---------------------------------------------------------------------------
// Cron triggers
// ---------------------------------------------------------------------------
async function handleCron(event: ScheduledEvent, env: Env): Promise<void> {
	const trigger = event.cron;
	console.log(`[cron] Running scheduled task: ${trigger}`);

	switch (trigger) {
		case '0 * * * *':
			// Hourly: cleanup and maintenance
			await hourlyMaintenance(env);
			break;
		case '0 0 * * *':
			// Daily: aggregate stats, mark stale projects
			await dailyMaintenance(env);
			break;
		case '0 0 * * 1':
			// Weekly: cleanup old data
			await weeklyCleanup(env);
			break;
	}
}

async function hourlyMaintenance(env: Env): Promise<void> {
	// Mark projects with no activity in 7 days as stale
	const sevenDaysAgo = new Date();
	sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
	const cutoff = sevenDaysAgo.toISOString();

	const { results: staleProjects } = await env.DB.prepare(`
		SELECT DISTINCT project
		FROM sessions
		WHERE project IS NOT NULL
		AND project NOT IN (
			SELECT DISTINCT project FROM sessions
			WHERE started_at >= ? AND project IS NOT NULL
		)
	`).bind(cutoff).all<{ project: string }>();

	for (const p of staleProjects || []) {
		// Check if already marked stale recently
		const existing = await env.DB.prepare(
			"SELECT id FROM project_status WHERE project = ? AND status = 'stale' AND extracted_at >= ?"
		).bind(p.project, cutoff).first();

		if (!existing) {
			await env.DB.prepare(`
				INSERT INTO project_status (id, project, status, summary, extracted_at)
				VALUES (?, ?, 'stale', 'No activity in 7+ days', datetime('now'))
			`).bind(`ps_stale_${crypto.randomUUID().slice(0, 8)}`, p.project).run();
		}
	}
}

async function dailyMaintenance(env: Env): Promise<void> {
	// Clean up orphaned tool events (sessions that never started)
	await env.DB.prepare(`
		DELETE FROM tool_events
		WHERE session_id NOT IN (SELECT id FROM sessions)
		AND created_at < datetime('now', '-1 day')
	`).run();
}

async function weeklyCleanup(env: Env): Promise<void> {
	// Delete tool_events older than 90 days (keep sessions and project_status)
	await env.DB.prepare(`
		DELETE FROM tool_events WHERE created_at < datetime('now', '-90 days')
	`).run();

	// Delete prompts older than 90 days
	await env.DB.prepare(`
		DELETE FROM prompts WHERE created_at < datetime('now', '-90 days')
	`).run();

	// Delete action_log older than 90 days
	await env.DB.prepare(`
		DELETE FROM action_log WHERE created_at < datetime('now', '-90 days')
	`).run();

	// Clean up removed worktrees older than 30 days
	await env.DB.prepare(`
		DELETE FROM worktrees WHERE status = 'cleaned' AND removed_at < datetime('now', '-30 days')
	`).run();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export default {
	fetch: app.fetch,
	scheduled: handleCron,
};
