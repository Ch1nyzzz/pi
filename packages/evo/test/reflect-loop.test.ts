import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { renderRuntimeBundle } from "../src/bundle/runtime.ts";
import type { CodeL1Result, CodeValidationContext, CodeValidationExecutor } from "../src/code/worktree.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import { readEvidenceReviewCursor } from "../src/reflect/evidence.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { runReflector, runReport } from "../src/reflect/reflector.ts";
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

class FakeCodeValidator implements CodeValidationExecutor {
	readonly calls: CodeValidationContext[] = [];

	async validate(context: CodeValidationContext): Promise<CodeL1Result> {
		this.calls.push({ ...context, changedPaths: [...context.changedPaths] });
		return { passed: true, errors: [], checks: [] };
	}
}

interface Fixture {
	root: string;
	paths: EvoPaths;
	repository: string;
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

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function replacementPatch(path: string, before: string, after: string): string {
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -1 +1 @@",
		`-${before}`,
		`+${after}`,
		"",
	].join("\n");
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
	const repository = join(root, "repository");
	await mkdir(join(repository, "src"), { recursive: true });
	git(repository, ["init", "--quiet"]);
	git(repository, ["config", "user.name", "Evo Test"]);
	git(repository, ["config", "user.email", "evo-test@example.invalid"]);
	await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
	git(repository, ["add", "src/value.ts"]);
	git(repository, ["commit", "--quiet", "-m", "initial"]);
	const oldSystemPrompt = `Base worker prompt\n\n${(await renderRuntimeBundle(bundle)).systemPromptAppend}`;
	const store = await createRecorderStore({
		paths,
		sessionId: "recorded-session",
		bundleDigest: bundle.digest,
		now: () => new Date("2026-07-13T00:00:00.000Z"),
	});
	await store.append({ type: "session_start", reason: "startup", cwd: repository });
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
	return { root, paths, repository, oldSystemPrompt };
}

function reflectorResponse(options: ReflectorResponseOptions): string {
	return JSON.stringify({
		observationsMarkdown: "# Observations\n\nThe same unsafe shortcut appeared twice.",
		observationEvidence: [
			{ sessionId: "recorded-session", sequence: 3, quote: "The agent repeated the unsafe shortcut." },
			{ sessionId: "recorded-session", sequence: 5, quote: "The agent repeated the unsafe shortcut again." },
		],
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

function codeReflectorResponse(codePatch: string, replay: boolean): string {
	return JSON.stringify({
		observationsMarkdown: "# Observations\n\nThe same unsafe shortcut appeared twice.",
		observationEvidence: [
			{ sessionId: "recorded-session", sequence: 3, quote: "The agent repeated the unsafe shortcut." },
			{ sessionId: "recorded-session", sequence: 5, quote: "The agent repeated the unsafe shortcut again." },
		],
		proposals: [
			{
				motivation: "Prevent the repeated unsafe shortcut in the implementation.",
				expectedEffect: "The worker should choose the safe path first.",
				risk: "The code change could affect unrelated callers.",
				verifyPlan: "Run fixed L1 checks and a bounded generate-only replay.",
				trialPlan: "Human reviews and merges the isolated branch manually.",
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
				replayScenarios: replay ? [{ sessionId: "recorded-session", sequence: 5 }] : [],
				codePatch,
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
		expect(proposal).toMatchObject({ kind: "data", tier: "T1", revision: 1 });
		expect(proposal.artifacts.review).toMatchObject({
			file: "revisions/1/review.md",
			revision: 1,
			diffDigest: proposal.diffDigest,
		});
		expect(proposal.l1.passed).toBe(true);
		expect(runner.requests).toHaveLength(2);
		expect(runner.requests[0].systemPrompt).toContain("Evo-Pi Reflector");
		expect(runner.requests[0].model).toBe("fake/reflector");
		expect(runner.requests[1].systemPrompt).toContain("independent Evo-Pi Critic");
		expect(runner.requests[1].model).toBe("fake/critic");
		expect(runner.requests[1].prompt).not.toContain("<counterfactual_replay>");
		expect(
			await readFile(join(fixture.paths.proposals, proposal.id, proposal.artifacts.review?.file ?? ""), "utf8"),
		).toContain("supported");
	});

	it("advances the review cursor only after success and keeps bundle and history context", async () => {
		const fixture = await createFixture(false);
		const store = await createRecorderStore({ paths: fixture.paths, sessionId: "recorded-session" });
		const oldInbox = await store.writeInbox("REQUEST: old-review-window-signal", "interactive");
		const failedRunner = new FakeModelRunner(["not valid reflector JSON"]);

		await expect(runReflector({ paths: fixture.paths, runner: failedRunner, cwd: fixture.root })).rejects.toThrow(
			"Reflector did not return a JSON object",
		);
		expect(await readEvidenceReviewCursor(fixture.paths)).toBeUndefined();

		const runner = new FakeModelRunner([
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nInitial review window.",
				observationEvidence: [
					{ sessionId: "recorded-session", sequence: 3, quote: "The agent repeated the unsafe shortcut." },
				],
				proposals: [],
			}),
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nIncremental review window.",
				observationEvidence: [{ sessionId: "recorded-session", sequence: 6, quote: "new-review-window-signal" }],
				proposals: [],
			}),
		]);

		const first = await runReflector({ paths: fixture.paths, runner, cwd: fixture.root });
		expect(first.corpus.mode).toBe("incremental");
		expect(runner.requests[0].prompt).toContain(oldInbox.entry.text);
		expect(await readFile(first.file, "utf8")).toContain("Initial review window.");
		expect(await readFile(first.file, "utf8")).toContain(`- Digest: ${first.corpus.evidenceDigest}`);
		expect(await readEvidenceReviewCursor(fixture.paths)).toMatchObject({
			inboxFiles: [oldInbox.fileName],
			sessionSequences: { "recorded-session": 5 },
		});

		const newInbox = await store.writeInbox("REQUEST: new-inbox-window-signal", "interactive");
		await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({ role: "user", content: "new-review-window-signal", timestamp: 4 }),
		});
		const second = await runReflector({ paths: fixture.paths, runner, cwd: fixture.root });

		expect(second.corpus.mode).toBe("incremental");
		expect(second.corpus.inboxFiles).toEqual([newInbox.fileName]);
		expect(runner.requests[1].prompt).toContain("new-review-window-signal");
		expect(runner.requests[1].prompt).toContain("new-inbox-window-signal");
		expect(runner.requests[1].prompt).not.toContain("old-review-window-signal");
		expect(runner.requests[1].prompt).not.toContain("unsafe shortcut again");
		expect(runner.requests[1].prompt).toContain("Original instruction.");
		expect(runner.requests[1].prompt).toContain('"action": "initialize"');
		expect(await readEvidenceReviewCursor(fixture.paths)).toMatchObject({
			inboxFiles: expect.arrayContaining([oldInbox.fileName, newInbox.fileName]),
			sessionSequences: { "recorded-session": 6 },
		});
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
		expect(proposal).toMatchObject({ kind: "data", tier: "T2", revision: 1 });
		expect(proposal.artifacts.replay).toMatchObject({
			file: "revisions/1/replay.md",
			revision: 1,
			diffDigest: proposal.diffDigest,
		});
		expect(proposal.artifacts.review).toMatchObject({
			file: "revisions/1/review.md",
			revision: 1,
			diffDigest: proposal.diffDigest,
		});
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
		const replayMarkdown = await readFile(
			join(fixture.paths.proposals, proposal.id, proposal.artifacts.replay?.file ?? ""),
			"utf8",
		);
		expect(replayMarkdown).toContain("Old first action");
		expect(replayMarkdown).toContain("Candidate first action");
		expect(replayMarkdown).toContain("not end-to-end task completion");
	});

	it("rejects a code proposal without a replay scenario before L1 validation", async () => {
		const fixture = await createFixture(false);
		const validator = new FakeCodeValidator();
		const patch = replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;");
		const runner = new FakeModelRunner([codeReflectorResponse(patch, false)]);

		await expect(
			runReflector({
				paths: fixture.paths,
				runner,
				cwd: fixture.repository,
				codeValidationExecutor: validator,
			}),
		).rejects.toThrow("Code proposals require at least one replay scenario");
		expect(validator.calls).toHaveLength(0);
		expect(runner.requests).toHaveLength(1);
	});

	it("runs a code T2 replay as a patch-conditioned generation without executing the candidate", async () => {
		const fixture = await createFixture(false);
		const validator = new FakeCodeValidator();
		const patch = replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;");
		const runner = new FakeModelRunner([
			codeReflectorResponse(patch, true),
			"Parent-context first action",
			"Hypothetical patched-agent first action",
			"# Review\n\nuncertain: the code replay is useful only as a bounded hypothesis.",
		]);

		const result = await runReflector({
			paths: fixture.paths,
			runner,
			cwd: fixture.repository,
			codeValidationExecutor: validator,
		});

		const proposal = result.proposals[0];
		expect(proposal).toMatchObject({ kind: "code", tier: "T2", revision: 1 });
		expect(proposal.replayScenarios).toEqual([{ sessionId: "recorded-session", sequence: 5 }]);
		expect(proposal.artifacts.validation).toMatchObject({ revision: 1, diffDigest: proposal.diffDigest });
		expect(proposal.artifacts.replay).toMatchObject({ revision: 1, diffDigest: proposal.diffDigest });
		expect(proposal.artifacts.review).toMatchObject({ revision: 1, diffDigest: proposal.diffDigest });
		expect(validator.calls).toHaveLength(1);
		expect(runner.requests).toHaveLength(4);
		const parentReplay = runner.requests[1];
		const candidateReplay = runner.requests[2];
		expect(parentReplay.model).toBe("fake/worker");
		expect(candidateReplay.model).toBe("fake/worker");
		expect(parentReplay.systemPrompt).toBe(fixture.oldSystemPrompt);
		expect(parentReplay.systemPrompt).not.toContain("<evo-pi-code-replay-evaluation>");
		expect(candidateReplay.systemPrompt).toContain("<evo-pi-code-replay-evaluation>");
		expect(candidateReplay.systemPrompt).toContain("no candidate code or tool is loaded or executable");
		expect(candidateReplay.systemPrompt).toContain(`Proposal diff digest: ${proposal.diffDigest}`);
		expect(candidateReplay.systemPrompt).toContain(`Proposed patch JSON: ${JSON.stringify(proposal.diff)}`);
		expect(candidateReplay.prompt).toBe(parentReplay.prompt);
		expect(candidateReplay.history).toBe(parentReplay.history);
		expect(candidateReplay.sessionIdentity).toBe(parentReplay.sessionIdentity);
		expect(runner.requests[3].prompt).toContain("hypothetical model prediction conditioned on the patch");
		expect(runner.requests[3].prompt).toContain("<counterfactual_replay>");
		const replayMarkdown = await readFile(
			join(fixture.paths.proposals, proposal.id, proposal.artifacts.replay?.file ?? ""),
			"utf8",
		);
		expect(replayMarkdown).toContain("Mode: `code-patch-hypothesis`");
		expect(replayMarkdown).toContain("Candidate runtime installed: no");
		expect(replayMarkdown).toContain("candidate code was not loaded or executed");
		expect(replayMarkdown).toContain("not implementation correctness or end-to-end task completion");
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

	it("persists validated report citations with the observations", async () => {
		const fixture = await createFixture(false);
		const runner = new FakeModelRunner([
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nThe unsafe shortcut recurred.",
				observationEvidence: [
					{
						sessionId: "recorded-session",
						sequence: 3,
						quote: "The agent repeated the unsafe shortcut.",
					},
				],
				proposals: [],
			}),
		]);

		const report = await runReport({ paths: fixture.paths, runner, cwd: fixture.root });

		const reportFile = await readFile(report.file, "utf8");
		expect(reportFile).toContain("- recorded-session:3");
		expect(reportFile).toContain("| report | 1 |");
		expect(report.observationsMarkdown).toContain("## Background model usage");
		expect(report.observationEvidence).toHaveLength(1);
	});

	it("limits the default report window to evidence recorded since the last improve", async () => {
		const fixture = await createFixture(false);
		const store = await createRecorderStore({ paths: fixture.paths, sessionId: "recorded-session" });
		await store.writeInbox("REQUEST: old-report-window-signal", "interactive");
		const runner = new FakeModelRunner([
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nReviewed once.",
				observationEvidence: [
					{ sessionId: "recorded-session", sequence: 3, quote: "The agent repeated the unsafe shortcut." },
				],
				proposals: [],
			}),
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nWindowed report.",
				observationEvidence: [{ sessionId: "recorded-session", sequence: 6, quote: "new-report-window-signal" }],
				proposals: [],
			}),
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nFull report.",
				observationEvidence: [
					{ sessionId: "recorded-session", sequence: 3, quote: "The agent repeated the unsafe shortcut." },
				],
				proposals: [],
			}),
		]);

		await runReflector({ paths: fixture.paths, runner, cwd: fixture.root });
		const cursorAfterImprove = await readEvidenceReviewCursor(fixture.paths);
		await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({ role: "user", content: "new-report-window-signal", timestamp: 4 }),
		});

		const windowed = await runReport({ paths: fixture.paths, runner, cwd: fixture.root });
		expect(windowed.corpus.mode).toBe("incremental");
		expect(runner.requests[1].prompt).toContain("new-report-window-signal");
		expect(runner.requests[1].prompt).not.toContain("old-report-window-signal");
		expect(await readEvidenceReviewCursor(fixture.paths)).toEqual(cursorAfterImprove);

		const full = await runReport({ paths: fixture.paths, runner, cwd: fixture.root, window: "full" });
		expect(full.corpus.mode).toBe("full");
		expect(runner.requests[2].prompt).toContain("old-report-window-signal");
	});

	it("rejects a report whose observations omit recorded-event citations", async () => {
		const fixture = await createFixture(false);
		const runner = new FakeModelRunner([
			JSON.stringify({
				observationsMarkdown: "# Observations\n\nAn unsupported claim.",
				observationEvidence: [],
				proposals: [],
			}),
		]);

		await expect(runReport({ paths: fixture.paths, runner, cwd: fixture.root })).rejects.toThrow(
			"Reflector observations must cite recorded session evidence",
		);
		expect(runner.requests).toHaveLength(1);
	});
});
