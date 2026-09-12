import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { discoverAgents, type AgentConfig } from "./catalog.js";

const MAX_SUGGESTIONS = 20;
const MENTION_NAME_GRAMMAR = "[A-Za-z0-9-]";
const MENTION_TOKEN_PATTERN = new RegExp(
	`(?:^|[\\s([{'"\`])(@(?:crew:)?(${MENTION_NAME_GRAMMAR}*))$`,
	"u",
);
const MENTION_NAME_PATTERN = new RegExp(`^${MENTION_NAME_GRAMMAR}+$`);
const CREW_MENTION_PATTERN = new RegExp(
	`(^|[\\s([{'"\`])@crew:(${MENTION_NAME_GRAMMAR}+)(?=$|\\s|[)\\]},.!?;:'"\`]+(?:$|\\s))`,
	"gu",
);

type MentionToken = {
	prefix: string;
	query: string;
};

type UserContent = string | (TextContent | ImageContent)[];

function mentionToken(textBeforeCursor: string): MentionToken | undefined {
	const match = textBeforeCursor.match(MENTION_TOKEN_PATTERN);
	if (!match) return undefined;
	return { prefix: match[1] ?? "@", query: match[2] ?? "" };
}

function crewSuggestionItems(agents: AgentConfig[], query: string): AutocompleteItem[] {
	const mentionableAgents = agents.filter((agent) => MENTION_NAME_PATTERN.test(agent.name));
	const matches = query
		? fuzzyFilter(mentionableAgents, query, (agent) => agent.name)
		: mentionableAgents;
	return matches.slice(0, MAX_SUGGESTIONS).map((agent) => {
		const value = `@crew:${agent.name}`;
		return { value, label: value, description: agent.description };
	});
}

function applyCrewCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const before = currentLine.slice(0, cursorCol - prefix.length);
	const after = currentLine.slice(cursorCol);
	const separator = after === "" || /^\s/u.test(after) ? "" : " ";
	const nextLines = [...lines];
	nextLines[cursorLine] = before + item.value + separator + after;
	return {
		lines: nextLines,
		cursorLine,
		cursorCol: before.length + item.value.length + separator.length,
	};
}

export function createCrewMentionProvider(
	current: AutocompleteProvider,
	agents: () => AgentConfig[],
): AutocompleteProvider {
	const crewItems = new WeakSet<object>();
	const delegatedPrefixes = new WeakMap<object, string>();
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],

		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const token = mentionToken(line.slice(0, cursorCol));
			if (!token) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return null;
			const suggestions = crewSuggestionItems(agents(), token.query);
			for (const item of suggestions) crewItems.add(item);
			if (suggestions.length === 0) return native;
			if (native) {
				for (const item of native.items) delegatedPrefixes.set(item, native.prefix);
			}
			return {
				items: [...suggestions, ...(native?.items ?? [])],
				prefix: token.prefix,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return crewItems.has(item)
				? applyCrewCompletion(lines, cursorLine, cursorCol, item, prefix)
				: current.applyCompletion(
					lines,
					cursorLine,
					cursorCol,
					item,
					delegatedPrefixes.get(item) ?? prefix,
				);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function addCrewMentionAutocomplete(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.addAutocompleteProvider((current) =>
		createCrewMentionProvider(
			current,
			() => discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() }).agents,
		));
}

/** Expand explicit crew references only in the context copy sent to the model. */
export function expandCrewMentions(text: string): string | undefined {
	let changed = false;
	const expanded = text.replace(CREW_MENTION_PATTERN, (_match, boundary: string, name: string) => {
		changed = true;
		return `${boundary}<pi-crew subagent="${name}" />`;
	});
	return changed ? expanded : undefined;
}

function expandUserContent(content: UserContent): UserContent | undefined {
	if (typeof content === "string") return expandCrewMentions(content);

	let changed = false;
	const next = content.map((part) => {
		if (part.type !== "text") return part;
		const expanded = expandCrewMentions(part.text);
		if (expanded === undefined) return part;
		changed = true;
		return { ...part, text: expanded };
	});
	return changed ? next : undefined;
}

export function expandCrewMentionsInMessages(
	messages: AgentMessage[],
): { messages: AgentMessage[] } | undefined {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "user") return message;
		const expanded = expandUserContent(message.content);
		if (expanded === undefined) return message;
		changed = true;
		return { ...message, content: expanded };
	});
	return changed ? { messages: next } : undefined;
}
