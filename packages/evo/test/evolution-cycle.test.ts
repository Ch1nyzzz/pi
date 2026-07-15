import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { runEvolutionCycle } from "../src/evolve/cycle.ts";
import { parseEvolutionResearchPlan } from "../src/evolve/research-plan.ts";
import { initializeInboxLifecycle, readInboxLifecycleStates } from "../src/inbox.ts";
import { getEvoPaths } from "../src/paths.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import { EvoService } from "../src/service.ts";
import type { EvoControlConfig } from "../src/types.ts";

class FakeRunner implements ModelRunner {
	readonly requests: ModelRunRequest[] = [];
	private readonly responses: string[];
	constructor(responses: string[]) {
		this.responses = responses;
	}
	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.requests.push(request);
		const text = this.responses.shift();
		if (text === undefined) throw new Error("No fake response");
		return {
			text,
			model: { provider: "fake", id: request.model ?? "default" },
			stats: {
				sessionFile: undefined,
				sessionId: `run-${this.requests.length}`,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				cost: 0,
			},
		};
	}
}

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config: EvoControlConfig = {
	schemaVersion: 1,
	models: {
		researchPlanner: { model: "fake/sol-ultra" },
		builder: { model: "fake/terra-max" },
		evaluator: { model: "fake/terra", thinkingLevel: "xhigh" },
	},
	release: {
		autoApplyT0: false,
		autoStartDataTrial: false,
		autoStartComponentTrial: false,
		autoKeepSuccessfulTrial: false,
	},
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-cycle-"));
	roots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const source = join(root, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await mkdir(join(source, "memory"), { recursive: true });
	await writeFile(join(source, "policy.json"), JSON.stringify({ schemaVersion: 1 }));
	await writeFile(join(source, "prompts", "system.md"), "Original instruction.\n");
	await writeFile(
		join(source, "memory", "preferences.json"),
		JSON.stringify({
			schemaVersion: 1,
			preferences: [
				{
					id: "design-first",
					instruction: "Prefer design-first implementation.",
					source: {
						sessionId: "preference-source",
						sequence: 1,
						quote: "Prefer design-first implementation.",
					},
					addedAt: "2026-07-13T00:00:00.000Z",
				},
			],
		}),
	);
	const bundle = await compileBundle({ paths, sourceDirectory: source, parentDigest: null, summary: "initial" });
	await new BundleRegistry(paths).initialize(bundle.digest);
	const store = await createRecorderStore({ paths, sessionId: "evidence-session", bundleDigest: bundle.digest });
	await store.append({ type: "session_start", reason: "startup", cwd: root });
	await store.append({
		type: "before_agent_start",
		prompt: await store.storePayload("first request"),
		systemPrompt: await store.storePayload("system"),
		systemPromptOptions: await store.storePayload({ cwd: root }),
	});
	await store.append({
		type: "message",
		role: "user",
		message: await store.storePayload({ role: "user", content: "Repeated friction happened.", timestamp: 1 }),
	});
	await store.append({
		type: "message",
		role: "assistant",
		message: await store.storePayload({ role: "assistant", content: "ack", timestamp: 2 }),
	});
	await store.append({
		type: "message",
		role: "user",
		message: await store.storePayload({ role: "user", content: "Repeated friction happened again.", timestamp: 3 }),
	});
	return { root, paths, service: new EvoService(paths) };
}

function planResponse(candidateKind: "none" | "data" = "data") {
	return JSON.stringify({
		topic: "reduce repeated friction",
		reason: "Two grounded occurrences exist.",
		planMarkdown: "# Plan\n\nMeasure the baseline, then make one data change.",
		experiment: {
			baseline: "Original instruction",
			hypothesis: "A narrow instruction reduces repetition.",
			checkProfiles: ["bundle-compile", "session-comparison"],
			metrics: ["followUpsPerTask"],
			minimumEffect: { followUpsPerTask: 0.1 },
			trialPlan: "Run ten sessions.",
			rollbackConditions: ["More user correction"],
		},
		requiresNewAbi: false,
		candidateKind,
		builderInstructions: candidateKind === "none" ? "No safe candidate." : "Edit prompts/system.md only.",
	});
}

function builderResponse() {
	return JSON.stringify({
		observationsMarkdown: "# Evidence\n\nThe friction repeated twice.",
		observationEvidence: [],
		proposals: [
			{
				motivation: "Reduce repeated friction.",
				expectedEffect: "The same task should need fewer follow-ups.",
				risk: "The instruction may be over-broad.",
				verifyPlan: "Compile and compare sessions.",
				trialPlan: "This value is replaced by the frozen plan.",
				source: "pattern",
				evidence: [
					{ sessionId: "evidence-session", sequence: 3, quote: "Repeated friction happened." },
					{ sessionId: "evidence-session", sequence: 5, quote: "Repeated friction happened again." },
				],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "prompts/system.md", content: "Avoid the repeated friction.\n" }],
			},
		],
	});
}

describe("fixed evolution cycle", () => {
	it("runs Sol plan, Terra build, and two fresh Terra XHigh evaluation passes", async () => {
		const f = await fixture();
		const runner = new FakeRunner([
			planResponse(),
			builderResponse(),
			"The candidate matches the frozen experiment.\nRecommendation: supported",
			"A real trial is still needed.\nRecommendation: uncertain",
		]);
		const result = await runEvolutionCycle({
			paths: f.paths,
			service: f.service,
			runner,
			cwd: f.root,
			config,
		});
		expect(result.run.status).toBe("completed");
		expect(result.proposals).toHaveLength(1);
		expect(result.evaluation?.verdict).toBe("uncertain");
		expect(result.release?.action).toBe("review");
		expect(runner.requests.map((request) => request.model)).toEqual([
			"fake/sol-ultra",
			"fake/terra-max",
			"fake/terra",
			"fake/terra",
		]);
		expect(runner.requests[0].tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"evo_research_search",
			"evo_research_fetch",
		]);
		expect(runner.requests[0].customTools?.map((tool) => tool.name)).toEqual([
			"evo_research_search",
			"evo_research_fetch",
		]);
		expect(runner.requests[0].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[1].prompt).toContain("<research_plan>");
		expect(runner.requests[1].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[2].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[2].thinkingLevel).toBe("xhigh");
		expect(runner.requests[3].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[3].systemPrompt).toContain("adversarial");
		expect(result.proposals[0].artifacts.review?.file).toBe("revisions/1/review.md");
	});

	it("materializes an existing-ABI component and starts a reversible component trial", async () => {
		const f = await fixture();
		const componentPlan = JSON.stringify({
			...JSON.parse(planResponse()),
			topic: "compaction",
			candidateKind: "component",
			targetAbi: "compaction/v1",
			experiment: {
				...JSON.parse(planResponse()).experiment,
				checkProfiles: ["bundle-compile", "compaction-replay"],
			},
		});
		const entrypointContent = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const request = JSON.parse(line);
  const result = request.method === "invoke" ? {
    summary: request.payload.conversation,
    firstKeptEntryId: request.payload.firstKeptEntryId
  } : {};
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
});`;
		const componentBuilder = JSON.stringify({
			observationsMarkdown: "# Evidence\n\nThe friction repeated twice.",
			observationEvidence: [],
			proposal: {
				motivation: "Test a replaceable compaction strategy.",
				expectedEffect: "Compaction should preserve the same evidence with a replaceable implementation.",
				risk: "Semantic information may be lost.",
				verifyPlan: "Compile and replay compaction.",
				trialPlan: "Use the frozen trial.",
				source: "pattern",
				evidence: [
					{ sessionId: "evidence-session", sequence: 3, quote: "Repeated friction happened." },
					{ sessionId: "evidence-session", sequence: 5, quote: "Repeated friction happened again." },
				],
				inboxReferences: [],
				replayScenarios: [{ sessionId: "evidence-session", sequence: 5 }],
			},
			component: {
				id: "test-compaction",
				version: "1.0.0",
				capabilities: [],
				config: {},
				entrypointContent,
			},
		});
		const runner = new FakeRunner([
			componentPlan,
			componentBuilder,
			"Baseline first action",
			"Candidate first action",
			"The ABI and bundle checks pass; use a trial.\nRecommendation: supported",
			"A semantic trial remains necessary.\nRecommendation: uncertain",
		]);
		const componentConfig: EvoControlConfig = {
			...config,
			release: { ...config.release, autoStartComponentTrial: true },
		};
		const result = await runEvolutionCycle({
			paths: f.paths,
			service: f.service,
			runner,
			cwd: f.root,
			config: componentConfig,
		});
		expect(result.release?.action).toBe("trial");
		expect(result.proposals[0]).toMatchObject({
			kind: "data",
			tier: "T2",
			targetAbi: "compaction/v1",
			status: "trialing",
		});
		expect(await f.service.registry.readTrial()).toMatchObject({ proposalId: result.proposals[0].id });
	});

	it("can finish after research without forcing a candidate", async () => {
		const f = await fixture();
		const runner = new FakeRunner([planResponse("none")]);
		const result = await runEvolutionCycle({ paths: f.paths, service: f.service, runner, cwd: f.root, config });
		expect(result.proposals).toEqual([]);
		expect(result.run.status).toBe("completed");
		expect(runner.requests).toHaveLength(1);
	});

	it("classifies feature-shaped natural language as an open request rather than a durable preference", async () => {
		const f = await fixture();
		const store = await createRecorderStore({ paths: f.paths, sessionId: "request-session" });
		const inbox = await store.writeInbox("希望每次对话显示实时计时", "interactive", "candidate");
		await initializeInboxLifecycle(f.paths, inbox.fileName);
		const response = JSON.stringify({
			...JSON.parse(planResponse("none")),
			inboxDecisions: [
				{
					file: inbox.fileName,
					kind: "request",
					reason: "This asks for a new UI capability rather than a cross-task behavior default.",
				},
			],
		});
		await runEvolutionCycle({
			paths: f.paths,
			service: f.service,
			runner: new FakeRunner([response]),
			cwd: f.root,
			config,
		});
		expect((await readInboxLifecycleStates(f.paths)).get(inbox.fileName)).toMatchObject({
			kind: "request",
			status: "open",
		});
	});

	it("rejects a component plan for an ABI the host did not predefine", () => {
		expect(() =>
			parseEvolutionResearchPlan(
				JSON.stringify({
					...JSON.parse(planResponse()),
					candidateKind: "component",
					targetAbi: "invented/v1",
				}),
			),
		).toThrow("Unknown Evo component ABI");
	});
});
