export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

export function formatCost(cost: number): string {
	if (cost === 0 || cost >= 0.01) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(4)}`;
}

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

/** Splits a `provider/model-id` reference; undefined when either part is empty after trimming. */
export function parseModelId(model: string | undefined): { provider: string; modelId: string } | undefined {
	if (!model) return undefined;
	const separator = model.indexOf("/");
	if (separator < 0) return undefined;
	const provider = model.slice(0, separator).trim();
	const modelId = model.slice(separator + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/**
 * Display label for a model reference: `[provider] name`. The catalog name comes from the resolved
 * `Model`; without it the last path segment of the id is used, because ids are often deep provider
 * paths (`fireworks/accounts/fireworks/models/glm-5p3-flash`). Returns undefined for a missing
 * model so each surface can pick its own fallback text.
 */
export function formatModelLabel(model: string | undefined, name?: string): string | undefined {
	if (!model) return undefined;
	const parsed = parseModelId(model);
	const label = name?.trim() || (parsed ? parsed.modelId.split("/").filter(Boolean).at(-1) : undefined);
	if (!parsed) return label ?? model;
	return label ? `[${parsed.provider}] ${label}` : model;
}
