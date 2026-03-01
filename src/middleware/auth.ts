import { Context, Next } from 'hono';
import type { Env } from '../types';

/**
 * Hook receiver authentication.
 * Verifies the shared secret sent by Claude Code HTTP hooks.
 */
export function hookAuth() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const authHeader = c.req.header('Authorization');
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json({ error: 'Missing authorization' }, 401);
		}

		const token = authHeader.slice(7);
		if (token !== c.env.HOOK_SECRET) {
			return c.json({ error: 'Invalid hook secret' }, 403);
		}

		await next();
	};
}

/**
 * Admin API authentication.
 * Verifies Bearer token for admin dashboard and API access.
 */
export function adminAuth() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const authHeader = c.req.header('Authorization');
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json({ error: 'Missing authorization' }, 401);
		}

		const token = authHeader.slice(7);
		if (token !== c.env.ADMIN_API_KEY) {
			return c.json({ error: 'Invalid API key' }, 403);
		}

		await next();
	};
}
