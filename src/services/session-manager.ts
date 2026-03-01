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
): Promise<{ sessions: SessionRow[]; total: number }> {
	// Build WHERE clause for both count and data queries
	let whereSql = ' WHERE 1=1';
	const whereParams: (string | number)[] = [];

	if (filters.user_id) {
		whereSql += ' AND user_id = ?';
		whereParams.push(filters.user_id);
	}
	if (filters.project) {
		whereSql += ' AND project = ?';
		whereParams.push(filters.project);
	}
	if (filters.since) {
		whereSql += ' AND started_at >= ?';
		whereParams.push(filters.since);
	}
	if (filters.until) {
		whereSql += ' AND started_at <= ?';
		whereParams.push(filters.until);
	}

	// Run COUNT(*) query for actual total
	const countSql = 'SELECT COUNT(*) as total FROM sessions' + whereSql;
	const countResult = await db.prepare(countSql).bind(...whereParams).first<{ total: number }>();
	const total = countResult?.total || 0;

	// Run data query with LIMIT/OFFSET
	const dataSql = 'SELECT * FROM sessions' + whereSql + ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
	const dataParams = [...whereParams, filters.limit || 50, filters.offset || 0];
	const { results } = await db.prepare(dataSql).bind(...dataParams).all<SessionRow>();

	return { sessions: results || [], total };
}

/**
 * Increment tool call count for a session.
 */
export async function incrementToolCalls(db: D1Database, sessionId: string): Promise<void> {
	await db.prepare(
		'UPDATE sessions SET total_tool_calls = total_tool_calls + 1 WHERE id = ?'
	).bind(sessionId).run();
}
