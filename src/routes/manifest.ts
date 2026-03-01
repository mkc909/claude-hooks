import { Hono } from 'hono';
import type { Env } from '../types';
import { HookEvents, Tools, PolicyConditions, PolicyActions, ActionTypes, ProjectStatuses, DeployStatuses, BLOCKING_EVENTS } from '../config/manifest';
import { HOOK_ROUTES } from '../config/route-registry';

export const manifestRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/manifest — returns the full system manifest for UI discovery.
 * The UI uses this to populate dropdowns, validate forms, and display metadata.
 */
manifestRoutes.get('/', (c) => {
	return c.json({
		version: '1.0.0',
		events: Object.entries(HookEvents).map(([key, value]) => ({
			key,
			value,
			blocking: BLOCKING_EVENTS.has(value),
		})),
		tools: Object.entries(Tools).map(([key, value]) => ({
			key,
			value,
		})),
		policyConditions: Object.entries(PolicyConditions).map(([key, value]) => ({
			key,
			value,
			description: getConditionDescription(value),
		})),
		policyActions: Object.entries(PolicyActions).map(([key, value]) => ({
			key,
			value,
		})),
		actionTypes: Object.entries(ActionTypes).map(([key, value]) => ({
			key,
			value,
			description: getActionTypeDescription(value),
		})),
		projectStatuses: Object.values(ProjectStatuses),
		deployStatuses: Object.values(DeployStatuses),
		routes: HOOK_ROUTES.map(r => ({
			path: `/hooks/${r.path}`,
			event: r.event,
			blocking: r.blocking,
		})),
	});
});

function getConditionDescription(type: string): string {
	switch (type) {
		case PolicyConditions.BLOCK_PATTERN: return 'Block commands matching regex patterns';
		case PolicyConditions.FILE_PROTECTION: return 'Protect files/directories from modification';
		case PolicyConditions.SECRET_DETECTION: return 'Detect secrets in file write content';
		case PolicyConditions.RATE_LIMIT: return 'Limit tool calls per time window';
		case PolicyConditions.SCOPE_ENFORCEMENT: return 'Restrict file access to allowed paths';
		default: return '';
	}
}

function getActionTypeDescription(type: string): string {
	switch (type) {
		case ActionTypes.NOTIFY_DISCORD: return 'Send notification to Discord webhook';
		case ActionTypes.SYNC_OPS: return 'Sync event data to ops-os knowledge graph';
		case ActionTypes.TRACK_EVENT: return 'Track event in analytics dashboard';
		case ActionTypes.SEND_EMAIL: return 'Send email via email-service';
		case ActionTypes.WEBHOOK: return 'POST to arbitrary webhook URL';
		default: return '';
	}
}
