import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import {
	createEvoFeatureHandler,
	createPolicyRuntimeExtension,
	guardEvoFeature,
	isEvoFeatureEnabled,
} from "../src/bundle/runtime.ts";
import { parseBundlePolicy } from "../src/bundle/schema.ts";
import { getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { BundlePolicy, CompiledBundle } from "../src/types.ts";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

interface HarnessModel {
	provider: string;
	id: string;
}

interface HarnessOptions {
	initialModel?: HarnessModel;
	models?: readonly HarnessModel[];
	rejectModel?: (model: HarnessModel) => boolean;
	rejectTools?: (tools: readonly string[]) => boolean;
}

function createHarness(root: string, initialSessionId: string, options: HarnessOptions = {}) {
	const handlers = new Map<string, EventHandler[]>();
	const entries: unknown[] = [];
	const notifications: string[] = [];
	const modelAttempts: HarnessModel[] = [];
	let activeTools = ["read", "bash", "edit"];
	let activeModel = options.initialModel;
	let sessionId = initialSessionId;
	const api = {
		on: (event: string, handler: EventHandler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => {
			if (options.rejectTools?.(tools)) throw new Error(`Rejected tools: ${tools.join(", ")}`);
			activeTools = [...tools];
		},
		setModel: async (model: HarnessModel) => {
			modelAttempts.push(model);
			if (options.rejectModel?.(model)) return false;
			activeModel = model;
			return true;
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(root, `${sessionId}.jsonl`),
			getEntries: () => entries,
		},
		get model() {
			return activeModel;
		},
		modelRegistry: {
			getAll: () => [...(options.models ?? [])],
			find: (provider: string, modelId: string) =>
				options.models?.find((model) => model.provider === provider && model.id === modelId),
		},
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;

	return {
		api,
		entries,
		modelAttempts,
		notifications,
		getActiveModel: () => activeModel,
		getActiveTools: () => [...activeTools],
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
	files: ReadonlyArray<readonly [path: string, content: string]> = [],
): Promise<CompiledBundle> {
	const source = await mkdtemp(join(root, "feature-policy-"));
	await writeFile(join(source, "policy.json"), `${JSON.stringify(policy, undefined, "\t")}\n`);
	for (const [path, content] of files) {
		const target = join(source, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	return compileBundle({ paths: getEvoPaths(root), sourceDirectory: source, parentDigest, summary });
}

describe("Evo feature gate", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createRoot(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-feature-gate-"));
		temporaryDirectories.push(root);
		return root;
	}

	it("leaves the original tools active when the registry is not initialized", async () => {
		const root = await createRoot();
		const harness = createHarness(root, "uninitialized-session");
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
		expect(harness.notifications).toEqual([]);
		expect(await harness.emit("before_agent_start", { systemPrompt: "base prompt" })).toEqual([undefined]);
		expect(await harness.emit("resources_discover", {})).toEqual([undefined]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("fails closed when the stable bundle cannot be validated", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledTools: ["read"], enabledFeatures: ["feature-a"] },
			null,
			"Bundle that will be corrupted",
			[["skills/example/SKILL.md", "# Example\n"]],
		);
		await new BundleRegistry(paths).initialize(bundle.digest);
		await rm(join(bundle.directory, "policy.json"));
		const harness = createHarness(root, "corrupt-bundle-session");
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual([]);
		expect(isEvoFeatureEnabled("feature-a", { root, sessionId: "corrupt-bundle-session" })).toBe(false);
		expect(await harness.emit("before_agent_start", { systemPrompt: "base prompt" })).toEqual([undefined]);
		expect(await harness.emit("resources_discover", {})).toEqual([undefined]);
		expect(harness.notifications).toEqual([expect.stringContaining("bundle disabled with all tools blocked")]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
	});

	it("fails closed when the bundle tool policy cannot be applied", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledTools: ["unavailable"], enabledFeatures: ["feature-a"] },
			null,
			"Bundle with an unavailable tool",
			[["skills/example/SKILL.md", "# Example\n"]],
		);
		await new BundleRegistry(paths).initialize(bundle.digest);
		const harness = createHarness(root, "invalid-tools-session", {
			rejectTools: (tools) => tools.includes("unavailable"),
		});
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual([]);
		expect(isEvoFeatureEnabled("feature-a", { root, sessionId: "invalid-tools-session" })).toBe(false);
		expect(await harness.emit("before_agent_start", { systemPrompt: "base prompt" })).toEqual([undefined]);
		expect(await harness.emit("resources_discover", {})).toEqual([undefined]);
		expect(harness.notifications).toEqual([expect.stringContaining("bundle disabled with all tools blocked")]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
	});

	it("routes a qualified worker model whose id contains slashes and restores the original model", async () => {
		const root = await createRoot();
		const originalModel = { provider: "original", id: "default/model" };
		const workerModel = { provider: "openrouter", id: "anthropic/claude-sonnet-4" };
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, modelRouting: { worker: "openrouter/anthropic/claude-sonnet-4" } },
			null,
			"Qualified worker route",
		);
		await new BundleRegistry(getEvoPaths(root)).initialize(bundle.digest);
		const harness = createHarness(root, "qualified-model-session", {
			initialModel: originalModel,
			models: [workerModel],
		});
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveModel()).toBe(workerModel);
		expect(harness.modelAttempts).toEqual([workerModel]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(harness.getActiveModel()).toBe(originalModel);
		expect(harness.modelAttempts).toEqual([workerModel, originalModel]);
	});

	it("resolves a unique bare worker model id and restores it across session switches", async () => {
		const root = await createRoot();
		const originalModel = { provider: "original", id: "default" };
		const workerModel = { provider: "anthropic", id: "worker-model" };
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, modelRouting: { worker: "worker-model" } },
			null,
			"Bare worker route",
		);
		await new BundleRegistry(getEvoPaths(root)).initialize(bundle.digest);
		const harness = createHarness(root, "first-model-session", {
			initialModel: originalModel,
			models: [workerModel],
		});
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		harness.setSessionId("second-model-session");
		await harness.emit("session_start", { type: "session_start", reason: "new" });

		expect(harness.getActiveModel()).toBe(workerModel);
		expect(harness.modelAttempts).toEqual([workerModel, originalModel, workerModel]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(harness.getActiveModel()).toBe(originalModel);
		expect(harness.modelAttempts).toEqual([workerModel, originalModel, workerModel, originalModel]);
	});

	it("fails closed when a qualified worker model does not exist", async () => {
		const root = await createRoot();
		const originalModel = { provider: "original", id: "default" };
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledTools: ["read"], modelRouting: { worker: "missing/vendor/model" } },
			null,
			"Missing worker route",
		);
		await new BundleRegistry(getEvoPaths(root)).initialize(bundle.digest);
		const harness = createHarness(root, "missing-model-session", { initialModel: originalModel });
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual([]);
		expect(harness.getActiveModel()).toBe(originalModel);
		expect(harness.modelAttempts).toEqual([]);
		expect(harness.notifications).toEqual([expect.stringContaining("worker model does not exist")]);
		expect(await harness.emit("before_agent_start", { systemPrompt: "base prompt" })).toEqual([undefined]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("fails closed when a bare worker model id is ambiguous", async () => {
		const root = await createRoot();
		const originalModel = { provider: "original", id: "default" };
		const firstWorker = { provider: "first", id: "shared-worker" };
		const secondWorker = { provider: "second", id: "shared-worker" };
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledTools: ["read"], modelRouting: { worker: "shared-worker" } },
			null,
			"Ambiguous worker route",
		);
		await new BundleRegistry(getEvoPaths(root)).initialize(bundle.digest);
		const harness = createHarness(root, "ambiguous-model-session", {
			initialModel: originalModel,
			models: [firstWorker, secondWorker],
		});
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual([]);
		expect(harness.getActiveModel()).toBe(originalModel);
		expect(harness.modelAttempts).toEqual([]);
		expect(harness.notifications).toEqual([expect.stringContaining("worker model id is ambiguous")]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("fails closed and restores the original model when setModel rejects the worker", async () => {
		const root = await createRoot();
		const originalModel = { provider: "original", id: "default" };
		const workerModel = { provider: "worker", id: "model" };
		const bundle = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledTools: ["read"], modelRouting: { worker: "worker/model" } },
			null,
			"Unavailable worker route",
		);
		await new BundleRegistry(getEvoPaths(root)).initialize(bundle.digest);
		const harness = createHarness(root, "unavailable-model-session", {
			initialModel: originalModel,
			models: [workerModel],
			rejectModel: (model) => model === workerModel,
		});
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.getActiveTools()).toEqual([]);
		expect(harness.getActiveModel()).toBe(originalModel);
		expect(harness.modelAttempts).toEqual([workerModel, originalModel]);
		expect(harness.notifications).toEqual([expect.stringContaining("worker model is unavailable")]);
		expect(await harness.emit("before_agent_start", { systemPrompt: "base prompt" })).toEqual([undefined]);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("keeps merged features dormant unless the pinned bundle enables them", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const dormant = await compilePolicyBundle(root, { schemaVersion: 1 }, null, "Dormant features");
		await new BundleRegistry(paths).initialize(dormant.digest);
		const harness = createHarness(root, "dormant-session");
		await createPolicyRuntimeExtension({ root })(harness.api);

		expect(isEvoFeatureEnabled("feature-a")).toBe(false);
		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(false);
		expect(guardEvoFeature("feature-a", { root })).toBe(false);
		expect(createEvoFeatureHandler("feature-a", () => "ran", { root })()).toBeUndefined();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(false);
		expect(isEvoFeatureEnabled("unknown-feature", { root })).toBe(false);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("enables handlers only for the current root and pinned session", async () => {
		const enabledRoot = await createRoot();
		const otherRoot = await createRoot();
		const enabled = await compilePolicyBundle(
			enabledRoot,
			{ schemaVersion: 1, enabledTools: ["read"], enabledFeatures: ["feature-a"] },
			null,
			"Enable feature-a",
		);
		await new BundleRegistry(getEvoPaths(enabledRoot)).initialize(enabled.digest);
		const other = await compilePolicyBundle(
			otherRoot,
			{ schemaVersion: 1, enabledFeatures: ["feature-b"] },
			null,
			"Enable feature-b",
		);
		await new BundleRegistry(getEvoPaths(otherRoot)).initialize(other.digest);
		const harness = createHarness(enabledRoot, "enabled-session");
		const otherHarness = createHarness(otherRoot, "other-session");
		await createPolicyRuntimeExtension({ root: enabledRoot })(harness.api);
		await createPolicyRuntimeExtension({ root: otherRoot })(otherHarness.api);
		let calls = 0;
		const handler = createEvoFeatureHandler(
			"feature-a",
			(value: number) => {
				calls += 1;
				return value * 2;
			},
			{ root: enabledRoot },
		);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await otherHarness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(isEvoFeatureEnabled("feature-a", { root: enabledRoot })).toBe(true);
		expect(isEvoFeatureEnabled("feature-a", { root: otherRoot })).toBe(false);
		expect(isEvoFeatureEnabled("feature-b", { root: enabledRoot })).toBe(false);
		expect(isEvoFeatureEnabled("feature-b", { root: otherRoot })).toBe(true);
		expect(isEvoFeatureEnabled("unknown-feature", { root: enabledRoot })).toBe(false);
		expect(handler(4)).toBe(8);
		expect(calls).toBe(1);
		expect(harness.getActiveTools()).toEqual(["read"]);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(isEvoFeatureEnabled("feature-a", { root: enabledRoot })).toBe(false);
		expect(isEvoFeatureEnabled("feature-b", { root: otherRoot })).toBe(true);
		expect(handler(4)).toBeUndefined();
		expect(calls).toBe(1);
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
		await otherHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(isEvoFeatureEnabled("feature-b", { root: otherRoot })).toBe(false);
	});

	it("defaults to disabled when same-root sessions are ambiguous", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const first = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledFeatures: ["feature-a"] },
			null,
			"First session feature",
		);
		const second = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledFeatures: ["feature-b"] },
			first.digest,
			"Second session feature",
		);
		const registry = new BundleRegistry(paths);
		await registry.initialize(first.digest);
		const firstHarness = createHarness(root, "first-session");
		await createPolicyRuntimeExtension({ root })(firstHarness.api);
		await firstHarness.emit("session_start", { type: "session_start", reason: "startup" });

		await registry.activateTrial({ digest: second.digest, proposalId: "second-feature", plan: "One session" });
		const secondHarness = createHarness(root, "second-session");
		await createPolicyRuntimeExtension({ root })(secondHarness.api);
		await secondHarness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(false);
		expect(isEvoFeatureEnabled("feature-a", { root, sessionId: "first-session" })).toBe(true);
		expect(isEvoFeatureEnabled("feature-b", { root, sessionId: "second-session" })).toBe(true);

		await firstHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(isEvoFeatureEnabled("feature-b", { root })).toBe(true);
		await secondHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(isEvoFeatureEnabled("feature-b", { root })).toBe(false);
	});

	it("keeps a feature pinned through rollback and disables it in the next session", async () => {
		const root = await createRoot();
		const paths = getEvoPaths(root);
		const dormant = await compilePolicyBundle(root, { schemaVersion: 1 }, null, "Dormant stable bundle");
		const enabled = await compilePolicyBundle(
			root,
			{ schemaVersion: 1, enabledFeatures: ["feature-a"] },
			dormant.digest,
			"Enabled trial bundle",
		);
		const registry = new BundleRegistry(paths);
		await registry.initialize(dormant.digest);
		await registry.activateTrial({ digest: enabled.digest, proposalId: "feature-trial", plan: "One session" });
		const harness = createHarness(root, "trial-session");
		await createPolicyRuntimeExtension({ root })(harness.api);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(true);
		await registry.rollback(undefined, "Disable the feature trial");
		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(true);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(false);
		harness.setSessionId("next-session");
		await harness.emit("session_start", { type: "session_start", reason: "new" });
		expect(isEvoFeatureEnabled("feature-a", { root })).toBe(false);
		expect(harness.entries).toContainEqual({
			type: "custom",
			customType: "evo.bundle",
			data: { digest: dormant.digest, sessionId: "next-session" },
		});
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("validates enabledFeatures as unique non-empty strings", () => {
		expect(parseBundlePolicy({ schemaVersion: 1, enabledFeatures: ["feature-a", "feature-b"] })).toEqual({
			schemaVersion: 1,
			promptOrder: undefined,
			stablePromptPaths: undefined,
			dynamicPromptPaths: undefined,
			enabledTools: undefined,
			enabledFeatures: ["feature-a", "feature-b"],
			coreAssets: undefined,
			limits: undefined,
			modelRouting: undefined,
			validation: undefined,
		});
		expect(() => parseBundlePolicy({ schemaVersion: 1, enabledFeatures: [""] })).toThrow(
			"policy.enabledFeatures must be an array of non-empty strings",
		);
		expect(() => parseBundlePolicy({ schemaVersion: 1, enabledFeatures: ["feature-a", "feature-a"] })).toThrow(
			"policy.enabledFeatures must not contain duplicates",
		);
		expect(() => parseBundlePolicy({ schemaVersion: 1, enabledFeatures: ["feature-a", 1] })).toThrow(
			"policy.enabledFeatures must be an array of non-empty strings",
		);
	});
});
