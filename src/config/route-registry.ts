/**
 * Route registry — maps HTTP route paths to hook events and their metadata.
 * Used by both main hook routes and tenant hook routes to ensure consistency.
 */
import { HookEvents, Tools, type HookEvent } from './manifest';

export interface RouteDefinition {
	/** URL path segment (e.g., 'session-start') */
	path: string;
	/** The hook event this route handles */
	event: HookEvent;
	/** Whether this hook can return blocking decisions */
	blocking: boolean;
	/** Default tool_name to log for events that aren't tool calls */
	defaultToolName: string;
	/** Whether this route has a dedicated handler (vs simple event logging) */
	hasCustomHandler: boolean;
}

/**
 * All hook route definitions.
 * Routes with hasCustomHandler=true have dedicated handler functions.
 * Routes with hasCustomHandler=false use the generic simple event logger.
 */
export const HOOK_ROUTES: RouteDefinition[] = [
	// --- Session lifecycle ---
	{ path: 'session-start', event: HookEvents.SESSION_START, blocking: false, defaultToolName: 'Session', hasCustomHandler: true },
	{ path: 'session-end', event: HookEvents.SESSION_END, blocking: false, defaultToolName: 'Session', hasCustomHandler: true },

	// --- Tool use ---
	{ path: 'pre-tool-use', event: HookEvents.PRE_TOOL_USE, blocking: true, defaultToolName: '', hasCustomHandler: true },
	{ path: 'post-tool-use', event: HookEvents.POST_TOOL_USE, blocking: false, defaultToolName: '', hasCustomHandler: true },
	{ path: 'post-tool-failure', event: HookEvents.POST_TOOL_USE_FAILURE, blocking: false, defaultToolName: '', hasCustomHandler: true },

	// --- Prompt ---
	{ path: 'prompt', event: HookEvents.USER_PROMPT_SUBMIT, blocking: false, defaultToolName: 'Prompt', hasCustomHandler: true },

	// --- Stop ---
	{ path: 'stop', event: HookEvents.STOP, blocking: true, defaultToolName: Tools.STOP, hasCustomHandler: true },

	// --- Subagent ---
	{ path: 'subagent-start', event: HookEvents.SUBAGENT_START, blocking: false, defaultToolName: Tools.SUBAGENT, hasCustomHandler: false },
	{ path: 'subagent-stop', event: HookEvents.SUBAGENT_STOP, blocking: true, defaultToolName: Tools.SUBAGENT, hasCustomHandler: false },

	// --- Worktree ---
	{ path: 'worktree-create', event: HookEvents.WORKTREE_CREATE, blocking: false, defaultToolName: Tools.WORKTREE, hasCustomHandler: true },
	{ path: 'worktree-remove', event: HookEvents.WORKTREE_REMOVE, blocking: false, defaultToolName: Tools.WORKTREE, hasCustomHandler: true },

	// --- Simple event types (logged only, no custom logic) ---
	{ path: 'permission-request', event: HookEvents.PERMISSION_REQUEST, blocking: true, defaultToolName: Tools.PERMISSION, hasCustomHandler: false },
	{ path: 'notification', event: HookEvents.NOTIFICATION, blocking: false, defaultToolName: Tools.NOTIFICATION, hasCustomHandler: false },
	{ path: 'config-change', event: HookEvents.CONFIG_CHANGE, blocking: false, defaultToolName: Tools.CONFIG, hasCustomHandler: false },
	{ path: 'pre-compact', event: HookEvents.PRE_COMPACT, blocking: false, defaultToolName: Tools.COMPACT, hasCustomHandler: false },
	{ path: 'task-completed', event: HookEvents.TASK_COMPLETED, blocking: false, defaultToolName: Tools.TASK, hasCustomHandler: false },
	{ path: 'teammate-idle', event: HookEvents.TEAMMATE_IDLE, blocking: false, defaultToolName: Tools.TEAMMATE, hasCustomHandler: false },
];

/** Lookup: route path -> event name */
export const PATH_TO_EVENT = Object.fromEntries(
	HOOK_ROUTES.map(r => [r.path, r.event])
) as Record<string, HookEvent>;

/** Lookup: event name -> route definition */
export const EVENT_TO_ROUTE = Object.fromEntries(
	HOOK_ROUTES.map(r => [r.event, r])
) as Record<HookEvent, RouteDefinition>;

/** Routes that only need generic event logging (no custom handler) */
export const SIMPLE_EVENT_ROUTES = HOOK_ROUTES.filter(r => !r.hasCustomHandler);
