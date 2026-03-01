import type { Env, PolicyRow, PreToolUsePayload } from '../types';

const POLICY_CACHE_TTL = 300; // 5 minutes
const POLICY_CACHE_KEY = 'policies:active';

interface PolicyCondition {
	patterns?: string[];
	paths?: string[];
	threshold?: number;
	window_seconds?: number;
}

interface PolicyAction {
	reason?: string;
	notification_target?: string;
}

export interface PolicyDecision {
	allowed: boolean;
	decision: 'allow' | 'deny' | 'ask';
	reason?: string;
	policyId?: string;
	policyName?: string;
}

/**
 * Evaluate active policies against a PreToolUse event.
 * Returns the first matching policy decision, or allow if none match.
 */
export async function evaluatePolicies(
	env: Env,
	payload: PreToolUsePayload,
	tenantId?: string
): Promise<PolicyDecision> {
	const policies = await getActivePolicies(env, 'PreToolUse', tenantId);

	for (const policy of policies) {
		// Check tool_matcher regex
		if (policy.tool_matcher) {
			try {
				const regex = new RegExp(policy.tool_matcher);
				if (!regex.test(payload.tool_name)) continue;
			} catch {
				continue; // Invalid regex, skip
			}
		}

		// Evaluate condition
		const matches = evaluateCondition(policy, payload);
		if (matches) {
			const actionConfig = parseJson<PolicyAction>(policy.action_config);
			return {
				allowed: policy.action === 'allow',
				decision: policy.action as 'allow' | 'deny' | 'ask',
				reason: actionConfig?.reason || `Blocked by policy: ${policy.name}`,
				policyId: policy.id,
				policyName: policy.name,
			};
		}
	}

	return { allowed: true, decision: 'allow' };
}

/**
 * Get active policies, using KV cache with fallback to D1.
 */
async function getActivePolicies(
	env: Env,
	eventType: string,
	tenantId?: string
): Promise<PolicyRow[]> {
	const cacheKey = tenantId ? `${POLICY_CACHE_KEY}:${eventType}:${tenantId}` : `${POLICY_CACHE_KEY}:${eventType}`;

	// Try KV cache first
	try {
		const cached = await env.CACHE.get(cacheKey, 'json');
		if (cached) return cached as PolicyRow[];
	} catch {
		// Cache miss, fall through to D1
	}

	// Query D1
	let sql = 'SELECT * FROM policies WHERE event_type = ? AND is_active = 1';
	const params: (string | number)[] = [eventType];

	if (tenantId) {
		sql += ' AND (tenant_id IS NULL OR tenant_id = ?)';
		params.push(tenantId);
	} else {
		sql += ' AND tenant_id IS NULL';
	}

	sql += ' ORDER BY priority ASC';

	const { results } = await env.DB.prepare(sql).bind(...params).all<PolicyRow>();
	const policies = results || [];

	// Cache in KV
	try {
		await env.CACHE.put(cacheKey, JSON.stringify(policies), { expirationTtl: POLICY_CACHE_TTL });
	} catch {
		// Non-critical, continue
	}

	return policies;
}

/**
 * Evaluate a specific policy condition against the hook payload.
 */
function evaluateCondition(policy: PolicyRow, payload: PreToolUsePayload): boolean {
	const condition = parseJson<PolicyCondition>(policy.condition_config);
	if (!condition) return false;

	switch (policy.condition_type) {
		case 'block_pattern':
			return evaluateBlockPattern(condition, payload);
		case 'file_protection':
			return evaluateFileProtection(condition, payload);
		case 'secret_detection':
			return evaluateSecretDetection(payload);
		default:
			return false;
	}
}

function evaluateBlockPattern(condition: PolicyCondition, payload: PreToolUsePayload): boolean {
	if (!condition.patterns) return false;

	const command = getCommandString(payload);
	if (!command) return false;

	return condition.patterns.some(pattern => {
		try {
			const regex = new RegExp(pattern, 'i');
			return regex.test(command);
		} catch {
			return command.includes(pattern);
		}
	});
}

function evaluateFileProtection(condition: PolicyCondition, payload: PreToolUsePayload): boolean {
	if (!condition.paths) return false;

	const filePath = (payload.tool_input.file_path as string) || '';
	if (!filePath) return false;

	return condition.paths.some(pattern => {
		try {
			const regex = new RegExp(pattern);
			return regex.test(filePath);
		} catch {
			return filePath.includes(pattern);
		}
	});
}

function evaluateSecretDetection(payload: PreToolUsePayload): boolean {
	const content = (payload.tool_input.content as string) || (payload.tool_input.new_string as string) || '';
	if (!content) return false;

	const secretPatterns = [
		/(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/i,
		/(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
		/sk[-_](?:live|test)_[a-zA-Z0-9]{20,}/,
		/ghp_[a-zA-Z0-9]{36}/,
		/AKIA[0-9A-Z]{16}/,
	];

	return secretPatterns.some(pattern => pattern.test(content));
}

function getCommandString(payload: PreToolUsePayload): string | null {
	if (payload.tool_name === 'Bash') {
		return (payload.tool_input.command as string) || null;
	}
	return null;
}

function parseJson<T>(str: string | null | undefined): T | null {
	if (!str) return null;
	try {
		return JSON.parse(str) as T;
	} catch {
		return null;
	}
}
