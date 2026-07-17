import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { approveCanaryRun, directKeepCanaryRun } from "../src/cli.ts";
import { listEvoActivityItems } from "../src/evolve/activity.ts";
import { runEvolutionCycle } from "../src/evolve/cycle.ts";
import { EvolutionProcessInspector } from "../src/evolve/inspect-ui.ts";
import { applyEvolutionReleasePolicy } from "../src/evolve/release.ts";
import { parseEvolutionResearchPlanValue } from "../src/evolve/research-plan.ts";
import { resumeEvolutionEvidence, retryEvolutionFromValidation } from "../src/evolve/retry.ts";
import { evolutionRunDirectory, listEvolutionRuns, readEvolutionRun, updateEvolutionRun } from "../src/evolve/run.ts";
import { initializeInboxLifecycle, readInboxLifecycleStates } from "../src/inbox.ts";
import { getEvoPaths } from "../src/paths.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import { EvoService } from "../src/service.ts";
import type { EvoControlConfig } from "../src/types.ts";

type FakeResponse = string | { text?: string; submission?: unknown };

class FakeRunner implements ModelRunner {
	readonly requests: ModelRunRequest[] = [];
	private readonly responses: FakeResponse[];
	constructor(responses: FakeResponse[]) {
		this.responses = responses;
	}
	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.requests.push(request);
		const response = this.responses.shift();
		if (response === undefined) throw new Error("No fake response");
		const normalized = typeof response === "string" ? { text: response } : response;
		if (request.submission && normalized.submission === undefined) {
			throw new Error(`Fake response is missing a ${request.submission.toolName} submission`);
		}
		const validated =
			request.submission && normalized.submission !== undefined
				? await request.submission.validate?.(normalized.submission as Record<string, unknown>)
				: undefined;
		const submission = validated ?? normalized.submission;
		return {
			text: normalized.text ?? "",
			...(submission !== undefined ? { submission } : {}),
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
		triage: { model: "fake/luna" },
	},
	release: {
		autoApplyT0: false,
		autoStartDataTrial: false,
		autoStartComponentTrial: false,
		autoKeepSuccessfulTrial: false,
	},
	grants: {
		approval: "auto",
	},
	triage: {
		everyNSessions: 5,
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
			evidenceStrategy: {
				patchClass: "prompt",
				offline: { mode: "required", profiles: ["bundle-compile"] },
				historicalReplay: {
					mode: "optional",
					reason: "Historical sessions improve confidence but are not causal.",
				},
				online: { mode: "canary", minimumSamples: 10, maximumDuration: "14d" },
				rollout: "canary-first",
			},
			metrics: ["followUpsPerTask"],
			primaryMetric: "followUpsPerTask",
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
			{ submission: JSON.parse(planResponse()) },
			{ submission: JSON.parse(builderResponse()) },
			{
				submission: {
					verdict: "verified",
					summary: "The candidate matches the frozen experiment.",
					findings: [],
				},
			},
			{
				submission: {
					verdict: "needs-evidence",
					summary: "A real trial is still needed.",
					findings: [{ title: "Trial pending", detail: "No online samples exist yet." }],
				},
			},
		]);
		const result = await runEvolutionCycle({
			paths: f.paths,
			service: f.service,
			runner,
			cwd: f.root,
			config,
		});
		expect(result.run.status).toBe("awaiting-evidence");
		expect(result.proposals).toHaveLength(1);
		expect(result.evaluation?.verdict).toBe("needs-evidence");
		expect(result.release?.action).toBe("needs-evidence");
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
		expect(runner.requests[0].prompt).toContain("<evidence_corpus_index");
		expect(runner.requests[0].prompt).not.toContain("<evidence_corpus ");
		expect(runner.requests[0].prompt).toContain("corpus/sessions/evidence-session.md");
		expect(runner.requests[0].prompt).not.toContain("Repeated friction happened.");
		const corpusDirectory = join(evolutionRunDirectory(f.paths, result.run.id), "corpus");
		const renderedSession = await readFile(join(corpusDirectory, "sessions", "evidence-session.md"), "utf8");
		expect(renderedSession).toContain("Repeated friction happened.");
		expect(renderedSession).toContain("## Digest");
		const rawSession = await readFile(join(corpusDirectory, "sessions-raw", "evidence-session.json"), "utf8");
		expect(JSON.parse(rawSession)).toHaveLength(5);
		expect(runner.requests[1].prompt).toContain("<research_plan>");
		expect(runner.requests[1].prompt).toContain("<evidence_corpus_index");
		expect(runner.requests[1].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[2].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[2].thinkingLevel).toBe("xhigh");
		expect(runner.requests[3].prompt).toContain("Prefer design-first implementation.");
		expect(runner.requests[3].systemPrompt).toContain("adversarial");
		expect(result.proposals[0].artifacts.review?.file).toBe("revisions/1/review.md");

		await updateEvolutionRun(f.paths, result.run.id, { status: "failed" });
		const historicalActivity = await listEvoActivityItems(
			{ paths: f.paths, service: f.service },
			{ includeHistory: true },
		);
		expect(historicalActivity.map((item) => item.key)).toContain(`proposal:${result.proposals[0].id}`);
		expect(historicalActivity.find((item) => item.key === `proposal:${result.proposals[0].id}`)?.text).toContain(
			"等待处理",
		);
	});

	it("materializes an existing-ABI component and waits for explicit Canary approval", async () => {
		const f = await fixture();
		const componentPlan = JSON.stringify({
			...JSON.parse(planResponse()),
			topic: "compaction",
			candidateKind: "component",
			targetAbi: "compaction/v1",
			experiment: {
				...JSON.parse(planResponse()).experiment,
				checkProfiles: ["bundle-compile", "compaction-replay"],
				evidenceStrategy: {
					patchClass: "component",
					offline: { mode: "required", profiles: ["bundle-compile"] },
					historicalReplay: {
						mode: "not-applicable",
						reason: "This fixture has no recorded compaction boundary; runtime effects require Canary evidence.",
					},
					online: { mode: "canary", minimumSamples: 2, maximumDuration: "1d" },
					rollout: "canary-first",
				},
			},
		});
		const entrypointContent = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const request = JSON.parse(line);
  const result = request.method === "invoke" ? {
    summary: request.payload.previousSummary
      ? request.payload.previousSummary + "\\n" + request.payload.conversation
      : request.payload.conversation,
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
			{ submission: JSON.parse(componentPlan) },
			{ submission: JSON.parse(componentBuilder) },
			{
				submission: {
					verdict: "verified",
					summary: "The ABI and bundle checks pass; use a trial.",
					findings: [],
				},
			},
			{
				submission: {
					verdict: "needs-evidence",
					summary: "A semantic trial remains necessary.",
					findings: [],
				},
			},
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
			componentSandbox: false,
		});
		expect(result.release?.action).toBe("awaiting-canary-approval");
		expect(result.run.status).toBe("awaiting-canary-approval");
		expect(result.proposals[0]).toMatchObject({
			kind: "data",
			tier: "T1",
			targetAbi: "compaction/v1",
			status: "pending",
		});
		expect(result.proposals[0].artifacts.replay).toBeUndefined();
		const activity = await listEvoActivityItems({ paths: f.paths, service: f.service });
		expect(activity[0]?.text).toBe("Evo: compaction/test · 等待发布确认 · [↓ 后 Enter 展开]");
		expect(activity[0]?.text).not.toContain(result.run.id);
		expect(activity[0]?.text).not.toContain(result.proposals[0].id);
		expect(runner.requests).toHaveLength(4);
		expect(await f.service.registry.readTrial()).toBeUndefined();
		const componentStrategy = JSON.parse(componentPlan).experiment.evidenceStrategy;
		expect(
			await applyEvolutionReleasePolicy({
				service: f.service,
				config: { ...componentConfig, release: { ...componentConfig.release, autoStartComponentTrial: false } },
				proposal: result.proposals[0],
				verdict: "needs-evidence",
				evidenceStrategy: componentStrategy,
				receipts: new Map([
					[
						"bundle-compile" as const,
						{
							schemaVersion: 1 as const,
							profile: "bundle-compile" as const,
							passed: true,
							executedAt: new Date(0).toISOString(),
							summary: "compiled",
						},
					],
				]),
			}),
		).toMatchObject({ action: "review", reason: "Component Canary is disabled by local release policy" });
		expect(
			await applyEvolutionReleasePolicy({
				service: f.service,
				config: componentConfig,
				proposal: result.proposals[0],
				verdict: "needs-evidence",
				evidenceStrategy: {
					...componentStrategy,
					historicalReplay: {
						mode: "required",
						profiles: ["paired-replay"],
						datasets: ["recorded-long-sessions"],
						minimumSamples: 2,
					},
				},
				receipts: new Map(),
			}),
		).toMatchObject({
			action: "needs-evidence",
			reason: "Required evidence profiles have no passing execution receipt: bundle-compile, paired-replay",
		});

		await f.service.reject(result.proposals[0].id, "Legacy evaluator rejected before executable validation");
		await updateEvolutionRun(f.paths, result.run.id, { status: "completed", experimentDigest: undefined });
		const retried = await retryEvolutionFromValidation({
			paths: f.paths,
			sourceRunId: result.run.id,
			cwd: f.root,
			sandbox: false,
		});
		expect((await readEvolutionRun(f.paths, result.run.id)).experimentDigest).toMatch(/^[a-f0-9]{64}$/);
		const sourceExperimentPath = join(evolutionRunDirectory(f.paths, result.run.id), "experiment.json");
		const sourceExperiment = await readFile(sourceExperimentPath, "utf8");
		await writeFile(sourceExperimentPath, JSON.stringify({ tampered: true }));
		await expect(
			retryEvolutionFromValidation({
				paths: f.paths,
				sourceRunId: result.run.id,
				cwd: f.root,
				sandbox: false,
			}),
		).rejects.toThrow("frozen experiment changed");
		await writeFile(sourceExperimentPath, sourceExperiment);
		const retryRun = await readEvolutionRun(f.paths, retried.runId);
		expect(retryRun).toMatchObject({
			status: "awaiting-canary-approval",
			retryOfRunId: result.run.id,
			sourceProposalId: result.proposals[0].id,
		});
		expect(await readFile(join(evolutionRunDirectory(f.paths, retried.runId), "validation.md"), "utf8")).toContain(
			"exact append-prefix preservation: passed",
		);
		expect(retried.proposal.artifacts).toMatchObject({
			replay: { diffDigest: retried.proposal.diffDigest },
			validation: { diffDigest: retried.proposal.diffDigest },
			review: { diffDigest: retried.proposal.diffDigest },
		});
		const tui = { terminal: { rows: 200 }, requestRender: () => {} };
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		let reviewedRun: string | undefined;
		let reviewedDecision: unknown;
		const inspector = new EvolutionProcessInspector(
			tui as never,
			theme as never,
			f.paths,
			f.service,
			`run:${retried.runId}`,
			() => {},
			async (runId, decision) => {
				reviewedRun = runId;
				reviewedDecision = decision;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const canaryCard = inspector.render(160).join("\n");
		expect(canaryCard).toContain("Exact diff");
		expect(canaryCard).toContain("test-compaction");
		expect(canaryCard).not.toContain(retried.proposal.id);
		expect(canaryCard).toContain("人工发布决策");
		expect(canaryCard).toContain("直接上线，跳过 Canary");
		inspector.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reviewedRun).toBe(retried.runId);
		expect(reviewedDecision).toEqual({ mode: "canary", customization: "default" });
		inspector.dispose();

		let directDecision: unknown;
		const directInspector = new EvolutionProcessInspector(
			tui as never,
			theme as never,
			f.paths,
			f.service,
			`run:${retried.runId}`,
			() => {},
			async (_runId, decision) => {
				directDecision = decision;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		directInspector.handleInput("\u001b[C");
		directInspector.handleInput("\u001b[C");
		directInspector.handleInput("\r");
		expect(directInspector.render(160).join("\n")).toContain("直接上线将跳过所有 Canary 效果证据");
		directInspector.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(directDecision).toEqual({ mode: "direct" });
		directInspector.dispose();

		await updateEvolutionRun(f.paths, retried.runId, { canaryCandidateDigest: "0".repeat(64) });
		await expect(approveCanaryRun({ service: f.service, paths: f.paths }, retried.runId)).rejects.toThrow(
			"Canary review metadata no longer matches",
		);
		await updateEvolutionRun(f.paths, retried.runId, { canaryCandidateDigest: retried.proposal.candidateDigest });
		await approveCanaryRun({ service: f.service, paths: f.paths }, retried.runId, {
			mode: "canary",
			customization: "custom",
			minimumSamples: 4,
			maximumDurationDays: 3,
		});
		expect(await f.service.registry.readTrial()).toMatchObject({
			proposalId: retried.proposal.id,
			canary: { customization: "custom", minimumSamples: 4, maximumDurationDays: 3 },
		});
		expect(await readEvolutionRun(f.paths, retried.runId)).toMatchObject({
			status: "trialing",
			canaryApprovalDigest: retried.proposal.approvalDigest,
			canaryStableDigest: retried.proposal.parentBundleDigest,
			componentApprovalMode: "custom-canary",
			canaryMinimumSamples: 4,
			canaryMaximumDurationDays: 3,
		});
		const customDeadline = () => new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
		expect(
			(await listEvoActivityItems({ paths: f.paths, service: f.service }, { now: customDeadline }))[0]?.text,
		).toContain("comparison pending");
		let keepRun: string | undefined;
		const activeInspector = new EvolutionProcessInspector(
			tui as never,
			theme as never,
			f.paths,
			f.service,
			`run:${retried.runId}`,
			() => {},
			async () => {},
			async (runId) => {
				keepRun = runId;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(activeInspector.render(160).join("\n")).toContain("compaction/test");
		activeInspector.handleInput("\r");
		expect(activeInspector.render(160).join("\n")).toContain("立即正式上线将结束 Canary");
		activeInspector.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(keepRun).toBe(retried.runId);
		activeInspector.dispose();
		await directKeepCanaryRun({ service: f.service, paths: f.paths }, retried.runId);
		expect(await f.service.registry.readTrial()).toBeUndefined();
		expect(await f.service.getProposal(retried.proposal.id)).toMatchObject({ status: "kept" });
		expect(await readEvolutionRun(f.paths, retried.runId)).toMatchObject({
			status: "completed",
			componentApprovalMode: "direct",
		});
		await f.service.rollback(undefined, "Finish direct-kept Canary lifecycle test");
		expect((await listEvolutionRuns(f.paths)).find((run) => run.id === retried.runId)?.status).toBe("completed");

		const direct = await retryEvolutionFromValidation({
			paths: f.paths,
			sourceRunId: result.run.id,
			cwd: f.root,
			sandbox: false,
		});
		await approveCanaryRun({ service: f.service, paths: f.paths }, direct.runId, { mode: "direct" });
		expect(await f.service.registry.readTrial()).toBeUndefined();
		expect(await f.service.getProposal(direct.proposal.id)).toMatchObject({ status: "kept" });
		expect(await readEvolutionRun(f.paths, direct.runId)).toMatchObject({
			status: "completed",
			componentApprovalMode: "direct",
		});
		const history = (await readFile(f.paths.history, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string });
		expect(history.some((entry) => entry.action === "human-direct-keep")).toBe(true);
	});

	it("resumes an awaiting-evidence run by executing the missing replay receipt", async () => {
		const f = await fixture();
		const plan = {
			...JSON.parse(planResponse()),
		};
		plan.experiment.checkProfiles = ["bundle-compile", "paired-replay"];
		plan.experiment.evidenceStrategy.historicalReplay = {
			mode: "required",
			profiles: ["paired-replay"],
			datasets: ["evidence-session"],
			minimumSamples: 1,
		};
		const builder = JSON.parse(builderResponse());
		builder.proposals[0].replayScenarios = [{ sessionId: "evidence-session", sequence: 3 }];
		const cycleRunner = new FakeRunner([
			{ submission: plan },
			{ submission: builder },
			{ submission: { verdict: "verified", summary: "Deterministic checks pass.", findings: [] } },
			{ submission: { verdict: "verified", summary: "No falsification found.", findings: [] } },
		]);
		const result = await runEvolutionCycle({
			paths: f.paths,
			service: f.service,
			runner: cycleRunner,
			cwd: f.root,
			config,
		});
		// The required paired-replay receipt is missing, so the deterministic gate holds.
		expect(result.run.status).toBe("awaiting-evidence");
		expect(result.release?.reason).toContain("paired-replay");

		const resumeRunner = new FakeRunner([
			"old bundle answer",
			"candidate bundle answer",
			{ submission: { verdict: "verified", summary: "Replay evidence supports the change.", findings: [] } },
			{ submission: { verdict: "verified", summary: "No falsification found after replay.", findings: [] } },
		]);
		const resumed = await resumeEvolutionEvidence({
			paths: f.paths,
			runner: resumeRunner,
			runId: result.run.id,
			cwd: f.root,
			config,
		});
		expect(resumed.executedProfilesNow).toEqual(["paired-replay"]);
		// All receipts now pass; the data proposal moves to human review because
		// automatic data trials are disabled in this test config.
		expect(resumed.release.action).toBe("review");
		expect(resumed.run.status).toBe("awaiting-decision");
		const receipt = JSON.parse(
			await readFile(join(evolutionRunDirectory(f.paths, result.run.id), "receipts", "paired-replay.json"), "utf8"),
		);
		expect(receipt).toMatchObject({ profile: "paired-replay", passed: true });
	});

	it("can finish after research without forcing a candidate", async () => {
		const f = await fixture();
		const runner = new FakeRunner([{ submission: JSON.parse(planResponse("none")) }]);
		const result = await runEvolutionCycle({ paths: f.paths, service: f.service, runner, cwd: f.root, config });
		expect(result.proposals).toEqual([]);
		expect(result.run.status).toBe("completed");
		expect(runner.requests).toHaveLength(1);
	});

	it("feeds triage hypotheses to scheduled research and keeps request-channel runs narrow", async () => {
		const scheduled = await fixture();
		const scheduledStore = await createRecorderStore({ paths: scheduled.paths, sessionId: "triage-session" });
		const scheduledNote = await scheduledStore.writeInbox(
			"NOTE: triage hypothesis (reduce-tool-errors): bash verification keeps failing across recent sessions [evidence sessions: s1, s2]",
			"extension",
			"note",
		);
		await initializeInboxLifecycle(scheduled.paths, scheduledNote.fileName);
		const scheduledRunner = new FakeRunner([{ submission: JSON.parse(planResponse("none")) }]);
		await runEvolutionCycle({
			paths: scheduled.paths,
			service: scheduled.service,
			runner: scheduledRunner,
			cwd: scheduled.root,
			config,
		});
		expect(scheduledRunner.requests[0]?.prompt).toContain("<triage_hypotheses>");
		expect(scheduledRunner.requests[0]?.prompt).toContain("reduce-tool-errors");
		expect(scheduledRunner.requests[0]?.prompt).not.toContain("request-channel run");

		const requested = await fixture();
		const requestedStore = await createRecorderStore({ paths: requested.paths, sessionId: "triage-session" });
		const requestedNote = await requestedStore.writeInbox(
			"NOTE: triage hypothesis (reduce-tool-errors): bash verification keeps failing across recent sessions",
			"extension",
			"note",
		);
		await initializeInboxLifecycle(requested.paths, requestedNote.fileName);
		const requestedRunner = new FakeRunner([{ submission: JSON.parse(planResponse("none")) }]);
		await runEvolutionCycle({
			paths: requested.paths,
			service: requested.service,
			runner: requestedRunner,
			cwd: requested.root,
			config,
			request: "reduce prompt caching misses",
		});
		expect(requestedRunner.requests[0]?.prompt).toContain("request-channel run");
		expect(requestedRunner.requests[0]?.prompt).toContain("reduce prompt caching misses");
		expect(requestedRunner.requests[0]?.prompt).not.toContain("<triage_hypotheses>");
	});

	it("classifies feature-shaped natural language as an open request rather than a durable preference", async () => {
		const f = await fixture();
		const store = await createRecorderStore({ paths: f.paths, sessionId: "request-session" });
		const inbox = await store.writeInbox("希望每次对话显示实时计时", "interactive", "candidate");
		await initializeInboxLifecycle(f.paths, inbox.fileName);
		const response = {
			...JSON.parse(planResponse("none")),
			inboxDecisions: [
				{
					file: inbox.fileName,
					kind: "request",
					reason: "This asks for a new UI capability rather than a cross-task behavior default.",
				},
			],
		};
		await runEvolutionCycle({
			paths: f.paths,
			service: f.service,
			runner: new FakeRunner([{ submission: response }]),
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
			parseEvolutionResearchPlanValue({
				...JSON.parse(planResponse()),
				candidateKind: "component",
				targetAbi: "invented/v1",
			}),
		).toThrow("Unknown Evo component ABI");
	});
});
