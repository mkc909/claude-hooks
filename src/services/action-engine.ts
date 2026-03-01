import type { Env, ActionRuleRow } from '../types';
import { generateId } from '../lib/utils';

// Cache TTL for action rules (5 minutes)
const RULES_CACHE_TTL = 300;
const RULES_CACHE_KEY = 'action_rules:active';

export interface ActionEvent {
	session_id: string;
	event_type: string; // PostToolUse, SessionEnd, Stop, etc.
	tool_name?: string;
	input_summary?: string;
	file_path?: string;
	success?: boolean;
}

interface TriggerCondition {
	tool_name?: string;
	input_contains?: string;
	file_path_contains?: string;
	success?: boolean;
}

interface NotifyDiscordConfig {
	webhook_url: string;
	message_template?: string;
}

interface SyncOpsConfig {
	endpoint: string;
	node_type?: string;
}

interface TrackEventConfig {
	event_name: string;
	site_id?: string;
}

interface SendEmailConfig {
	template: string;
	to: string;
}

interface WebhookConfig {
	url: string;
	headers?: Record<string, string>;
	body_template?: string;
}

type ActionConfig = NotifyDiscordConfig | SyncOpsConfig | TrackEventConfig | SendEmailConfig | WebhookConfig;

/**
 * Evaluate active action rules against a hook event.
 * Triggers configured actions for any matching rules not in cooldown.
 */
export async function evaluateActionRules(env: Env, event: ActionEvent): Promise<void> {
	const rules = await getActiveRules(env, event.event_type);

	for (const rule of rules) {
		try {
			// Evaluate trigger condition
			const condition = parseJson<TriggerCondition>(rule.trigger_condition);
			if (!matchesCondition(condition, event)) continue;

			// Check cooldown
			if (rule.cooldown_seconds > 0) {
				const inCooldown = await checkCooldown(env, rule.id, rule.cooldown_seconds);
				if (inCooldown) continue;
			}

			// Execute action
			const logId = generateId('al');
			const result = await executeAction(env, rule, event);

			// Log result
			await logAction(env, {
				id: logId,
				rule,
				event,
				result,
			});
		} catch (err) {
			console.error(`[action-engine] Error processing rule ${rule.id}:`, err);
		}
	}
}

/**
 * Get active action rules for a given event type, using KV cache.
 */
async function getActiveRules(env: Env, eventType: string): Promise<ActionRuleRow[]> {
	const cacheKey = `${RULES_CACHE_KEY}:${eventType}`;

	try {
		const cached = await env.CACHE.get(cacheKey, 'json');
		if (cached) return cached as ActionRuleRow[];
	} catch {
		// Cache miss, fall through to D1
	}

	const { results } = await env.DB.prepare(
		'SELECT * FROM action_rules WHERE trigger_event = ? AND is_active = 1 ORDER BY created_at ASC'
	).bind(eventType).all<ActionRuleRow>();

	const rules = results || [];

	try {
		await env.CACHE.put(cacheKey, JSON.stringify(rules), { expirationTtl: RULES_CACHE_TTL });
	} catch {
		// Non-critical
	}

	return rules;
}

/**
 * Check if a rule is currently in its cooldown period.
 */
async function checkCooldown(env: Env, ruleId: string, cooldownSeconds: number): Promise<boolean> {
	const cutoff = new Date(Date.now() - cooldownSeconds * 1000).toISOString();
	const last = await env.DB.prepare(
		"SELECT id FROM action_log WHERE action_config LIKE ? AND result = 'success' AND created_at >= ?"
	).bind(`%${ruleId}%`, cutoff).first<{ id: string }>();

	return last !== null;
}

/**
 * Check if an event matches a trigger condition.
 * An empty condition object {} matches everything.
 */
function matchesCondition(condition: TriggerCondition | null, event: ActionEvent): boolean {
	if (!condition || Object.keys(condition).length === 0) return true;

	if (condition.tool_name !== undefined && event.tool_name !== condition.tool_name) {
		return false;
	}

	if (condition.input_contains !== undefined) {
		const summary = event.input_summary || '';
		if (!summary.toLowerCase().includes(condition.input_contains.toLowerCase())) {
			return false;
		}
	}

	if (condition.file_path_contains !== undefined) {
		const fp = event.file_path || '';
		if (!fp.toLowerCase().includes(condition.file_path_contains.toLowerCase())) {
			return false;
		}
	}

	if (condition.success !== undefined && event.success !== condition.success) {
		return false;
	}

	return true;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

interface ExecutionResult {
	status: 'success' | 'error';
	detail?: string;
}

async function executeAction(env: Env, rule: ActionRuleRow, event: ActionEvent): Promise<ExecutionResult> {
	const config = parseJson<ActionConfig>(rule.action_config);
	if (!config) {
		return { status: 'error', detail: 'Invalid action_config JSON' };
	}

	switch (rule.action_type) {
		case 'notify_discord':
			return executeNotifyDiscord(config as NotifyDiscordConfig, event);
		case 'sync_ops':
			return executeSyncOps(env, config as SyncOpsConfig, event);
		case 'track_event':
			return executeTrackEvent(env, config as TrackEventConfig, event);
		case 'send_email':
			return executeSendEmail(env, config as SendEmailConfig, event);
		case 'webhook':
			return executeWebhook(config as WebhookConfig, event);
		default:
			return { status: 'error', detail: `Unknown action_type: ${rule.action_type}` };
	}
}

/**
 * Render a template string with event variable substitution.
 */
function renderTemplate(template: string, event: ActionEvent): string {
	return template
		.replace(/\{\{session_id\}\}/g, event.session_id)
		.replace(/\{\{event_type\}\}/g, event.event_type)
		.replace(/\{\{tool_name\}\}/g, event.tool_name || '')
		.replace(/\{\{input_summary\}\}/g, event.input_summary || '')
		.replace(/\{\{file_path\}\}/g, event.file_path || '');
}

async function executeNotifyDiscord(config: NotifyDiscordConfig, event: ActionEvent): Promise<ExecutionResult> {
	if (!config.webhook_url) {
		return { status: 'error', detail: 'Missing webhook_url' };
	}

	const message = config.message_template
		? renderTemplate(config.message_template, event)
		: `[claude-hooks] ${event.event_type} — session ${event.session_id}${event.tool_name ? ` — tool: ${event.tool_name}` : ''}${event.input_summary ? `\n\`${event.input_summary}\`` : ''}`;

	try {
		const res = await fetch(config.webhook_url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: message }),
		});

		if (!res.ok) {
			return { status: 'error', detail: `Discord responded with ${res.status}` };
		}
		return { status: 'success' };
	} catch (err) {
		return { status: 'error', detail: String(err) };
	}
}

async function executeSyncOps(env: Env, config: SyncOpsConfig, event: ActionEvent): Promise<ExecutionResult> {
	if (!config.endpoint) {
		return { status: 'error', detail: 'Missing endpoint' };
	}

	try {
		const body = JSON.stringify({
			node_type: config.node_type || 'session',
			session_id: event.session_id,
			event_type: event.event_type,
			tool_name: event.tool_name,
			input_summary: event.input_summary,
			file_path: event.file_path,
			success: event.success,
			timestamp: new Date().toISOString(),
		});

		const res = await env.OPS_OS.fetch(`https://ops-os.internal${config.endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});

		if (!res.ok) {
			return { status: 'error', detail: `OPS_OS responded with ${res.status}` };
		}
		return { status: 'success' };
	} catch (err) {
		return { status: 'error', detail: String(err) };
	}
}

async function executeTrackEvent(env: Env, config: TrackEventConfig, event: ActionEvent): Promise<ExecutionResult> {
	if (!config.event_name) {
		return { status: 'error', detail: 'Missing event_name' };
	}

	try {
		const body = JSON.stringify({
			event: config.event_name,
			site_id: config.site_id || 'claude-hooks',
			session_id: event.session_id,
			properties: {
				event_type: event.event_type,
				tool_name: event.tool_name,
				success: event.success,
			},
			timestamp: new Date().toISOString(),
		});

		const res = await env.ANALYTICS_DASHBOARD.fetch('https://analytics-dashboard.internal/api/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});

		if (!res.ok) {
			return { status: 'error', detail: `ANALYTICS_DASHBOARD responded with ${res.status}` };
		}
		return { status: 'success' };
	} catch (err) {
		return { status: 'error', detail: String(err) };
	}
}

async function executeSendEmail(env: Env, config: SendEmailConfig, event: ActionEvent): Promise<ExecutionResult> {
	if (!config.template || !config.to) {
		return { status: 'error', detail: 'Missing template or to' };
	}

	try {
		const body = JSON.stringify({
			template: config.template,
			to: config.to,
			data: {
				session_id: event.session_id,
				event_type: event.event_type,
				tool_name: event.tool_name,
				input_summary: event.input_summary,
				timestamp: new Date().toISOString(),
			},
		});

		const res = await env.EMAIL_SERVICE.fetch('https://email-service.internal/api/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});

		if (!res.ok) {
			return { status: 'error', detail: `EMAIL_SERVICE responded with ${res.status}` };
		}
		return { status: 'success' };
	} catch (err) {
		return { status: 'error', detail: String(err) };
	}
}

async function executeWebhook(config: WebhookConfig, event: ActionEvent): Promise<ExecutionResult> {
	if (!config.url) {
		return { status: 'error', detail: 'Missing url' };
	}

	const bodyStr = config.body_template
		? renderTemplate(config.body_template, event)
		: JSON.stringify({
				session_id: event.session_id,
				event_type: event.event_type,
				tool_name: event.tool_name,
				input_summary: event.input_summary,
				file_path: event.file_path,
				success: event.success,
				timestamp: new Date().toISOString(),
			});

	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(config.headers || {}),
		};

		const res = await fetch(config.url, {
			method: 'POST',
			headers,
			body: bodyStr,
		});

		if (!res.ok) {
			return { status: 'error', detail: `Webhook responded with ${res.status}` };
		}
		return { status: 'success' };
	} catch (err) {
		return { status: 'error', detail: String(err) };
	}
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

interface LogActionArgs {
	id: string;
	rule: ActionRuleRow;
	event: ActionEvent;
	result: ExecutionResult;
}

async function logAction(env: Env, { id, rule, event, result }: LogActionArgs): Promise<void> {
	// Include rule.id in action_config field so cooldown check can find it
	const loggedConfig = JSON.stringify({ rule_id: rule.id, ...parseJson<ActionConfig>(rule.action_config) });

	await env.DB.prepare(`
		INSERT INTO action_log (id, trigger_event, trigger_session_id, action_type, action_target, action_config, result, result_detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		id,
		event.event_type,
		event.session_id,
		rule.action_type,
		rule.name,
		loggedConfig,
		result.status,
		result.detail || null
	).run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(str: string | null | undefined): T | null {
	if (!str) return null;
	try {
		return JSON.parse(str) as T;
	} catch {
		return null;
	}
}

/**
 * Invalidate the KV cache for a given trigger_event type.
 * Call this whenever an action rule is created, updated, or deactivated.
 */
export async function invalidateRulesCache(env: Env, triggerEvent: string): Promise<void> {
	try {
		await env.CACHE.delete(`${RULES_CACHE_KEY}:${triggerEvent}`);
	} catch {
		// Non-critical
	}
}
