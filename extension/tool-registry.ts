const SUPPORTED_TOOL_NAMES_LITERAL = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

export type SupportedToolName = (typeof SUPPORTED_TOOL_NAMES_LITERAL)[number];

export const SUPPORTED_TOOL_NAMES = Object.freeze(
	[...SUPPORTED_TOOL_NAMES_LITERAL] as SupportedToolName[],
);

export function isSupportedToolName(name: string): name is SupportedToolName {
	return SUPPORTED_TOOL_NAMES.includes(name as SupportedToolName);
}
