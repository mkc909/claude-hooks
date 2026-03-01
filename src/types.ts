// Environment bindings
export interface Env {
	DB: D1Database;
	CACHE: KVNamespace;
	OPS_OS: Fetcher;
	ANALYTICS_DASHBOARD: Fetcher;
	EMAIL_SERVICE: Fetcher;
	DEPLOY_BOT: Fetcher;
	HOOK_SECRET: string;
	ADMIN_API_KEY: string;
	ENVIRONMENT: string;
}

// D1 Row Types

export interface SessionRow {
	id: string;
	user_id: string | null;
	device_id: string | null;
	hostname: string | null;
	cwd: string | null;
	project: string | null;
	permission_mode: string | null;
	started_at: string;
	ended_at: string | null;
	end_reason: string | null;
	total_tool_calls: number;
	total_tokens_est: number;
	summary: string | null;
	metadata: string | null;
}

export interface ToolEventRow {
	id: string;
	session_id: string;
	event_type: string;
	tool_name: string;
	tool_use_id: string | null;
	input_summary: string | null;
	output_summary: string | null;
	file_path: string | null;
	decision: string | null;
	decision_reason: string | null;
	policy_id: string | null;
	duration_ms: number | null;
	success: number | null;
	created_at: string;
}

export interface PolicyRow {
	id: string;
	name: string;
	description: string | null;
	event_type: string;
	tool_matcher: string | null;
	condition_type: string;
	condition_config: string;
	action: string;
	action_config: string | null;
	priority: number;
	is_active: number;
	tenant_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface PromptRow {
	id: string;
	session_id: string;
	prompt_text: string | null;
	prompt_length: number | null;
	blocked: number;
	block_reason: string | null;
	created_at: string;
}

export interface ProjectStatusRow {
	id: string;
	project: string;
	session_id: string | null;
	status: string;
	summary: string | null;
	files_modified: string | null;
	issues_referenced: string | null;
	commits: string | null;
	tests_passed: number | null;
	tests_failed: number | null;
	typecheck_errors: number | null;
	deploy_status: string | null;
	extracted_at: string;
}

export interface ActionLogRow {
	id: string;
	trigger_event: string;
	trigger_session_id: string | null;
	action_type: string;
	action_target: string | null;
	action_config: string | null;
	result: string | null;
	result_detail: string | null;
	created_at: string;
}

export interface ActionRuleRow {
	id: string;
	name: string;
	description: string | null;
	trigger_event: string;
	trigger_condition: string;
	action_type: string;
	action_config: string;
	cooldown_seconds: number;
	is_active: number;
	tenant_id: string | null;
	created_at: string;
}

export interface WorktreeRow {
	id: string;
	session_id: string;
	name: string | null;
	branch: string | null;
	base_branch: string | null;
	path: string;
	project: string | null;
	status: string;
	created_at: string;
	removed_at: string | null;
}

// Hook event payloads from Claude Code

export interface HookPayload {
	session_id: string;
	hook_event_name: string;
	cwd?: string;
	permission_mode?: string;
	transcript_path?: string;
}

export interface PreToolUsePayload extends HookPayload {
	hook_event_name: 'PreToolUse';
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id: string;
}

export interface PostToolUsePayload extends HookPayload {
	hook_event_name: 'PostToolUse';
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_response: Record<string, unknown>;
	tool_use_id: string;
}

export interface PostToolUseFailurePayload extends HookPayload {
	hook_event_name: 'PostToolUseFailure';
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_response: Record<string, unknown>;
	tool_use_id: string;
}

export interface UserPromptSubmitPayload extends HookPayload {
	hook_event_name: 'UserPromptSubmit';
	prompt: string;
}

export interface StopPayload extends HookPayload {
	hook_event_name: 'Stop';
	stop_hook_active: boolean;
	last_assistant_message: string;
}

export interface SessionStartPayload extends HookPayload {
	hook_event_name: 'SessionStart';
}

export interface SessionEndPayload extends HookPayload {
	hook_event_name: 'SessionEnd';
}

export interface SubagentStopPayload extends HookPayload {
	hook_event_name: 'SubagentStop';
}

export interface WorktreeCreatePayload extends HookPayload {
	hook_event_name: 'WorktreeCreate';
}

export interface WorktreeRemovePayload extends HookPayload {
	hook_event_name: 'WorktreeRemove';
}

export type AnyHookPayload =
	| PreToolUsePayload
	| PostToolUsePayload
	| PostToolUseFailurePayload
	| UserPromptSubmitPayload
	| StopPayload
	| SessionStartPayload
	| SessionEndPayload
	| SubagentStopPayload
	| WorktreeCreatePayload
	| WorktreeRemovePayload
	| HookPayload;
