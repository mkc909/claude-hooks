import type { SessionRow } from '../types';
import { generateDeviceId, extractProjectName } from '../lib/utils';

/**
 * Create or update a session record.
 * Called on SessionStart. If session already exists (resume), updates it.
 */
export async function upsertSession(
	db: D1Database,
	sessionId: string,
	cwd?: string,
	permissionMode?: string,
	hostname?: string,
	tenantId?: string
): Promise<void> {
	const project = extractProjectName(cwd);
	const deviceId = await generateDeviceId(hostname);

	// Try insert, update on conflict
	await db.prepare(`
		INSERT INTO sessions (id, device_id, hostname, cwd, project, permission_mode, tenant_id, started_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(id) DO UPDATE SET
			cwd = COALESCE(excluded.cwd, sessions.cwd),
			project = COALESCE(excluded.project, sessions.project),
			permission_mode = COALESCE(excluded.permission_mode, sessions.permission_mode),
			hostname = COALESCE(excluded.hostname, sessions.hostname),
			device_id = COALESCE(excluded.device_id, sessions.device_id),
			tenant_id = COALESCE(excluded.tenant_id, sessions.tenant_id)
	`).bind(sessionId, deviceId, hostname, cwd, project, permissionMode, tenantId || null).run();
}

/**
 * End a session. Called on SessionEnd.
 */
export async function endSession(
	db: D1Database,
	sessionId: string,
	endReason?: string
): Promise<void> {
	// Count total tool calls for this session
	const countResult = await db.prepare(
		'SELECT COUNT(*) as cnt FROM tool_events WHERE session_id = ?'
	).bind(sessionId).first<{ cnt: number }>();

	const totalToolCalls = countResult?.cnt || 0;

	await db.prepare(`
		UPDATE sessions
		SET ended_at = datetime('now'),
			end_reason = ?,
			total_tool_calls = ?
		WHERE id = ?
	`).bind(endReason, totalToolCalls, sessionId).run();
}

/**
 * Get a session by ID.
 */
export async function getSession(db: D1Database, sessionId: string): Promise<SessionRow | null> {
	return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first<SessionRow>();
}

/**
 * List sessions with filters.
 */
export async function listSessions(
	db: D1Database,
	filters: {
		user_id?: string;
		project?: string;
		since?: string;
		until?: string;
		limit?: number;
		offset?: number;
	}
): Promise<{ sessions: SessionRow[]; count: number }> {
	let sql = 'SELECT * FROM sessions WHERE 1=1';
	const params: (string | number)[] = [];

	if (filters.user_id) {
		sql += ' AND user_id = ?';
		params.push(filters.user_id);
	}
	if (filters.project) {
		sql += ' AND project = ?';
		params.push(filters.project);
	}
	if (filters.since) {
		sql += ' AND started_at >= ?';
		params.push(filters.since);
	}
	if (filters.until) {
		sql += ' AND started_at <= ?';
		params.push(filters.until);
	}

	sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
	params.push(filters.limit || 50, filters.offset || 0);

	const { results } = await db.prepare(sql).bind(...params).all<SessionRow>();
	return { sessions: results || [], count: results?.length || 0 };
}

/**
 * Increment tool call count for a session.
 */
export async function incrementToolCalls(db: D1Database, sessionId: string): Promise<void> {
	await db.prepare(
		'UPDATE sessions SET total_tool_calls = total_tool_calls + 1 WHERE id = ?'
	).bind(sessionId).run();
}
