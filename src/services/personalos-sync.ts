/**
 * PersonalOS Sync Service
 *
 * On SessionEnd, collects all session data (prompts, tool events, progress)
 * and POSTs it to PersonalOS ingestion endpoint for brain integration.
 *
 * PersonalOS is on a different CF account, so we use external fetch.
 */

import type { Env, PromptRow, ToolEventRow, SessionRow, ProjectStatusRow } from '../types';

interface PersonalOSSessionPayload {
	session_id: string;
	project?: string;
	cwd?: string;
	git_branch?: string;
	started_at?: string;
	ended_at?: string;
	total_tool_calls?: number;
	summary?: string;
	files_modified?: string[];
	commits?: string[];
	deploy_status?: string;
	prompts: Array<{
		text: string;
		timestamp?: string;
	}>;
	tool_events?: Array<{
		tool_name: string;
		event_type: string;
		input_summary?: string;
		file_path?: string;
		success?: boolean;
		timestamp?: string;
	}>;
}

/**
 * Sync a completed session to PersonalOS brain.
 * Called from SessionEnd hook handler via waitUntil.
 */
export async function syncSessionToPersonalOS(env: Env, sessionId: string): Promise<void> {
	const url = env.PERSONAL_OS_URL;
	const key = env.PERSONAL_OS_INGEST_KEY;

	if (!url || !key) {
		// PersonalOS sync not configured — skip silently
		return;
	}

	// Collect session data
	const session = await env.DB.prepare(
		'SELECT * FROM sessions WHERE id = ?'
	).bind(sessionId).first<SessionRow>();

	if (!session) {
		console.error(`[personalos-sync] Session not found: ${sessionId}`);
		return;
	}

	// Get all prompts
	const { results: prompts } = await env.DB.prepare(
		'SELECT prompt_text, created_at FROM prompts WHERE session_id = ? ORDER BY created_at ASC'
	).bind(sessionId).all<Pick<PromptRow, 'prompt_text' | 'created_at'>>();

	// Skip sessions with no user prompts (nothing to capture)
	if (!prompts || prompts.length === 0) {
		return;
	}

	// Get tool events
	const { results: toolEvents } = await env.DB.prepare(
		'SELECT tool_name, event_type, input_summary, file_path, success, created_at FROM tool_events WHERE session_id = ? ORDER BY created_at ASC'
	).bind(sessionId).all<Pick<ToolEventRow, 'tool_name' | 'event_type' | 'input_summary' | 'file_path' | 'success' | 'created_at'>>();

	// Get progress data
	const progress = await env.DB.prepare(
		'SELECT * FROM project_status WHERE session_id = ? ORDER BY extracted_at DESC LIMIT 1'
	).bind(sessionId).first<ProjectStatusRow>();

	// Build payload
	const payload: PersonalOSSessionPayload = {
		session_id: sessionId,
		project: session.project || undefined,
		cwd: session.cwd || undefined,
		started_at: session.started_at,
		ended_at: session.ended_at || new Date().toISOString(),
		total_tool_calls: session.total_tool_calls,
		summary: progress?.summary || session.summary || undefined,
		files_modified: progress?.files_modified ? safeParseArray(progress.files_modified) : undefined,
		commits: progress?.commits ? safeParseArray(progress.commits) : undefined,
		deploy_status: progress?.deploy_status || undefined,
		prompts: (prompts || [])
			.filter(p => p.prompt_text && p.prompt_text.trim())
			.map(p => ({
				text: p.prompt_text!,
				timestamp: p.created_at,
			})),
		tool_events: (toolEvents || []).map(te => ({
			tool_name: te.tool_name,
			event_type: te.event_type,
			input_summary: te.input_summary || undefined,
			file_path: te.file_path || undefined,
			success: te.success === 1,
			timestamp: te.created_at,
		})),
	};

	// POST to PersonalOS
	const endpoint = url.replace(/\/+$/, '') + '/api/ingestion/claude-session';

	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${key}`,
			},
			body: JSON.stringify(payload),
		});

		if (!res.ok) {
			const errorBody = await res.text().catch(() => '');
			console.error(`[personalos-sync] PersonalOS responded ${res.status}: ${errorBody}`);
		} else {
			console.log(`[personalos-sync] Session ${sessionId} synced to PersonalOS`);
		}
	} catch (err) {
		console.error(`[personalos-sync] Failed to sync session ${sessionId}:`, err);
	}
}

function safeParseArray(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
