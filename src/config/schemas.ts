/**
 * Zod validation schemas for policy condition configs and action configs.
 * Used to validate data at API boundaries (policy creation, action rule creation).
 */
import { PolicyConditions, ActionTypes } from './manifest';

// We use lightweight validation here (no Zod dependency) to keep bundle small.
// These validate the JSON config objects stored in D1.

export interface BlockPatternConfig {
	patterns: string[];
}

export interface FileProtectionConfig {
	paths: string[];
}

export interface SecretDetectionConfig {
	// Currently no config needed — uses built-in patterns
}

export interface RateLimitConfig {
	threshold: number;
	window_seconds: number;
}

export interface ScopeEnforcementConfig {
	allowed_paths: string[];
}

export interface NotifyDiscordConfig {
	webhook_url: string;
	message_template?: string;
}

export interface SyncOpsConfig {
	endpoint: string;
	node_type?: string;
}

export interface TrackEventConfig {
	event_name: string;
	site_id?: string;
}

export interface SendEmailConfig {
	template: string;
	to: string;
}

export interface WebhookConfig {
	url: string;
	headers?: Record<string, string>;
	body_template?: string;
}

// ---------------------------------------------------------------------------
// Config type maps — map condition/action type string -> config interface
// ---------------------------------------------------------------------------

export type PolicyConditionConfigMap = {
	[PolicyConditions.BLOCK_PATTERN]: BlockPatternConfig;
	[PolicyConditions.FILE_PROTECTION]: FileProtectionConfig;
	[PolicyConditions.SECRET_DETECTION]: SecretDetectionConfig;
	[PolicyConditions.RATE_LIMIT]: RateLimitConfig;
	[PolicyConditions.SCOPE_ENFORCEMENT]: ScopeEnforcementConfig;
};

export type ActionConfigMap = {
	[ActionTypes.NOTIFY_DISCORD]: NotifyDiscordConfig;
	[ActionTypes.SYNC_OPS]: SyncOpsConfig;
	[ActionTypes.TRACK_EVENT]: TrackEventConfig;
	[ActionTypes.SEND_EMAIL]: SendEmailConfig;
	[ActionTypes.WEBHOOK]: WebhookConfig;
};

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

export function validatePolicyConditionConfig(
	conditionType: string,
	config: unknown
): { valid: boolean; error?: string } {
	if (!config || typeof config !== 'object') {
		return { valid: false, error: 'Config must be a non-null object' };
	}

	const c = config as Record<string, unknown>;

	switch (conditionType) {
		case PolicyConditions.BLOCK_PATTERN:
			if (!Array.isArray(c.patterns) || c.patterns.length === 0) {
				return { valid: false, error: 'block_pattern requires non-empty patterns array' };
			}
			if (!c.patterns.every((p: unknown) => typeof p === 'string')) {
				return { valid: false, error: 'All patterns must be strings' };
			}
			return { valid: true };

		case PolicyConditions.FILE_PROTECTION:
			if (!Array.isArray(c.paths) || c.paths.length === 0) {
				return { valid: false, error: 'file_protection requires non-empty paths array' };
			}
			if (!c.paths.every((p: unknown) => typeof p === 'string')) {
				return { valid: false, error: 'All paths must be strings' };
			}
			return { valid: true };

		case PolicyConditions.SECRET_DETECTION:
			return { valid: true }; // No config needed

		case PolicyConditions.RATE_LIMIT:
			if (typeof c.threshold !== 'number' || c.threshold <= 0) {
				return { valid: false, error: 'rate_limit requires positive threshold number' };
			}
			if (typeof c.window_seconds !== 'number' || c.window_seconds <= 0) {
				return { valid: false, error: 'rate_limit requires positive window_seconds number' };
			}
			return { valid: true };

		case PolicyConditions.SCOPE_ENFORCEMENT:
			if (!Array.isArray(c.allowed_paths) || c.allowed_paths.length === 0) {
				return { valid: false, error: 'scope_enforcement requires non-empty allowed_paths array' };
			}
			return { valid: true };

		default:
			return { valid: false, error: `Unknown condition_type: ${conditionType}` };
	}
}

export function validateActionConfig(
	actionType: string,
	config: unknown
): { valid: boolean; error?: string } {
	if (!config || typeof config !== 'object') {
		return { valid: false, error: 'Config must be a non-null object' };
	}

	const c = config as Record<string, unknown>;

	switch (actionType) {
		case ActionTypes.NOTIFY_DISCORD:
			if (typeof c.webhook_url !== 'string' || !c.webhook_url) {
				return { valid: false, error: 'notify_discord requires webhook_url string' };
			}
			return { valid: true };

		case ActionTypes.SYNC_OPS:
			if (typeof c.endpoint !== 'string' || !c.endpoint) {
				return { valid: false, error: 'sync_ops requires endpoint string' };
			}
			return { valid: true };

		case ActionTypes.TRACK_EVENT:
			if (typeof c.event_name !== 'string' || !c.event_name) {
				return { valid: false, error: 'track_event requires event_name string' };
			}
			return { valid: true };

		case ActionTypes.SEND_EMAIL:
			if (typeof c.template !== 'string' || !c.template) {
				return { valid: false, error: 'send_email requires template string' };
			}
			if (typeof c.to !== 'string' || !c.to) {
				return { valid: false, error: 'send_email requires to string' };
			}
			return { valid: true };

		case ActionTypes.WEBHOOK:
			if (typeof c.url !== 'string' || !c.url) {
				return { valid: false, error: 'webhook requires url string' };
			}
			return { valid: true };

		default:
			return { valid: false, error: `Unknown action_type: ${actionType}` };
	}
}
