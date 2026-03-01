import type { Env, ToolEventRow } from '../types';
import { generateId } from '../lib/utils';

/**
 * Extract project progress from a session's tool events.
 * Called on SessionEnd to create project_status snapshots.
 */
export async function extractProgress(env: Env, sessionId: string): Promise<void> {
	// Get all tool events for this session
	const { results: events } = await env.DB.prepare(
		'SELECT * FROM tool_events WHERE session_id = ? ORDER BY created_at ASC'
	).bind(sessionId).all<ToolEventRow>();

	if (!events || events.length === 0) return;

	// Get prompts for issue extraction
	const { results: prompts } = await env.DB.prepare(
		'SELECT prompt_text FROM prompts WHERE session_id = ?'
	).bind(sessionId).all<{ prompt_text: string | null }>();

	// Get session to know the primary project
	const session = await env.DB.prepare(
		'SELECT project, cwd FROM sessions WHERE id = ?'
	).bind(sessionId).first<{ project: string | null; cwd: string | null }>();

	const primaryProject = session?.project;
	if (!primaryProject) return;

	// Collect data
	const filesModified = new Set<string>();
	const commits: string[] = [];
	let testsPassed: number | null = null;
	let testsFailed: number | null = null;
	let typecheckErrors: number | null = null;
	let deployStatus: string | null = null;

	for (const event of events) {
		// Track file modifications
		if (event.file_path && (event.event_type === 'PostToolUse') &&
			(event.tool_name === 'Write' || event.tool_name === 'Edit')) {
			filesModified.add(event.file_path);
		}

		// Detect test results from Bash commands
		if (event.tool_name === 'Bash' && event.input_summary) {
			const cmd = event.input_summary;

			if (cmd.includes('npm test') || cmd.includes('npx vitest') || cmd.includes('jest')) {
				if (event.success === 1) {
					testsPassed = (testsPassed || 0) + 1;
				} else {
					testsFailed = (testsFailed || 0) + 1;
				}
			}

			if (cmd.includes('tsc --noEmit') || cmd.includes('typecheck')) {
				if (event.success === 0) {
					typecheckErrors = (typecheckErrors || 0) + 1;
				} else {
					typecheckErrors = 0;
				}
			}

			if (cmd.includes('wrangler deploy') || cmd.includes('npm run deploy')) {
				deployStatus = event.success === 1 ? 'success' : 'failed';
			}

			if (cmd.includes('git commit')) {
				// Extract commit message if visible
				const commitMatch = cmd.match(/-m\s+["']([^"']+)["']/);
				if (commitMatch) {
					commits.push(commitMatch[1]);
				}
			}
		}
	}

	// Extract issue references from prompts
	const issuesReferenced = new Set<string>();
	for (const prompt of prompts || []) {
		if (!prompt.prompt_text) continue;
		const issueMatches = prompt.prompt_text.matchAll(/#(\d+)/g);
		for (const match of issueMatches) {
			issuesReferenced.add(`#${match[1]}`);
		}
	}

	// Determine status
	let status = 'active';
	if (typecheckErrors && typecheckErrors > 0) status = 'blocked';
	if (testsFailed && testsFailed > 0) status = 'blocked';
	if (deployStatus === 'success') status = 'completed';

	// Build summary
	const summaryParts: string[] = [];
	if (filesModified.size > 0) summaryParts.push(`${filesModified.size} files modified`);
	if (commits.length > 0) summaryParts.push(`${commits.length} commits`);
	if (deployStatus) summaryParts.push(`deploy: ${deployStatus}`);
	if (testsPassed) summaryParts.push(`${testsPassed} test runs passed`);
	if (testsFailed) summaryParts.push(`${testsFailed} test runs failed`);

	// Insert project_status
	await env.DB.prepare(`
		INSERT INTO project_status (id, project, session_id, status, summary, files_modified, issues_referenced, commits, tests_passed, tests_failed, typecheck_errors, deploy_status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		generateId('ps'),
		primaryProject,
		sessionId,
		status,
		summaryParts.join('; ') || null,
		JSON.stringify(Array.from(filesModified)),
		JSON.stringify(Array.from(issuesReferenced)),
		JSON.stringify(commits),
		testsPassed,
		testsFailed,
		typecheckErrors,
		deployStatus
	).run();
}

/**
 * Get latest status for all projects.
 */
export async function getProjectProgress(
	db: D1Database,
	filters?: { project?: string; status?: string; since?: string; limit?: number }
): Promise<{ project: string; status: string; summary: string | null; extracted_at: string }[]> {
	let sql = `
		SELECT ps.*
		FROM project_status ps
		INNER JOIN (
			SELECT project, MAX(extracted_at) as max_date
			FROM project_status
			WHERE 1=1
	`;
	const params: (string | number)[] = [];

	if (filters?.project) {
		sql += ' AND project = ?';
		params.push(filters.project);
	}
	if (filters?.since) {
		sql += ' AND extracted_at >= ?';
		params.push(filters.since);
	}

	sql += `
			GROUP BY project
		) latest ON ps.project = latest.project AND ps.extracted_at = latest.max_date
	`;

	if (filters?.status) {
		sql += ' WHERE ps.status = ?';
		params.push(filters.status);
	}

	sql += ' ORDER BY ps.extracted_at DESC';

	if (filters?.limit) {
		sql += ' LIMIT ?';
		params.push(filters.limit);
	}

	const { results } = await db.prepare(sql).bind(...params).all();
	return (results || []) as { project: string; status: string; summary: string | null; extracted_at: string }[];
}
