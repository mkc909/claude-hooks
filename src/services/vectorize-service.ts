import type { Env } from '../types';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const RAG_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

export interface VectorSearchResult {
	id: string;
	score: number;
	metadata: Record<string, string>;
}

/**
 * Generate embeddings for text using Workers AI.
 * Uses bge-base-en-v1.5 which produces 768-dimensional vectors.
 */
export async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
	const result = await ai.run(EMBEDDING_MODEL as Parameters<typeof ai.run>[0], {
		text: [text],
	}) as { data: number[][] };

	if (!result?.data?.[0]) {
		throw new Error('Failed to generate embedding: no data returned');
	}

	return result.data[0];
}

/**
 * Upsert a vector with metadata into Vectorize.
 */
export async function upsertVector(
	env: Env,
	id: string,
	text: string,
	metadata: Record<string, string>
): Promise<void> {
	const values = await generateEmbedding(env.AI, text);

	await env.VECTORS.upsert([
		{
			id,
			values,
			metadata,
		},
	]);
}

/**
 * Search for similar vectors using semantic similarity.
 */
export async function searchVectors(
	env: Env,
	query: string,
	options?: { limit?: number; filter?: Record<string, string> }
): Promise<VectorSearchResult[]> {
	const queryVector = await generateEmbedding(env.AI, query);
	const topK = options?.limit ?? 10;

	const queryOptions: VectorizeQueryOptions = {
		topK,
		returnMetadata: 'all',
	};

	if (options?.filter) {
		queryOptions.filter = options.filter as VectorizeVectorMetadataFilter;
	}

	const response = await env.VECTORS.query(queryVector, queryOptions);

	return (response.matches || []).map((match) => ({
		id: match.id,
		score: match.score,
		metadata: (match.metadata as Record<string, string>) || {},
	}));
}

/**
 * RAG: Search for relevant context then generate an AI answer.
 */
export async function askWithRAG(
	env: Env,
	question: string,
	filter?: Record<string, string>
): Promise<{ answer: string; sources: VectorSearchResult[] }> {
	// Step 1: Search for relevant context
	const sources = await searchVectors(env, question, {
		limit: 5,
		filter,
	});

	// Step 2: Build context from search results
	const contextParts = sources.map((source, index) => {
		const { project, status, type } = source.metadata;
		return `[${index + 1}] ${type || 'record'} — project: ${project || 'unknown'}, status: ${status || 'unknown'}\nSource ID: ${source.id}\nRelevance: ${(source.score * 100).toFixed(1)}%`;
	});

	const context = contextParts.length > 0
		? contextParts.join('\n\n')
		: 'No relevant context found.';

	// Step 3: Generate answer using RAG model
	const prompt = `You are an assistant that answers questions about software project progress and development activity based on telemetry data from Claude Code sessions.

Context from project status records:
${context}

Question: ${question}

Based on the context provided, give a concise and accurate answer. If the context doesn't contain enough information to answer the question, say so clearly.`;

	const ragResult = await env.AI.run(RAG_MODEL as Parameters<typeof env.AI.run>[0], {
		messages: [
			{
				role: 'user',
				content: prompt,
			},
		],
	}) as { response?: string };

	const answer = ragResult?.response || 'Unable to generate an answer based on the available context.';

	return { answer, sources };
}
