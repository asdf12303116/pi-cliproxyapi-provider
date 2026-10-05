import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	computePatchedModuleCachePath,
	loadCliproxyCodexStreams,
	resolveCodexModuleFromNodeEntry,
	resolveOriginalCodexModulePath,
	wellKnownCodexModuleCandidates,
	writePatchedModuleCache,
} from "../extensions/codex-stream.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function writeFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

const CODEX_RELATIVE = join("node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js");

function failingResolveSpecifier(): string {
	throw Object.assign(new Error("Cannot find package '@earendil-works/pi-ai'"), { code: "ERR_MODULE_NOT_FOUND" });
}

function writeMachOLikeHost(root: string): string {
	const entryPath = join(root, "omp-darwin-arm64");
	writeFile(entryPath, "\x00Mach-O");
	return entryPath;
}

function writePartialJsonPackage(nodeModulesDir: string): string {
	const packageDir = join(nodeModulesDir, "partial-json");
	writeFile(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "partial-json",
			type: "module",
			exports: "./index.js",
		}),
	);
	writeFile(join(packageDir, "index.js"), `export function parse(text) {\n\treturn { ok: true, text };\n}\n`);
	return join(packageDir, "index.js");
}

function writeOmpPluginsCodexTree(home: string): { codexPath: string; jsonParsePath: string; partialJsonPath: string } {
	const pluginsNodeModules = join(home, ".omp", "plugins", "node_modules");
	const codexPath = join(home, ".omp", "plugins", CODEX_RELATIVE);
	const jsonParsePath = join(dirname(dirname(codexPath)), "utils", "json-parse.js");
	writeFile(
		codexPath,
		`import { parsePartial } from "../utils/json-parse.js";\nexport function streamSimple() {\n\treturn parsePartial('{"ok":');\n}\nexport function stream() {\n\treturn streamSimple();\n}\n`,
	);
	writeFile(
		jsonParsePath,
		`import { parse } from "partial-json";\nexport function parsePartial(text) {\n\treturn parse(text);\n}\n`,
	);
	const partialJsonPath = writePartialJsonPackage(pluginsNodeModules);
	return { codexPath, jsonParsePath, partialJsonPath };
}

describe("wellKnownCodexModuleCandidates", () => {
	it("lists HOME/.omp, HOME/.pi, and global package roots without host-specific paths", () => {
		const candidates = wellKnownCodexModuleCandidates("/home/user");
		expect(candidates).toEqual([
			join("/home/user", ".omp", "plugins", CODEX_RELATIVE),
			join("/home/user", ".omp", "plugins", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/home/user", ".pi", "agent", "npm", CODEX_RELATIVE),
			join(
				"/home/user",
				".pi",
				"agent",
				"npm",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".bun", "install", "global", CODEX_RELATIVE),
			join(
				"/home/user",
				".bun",
				"install",
				"global",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".npm-global", CODEX_RELATIVE),
			join("/home/user", ".npm-global", "lib", CODEX_RELATIVE),
			join("/home/user", ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/home/user", "Library", "pnpm", "global", "5", CODEX_RELATIVE),
			join(
				"/home/user",
				"Library",
				"pnpm",
				"global",
				"5",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".local", "share", "pnpm", "global", "5", CODEX_RELATIVE),
			join(
				"/home/user",
				".local",
				"share",
				"pnpm",
				"global",
				"5",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/usr", "local", "lib", CODEX_RELATIVE),
			join("/usr", "local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/opt", "homebrew", "lib", CODEX_RELATIVE),
			join("/opt", "homebrew", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
		]);
		expect(candidates.join("\n")).not.toMatch(/\/Users\/|\/home\/(?!user\b)|Ravi|tailscale/i);
	});
});

describe("resolveOriginalCodexModulePath", () => {
	it("still resolves the installed package when import.meta.resolve works", () => {
		const resolved = resolveOriginalCodexModulePath();
		expect(resolved.path).toMatch(/openai-codex-responses\.js$/);
		expect(existsSync(resolved.path)).toBe(true);
		expect(resolved.dir).toBe(dirname(resolved.path));
	});

	it("prefers host nodeEntry over import.meta.resolve candidate to keep module identity aligned with host", () => {
		const hostRoot = tempDir("pi-cpa-host-root-");
		const cliEntry = join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		const hostCodex = join(
			hostRoot,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		writeFile(cliEntry, "");
		writeFile(hostCodex, "");

		const otherDir = tempDir("pi-cpa-specifier-root-");
		const otherCodex = join(otherDir, "openai-codex-responses.js");
		writeFile(otherCodex, "");

		const resolved = resolveOriginalCodexModulePath({
			nodeEntry: cliEntry,
			resolveSpecifier: () => pathToFileURL(otherCodex).href,
		});

		expect(resolved.path).toBe(hostCodex);
	});

	it("prefers import.meta.resolve over a HOME/.omp candidate when nodeEntry is not a Node host", () => {
		const home = tempDir("pi-cpa-home-shadow-");
		writeOmpPluginsCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({ homeDirectory: home, nodeEntry: undefined });
		expect(resolved.path).not.toBe(join(home, ".omp", "plugins", CODEX_RELATIVE));
		expect(resolved.path).toMatch(/node_modules\/@earendil-works\/pi-ai\/dist\/api\/openai-codex-responses\.js$/);
	});

	it("resolves a HOME/.omp/plugins candidate when import.meta.resolve fails and argv is a Mach-O host", () => {
		const home = tempDir("pi-cpa-omp-home-");
		const hostDir = tempDir("pi-cpa-omp-host-");
		const { codexPath } = writeOmpPluginsCodexTree(home);
		const nodeEntry = writeMachOLikeHost(hostDir);

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry,
			homeDirectory: home,
		});

		expect(resolved.path).toBe(codexPath);
		expect(resolved.dir).toBe(dirname(codexPath));
	});

	it("resolves a nested HOME/.pi/agent/npm candidate for the bundled pi host", () => {
		const home = tempDir("pi-cpa-pi-home-");
		const hostDir = tempDir("pi-cpa-pi-host-");
		const nested = join(
			home,
			".pi",
			"agent",
			"npm",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_RELATIVE,
		);
		writeFile(nested, "export {}\n");

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: writeMachOLikeHost(hostDir),
			homeDirectory: home,
		});

		expect(resolved.path).toBe(nested);
	});

	it("resolves bundled host module through wrapper script importing target CLI entry", () => {
		const hostRoot = tempDir("pi-cpa-wrapper-root-");
		const targetCli = join(hostRoot, "bundle", "cli.js");
		const codexModule = join(
			hostRoot,
			"bundle",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		const wrapper = join(hostRoot, "bin", "pi");

		writeFile(targetCli, "export {}\n");
		writeFile(codexModule, "export {}\n");
		writeFile(
			wrapper,
			`import { join } from "node:path";\nconst cliPath = ${JSON.stringify(targetCli)};\nawait import(cliPath);\n`,
		);

		expect(resolveCodexModuleFromNodeEntry(wrapper)).toBe(codexModule);
	});
});

describe("writePatchedModuleCache", () => {
	it("rewrites a bare partial-json import so a tmpdir cache can load it", async () => {
		const home = tempDir("pi-cpa-bare-home-");
		const cacheDir = tempDir("pi-cpa-bare-cache-");
		const { codexPath, partialJsonPath } = writeOmpPluginsCodexTree(home);
		const cachePath = join(cacheDir, "patched-bare.mjs");

		writePatchedModuleCache(
			cachePath,
			`import { parse } from "partial-json";\nexport const parsed = parse("x");\n`,
			codexPath,
		);

		const rewritten = readFileSync(cachePath, "utf8");
		expect(rewritten).toContain(pathToFileURL(partialJsonPath).href);
		expect(rewritten).not.toContain('from "partial-json"');

		const loaded = (await import(pathToFileURL(cachePath).href)) as { parsed: { ok: boolean; text: string } };
		expect(loaded.parsed).toEqual({ ok: true, text: "x" });
	});

	it("resolves partial-json after locating openai-codex-responses via HOME/.omp and writing the cache outside that tree", async () => {
		const home = tempDir("pi-cpa-graph-home-");
		const hostDir = tempDir("pi-cpa-graph-host-");
		const cacheDir = tempDir("pi-cpa-graph-cache-");
		const { codexPath, jsonParsePath } = writeOmpPluginsCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: writeMachOLikeHost(hostDir),
			homeDirectory: home,
		});
		expect(resolved.path).toBe(codexPath);

		const cachePath = join(cacheDir, "openai-codex-responses-cpa-test.mjs");
		writePatchedModuleCache(cachePath, readFileSync(resolved.path, "utf8"), resolved.path);

		const entrySource = readFileSync(cachePath, "utf8");
		expect(entrySource).not.toContain('from "../utils/json-parse.js"');
		expect(entrySource).toContain(pathToFileURL(jsonParsePath).href);

		const loaded = (await import(pathToFileURL(cachePath).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loaded.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
	});

	it("preserves shared module identity so session-resources cleanup reaches patched streams", async () => {
		const home = tempDir("pi-cpa-shared-home-");
		const cacheDir = tempDir("pi-cpa-shared-cache-");
		const codexPath = join(home, ".omp", "plugins", CODEX_RELATIVE);
		const sessionResourcesPath = join(dirname(dirname(codexPath)), "session-resources.js");

		writeFile(
			sessionResourcesPath,
			`export const cleanups = new Set();
export function registerCleanup(fn) { cleanups.add(fn); }
export function runCleanups() { for (const fn of cleanups) fn(); }
`,
		);

		writeFile(
			codexPath,
			`import { registerCleanup } from "../session-resources.js";
export function registerHook(fn) { registerCleanup(fn); }
`,
		);

		const cachePath = join(cacheDir, "openai-codex-responses-cpa-test.mjs");
		writePatchedModuleCache(cachePath, readFileSync(codexPath, "utf8"), codexPath);

		// Host imports original module directly
		const hostModule = (await import(pathToFileURL(sessionResourcesPath).href)) as {
			cleanups: Set<() => void>;
			runCleanups: () => void;
		};

		// Patched cache module registers into session resources
		const patchedModule = (await import(pathToFileURL(cachePath).href)) as {
			registerHook: (fn: () => void) => void;
		};

		let cleanedUp = false;
		patchedModule.registerHook(() => {
			cleanedUp = true;
		});

		expect(hostModule.cleanups.size).toBe(1);
		hostModule.runCleanups();
		expect(cleanedUp).toBe(true);
	});

	it("isolates cache keys across different installation paths using production hashing", async () => {
		const homeA = tempDir("pi-cpa-inst-a-");
		const homeB = tempDir("pi-cpa-inst-b-");
		const { codexPath: codexPathA } = writeOmpPluginsCodexTree(homeA);
		const { codexPath: codexPathB } = writeOmpPluginsCodexTree(homeB);

		// Same content, different locations
		expect(readFileSync(codexPathA, "utf8")).toBe(readFileSync(codexPathB, "utf8"));

		const cacheDir = tempDir("pi-cpa-dual-cache-");
		const source = readFileSync(codexPathA, "utf8");

		const outPathA = computePatchedModuleCachePath(codexPathA, source, cacheDir);
		const outPathB = computePatchedModuleCachePath(codexPathB, source, cacheDir);

		// Cache paths must be different because originalPath is hashed
		expect(outPathA).not.toBe(outPathB);

		writePatchedModuleCache(outPathA, source, codexPathA);
		writePatchedModuleCache(outPathB, source, codexPathB);

		const sourceA = readFileSync(outPathA, "utf8");
		const sourceB = readFileSync(outPathB, "utf8");

		expect(sourceA).not.toBe(sourceB);
		expect(sourceA).toContain(homeA);
		expect(sourceB).toContain(homeB);

		// Removing install A does not affect install B
		rmSync(homeA, { recursive: true, force: true });
		const loadedB = (await import(pathToFileURL(outPathB).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loadedB.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
	});
});

describe("loadCliproxyCodexStreams", () => {
	it("still loads the patched module from the installed package graph", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("cliproxyapi-codex-responses");
	});
});
