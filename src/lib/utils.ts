/**
 * Generate a prefixed unique ID
 */
export function generateId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Extract project name from a working directory path.
 * e.g., "C:\Dev\MKC909_GITHUB_REPOS\cloudclaw-core" -> "cloudclaw-core"
 * e.g., "/home/user/projects/my-app" -> "my-app"
 */
export function extractProjectName(cwd: string | undefined): string | null {
	if (!cwd) return null;
	// Normalize path separators
	const normalized = cwd.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(Boolean);
	return parts[parts.length - 1] || null;
}

/**
 * Generate a device fingerprint from hostname
 */
export async function generateDeviceId(hostname: string | undefined): Promise<string | null> {
	if (!hostname) return null;
	const encoder = new TextEncoder();
	const data = encoder.encode(hostname);
	const hash = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hash));
	return `dev_${hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Truncate a string to a maximum length for privacy/storage
 */
export function truncate(str: string | undefined | null, maxLength: number): string | null {
	if (!str) return null;
	if (str.length <= maxLength) return str;
	return str.slice(0, maxLength) + '...';
}

/**
 * Safely JSON stringify, returning null on error
 */
export function safeStringify(obj: unknown, maxLength = 2000): string | null {
	try {
		const str = JSON.stringify(obj);
		return truncate(str, maxLength);
	} catch {
		return null;
	}
}

/**
 * Extract file_path from tool input based on tool name
 */
export function extractFilePath(toolName: string, toolInput: Record<string, unknown>): string | null {
	switch (toolName) {
		case 'Read':
		case 'Write':
		case 'Edit':
			return (toolInput.file_path as string) || null;
		case 'Glob':
			return (toolInput.path as string) || null;
		case 'Grep':
			return (toolInput.path as string) || null;
		default:
			return null;
	}
}

/**
 * Summarize tool input for storage (avoid storing large content)
 */
export function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string | null {
	switch (toolName) {
		case 'Bash':
			return truncate(toolInput.command as string, 500);
		case 'Read':
			return `Read ${toolInput.file_path}`;
		case 'Write':
			return `Write ${toolInput.file_path} (${((toolInput.content as string) || '').length} chars)`;
		case 'Edit':
			return `Edit ${toolInput.file_path}`;
		case 'Glob':
			return `Glob ${toolInput.pattern} in ${toolInput.path || 'cwd'}`;
		case 'Grep':
			return `Grep "${toolInput.pattern}" in ${toolInput.path || 'cwd'}`;
		case 'WebFetch':
			return `Fetch ${toolInput.url}`;
		case 'WebSearch':
			return `Search "${toolInput.query}"`;
		case 'Task':
			return truncate(`Task: ${toolInput.description || toolInput.prompt}`, 500);
		default:
			return truncate(safeStringify(toolInput), 500);
	}
}
