import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface PackageJson {
	files?: string[];
	peerDependencies?: Record<string, string>;
	pi?: {
		extensions?: string[];
		skills?: string[];
		prompts?: string[];
	};
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as PackageJson;

function normalizePackagePath(packagePath: string): string {
	return packagePath.replace(/^\.\//, "").replace(/\/$/, "");
}

function assertPackagePathExists(packagePath: string): void {
	const normalized = normalizePackagePath(packagePath);
	assert.equal(
		existsSync(join(repoRoot, normalized)),
		true,
		`${packagePath} must exist`,
	);
}

function assertCoveredByNpmFiles(packagePath: string): void {
	const normalizedPath = normalizePackagePath(packagePath);
	const files = packageJson.files ?? [];
	assert.equal(
		files.some((entry) => {
			const normalizedEntry = normalizePackagePath(entry);
			return normalizedPath === normalizedEntry || normalizedPath.startsWith(`${normalizedEntry}/`);
		}),
		true,
		`${packagePath} must be covered by package.json files`,
	);
}

describe("package metadata", () => {
	it("ships bundled resources in the npm package", () => {
		assert.deepEqual(packageJson.files, [
			"extension/",
			"agents/",
			"skills/",
			"prompts/",
		]);

		for (const packagePath of packageJson.files ?? []) {
			assertPackagePathExists(packagePath);
		}
	});

	it("requires the Pi 0.82.1 API version", () => {
		for (const packageName of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			assert.equal(packageJson.peerDependencies?.[packageName], ">=0.82.1");
		}
	});

	it("keeps pi-registered resources present and shipped", () => {
		const manifestResources = [
			...(packageJson.pi?.extensions ?? []),
			...(packageJson.pi?.skills ?? []),
			...(packageJson.pi?.prompts ?? []),
		];

		assert.deepEqual(packageJson.pi?.extensions, ["./extension/index.ts"]);
		assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
		assert.deepEqual(packageJson.pi?.prompts, ["./prompts"]);

		for (const packagePath of manifestResources) {
			assertPackagePathExists(packagePath);
			assertCoveredByNpmFiles(packagePath);
		}
	});
});
