import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { renderRuntimeBundle } from "../src/bundle/runtime.ts";
import type { CodeL1Result, CodeValidationContext, CodeValidationExecutor } from "../src/code/worktree.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import { loadProposal, stageProposal } from "../src/proposal.ts";
import { readApprovalTurns } from "../src/proposal-artifacts.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import {
	askProposalQuestion,
	recordPermitDefer,
	recordPermitReopen,
	reviseProposalFromInstruction,
} from "../src/reflect/permit.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { Proposal } from "../src/types.ts";

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
	proposal: Proposal;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

function evidence() {
	return [
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
	];
}

function revisionResponse(change: { path: string; content: string } | { codePatch: string }): string {
	return JSON.stringify({
		observationsMarkdown: "# Revised proposal\n\nThe human requested a narrower implementation.",
		proposals: [
			{
				motivation: "Prevent the repeated unsafe shortcut without broadening unrelated behavior.",
				expectedEffect: "The worker should choose the safe path first.",
				risk: "The narrower rule could still overfit the cited cases.",
				verifyPlan: "Run L1 and an independent Critic review.",
				trialPlan: "Use the candidate for five sessions.",
				source: "pattern",
				evidence: evidence(),
				inboxReferences: [],
				replayScenarios: [{ sessionId: "recorded-session", sequence: 5 }],
				...("path" in change ? { changes: [change] } : { codePatch: change.codePatch }),
			},
		],
	});
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-permit-"));
	roots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const source = join(root, "bundle-source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(
		join(source, "policy.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				promptOrder: ["prompts/system.md"],
				coreAssets: ["prompts/system.md"],
				modelRouting: {
					worker: "fake/worker",
					reflector: "fake/reflector",
					critic: "fake/critic",
				},
				validation: {},
			},
			undefined,
			"\t",
		)}\n`,
	);
	await writeFile(join(source, "prompts", "system.md"), "Original core instruction.\n");
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "Permit test bundle",
	});
	await new BundleRegistry(paths).initialize(bundle.digest);

	const store = await createRecorderStore({
		paths,
		sessionId: "recorded-session",
		bundleDigest: bundle.digest,
		now: () => new Date("2026-07-14T00:00:00.000Z"),
	});
	await store.append({ type: "session_start", reason: "startup", cwd: root });
	await store.append({
		type: "before_agent_start",
		prompt: await store.storePayload("Initial request"),
		systemPrompt: await store.storePayload(
			`Base worker prompt\n\n${(await renderRuntimeBundle(bundle)).systemPromptAppend}`,
		),
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

	const proposal = await stageProposal({
		paths,
		parentDigest: bundle.digest,
		observationsMarkdown: "# Observation\n\nThe unsafe shortcut occurred twice.",
		draft: {
			motivation: "Prevent the repeated unsafe shortcut.",
			expectedEffect: "The worker should choose the safe path first.",
			risk: "The instruction could be over-broad.",
			verifyPlan: "Replay the failure point and run Critic.",
			trialPlan: "Use the candidate for five sessions.",
			source: "pattern",
			evidence: evidence(),
			inboxReferences: [],
			replayScenarios: [{ sessionId: "recorded-session", sequence: 5 }],
			changes: [{ path: "prompts/system.md", content: "First candidate core instruction.\n" }],
		},
	});

	const repository = join(root, "repository");
	await mkdir(join(repository, "src"), { recursive: true });
	git(repository, ["init", "--quiet"]);
	git(repository, ["config", "user.name", "Evo Test"]);
	git(repository, ["config", "user.email", "evo-test@example.invalid"]);
	await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
	git(repository, ["add", "src/value.ts"]);
	git(repository, ["commit", "--quiet", "-m", "initial"]);
	return { root, paths, repository, proposal };
}

describe("permit conversation", () => {
	it("answers a grounded question and journals question/answer turns", async () => {
		const fixture = await createFixture();
		const answerMarkdown =
			"The change is motivated by recorded-session:3 and recorded-session:5; both show the same repeated shortcut.";
		const runner = new FakeModelRunner([JSON.stringify({ answerMarkdown, evidence: evidence() })]);

		const result = await askProposalQuestion({
			paths: fixture.paths,
			runner,
			proposalId: fixture.proposal.id,
			expected: { revision: fixture.proposal.revision, diffDigest: fixture.proposal.diffDigest },
			question: "Why is this a core change?",
			cwd: fixture.root,
		});

		expect(result.answerMarkdown).toBe(answerMarkdown);
		expect(result.evidence).toEqual(evidence());
		expect(result.questionTurn).toMatchObject({ role: "human", kind: "question", revision: 1 });
		expect(result.answerTurn).toMatchObject({ role: "meta", kind: "answer", revision: 1 });
		expect(runner.requests).toHaveLength(1);
		expect(runner.requests[0].systemPrompt).toContain("Evo-Pi Permit adviser");
		expect(runner.requests[0].prompt).toContain("QUESTION MODE");
		expect(runner.requests[0].prompt).toContain("Session recorded-session, sequence 3");
		expect(runner.requests[0].model).toBe("fake/reflector");
		expect((await loadProposal(fixture.paths, fixture.proposal.id)).revision).toBe(1);
		expect((await readApprovalTurns(fixture.paths, fixture.proposal.id)).map((turn) => turn.kind)).toEqual([
			"question",
			"answer",
		]);
	});

	it("revises a T2 data proposal, then regenerates replay and Critic artifacts", async () => {
		const fixture = await createFixture();
		const oldDigest = fixture.proposal.diffDigest;
		const runner = new FakeModelRunner([
			revisionResponse({ path: "prompts/system.md", content: "Narrow revised core instruction.\n" }),
			"Old first action",
			"Candidate first action",
			"# Critic review\n\nsupported with replay limitations.",
		]);

		const revised = await reviseProposalFromInstruction({
			paths: fixture.paths,
			runner,
			proposalId: fixture.proposal.id,
			expected: { revision: 1, diffDigest: oldDigest },
			instruction: "Keep the direction, but make the core instruction narrower.",
			cwd: fixture.root,
			replayModel: "fake/replay",
		});

		expect(revised).toMatchObject({ revision: 2, kind: "data", tier: "T2", status: "pending" });
		expect(revised.diffDigest).not.toBe(oldDigest);
		expect(revised.artifacts.replay).toMatchObject({ revision: 2, diffDigest: revised.diffDigest });
		expect(revised.artifacts.review).toMatchObject({ revision: 2, diffDigest: revised.diffDigest });
		expect(runner.requests).toHaveLength(4);
		expect(runner.requests[0].prompt).toContain("REVISION MODE");
		expect(runner.requests[1].model).toBe("fake/replay");
		expect(runner.requests[2].model).toBe("fake/replay");
		expect(runner.requests[3].prompt).toContain("<counterfactual_replay>");
		expect(runner.requests[3].model).toBe("fake/critic");
		const turns = await readApprovalTurns(fixture.paths, fixture.proposal.id);
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({ kind: "revision-request", revision: 1, diffDigest: oldDigest });
		expect(turns[1]).toMatchObject({
			kind: "revision-result",
			revision: 2,
			diffDigest: revised.diffDigest,
		});
	});

	it("revises to code with faux L1, generate-only replay, and Critic review", async () => {
		const fixture = await createFixture();
		const validator = new FakeCodeValidator();
		const patch = replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;");
		const runner = new FakeModelRunner([
			revisionResponse({ codePatch: patch }),
			"Parent-context first action",
			"Hypothetical patched-agent first action",
			"# Critic review\n\nsupported after sandboxed L1 and bounded replay.",
		]);

		const revised = await reviseProposalFromInstruction({
			paths: fixture.paths,
			runner,
			proposalId: fixture.proposal.id,
			expected: { revision: 1, diffDigest: fixture.proposal.diffDigest },
			instruction: "Implement this as the smallest code change instead.",
			repositoryCwd: fixture.repository,
			codeValidationExecutor: validator,
			replayModel: "fake/replay",
		});

		expect(revised).toMatchObject({ revision: 2, kind: "code", tier: "T2" });
		expect(revised.l1.passed).toBe(true);
		expect(revised.artifacts.validation).toMatchObject({ revision: 2, diffDigest: revised.diffDigest });
		expect(revised.artifacts.replay).toMatchObject({ revision: 2, diffDigest: revised.diffDigest });
		expect(revised.artifacts.review).toMatchObject({ revision: 2, diffDigest: revised.diffDigest });
		expect(validator.calls).toHaveLength(1);
		expect(runner.requests).toHaveLength(4);
		expect(runner.requests[1].model).toBe("fake/replay");
		expect(runner.requests[1].systemPrompt).not.toContain("<evo-pi-code-replay-evaluation>");
		expect(runner.requests[2].model).toBe("fake/replay");
		expect(runner.requests[2].systemPrompt).toContain("<evo-pi-code-replay-evaluation>");
		expect(runner.requests[2].systemPrompt).toContain(`Proposal diff digest: ${revised.diffDigest}`);
		expect(runner.requests[2].systemPrompt).toContain(`Proposed patch JSON: ${JSON.stringify(revised.diff)}`);
		expect(runner.requests[2].prompt).toBe(runner.requests[1].prompt);
		expect(runner.requests[2].history).toBe(runner.requests[1].history);
		expect(runner.requests[3].systemPrompt).toContain("independent Evo-Pi Critic");
		expect(runner.requests[3].prompt).toContain("hypothetical model prediction conditioned on the patch");
		expect(runner.requests[3].prompt).toContain("<counterfactual_replay>");
		expect(runner.requests[3].prompt).toContain("candidate code was not loaded or executed");
	});

	it("requires exactly one grounded revision draft", async () => {
		const fixture = await createFixture();
		const invalid = JSON.parse(revisionResponse({ path: "prompts/system.md", content: "A candidate.\n" })) as {
			proposals: unknown[];
		};
		invalid.proposals = [];
		const runner = new FakeModelRunner([JSON.stringify(invalid)]);

		await expect(
			reviseProposalFromInstruction({
				paths: fixture.paths,
				runner,
				proposalId: fixture.proposal.id,
				expected: { revision: 1, diffDigest: fixture.proposal.diffDigest },
				instruction: "Narrow the proposal.",
			}),
		).rejects.toThrow("exactly one proposal draft");
		expect((await loadProposal(fixture.paths, fixture.proposal.id)).revision).toBe(1);
		expect((await readApprovalTurns(fixture.paths, fixture.proposal.id)).map((turn) => turn.kind)).toEqual([
			"revision-request",
		]);
	});

	it("records defer and reopen audit turns without changing proposal state", async () => {
		const fixture = await createFixture();
		const binding = {
			paths: fixture.paths,
			proposalId: fixture.proposal.id,
			revision: fixture.proposal.revision,
			diffDigest: fixture.proposal.diffDigest,
		};
		await recordPermitDefer({ ...binding, reason: "Need maintainer input", until: "2026-07-20" });
		await recordPermitReopen({ ...binding, reason: "Maintainer input received" });

		expect((await loadProposal(fixture.paths, fixture.proposal.id)).status).toBe("pending");
		expect(await readApprovalTurns(fixture.paths, fixture.proposal.id)).toMatchObject([
			{ role: "human", kind: "defer", revision: 1, diffDigest: fixture.proposal.diffDigest },
			{ role: "human", kind: "reopen", revision: 1, diffDigest: fixture.proposal.diffDigest },
		]);
	});
});
