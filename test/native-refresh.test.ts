import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import providerExtension, { COMPAT_SOURCE_ID, resetCompatCoordinator } from "../extensions/index.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
] as const;

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-native-refresh-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEnv = new Map(CLIPROXYAPI_ENV_NAMES.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of CLIPROXYAPI_ENV_NAMES) delete process.env[name];

	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		for (const [name, value] of previousEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function createPiMock() {
	let providerConfig: ProviderConfig | undefined;
	const pi = {
		registerCommand: vi.fn(),
		unregisterProvider: vi.fn(() => {
			providerConfig = undefined;
		}),
		registerProvider: vi.fn((_providerId: string, config: ProviderConfig) => {
			providerConfig = config;
		}),
		setModel: vi.fn(async () => true),
		on: vi.fn((_event: string, _handler: (event: unknown, ctx: ExtensionContext) => unknown) => undefined),
	} as unknown as ExtensionAPI;
	return { pi, getProviderConfig: () => providerConfig };
}

function catalogResponse(models: Array<Record<string, unknown>>): Response {
	return new Response(JSON.stringify({ models }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function createRefreshContext(allowNetwork: boolean): RefreshModelsContext {
	const controller = new AbortController();
	return {
		allowNetwork,
		...(allowNetwork ? { force: true } : {}),
		signal: controller.signal,
		publish: async ({ update }) => {
			if (controller.signal.aborted) return false;
			update?.();
			return true;
		},
	};
}

describe("native refreshModels seam (upstream PR #22)", () => {
	afterEach(() => {
		resetCompatCoordinator();
		unregisterApiProviders(COMPAT_SOURCE_ID);
	});

	it("exposes refreshModels and replays the cached catalog without network access", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "key" }),
				"utf8",
			);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return catalogResponse([
					{ slug: "native-cached", display_name: "Native Cached", context_window: 64_000, max_tokens: 4096 },
				]);
			});

			try {
				const { pi, getProviderConfig } = createPiMock();
				await providerExtension(pi);
				const config = getProviderConfig();
				expect(typeof config?.refreshModels).toBe("function");

				const context = createRefreshContext(false);
				const models = await config?.refreshModels?.(context);

				expect(models?.map((model) => model.id)).toEqual(["native-cached"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("replaces the catalog through the native callback when network access is allowed", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "key" }),
				"utf8",
			);
			let remoteModels = [{ slug: "native-first", display_name: "Native First", context_window: 32_000 }];
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return catalogResponse(remoteModels);
			});

			try {
				const { pi, getProviderConfig } = createPiMock();
				await providerExtension(pi);

				remoteModels = [{ slug: "native-second", display_name: "Native Second", context_window: 128_000 }];
				const context = createRefreshContext(true);
				const models = await getProviderConfig()?.refreshModels?.(context);

				// The returned list is what Pi's model registry publishes for the provider.
				// Fresh models come first; previously cached models the proxy stopped
				// advertising are retained (marked stale) within the retention window.
				expect(models?.map((model) => model.id)).toEqual(["native-second", "native-first"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});
