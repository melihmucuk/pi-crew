import { homedir } from "node:os";
import { basename, dirname } from "node:path";

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const SENSITIVE_KEY = /(?:secret|token|password|passphrase|api.?key|authorization|cookie|credential)/iu;

export function sanitizeInline(value: string): string {
	return value.replace(ANSI_ESCAPE, "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function safeUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return value;
		return `${url.origin}${url.pathname}`;
	} catch {
		return value;
	}
}

function shortenPath(value: string): string {
	const home = homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function redactSensitiveText(value: string): string {
	const sanitized = sanitizeInline(value)
		.replace(/\b(Bearer|Basic)\s+[^\s"']+/giu, "$1 ***")
		.replace(/(--?(?:api[-_]?key|token|password|passphrase|authorization|cookie|credential))(?:=|\s+)\S+/giu, "$1=***");
	return sanitized.replace(/https?:\/\/[^\s"']+/giu, (url) => safeUrl(url));
}

function firstScalar(value: unknown): string {
	if (typeof value === "string") return redactSensitiveText(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = firstScalar(item);
			if (target) return target;
		}
	}
	return "";
}

function bashSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let escaped = false;
	let quote: "'" | '"' | "`" | undefined;
	const push = () => {
		const value = sanitizeInline(current);
		if (value) segments.push(value);
		current = "";
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index] ?? "";
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			current += character;
			quote = character;
			continue;
		}
		if (character === ";" || character === "\n" || character === "\r") {
			push();
			continue;
		}
		if (character === "&" || character === "|") {
			const previous = command[index - 1];
			const next = command[index + 1];
			if (previous === ">" || previous === "<" || (character === "&" && next === ">")) {
				current += character;
				continue;
			}
			push();
			if (next === character) index++;
			continue;
		}
		current += character;
	}
	push();
	return segments;
}

function shellWords(segment: string): string[] {
	return (segment.match(/(?:[^\s"'\\]+|"(?:\\.|[^"\\])*"|'[^']*')+/gu) ?? [])
		.map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_match, double, single) => String(double ?? single ?? "")));
}

function safeCommandSummary(segment: string): string {
	const words = shellWords(segment);
	while (words[0] && /^[a-z_][a-z0-9_]*=/iu.test(words[0])) words.shift();
	const executable = sanitizeInline(words[0] ?? "");
	if (!executable) return "";
	const command = executable.split("/").at(-1)?.toLowerCase() ?? executable.toLowerCase();
	const arg = (index: number) => redactSensitiveText(words[index] ?? "");

	if (command === "cd" || command === "git") return arg(1) ? `${executable} ${arg(1)}` : executable;
	if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
		const verb = arg(1);
		if (!verb) return executable;
		if (["run", "exec", "x"].includes(verb) && arg(2) && !SENSITIVE_KEY.test(arg(2))) return `${executable} ${verb} ${arg(2)}`;
		return `${executable} ${verb}`;
	}
	if (command === "gh") return [executable, arg(1), arg(2)].filter(Boolean).join(" ");
	if (command === "curl" || command === "wget") {
		const url = words.find((word) => /^https?:\/\//iu.test(word));
		return url ? `${executable} ${safeUrl(url)}` : executable;
	}
	return executable;
}

function bashTarget(command: string): string {
	const segments = bashSegments(command);
	const first = safeCommandSummary(segments[0] ?? "");
	return segments.length > 1 ? `${first} · ${segments.length} steps` : first;
}

function sourceLineCount(value: string): number {
	if (value === "") return 0;
	const lines = value.split(/\r\n|[\r\n]/u);
	return lines.length - (/(?:\r\n|[\r\n])$/u.test(value) ? 1 : 0);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function resultText(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const content = Reflect.get(value, "content");
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && Reflect.get(item, "type") === "text")
		.map((item) => Reflect.get(item, "text"))
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

function requestSummary(name: string, args: Record<string, unknown>): string | undefined {
	const lower = name.toLowerCase();
	if (lower === "write" && typeof args.content === "string") return `${countLabel(sourceLineCount(args.content), "line")} written`;
	if (lower !== "edit" || !Array.isArray(args.edits)) return undefined;
	let added = 0;
	let removed = 0;
	let changes = 0;
	for (const edit of args.edits) {
		if (typeof edit !== "object" || edit === null) continue;
		const oldText = Reflect.get(edit, "oldText");
		const newText = Reflect.get(edit, "newText");
		if (typeof oldText !== "string" || typeof newText !== "string") continue;
		removed += sourceLineCount(oldText);
		added += sourceLineCount(newText);
		changes++;
	}
	return changes > 0 ? `+${added} −${removed} lines` : undefined;
}

export function summarizeToolResult(name: string, result: unknown): string | undefined {
	const lower = name.toLowerCase();
	if (lower !== "read" && lower !== "grep") return undefined;
	const lines = resultText(result)
		.split(/\r?\n/u)
		.filter((line) => !/^\[\d+ more lines/u.test(line.trim()));
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	if (lines.length === 0) return undefined;
	if (lower === "read") return countLabel(lines.length, "line");
	const matches = lines.filter((line) => /^.+:\d+:\s/u.test(line)).length;
	return matches > 0 ? countLabel(matches, "match", "matches") : undefined;
}

export function summarizeToolName(name: string, args: unknown): string {
	if (name.toLowerCase() !== "read" || typeof args !== "object" || args === null) return name;
	const value = (args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path;
	if (typeof value !== "string" || basename(value) !== "SKILL.md") return name;
	return "skill";
}

export function summarizeToolTarget(name: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	const entries = Object.entries(record);
	const lower = name.toLowerCase();
	if (lower === "bash") {
		const command = entries.find(([key]) => key.toLowerCase() === "command")?.[1];
		if (typeof command === "string") return bashTarget(command);
	}
	if (lower === "read") {
		const path = record.path ?? record.file_path;
		if (typeof path === "string") {
			const offset = Number(record.offset);
			const limit = Number(record.limit);
			const suffix = Number.isFinite(offset) && offset > 0
				? `:${offset}${Number.isFinite(limit) && limit > 0 ? `-${offset + limit - 1}` : ""}`
				: "";
			const target = shortenPath(redactSensitiveText(path));
			return summarizeToolName(name, args) === "skill" ? (basename(dirname(target)) || "SKILL.md") : `${target}${suffix}`;
		}
	}
	if (lower === "grep") {
		const pattern = typeof record.pattern === "string" ? redactSensitiveText(record.pattern) : "";
		const path = typeof record.path === "string" ? shortenPath(redactSensitiveText(record.path)) : ".";
		const glob = typeof record.glob === "string" ? ` (${redactSensitiveText(record.glob)})` : "";
		if (pattern) return `/${pattern}/ in ${path}${glob}`;
	}
	for (const preferred of ["path", "file", "filepath", "command", "query", "url", "pattern", "prompt", "brief"]) {
		const entry = entries.find(([key]) => key.toLowerCase().replace(/[_-]/gu, "") === preferred);
		if (entry && !SENSITIVE_KEY.test(entry[0])) {
			const target = firstScalar(entry[1]);
			if (target) return ["path", "file", "filepath"].includes(preferred) ? shortenPath(target) : target;
		}
	}
	for (const [key, value] of entries) {
		if (SENSITIVE_KEY.test(key)) continue;
		const target = firstScalar(value);
		if (target) return target;
	}
	return "";
}

export function summarizeToolRequest(name: string, args: unknown): string | undefined {
	return typeof args === "object" && args !== null ? requestSummary(name, args as Record<string, unknown>) : undefined;
}
