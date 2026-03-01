import { Hono } from 'hono';
import type { Env } from '../types';
import { searchVectors, askWithRAG } from '../services/vectorize-service';

/**
 * Reusable guard that returns a 503 response if AI/Vectorize bindings are absent.
 */
function bindingsUnavailable(c: { json: (body: unknown, status?: number) => Response }): Response {
	return c.json({
		type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/503',
		status: 503,
		title: 'Service Unavailable',
		detail: 'Vectorize or AI bindings are not configured',
	}, 503);
}

// ---------------------------------------------------------------------------
// Search routes — mounted at /api/search
// ---------------------------------------------------------------------------
export const searchRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/search — Semantic search over embedded session data
 * Body: { "query": "billing webhook fixes", "limit": 10, "filter": { "project": "billing-service" } }
 */
searchRoutes.post('/', async (c) => {
	if (!c.env.VECTORS || !c.env.AI) return bindingsUnavailable(c);

	let body: { query?: string; limit?: number; filter?: Record<string, string> };
	try {
		body = await c.req.json();
	} catch {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'Request body must be valid JSON',
		}, 400);
	}

	const { query, limit, filter } = body;

	if (!query || typeof query !== 'string' || query.trim().length === 0) {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'query is required and must be a non-empty string',
		}, 400);
	}

	try {
		const results = await searchVectors(c.env, query.trim(), {
			limit: typeof limit === 'number' ? Math.min(limit, 100) : 10,
			filter,
		});

		return c.json({ results });
	} catch (err) {
		console.error('[search] Error during semantic search:', err);
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500',
			status: 500,
			title: 'Internal Server Error',
			detail: 'Failed to perform semantic search',
		}, 500);
	}
});

/**
 * POST /api/search/similar — Find sessions similar to a given session
 * Body: { "session_id": "abc123" }
 */
searchRoutes.post('/similar', async (c) => {
	if (!c.env.VECTORS || !c.env.AI) return bindingsUnavailable(c);

	let body: { session_id?: string; limit?: number };
	try {
		body = await c.req.json();
	} catch {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'Request body must be valid JSON',
		}, 400);
	}

	const { session_id, limit } = body;

	if (!session_id || typeof session_id !== 'string') {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'session_id is required',
		}, 400);
	}

	try {
		const session = await c.env.DB.prepare(
			'SELECT project, summary FROM sessions WHERE id = ?'
		).bind(session_id).first<{ project: string | null; summary: string | null }>();

		if (!session) {
			return c.json({
				type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404',
				status: 404,
				title: 'Not Found',
				detail: `Session ${session_id} not found`,
			}, 404);
		}

		// Look up latest project_status for this session to enrich the query
		const projectStatus = await c.env.DB.prepare(
			'SELECT status, summary FROM project_status WHERE session_id = ? ORDER BY extracted_at DESC LIMIT 1'
		).bind(session_id).first<{ status: string | null; summary: string | null }>();

		// Build search query from session data
		const queryParts: string[] = [];
		if (session.project) queryParts.push(`Project: ${session.project}`);
		if (projectStatus?.status) queryParts.push(`Status: ${projectStatus.status}`);
		if (session.summary) queryParts.push(session.summary);
		if (projectStatus?.summary) queryParts.push(projectStatus.summary);

		if (queryParts.length === 0) {
			return c.json({
				type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422',
				status: 422,
				title: 'Unprocessable Entity',
				detail: 'Session has insufficient data for similarity search',
			}, 422);
		}

		const searchQuery = queryParts.join('. ');
		const results = await searchVectors(c.env, searchQuery, {
			limit: typeof limit === 'number' ? Math.min(limit, 100) : 10,
		});

		// Exclude vectors from the same session
		const filtered = results.filter((r) => r.metadata.session_id !== session_id);

		return c.json({ session_id, results: filtered });
	} catch (err) {
		console.error('[search] Error during similarity search:', err);
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500',
			status: 500,
			title: 'Internal Server Error',
			detail: 'Failed to perform similarity search',
		}, 500);
	}
});

// ---------------------------------------------------------------------------
// Ask routes — mounted at /api/ask
// ---------------------------------------------------------------------------
export const askRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/ask — RAG Q&A over project data
 * Body: { "question": "What progress has been made on CloudClaw RBAC?", "filter": { "project": "cloudclaw-core" } }
 */
askRoutes.post('/', async (c) => {
	if (!c.env.VECTORS || !c.env.AI) return bindingsUnavailable(c);

	let body: { question?: string; filter?: Record<string, string> };
	try {
		body = await c.req.json();
	} catch {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'Request body must be valid JSON',
		}, 400);
	}

	const { question, filter } = body;

	if (!question || typeof question !== 'string' || question.trim().length === 0) {
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/400',
			status: 400,
			title: 'Bad Request',
			detail: 'question is required and must be a non-empty string',
		}, 400);
	}

	try {
		const { answer, sources } = await askWithRAG(c.env, question.trim(), filter);

		return c.json({ answer, sources });
	} catch (err) {
		console.error('[ask] Error during RAG query:', err);
		return c.json({
			type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500',
			status: 500,
			title: 'Internal Server Error',
			detail: 'Failed to generate answer',
		}, 500);
	}
});
