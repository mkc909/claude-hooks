import { Context, Next } from 'hono';
import type { Env } from '../types';

/**
 * Timing-safe string comparison using HMAC to prevent timing attacks.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const aBytes = enc.encode(a);
	const bBytes = enc.encode(b);
	if (aBytes.length !== bBytes.length) return false;
	const aKey = await crypto.subtle.importKey('raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', aKey, bBytes);
	const bKey = await crypto.subtle.importKey('raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig2 = await crypto.subtle.sign('HMAC', bKey, aBytes);
	return new Uint8Array(sig).every((v, i) => v === new Uint8Array(sig2)[i]);
}

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
		const valid = await timingSafeEqual(token, c.env.HOOK_SECRET);
		if (!valid) {
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
		const valid = await timingSafeEqual(token, c.env.ADMIN_API_KEY);
		if (!valid) {
			return c.json({ error: 'Invalid API key' }, 403);
		}

		await next();
	};
}
