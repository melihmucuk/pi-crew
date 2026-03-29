import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";

type ToolFactory = (
	cwd: string,
) => ReturnType<
	typeof createReadTool |
		typeof createBashTool |
		typeof createEditTool |
		typeof createWriteTool |
		typeof createGrepTool |
		typeof createFindTool |
		typeof createLsTool
>;

const TOOL_FACTORIES = {
	read: (cwd) => createReadTool(cwd),
	bash: (cwd) => createBashTool(cwd),
	edit: (cwd) => createEditTool(cwd),
	write: (cwd) => createWriteTool(cwd),
	grep: (cwd) => createGrepTool(cwd),
	find: (cwd) => createFindTool(cwd),
	ls: (cwd) => createLsTool(cwd),
} satisfies Record<string, ToolFactory>;

export type SupportedToolName = keyof typeof TOOL_FACTORIES;

export const SUPPORTED_TOOL_NAMES = Object.freeze(
	Object.keys(TOOL_FACTORIES) as SupportedToolName[],
);

export function isSupportedToolName(name: string): name is SupportedToolName {
	return name in TOOL_FACTORIES;
}

export function createSupportedTools(toolNames: readonly SupportedToolName[], cwd: string) {
	return toolNames.map((toolName) => TOOL_FACTORIES[toolName](cwd));
}
