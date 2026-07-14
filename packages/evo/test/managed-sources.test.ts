import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type ExtensionAPI,
	type ExtensionContext,
	loadSkills,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { createPolicyRuntimeExtension } from "../src/bundle/runtime.ts";
import { migratePiDataToBundleSource } from "../src/migration.ts";
import { getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { BundlePolicy, CompiledBundle } from "../src/types.ts";

const HOST_CUSTOM = "HOST_CUSTOM_SOURCE\n";
const HOST_APPEND = "HOST_APPEND_SOURCE\n";
const HOST_CONTEXT = "HOST_CONTEXT_SOURCE\n";
const HOST_SKILL = `---
name: review
description: Host-only review behavior.
---

# Review

Follow the host review process.
`;

const BUNDLE_CUSTOM = "BUNDLE_CUSTOM_TAKEOVER\n";
const BUNDLE_APPEND = "BUNDLE_APPEND_TAKEOVER\n";
const BUNDLE_CONTEXT = "BUNDLE_CONTEXT_TAKEOVER\n";
const BUNDLE_SKILL = `---
name: review
description: Bundle-owned review behavior.
---

# Review

Follow the evolved bundle review process.
`;

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

function createHarness(root: string) {
	const handlers = new Map<string, EventHandler[]>();
	const entries: unknown[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	let activeTools = ["read", "bash"];
	const api = {
		on: (event: string, handler: EventHandler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		setModel: async () => true,
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		sessionManager: {
			getSessionId: () => "managed-session",
			getSessionFile: () => join(root, "managed-session.jsonl"),
			getEntries: () => entries,
		},
		modelRegistry: {
			getAll: () => [],
			find: () => undefined,
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	return {
		api,
		context,
		entries,
		notifications,
		getActiveTools: () => [...activeTools],
		async emit(event: string, value: unknown): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

async function createManagedBundle(root: string): Promise<{
	agentDirectory: string;
	bundle: CompiledBundle;
	evoRoot: string;
}> {
	const agentDirectory = join(root, "agent");
	const bundleSourceDirectory = join(root, "bundle-source");
	const evoRoot = join(root, "evo-state");
	await mkdir(join(agentDirectory, "skills", "review"), { recursive: true });
	await mkdir(bundleSourceDirectory);
	await writeFile(join(agentDirectory, "SYSTEM.md"), HOST_CUSTOM);
	await writeFile(join(agentDirectory, "APPEND_SYSTEM.md"), HOST_APPEND);
	await writeFile(join(agentDirectory, "AGENTS.md"), HOST_CONTEXT);
	await writeFile(join(agentDirectory, "skills", "review", "SKILL.md"), HOST_SKILL);

	const migration = await migratePiDataToBundleSource({
		bundleSourceDirectory,
		sources: { agentDirectory },
	});
	await writeFile(join(bundleSourceDirectory, "prompts", "system.md"), BUNDLE_CUSTOM);
	await writeFile(join(bundleSourceDirectory, "prompts", "append-system.md"), BUNDLE_APPEND);
	await writeFile(join(bundleSourceDirectory, "memory", "global-context.md"), BUNDLE_CONTEXT);
	await writeFile(join(bundleSourceDirectory, "skills", "review", "SKILL.md"), BUNDLE_SKILL);
	const policy = {
		schemaVersion: 1,
		promptOrder: migration.promptPaths,
		stablePromptPaths: migration.promptPaths,
		enabledFeatures: [],
		coreAssets: migration.assets
			.filter((asset) => asset.kind === "custom-prompt" || asset.kind === "append-prompt")
			.map((asset) => asset.targetPath),
		modelRouting: {},
		validation: { requiredChecks: [] },
		managedSources: migration.assets,
	} satisfies BundlePolicy;
	await writeFile(join(bundleSourceDirectory, "policy.json"), `${JSON.stringify(policy, undefined, "\t")}\n`);
	const paths = getEvoPaths(evoRoot);
	const bundle = await compileBundle({
		paths,
		sourceDirectory: bundleSourceDirectory,
		parentDigest: null,
		summary: "Evolved managed-source runtime fixture",
	});
	await new BundleRegistry(paths).initialize(bundle.digest);
	return { agentDirectory, bundle, evoRoot };
}

function resultSystemPrompt(results: unknown[]): string {
	const result = results[0];
	if (typeof result !== "object" || result === null || !("systemPrompt" in result)) {
		throw new Error("Expected before_agent_start to return a system prompt");
	}
	const systemPrompt = result.systemPrompt;
	if (typeof systemPrompt !== "string") throw new Error("Expected returned systemPrompt to be a string");
	return systemPrompt;
}

function countOccurrences(content: string, needle: string): number {
	return content.split(needle).length - 1;
}

function expectSingleBundleOwnership(prompt: string, bundle: CompiledBundle, agentDirectory: string): void {
	for (const marker of [BUNDLE_CUSTOM, BUNDLE_APPEND, BUNDLE_CONTEXT]) {
		expect(countOccurrences(prompt, marker.trim())).toBe(1);
	}
	expect(countOccurrences(prompt, "Bundle-owned review behavior.")).toBe(1);
	expect(countOccurrences(prompt, "<name>review</name>")).toBe(1);
	expect(prompt).toContain(join(bundle.directory, "memory", "global-context.md"));
	expect(prompt).toContain(join(bundle.directory, "skills", "review", "SKILL.md"));
	expect(prompt).not.toContain(join(agentDirectory, "AGENTS.md"));
	expect(prompt).not.toContain(join(agentDirectory, "skills", "review", "SKILL.md"));
}

describe("Evo-Pi managed runtime sources", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createRoot(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-managed-sources-"));
		temporaryDirectories.push(root);
		return root;
	}

	it("takes over migrated custom, append, context, and skill resources without duplicate injection", async () => {
		const root = await createRoot();
		const { agentDirectory, bundle, evoRoot } = await createManagedBundle(root);
		const harness = createHarness(root);
		await createPolicyRuntimeExtension({ root: evoRoot })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(
			await harness.emit("resources_discover", { type: "resources_discover", cwd: root, reason: "startup" }),
		).toEqual([{ skillPaths: [join(bundle.directory, "skills")] }]);
		const hostSkills = loadSkills({
			cwd: root,
			agentDir: agentDirectory,
			skillPaths: [join(agentDirectory, "skills")],
			includeDefaults: false,
		});
		const discoveredBundleSkills = loadSkills({
			cwd: root,
			agentDir: agentDirectory,
			skillPaths: [join(bundle.directory, "skills")],
			includeDefaults: false,
		});
		expect(hostSkills.diagnostics).toEqual([]);
		expect(discoveredBundleSkills.diagnostics).toEqual([]);
		const systemPromptOptions: BuildSystemPromptOptions = {
			cwd: root,
			selectedTools: ["read"],
			customPrompt: HOST_CUSTOM,
			appendSystemPrompt: HOST_APPEND,
			contextFiles: [{ path: join(agentDirectory, "AGENTS.md"), content: HOST_CONTEXT }],
			skills: [...hostSkills.skills, ...discoveredBundleSkills.skills],
		};
		const hostBasePrompt = buildSystemPrompt(systemPromptOptions);
		const prompt = resultSystemPrompt(
			await harness.emit("before_agent_start", {
				type: "before_agent_start",
				prompt: "Review this change",
				systemPrompt: `OTHER_EXTENSION_PREFIX\n\n${hostBasePrompt}\n\nOTHER_EXTENSION_SUFFIX`,
				systemPromptOptions,
			}),
		);

		expectSingleBundleOwnership(prompt, bundle, agentDirectory);
		expect(prompt).toContain("OTHER_EXTENSION_PREFIX");
		expect(prompt).toContain("OTHER_EXTENSION_SUFFIX");
		expect(prompt).not.toContain(HOST_CUSTOM.trim());
		expect(prompt).not.toContain(HOST_APPEND.trim());
		expect(prompt).not.toContain(HOST_CONTEXT.trim());
		expect(prompt).not.toContain("Host-only review behavior.");
		expect(prompt).not.toContain("You are an expert coding assistant");
	});

	it("continues serving migrated resources from the bundle after the original sources are deleted", async () => {
		const root = await createRoot();
		const { agentDirectory, bundle, evoRoot } = await createManagedBundle(root);
		await rm(agentDirectory, { recursive: true, force: true });
		const harness = createHarness(root);
		await createPolicyRuntimeExtension({ root: evoRoot })(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const systemPromptOptions: BuildSystemPromptOptions = { cwd: root, selectedTools: ["read"] };
		const prompt = resultSystemPrompt(
			await harness.emit("before_agent_start", {
				type: "before_agent_start",
				prompt: "Review this change",
				systemPrompt: buildSystemPrompt(systemPromptOptions),
				systemPromptOptions,
			}),
		);

		expectSingleBundleOwnership(prompt, bundle, agentDirectory);
		expect(prompt).not.toContain("You are an expert coding assistant");
		expect(harness.notifications).toEqual([]);
	});

	it("fails closed at session_start when an original managed source drifts", async () => {
		const root = await createRoot();
		const { agentDirectory, evoRoot } = await createManagedBundle(root);
		await writeFile(join(agentDirectory, "SYSTEM.md"), "DRIFTED_OUTSIDE_REGISTRY\n");
		const harness = createHarness(root);
		await createPolicyRuntimeExtension({ root: evoRoot })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual([]);
		expect(harness.entries).toEqual([]);
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0]).toMatchObject({ level: "error" });
		expect(harness.notifications[0]?.message).toContain("managed source drifted outside the registry");
		expect(harness.notifications[0]?.message).toContain("disabled with all tools blocked");
		expect(
			await harness.emit("resources_discover", { type: "resources_discover", cwd: root, reason: "startup" }),
		).toEqual([undefined]);
		const systemPromptOptions: BuildSystemPromptOptions = { cwd: root, selectedTools: ["read"] };
		expect(
			await harness.emit("before_agent_start", {
				type: "before_agent_start",
				prompt: "Do not run",
				systemPrompt: buildSystemPrompt(systemPromptOptions),
				systemPromptOptions,
			}),
		).toEqual([undefined]);
	});
});
