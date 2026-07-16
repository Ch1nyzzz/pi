import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvoCommandExtension, type EvoCliIO, type EvoCommandDiscoveryService, runEvoCli } from "../src/cli.ts";
import type { EvoCapabilityGrant } from "../src/components/capabilities/broker.ts";
import {
	canonicalEvoPackRegistryEntryMetadata,
	type EvoPackRegistryEntry,
	type EvoRawFileSource,
} from "../src/discovery/registry.ts";
import type {
	EvoPackRegistryInspection,
	EvoPackRegistryInstallOptions,
	EvoPackRegistryInstallResult,
} from "../src/discovery/service.ts";
import type { EvoDiscoveryFetch } from "../src/discovery/transport.ts";
import type { EvoPackImportResult } from "../src/pack/import.ts";
import { type EvoPackManifest, parseEvoPackManifest } from "../src/pack/pack.ts";
import { getEvoPaths } from "../src/paths.ts";
import type { ModelRunner } from "../src/reflect/model-runner.ts";
import { EvoService } from "../src/service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function runner(): ModelRunner {
	return {
		async run() {
			throw new Error("discovery CLI test must not call the model");
		},
	};
}

function io(interactive = false): EvoCliIO & { output: string[] } {
	const output: string[] = [];
	return {
		interactive,
		output,
		write: (message) => output.push(message),
		writeError: (message) => output.push(message),
		question: async () => "yes",
	};
}

function registryInstallFixture(manifest: EvoPackManifest): {
	inspection: EvoPackRegistryInspection;
	imported: EvoPackImportResult;
	result: EvoPackRegistryInstallResult;
} {
	const registrySource: EvoRawFileSource = {
		kind: "https",
		rawUrl: "https://registry.example/index.json",
	};
	const packSource: EvoRawFileSource = {
		kind: "https",
		rawUrl: `https://packs.example/${manifest.name}/pack.json`,
	};
	const entry: EvoPackRegistryEntry = {
		name: manifest.name,
		version: manifest.version,
		integrity: manifest.integrity as string,
		source: packSource,
	};
	const trust = { status: "trusted" as const, trusted: true as const, signer: "alice" };
	const imported: EvoPackImportResult = {
		manifest,
		proposal: undefined,
		addedSkillPaths: [],
		addedPromptPaths: [],
		addedMemoryPreferences: 0,
		skippedCode: manifest.contents.components.length + manifest.contents.workflows.length,
		importedComponents: [],
		unregisteredAbis: [],
		pendingWorkflows: 0,
		unknownAbiRequests: [],
	};
	return {
		inspection: { registrySource, packSource, entry, trust, manifest },
		imported,
		result: { registrySource, packSource, trust, fileCount: 3, totalBytes: 900, imported },
	};
}

describe("discovery CLI", () => {
	it("loads the strict overridden config and injected fetch for registry search", async () => {
		const root = await temporary("evo-discovery-cli-search-");
		const configPath = join(root, "discovery.json");
		const registrySource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://registry.example/index.json",
		};
		const packSource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://packs.example/focused/pack.json",
		};
		const manifest = parseEvoPackManifest({
			packFormat: 1,
			name: "focused-pack",
			version: "1.0.0",
			description: "A focused pack",
			contents: {},
			requiresAbis: [],
			requiresCapabilities: [],
			integrity: `sha256:${"1".repeat(64)}`,
		});
		const keyPair = generateKeyPairSync("ed25519");
		const unsignedEntry: EvoPackRegistryEntry = {
			name: manifest.name,
			version: manifest.version,
			integrity: manifest.integrity as string,
			description: "A focused pack",
			source: packSource,
		};
		const signature = signPayload(
			null,
			Buffer.from(
				canonicalEvoPackRegistryEntryMetadata(unsignedEntry, { algorithm: "ed25519", signer: "alice" }),
				"utf8",
			),
			keyPair.privateKey,
		);
		const entry: EvoPackRegistryEntry = {
			...unsignedEntry,
			signature: { algorithm: "ed25519", signer: "alice", value: `base64:${signature.toString("base64")}` },
		};
		await writeFile(
			configPath,
			`${JSON.stringify({
				schemaVersion: 1,
				registrySources: [registrySource],
				trustedSigners: [
					{
						id: "alice",
						publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
					},
				],
			})}\n`,
		);
		const files = new Map<string, string>([
			[registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [entry] })],
			[packSource.rawUrl, JSON.stringify(manifest)],
		]);
		const fetchImpl = vi.fn<EvoDiscoveryFetch>(async (url) => {
			const body = files.get(url);
			return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
		});
		const output = io();

		await runEvoCli(["search", "focused"], {
			paths: getEvoPaths(join(root, "evo")),
			runner: runner(),
			discovery: { configPath, fetch: fetchImpl },
			io: output,
		});

		expect(output.output.join("\n")).toContain("Pack: focused-pack@1.0.0");
		expect(output.output.join("\n")).toContain("Trust: trusted (alice)");
		expect(output.output.join("\n")).toContain("Required capabilities: none");
		expect(fetchImpl).toHaveBeenCalled();
		expect(fetchImpl.mock.calls.filter(([url]) => url === registrySource.rawUrl)).toHaveLength(1);
	});

	it("uses only configured spawn-agent tool names in standalone install grants", async () => {
		const root = await temporary("evo-discovery-cli-install-");
		const service = new EvoService(getEvoPaths(join(root, "evo")));
		await service.init();
		const manifest = parseEvoPackManifest({
			packFormat: 1,
			name: "agent-pack",
			version: "1.0.0",
			contents: {
				components: [
					{
						surface: "tool",
						abi: "tool/v1",
						id: "agent-tool",
						artifact: "components/agent-tool",
						capabilities: ["spawn-agent"],
					},
				],
			},
			requiresAbis: ["tool/v1"],
			requiresCapabilities: ["spawn-agent"],
			integrity: `sha256:${"2".repeat(64)}`,
		});
		const fixture = registryInstallFixture(manifest);
		let installedOptions: EvoPackRegistryInstallOptions | undefined;
		const discovery: EvoCommandDiscoveryService = {
			search: async () => [],
			inspect: async () => fixture.inspection,
			install: async (options) => {
				installedOptions = options;
				await options.beforeStage?.({
					...fixture.inspection,
					packDirectory: root,
					fileCount: 3,
					totalBytes: 900,
					preflight: {
						manifest,
						integrity: manifest.integrity as string,
						packDirectory: root,
						unregisteredAbis: [],
						pendingWorkflows: 0,
						unknownAbiRequests: [],
					},
				});
				return fixture.result;
			},
		};
		const output = io(true);

		await runEvoCli(["install", "agent-pack", "1.0.0"], {
			service,
			runner: runner(),
			model: "openai/test",
			spawnAgentToolNames: ["approved-read"],
			discovery: { service: discovery },
			io: output,
		});

		const grants = installedOptions?.grantsByComponent?.["agent-tool"] as EvoCapabilityGrant[] | undefined;
		expect(installedOptions?.expectedIntegrity).toBe(manifest.integrity);
		expect(grants).toMatchObject([{ capability: "spawn-agent", models: ["openai/test"], tools: ["approved-read"] }]);
		expect(output.output.join("\n")).toContain("Activation: none;");
	});

	it("does not derive extension spawn-agent grants from pi.getActiveTools", async () => {
		const root = await temporary("evo-discovery-extension-install-");
		const service = new EvoService(getEvoPaths(join(root, "evo")));
		await service.init();
		const manifest = parseEvoPackManifest({
			packFormat: 1,
			name: "extension-agent-pack",
			version: "1.0.0",
			contents: {
				workflows: [
					{
						id: "review-agent",
						trigger: "/review-agent",
						abi: "workflow/v1",
						artifact: "workflows/review-agent",
						capabilities: ["spawn-agent"],
					},
				],
			},
			requiresAbis: ["workflow/v1"],
			requiresCapabilities: ["spawn-agent"],
			integrity: `sha256:${"3".repeat(64)}`,
		});
		const fixture = registryInstallFixture(manifest);
		let installedOptions: EvoPackRegistryInstallOptions | undefined;
		const discovery: EvoCommandDiscoveryService = {
			search: async () => [],
			inspect: async () => fixture.inspection,
			install: async (options) => {
				installedOptions = options;
				await options.beforeStage?.({
					...fixture.inspection,
					packDirectory: root,
					fileCount: 3,
					totalBytes: 900,
					preflight: {
						manifest,
						integrity: manifest.integrity as string,
						packDirectory: root,
						unregisteredAbis: [],
						pendingWorkflows: 0,
						unknownAbiRequests: [],
					},
				});
				return fixture.result;
			},
		};
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		let activeToolReads = 0;
		const sent: Array<Record<string, unknown>> = [];
		const api = {
			on: () => {},
			registerShortcut: () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commands.set(name, command);
			},
			sendMessage: (message: Record<string, unknown>) => sent.push(message),
			getActiveTools: () => {
				activeToolReads += 1;
				return ["ambient-shell"];
			},
		} as unknown as ExtensionAPI;
		await createEvoCommandExtension({
			service,
			runner: runner(),
			spawnAgentToolNames: ["approved-extension-tool"],
			discovery: { service: discovery },
		})(api);
		const notifications: string[] = [];
		const context = {
			cwd: root,
			hasUI: true,
			mode: "tui",
			model: { provider: "openai", id: "extension-test" },
			isIdle: () => true,
			waitForIdle: async () => {},
			sessionManager: { getSessionId: () => "discovery-extension" },
			ui: {
				confirm: async () => true,
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
				setStatusItems: () => {},
			},
		} as unknown as ExtensionCommandContext;

		await commands.get("evo")?.handler("install extension-agent-pack 1.0.0", context);

		const grants = installedOptions?.grantsByComponent?.["review-agent"] as EvoCapabilityGrant[] | undefined;
		expect(installedOptions?.expectedIntegrity).toBe(manifest.integrity);
		expect(grants).toMatchObject([
			{
				capability: "spawn-agent",
				models: ["openai/extension-test"],
				tools: ["approved-extension-tool"],
			},
		]);
		expect(activeToolReads).toBe(0);
		expect(sent.some((message) => message.customType === "evo.pack-install")).toBe(true);
		expect(notifications.some((message) => message.includes("error"))).toBe(false);
	});
});
