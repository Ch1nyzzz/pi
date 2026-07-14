import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { renderRuntimeBundle } from "../src/bundle/runtime.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { runReflector } from "../src/reflect/reflector.ts";
import { BundleRegistry } from "../src/registry/registry.ts";

class FakeModelRunner implements ModelRunner {
	readonly requests: ModelRunRequest[] = [];
	private readonly responses: string[];

	constructor(responses: string[]) {
		this.responses = [...responses];
	}

	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.requests.push(request);
		const text = this.responses.shift();
		if (text === undefined) throw new Error("Fake model runner has no queued response");
		return {
			text,
			model: { provider: "fake", id: request.model ?? "default" },
			stats: {
				sessionFile: undefined,
				sessionId: request.sessionIdentity ?? `fake-${this.requests.length}`,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
				cost: 0,
			},
		};
	}
}

interface Fixture {
	root: string;
	paths: EvoPaths;
	oldSystemPrompt: string;
}

interface ReflectorResponseOptions {
	path: string;
	content: string;
	replay: boolean;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function bundlePolicy(core: boolean, worker = "fake/worker"): string {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			promptOrder: ["prompts/system.md"],
			coreAssets: core ? ["prompts/system.md"] : [],
			modelRouting: {
				worker,
				reflector: "fake/reflector",
				critic: "fake/critic",
			},
			validation: {},
		},
		undefined,
		"\t",
	)}\n`;
}

async function createFixture(core: boolean): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-reflect-loop-"));
	temporaryRoots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const source = join(root, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(join(source, "policy.json"), bundlePolicy(core));
	await writeFile(join(source, "prompts", "system.md"), "Original instruction.");
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "Initial test bundle",
	});
	await new BundleRegistry(paths).initialize(bundle.digest);
	const oldSystemPrompt = `Base worker prompt\n\n${(await renderRuntimeBundle(bundle)).systemPromptAppend}`;
	const store = await createRecorderStore({
		paths,
		sessionId: "recorded-session",
		bundleDigest: bundle.digest,
		now: () => new Date("2026-07-13T00:00:00.000Z"),
	});
	await store.append({ type: "session_start", reason: "startup", cwd: root });
	await store.append({
		type: "before_agent_start",
		prompt: await store.storePayload("Initial request"),
		systemPrompt: await store.storePayload(oldSystemPrompt),
		systemPromptOptions: await store.storePayload({ tools: ["read", "bash"] }),
	});
	await store.append({
		type: "message",
		role: "user",
		message: await store.storePayload({
			role: "user",
			content: "The agent repeated the unsafe shortcut.",
			timestamp: 1,
		}),
	});
	await store.append({
		type: "message",
		role: "assistant",
		message: await store.storePayload({
			role: "assistant",
			content: [{ type: "text", text: "I will try again." }],
			timestamp: 2,
		}),
	});
	await store.append({
		type: "message",
		role: "user",
		message: await store.storePayload({
			role: "user",
			content: "The agent repeated the unsafe shortcut again.",
			timestamp: 3,
		}),
	});
	return { root, paths, oldSystemPrompt };
}

function reflectorResponse(options: ReflectorResponseOptions): string {
	return JSON.stringify({
		observationsMarkdown: "# Observations\n\nThe same unsafe shortcut appeared twice.",
		proposals: [
			{
				motivation: "Prevent the repeated unsafe shortcut.",
				expectedEffect: "The worker should choose the safe path first.",
				risk: "The instruction could be over-broad.",
				verifyPlan: "Compile the bundle and review the diff.",
				trialPlan: "Use the candidate for five sessions.",
				source: "pattern",
				evidence: [
					{
						sessionId: "recorded-session",
						sequence: 3,
						quote: "The agent repeated the unsafe shortcut.",
					},
					{
						sessionId: "recorded-session",
						sequence: 5,
						quote: "The agent repeated the unsafe shortcut again.",
					},
				],
				inboxReferences: [],
				replayScenarios: options.replay ? [{ sessionId: "recorded-session", sequence: 5 }] : [],
				changes: [{ path: options.path, content: options.content }],
			},
		],
	});
}

describe("reflect loop", () => {
	it("stages a grounded T1 proposal and saves an independent desk review", async () => {
		const fixture = await createFixture(false);
		const runner = new FakeModelRunner([
			reflectorResponse({
				path: "prompts/system.md",
				content: "Always avoid the unsafe shortcut.",
				replay: false,
			}),
			"# Review\n\nsupported: the evidence and narrow diff align.",
		]);

		const result = await runReflector({ paths: fixture.paths, runner, cwd: fixture.root });

		expect(result.proposals).toHaveLength(1);
		const proposal = result.proposals[0];
		expect(proposal).toMatchObject({ kind: "data", tier: "T1", reviewFile: "review.md" });
		expect(proposal.l1.passed).toBe(true);
		expect(runner.requests).toHaveLength(2);
		expect(runner.requests[0].systemPrompt).toContain("Evo-Pi Reflector");
		expect(runner.requests[0].model).toBe("fake/reflector");
		expect(runner.requests[1].systemPrompt).toContain("independent Evo-Pi Critic");
		expect(runner.requests[1].model).toBe("fake/critic");
		expect(runner.requests[1].prompt).not.toContain("<counterfactual_replay>");
		expect(await readFile(join(fixture.paths.proposals, proposal.id, "review.md"), "utf8")).toContain("supported");
	});

	it("runs old and candidate T2 replays back-to-back before the critic", async () => {
		const fixture = await createFixture(true);
		const runner = new FakeModelRunner([
			reflectorResponse({
				path: "prompts/system.md",
				content: "Candidate core instruction.",
				replay: true,
			}),
			"Old first action",
			"Candidate first action",
			"# Review\n\nsupported with generate-only replay limitations.",
		]);

		const result = await runReflector({
			paths: fixture.paths,
			runner,
			cwd: fixture.root,
			replayModel: "fake/replay-override",
		});

		const proposal = result.proposals[0];
		expect(proposal).toMatchObject({ kind: "data", tier: "T2", replayFile: "replay.md", reviewFile: "review.md" });
		expect(runner.requests).toHaveLength(4);
		const oldReplay = runner.requests[1];
		const candidateReplay = runner.requests[2];
		expect(oldReplay.systemPrompt).toBe(fixture.oldSystemPrompt);
		expect(candidateReplay.systemPrompt).toContain("Candidate core instruction.");
		expect(oldReplay.prompt).toBe("The agent repeated the unsafe shortcut again.");
		expect(candidateReplay.prompt).toBe(oldReplay.prompt);
		expect(candidateReplay.history).toBe(oldReplay.history);
		expect(oldReplay.sessionIdentity).toBe("recorded-session");
		expect(candidateReplay.sessionIdentity).toBe("recorded-session");
		expect(oldReplay.model).toBe("fake/replay-override");
		expect(candidateReplay.model).toBe("fake/replay-override");
		expect(runner.requests[3].prompt).toContain("<counterfactual_replay>");
		expect(runner.requests[3].prompt).toContain("does not restore a workspace snapshot");
		expect(runner.requests[3].prompt).toContain("does not provide tool schemas");
		expect(runner.requests[3].prompt).toContain("does not execute tools");
		const replayMarkdown = await readFile(join(fixture.paths.proposals, proposal.id, "replay.md"), "utf8");
		expect(replayMarkdown).toContain("Old first action");
		expect(replayMarkdown).toContain("Candidate first action");
		expect(replayMarkdown).toContain("not end-to-end task completion");
	});

	it("routes a policy-only T2 replay through the parent and candidate worker models", async () => {
		const fixture = await createFixture(false);
		const runner = new FakeModelRunner([
			reflectorResponse({
				path: "policy.json",
				content: bundlePolicy(false, "fake/candidate-worker"),
				replay: true,
			}),
			"Old routed action",
			"Candidate routed action",
			"# Review\n\nsupported with generate-only replay limitations.",
		]);

		const result = await runReflector({ paths: fixture.paths, runner, cwd: fixture.root });

		expect(result.proposals[0]).toMatchObject({
			kind: "data",
			tier: "T2",
			changedPaths: ["policy.json"],
		});
		expect(runner.requests).toHaveLength(4);
		expect(runner.requests[1].model).toBe("fake/worker");
		expect(runner.requests[2].model).toBe("fake/candidate-worker");
	});
});
