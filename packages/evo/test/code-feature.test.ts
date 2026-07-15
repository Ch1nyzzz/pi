import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@ch1nyzzz/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createEvoCodeFeatureExtension } from "../src/bundle/code-feature.ts";
import { compileBundle } from "../src/bundle/compile.ts";
import { createPolicyRuntimeExtension } from "../src/bundle/runtime.ts";
import { getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { BundlePolicy, CompiledBundle } from "../src/types.ts";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

function createHarness(root: string, initialSessionId: string) {
	const handlers = new Map<string, EventHandler[]>();
	const entries: unknown[] = [];
	const tools = new Map<string, ToolDefinition>();
	let activeTools = ["read"];
	let sessionId = initialSessionId;
	const api = {
		on: (event: string, handler: EventHandler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
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
			getSessionId: () => sessionId,
			getSessionFile: () => join(root, `${sessionId}.jsonl`),
			getEntries: () => entries,
		},
		modelRegistry: {
			getAll: () => [],
			find: () => undefined,
		},
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	return {
		api,
		context,
		getActiveTools: () => [...activeTools],
		getTool: (name: string): ToolDefinition => {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing test tool: ${name}`);
			return tool;
		},
		setSessionId: (value: string) => {
			sessionId = value;
		},
		async emit(event: string, value: unknown): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

async function compilePolicyBundle(
	root: string,
	policy: BundlePolicy,
	parentDigest: string | null,
	summary: string,
): Promise<CompiledBundle> {
	const source = await mkdtemp(join(root, "code-feature-policy-"));
	await writeFile(join(source, "policy.json"), `${JSON.stringify(policy, undefined, "\t")}\n`);
	return compileBundle({ paths: getEvoPaths(root), sourceDirectory: source, parentDigest, summary });
}

describe("Evo code feature activation", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createRoot(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-code-feature-"));
		temporaryDirectories.push(root);
		return root;
	}

	async function installFeature(root: string, harness: ReturnType<typeof createHarness>, calls: string[]) {
		await createPolicyRuntimeExtension({ root })(harness.api);
		await createEvoCodeFeatureExtension(
			{
				id: "feature-a",
				setup: (pi) => {
					pi.on("before_agent_start", () => {
						calls.push("hook");
					});
					pi.on("session_shutdown", () => {
						calls.push("shutdown");
					});
					pi.registerTool({
						name: "feature_tool",
						label: "Feature tool",
						description: "Feature-owned tool",
						parameters: Type.Object({}),
						execute: async () => {
							calls.push("tool");
							return { content: [{ type: "text", text: "ok" }], details: {} };
						},
					});
				},
			},
			{ root },
		)(harness.api);
	}

	it("keeps registered tools and hooks dormant without an initialized bundle", async () => {
		const root = await createRoot();
		const harness = createHarness(root, "uninitialized-session");
		const calls: string[] = [];
		await installFeature(root, harness, calls);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.getActiveTools()).toEqual(["read"]);
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });
		expect(calls).toEqual([]);
		await expect(
			harness.getTool("feature_tool").execute("call", {}, undefined, undefined, harness.context),
		).rejects.toThrow("disabled for this session");
	});

	it("runs wrapped hooks and tools only when the pinned bundle enables their feature", async () => {
		const root = await createRoot();
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledFeatures: ["feature-a"] },
			null,
			"Enable feature-a",
		);
		await new BundleRegistry(getEvoPaths(root)).initialize(bundle.digest);
		const harness = createHarness(root, "enabled-session");
		const calls: string[] = [];
		await installFeature(root, harness, calls);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.getActiveTools()).toEqual(["read", "feature_tool"]);
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });
		await harness.getTool("feature_tool").execute("call", {}, undefined, undefined, harness.context);
		expect(calls).toEqual(["hook", "tool"]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(calls).toEqual(["hook", "tool", "shutdown"]);
		await expect(
			harness.getTool("feature_tool").execute("call", {}, undefined, undefined, harness.context),
		).rejects.toThrow("disabled for this session");
	});

	it("keeps the current session pinned through rollback and disables the next session", async () => {
		const root = await createRoot();
		const dormant = await compilePolicyBundle(root, { schemaVersion: 1 }, null, "Dormant feature");
		const enabled = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledFeatures: ["feature-a"] },
			dormant.digest,
			"Enable feature-a",
		);
		const registry = new BundleRegistry(getEvoPaths(root));
		await registry.initialize(dormant.digest);
		await registry.activateTrial({ digest: enabled.digest, proposalId: "feature-a", plan: "One session" });
		const harness = createHarness(root, "trial-session");
		const calls: string[] = [];
		await installFeature(root, harness, calls);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await registry.rollback(undefined, "Disable feature-a");
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });
		await harness.getTool("feature_tool").execute("call", {}, undefined, undefined, harness.context);
		expect(calls).toEqual(["hook", "tool"]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
		harness.setSessionId("next-session");
		await harness.emit("session_start", { type: "session_start", reason: "new" });
		expect(harness.getActiveTools()).toEqual(["read"]);
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });
		expect(calls).toEqual(["hook", "tool", "shutdown"]);
		await expect(
			harness.getTool("feature_tool").execute("call", {}, undefined, undefined, harness.context),
		).rejects.toThrow("disabled for this session");
	});

	it("rejects one tool name being claimed by different code features", async () => {
		const root = await createRoot();
		const harness = createHarness(root, "collision-session");
		const register = (id: string) =>
			createEvoCodeFeatureExtension(
				{
					id,
					setup: (pi) => {
						pi.registerTool({
							name: "shared_tool",
							label: "Shared tool",
							description: "Shared name",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					},
				},
				{ root },
			)(harness.api);

		await register("feature-a");
		await expect(register("feature-b")).rejects.toThrow("already owned by code feature feature-a");
	});
});
