import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentToolDefinition } from "../src/core/tools/agent.ts";
import { createFauxStreamFn, type FauxResponseInput, type FauxStreamFnState } from "./test-harness.ts";

const extensionContext = undefined as unknown as ExtensionContext;

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

function createFixture(responses: FauxResponseInput[]): {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	faux: FauxStreamFnState;
} {
	const cwd = join(tmpdir(), `pi-agent-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	temporaryRoots.push(cwd);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const { streamFn, state } = createFauxStreamFn(responses);
	modelRegistry.registerProvider("faux", {
		name: "Faux",
		api: "anthropic-messages",
		baseUrl: "http://localhost:0",
		apiKey: "faux-key",
		streamSimple: streamFn,
		models: [
			{
				id: "faux-1",
				name: "Faux 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	});
	return { cwd, agentDir, authStorage, modelRegistry, faux: state };
}

function childToolNames(faux: FauxStreamFnState, call = 0): string[] {
	const context = faux.contexts[call];
	return (context?.tools ?? []).map((tool) => tool.name);
}

describe("agent tool", () => {
	it("runs the task in a fresh child session and returns its final report", async () => {
		const fixture = createFixture(["The answer is 42."]);
		const tool = createAgentToolDefinition(fixture.cwd, {
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			model: "faux/faux-1",
		});

		const result = await tool.execute("tc-1", { task: "Report the answer." }, undefined, undefined, extensionContext);

		expect(result.content).toEqual([{ type: "text", text: "The answer is 42." }]);
		expect(result.details.model).toEqual({ provider: "faux", id: "faux-1" });
		expect(result.details.stopReason).toBe("stop");
		expect(result.details.tokens?.total).toBeGreaterThan(0);
		expect(fixture.faux.callCount).toBe(1);
	});

	it("grants the default read-only toolset and never an agent tool at depth one", async () => {
		const fixture = createFixture(["done"]);
		const tool = createAgentToolDefinition(fixture.cwd, {
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			model: "faux/faux-1",
			// An explicit "agent" grant must be stripped: depth one means the child's
			// toolset cannot represent further spawning.
			tools: ["read", "grep", "agent"],
		});

		await tool.execute("tc-1", { task: "look around" }, undefined, undefined, extensionContext);

		const names = childToolNames(fixture.faux);
		expect(names).toEqual(expect.arrayContaining(["read", "grep"]));
		expect(names).not.toContain("agent");
	});

	it("hands children a one-level-shallower agent tool when maxDepth exceeds one", async () => {
		const fixture = createFixture(["done"]);
		const tool = createAgentToolDefinition(fixture.cwd, {
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			model: "faux/faux-1",
			maxDepth: 2,
		});

		await tool.execute("tc-1", { task: "delegate deeper" }, undefined, undefined, extensionContext);

		expect(childToolNames(fixture.faux)).toContain("agent");
	});

	it("surfaces a child failure as a tool error", async () => {
		const fixture = createFixture([{ error: "boom" }]);
		const tool = createAgentToolDefinition(fixture.cwd, {
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			model: "faux/faux-1",
		});

		await expect(
			tool.execute("tc-1", { task: "fail please" }, undefined, undefined, extensionContext),
		).rejects.toThrow(/stop reason "error"/);
	});

	it("rejects a child run that ends without a final report", async () => {
		const fixture = createFixture([""]);
		const tool = createAgentToolDefinition(fixture.cwd, {
			agentDir: fixture.agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			model: "faux/faux-1",
		});

		await expect(
			tool.execute("tc-1", { task: "say nothing" }, undefined, undefined, extensionContext),
		).rejects.toThrow("without a final report");
	});
});
