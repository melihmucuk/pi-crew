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

const BASH_TARGET_LIMIT = 120;

function bashTarget(command: string): string {
	const lines = command.split(/\r\n|[\r\n]/u).map((line) => line.trim()).filter((line) => line !== "");
	const first = redactSensitiveText(lines[0] ?? "");
	if (!first) return "";
	const text = first.length > BASH_TARGET_LIMIT ? `${first.slice(0, BASH_TARGET_LIMIT - 1)}…` : first;
	return lines.length > 1 ? `${text} · ${lines.length} lines` : text;
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
