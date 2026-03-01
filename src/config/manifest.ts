/**
 * Central manifest — single source of truth for all hook events,
 * tool names, policy condition types, action types, and route mappings.
 *
 * ALL code that references these values MUST import from this file.
 * Never hardcode event names, tool names, or condition types elsewhere.
 */

// ---------------------------------------------------------------------------
// Hook Events — all 18 Claude Code hook event types
// ---------------------------------------------------------------------------

export const HookEvents = {
	SESSION_START: 'SessionStart',
	SESSION_END: 'SessionEnd',
	USER_PROMPT_SUBMIT: 'UserPromptSubmit',
	PRE_TOOL_USE: 'PreToolUse',
	POST_TOOL_USE: 'PostToolUse',
	POST_TOOL_USE_FAILURE: 'PostToolUseFailure',
	STOP: 'Stop',
	SUBAGENT_START: 'SubagentStart',
	SUBAGENT_STOP: 'SubagentStop',
	WORKTREE_CREATE: 'WorktreeCreate',
	WORKTREE_REMOVE: 'WorktreeRemove',
	PERMISSION_REQUEST: 'PermissionRequest',
	NOTIFICATION: 'Notification',
	CONFIG_CHANGE: 'ConfigChange',
	PRE_COMPACT: 'PreCompact',
	TASK_COMPLETED: 'TaskCompleted',
	TEAMMATE_IDLE: 'TeammateIdle',
} as const;

export type HookEvent = typeof HookEvents[keyof typeof HookEvents];

// Which events can return blocking decisions (deny/ask)
export const BLOCKING_EVENTS = new Set<HookEvent>([
	HookEvents.PRE_TOOL_USE,
	HookEvents.STOP,
	HookEvents.SUBAGENT_STOP,
	HookEvents.PERMISSION_REQUEST,
]);

// ---------------------------------------------------------------------------
// Claude Code Tools — tool names as they appear in hook payloads
// ---------------------------------------------------------------------------

export const Tools = {
	// File operations
	READ: 'Read',
	WRITE: 'Write',
	EDIT: 'Edit',
	GLOB: 'Glob',
	GREP: 'Grep',

	// Execution
	BASH: 'Bash',

	// Web
	WEB_FETCH: 'WebFetch',
	WEB_SEARCH: 'WebSearch',

	// Agent
	TASK: 'Task',

	// Notebooks
	NOTEBOOK_EDIT: 'NotebookEdit',

	// Special (used as tool_name in events that aren't tool calls)
	STOP: 'Stop',
	SUBAGENT: 'Subagent',
	WORKTREE: 'Worktree',
	PERMISSION: 'Permission',
	NOTIFICATION: 'Notification',
	CONFIG: 'Config',
	COMPACT: 'Compact',
	TEAMMATE: 'Teammate',
} as const;

export type ToolName = typeof Tools[keyof typeof Tools];

// Tools that have a file_path in their input
export const FILE_PATH_TOOLS = new Set<string>([
	Tools.READ, Tools.WRITE, Tools.EDIT,
]);

// Tools that have a path (directory) in their input
export const DIR_PATH_TOOLS = new Set<string>([
	Tools.GLOB, Tools.GREP,
]);

// ---------------------------------------------------------------------------
// Policy Condition Types
// ---------------------------------------------------------------------------

export const PolicyConditions = {
	BLOCK_PATTERN: 'block_pattern',
	FILE_PROTECTION: 'file_protection',
	SECRET_DETECTION: 'secret_detection',
	RATE_LIMIT: 'rate_limit',
	SCOPE_ENFORCEMENT: 'scope_enforcement',
} as const;

export type PolicyConditionType = typeof PolicyConditions[keyof typeof PolicyConditions];

// ---------------------------------------------------------------------------
// Policy Actions (what happens when a policy matches)
// ---------------------------------------------------------------------------

export const PolicyActions = {
	DENY: 'deny',
	ALLOW: 'allow',
	ASK: 'ask',
	MODIFY: 'modify',
	NOTIFY: 'notify',
} as const;

export type PolicyAction = typeof PolicyActions[keyof typeof PolicyActions];

// ---------------------------------------------------------------------------
// Action Types (automated actions triggered by events)
// ---------------------------------------------------------------------------

export const ActionTypes = {
	NOTIFY_DISCORD: 'notify_discord',
	SYNC_OPS: 'sync_ops',
	TRACK_EVENT: 'track_event',
	SEND_EMAIL: 'send_email',
	WEBHOOK: 'webhook',
} as const;

export type ActionType = typeof ActionTypes[keyof typeof ActionTypes];

// ---------------------------------------------------------------------------
// Project Status values
// ---------------------------------------------------------------------------

export const ProjectStatuses = {
	ACTIVE: 'active',
	BLOCKED: 'blocked',
	COMPLETED: 'completed',
	STALE: 'stale',
} as const;

export type ProjectStatus = typeof ProjectStatuses[keyof typeof ProjectStatuses];

// ---------------------------------------------------------------------------
// Deploy Status values
// ---------------------------------------------------------------------------

export const DeployStatuses = {
	SUCCESS: 'success',
	FAILED: 'failed',
	PENDING: 'pending',
	NOT_ATTEMPTED: 'not_attempted',
} as const;

export type DeployStatus = typeof DeployStatuses[keyof typeof DeployStatuses];

// ---------------------------------------------------------------------------
// ID Prefixes — used by generateId()
// ---------------------------------------------------------------------------

export const IdPrefixes = {
	TOOL_EVENT: 'te',
	PROMPT: 'prm',
	WORKTREE: 'wt',
	ACTION_LOG: 'al',
	PROJECT_STATUS: 'ps',
	POLICY: 'pol',
	ACTION_RULE: 'ar',
} as const;
