import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import type { CodeL1Result, CodeValidationContext, CodeValidationExecutor } from "../src/code/worktree.ts";
import { getEvoPaths } from "../src/paths.ts";
import { approveProposal, type DraftProposal, proposalApproval, saveProposal, stageProposal } from "../src/proposal.ts";
import {
	saveProposalRevisionSnapshot,
	writeEvaluationArtifact,
	writeRetrospectiveArtifact,
} from "../src/proposal-artifacts.ts";
import type { RecorderInboxEntry } from "../src/recorder/schema.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import { collectEvidenceCorpus } from "../src/reflect/evidence.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { runRetrospective } from "../src/reflect/retrospective.ts";
import type {
	BundleRegistryOptions,
	RegistryTransitionAction,
	RegistryTransitionStep,
} from "../src/registry/registry.ts";
import { EvoService } from "../src/service.ts";
import type { Proposal, ProposalArtifactKind } from "../src/types.ts";

class PassingCodeValidator implements CodeValidationExecutor {
	readonly calls: CodeValidationContext[] = [];

	async validate(context: CodeValidationContext): Promise<CodeL1Result> {
		this.calls.push({ ...context, changedPaths: [...context.changedPaths] });
		return { passed: true, errors: [], checks: [] };
	}
}

class FakeRetrospectiveRunner implements ModelRunner {
	readonly requests: ModelRunRequest[] = [];

	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.requests.push(request);
		return {
			text: "# Trial retrospective\n\nThe trial should be kept.",
			model: { provider: "fake", id: "retrospective" },
			stats: {
				sessionFile: undefined,
				sessionId: "retrospective-test",
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

describe("EvoService", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createService(registryOptions: BundleRegistryOptions = {}): Promise<EvoService> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-service-"));
		temporaryDirectories.push(root);
		return new EvoService(getEvoPaths(root), registryOptions);
	}

	function failOnceAt(action: RegistryTransitionAction, step: RegistryTransitionStep): BundleRegistryOptions {
		let failed = false;
		return {
			afterTransitionStep(currentStep, currentAction) {
				if (!failed && currentAction === action && currentStep === step) {
					failed = true;
					throw new Error(`simulated ${action} interruption after ${step}`);
				}
			},
		};
	}

	async function historyEntries(service: EvoService): Promise<Array<{ action: string; eventId?: string }>> {
		const content = await readFile(service.paths.history, "utf8");
		return content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string; eventId?: string });
	}

	function approval(proposal: Proposal) {
		return proposalApproval(proposal);
	}

	async function attachArtifact(
		service: EvoService,
		proposal: Proposal,
		kind: ProposalArtifactKind,
		content: string,
	): Promise<void> {
		proposal.artifacts[kind] = await writeEvaluationArtifact({
			paths: service.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			kind,
			content,
		});
		await saveProposal(service.paths, proposal);
		await saveProposalRevisionSnapshot(service.paths, proposal);
	}

	async function attachRetrospectiveFixture(service: EvoService, proposal: Proposal): Promise<void> {
		const current = await service.getProposal(proposal.id);
		const corpus = await collectEvidenceCorpus(service.paths, { mode: "full" });
		current.artifacts.retrospective = await writeRetrospectiveArtifact({
			paths: service.paths,
			proposalId: current.id,
			revision: current.revision,
			diffDigest: current.diffDigest,
			content: "# Retrospective\n\nFixture supports keeping this trial.\n",
			evidenceDigest: corpus.evidenceDigest,
			evidenceCutoff: corpus.nextReviewCursor.updatedAt,
		});
		await saveProposal(service.paths, current);
		await saveProposalRevisionSnapshot(service.paths, current);
	}

	async function stageReviewedT1(service: EvoService, parentDigest: string, suffix: string): Promise<Proposal> {
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest,
			observationsMarkdown: "The candidate exercises transactional recovery.",
			draft: {
				motivation: "Exercise registry transaction recovery",
				expectedEffect: `Transactional candidate ${suffix} remains consistent`,
				risk: "A process may stop between durable writes",
				verifyPlan: "Interrupt and retry the exact transition",
				trialPlan: "Use for one recovery trial",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [
					{
						path: `memory/transaction-${suffix}.md`,
						content: `Transactional candidate ${suffix}.\n`,
					},
				],
			},
		});
		expect(proposal.tier).toBe("T1");
		await attachArtifact(service, proposal, "review", "# Review\n\nSupported for recovery testing.\n");
		return proposal;
	}

	it("initializes, trials, and rolls back a T1 data proposal", async () => {
		const service = await createService();
		const seed = await service.init();
		expect(seed.manifest.parentDigest).toBeNull();
		expect(seed.manifest.files.map((file) => file.path)).toEqual(["policy.json"]);
		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.init()).digest).toBe(seed.digest);

		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The preference is repeatedly requested.",
			draft: {
				motivation: "Persist a recurring response preference",
				expectedEffect: "Responses follow the recurring preference",
				risk: "The preference may be over-applied",
				verifyPlan: "Review responses for scope",
				trialPlan: "Use for one week and review",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/concise.md", content: "Prefer concise technical responses.\n" }],
			},
		});
		expect(proposal.tier).toBe("T1");
		if (!proposal.candidateDigest) throw new Error("T1 proposal has no candidate digest");
		await expect(
			service.registry.approveDataProposal({
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				parentDigest: proposal.parentBundleDigest,
				candidateDigest: proposal.candidateDigest,
				tier: proposal.tier,
				plan: proposal.trialPlan,
				reason: "Attempt low-level approval without review",
				proposalBefore: proposal,
				proposalAfter: { ...proposal, status: "trialing" },
			}),
		).rejects.toThrow("missing required review artifact");
		expect((await service.listProposals()).map((entry) => entry.id)).toEqual([proposal.id]);
		expect((await service.getProposal(proposal.id)).status).toBe("pending");
		await expect(service.approve(proposal.id, approval(proposal))).rejects.toThrow(
			"missing required review artifact",
		);
		await attachArtifact(service, proposal, "review", "# Review\n\nSupported for human review.\n");
		const confirmed = approval(proposal);
		expect(confirmed.artifactsDigest).toMatch(/^[a-f0-9]{64}$/);
		const review = proposal.artifacts.review;
		if (!review) throw new Error("Review artifact is missing");
		const confirmedCreatedAt = review.createdAt;
		review.createdAt = "2000-01-01T00:00:00.000Z";
		await saveProposal(service.paths, proposal);
		await expect(service.approve(proposal.id, confirmed)).rejects.toThrow(
			"approval artifacts changed after confirmation",
		);
		review.createdAt = confirmedCreatedAt;
		await saveProposal(service.paths, proposal);

		const approved = await service.approve(proposal.id, confirmed);
		expect(approved.status).toBe("trialing");
		const trialStatus = await service.status();
		expect(trialStatus.stableDigest).toBe(proposal.candidateDigest);
		expect(trialStatus.trial?.proposalId).toBe(proposal.id);

		await service.rollback(undefined, "Trial did not improve results");
		const rolledBackStatus = await service.status();
		expect(rolledBackStatus.stableDigest).toBe(seed.digest);
		expect(rolledBackStatus.trial).toBeUndefined();
		expect((await service.getProposal(proposal.id)).status).toBe("rolled-back");
	});

	it("recovers an interrupted approval without duplicating history events", async () => {
		const service = await createService(failOnceAt("approve-data", "history-appended"));
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "approval");

		await expect(service.approve(proposal.id, approval(proposal))).rejects.toThrow(
			"simulated approve-data interruption after history-appended",
		);
		const recoveredService = new EvoService(service.paths);
		const approved = await recoveredService.approve(proposal.id, approval(proposal));

		expect(approved.status).toBe("trialing");
		expect((await recoveredService.status()).trial?.proposalId).toBe(proposal.id);
		const history = await historyEntries(recoveredService);
		expect(history.filter((entry) => entry.action === "trial-start")).toHaveLength(1);
		expect(history.filter((entry) => entry.action === "proposal-approved")).toHaveLength(1);
		expect(history.every((entry) => entry.eventId !== undefined)).toBe(true);
		expect(new Set(history.map((entry) => entry.eventId)).size).toBe(history.length);
		await expect(readFile(service.paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("requires a valid evidence-bound retrospective before keeping a trial", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "retrospective-required");
		await service.approve(proposal.id, approval(proposal));
		const reason = "Keep only after retrospective review";

		await expect(service.keep(reason)).rejects.toThrow("missing an evidence-bound retrospective");
		expect((await service.status()).trial?.proposalId).toBe(proposal.id);

		await attachRetrospectiveFixture(service, proposal);
		expect((await service.keep(reason)).status).toBe("kept");
	});

	it("recovers an interrupted keep as one proposal and registry transition", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "keep");
		await service.approve(proposal.id, approval(proposal));
		await attachRetrospectiveFixture(service, proposal);
		const interruptedService = new EvoService(service.paths, failOnceAt("keep-proposal", "history-appended"));

		await expect(interruptedService.keep("Keep after recovery")).rejects.toThrow(
			"simulated keep-proposal interruption after history-appended",
		);
		const recoveredService = new EvoService(service.paths);
		const kept = await recoveredService.keep("Keep after recovery");

		expect(kept.status).toBe("kept");
		expect((await recoveredService.status()).stableDigest).toBe(proposal.candidateDigest);
		expect((await recoveredService.status()).trial).toBeUndefined();
		const history = await historyEntries(recoveredService);
		expect(history.filter((entry) => entry.action === "trial-keep")).toHaveLength(1);
		await expect(readFile(service.paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retries an interrupted default rollback without advancing another generation", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "rollback");
		await service.approve(proposal.id, approval(proposal));
		if (!proposal.candidateDigest) throw new Error("Recovery proposal has no candidate digest");
		const interruptedService = new EvoService(service.paths, failOnceAt("rollback-proposal", "stable-written"));

		await expect(interruptedService.rollback(undefined, "Rollback after recovery")).rejects.toThrow(
			"simulated rollback-proposal interruption after stable-written",
		);
		const recoveredService = new EvoService(service.paths);
		expect(await recoveredService.rollback(undefined, "Rollback after recovery")).toEqual({
			from: proposal.candidateDigest,
			to: seed.digest,
		});

		expect((await recoveredService.status()).stableDigest).toBe(seed.digest);
		expect((await recoveredService.status()).trial).toBeUndefined();
		expect((await recoveredService.getProposal(proposal.id)).status).toBe("rolled-back");
		const history = await historyEntries(recoveredService);
		expect(history.filter((entry) => entry.action === "rollback")).toHaveLength(1);
		await expect(readFile(service.paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reuses a durable intent and receipt after approval response loss", async () => {
		const service = await createService(failOnceAt("approve-data", "committed"));
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "approval-response-loss");

		await expect(service.approve(proposal.id, approval(proposal))).rejects.toThrow(
			"simulated approve-data interruption after committed",
		);
		await expect(readFile(service.paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(service.paths.intents)).toHaveLength(1);

		const recoveredService = new EvoService(service.paths);
		expect((await recoveredService.approve(proposal.id, approval(proposal))).status).toBe("trialing");
		expect(await readdir(service.paths.intents)).toHaveLength(1);
		const history = await historyEntries(recoveredService);
		expect(history.filter((entry) => entry.action === "proposal-approved")).toHaveLength(1);
		expect(history.filter((entry) => entry.action === "trial-start")).toHaveLength(1);
	});
	it("reuses durable reject receipts after a committed response is lost", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "reject-response-loss");
		const reason = "Reject after review";
		const interrupted = new EvoService(service.paths, failOnceAt("reject-proposal", "committed"));

		await expect(interrupted.reject(proposal.id, reason)).rejects.toThrow(
			"simulated reject-proposal interruption after committed",
		);
		expect((await service.getProposal(proposal.id)).status).toBe("rejected");

		const recovered = new EvoService(service.paths);
		expect((await recovered.reject(proposal.id, reason)).status).toBe("rejected");
		const history = await historyEntries(recovered);
		expect(history.filter((entry) => entry.action === "proposal-rejected")).toHaveLength(1);
	});

	it("reuses durable defer and reopen receipts after committed responses are lost", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "defer-reopen-response-loss");
		const deferReason = "Wait for scoped evidence";
		const until = "2026-08-01T00:00:00.000Z";
		const interruptedDefer = new EvoService(service.paths, failOnceAt("defer-proposal", "committed"));

		await expect(interruptedDefer.defer(proposal.id, deferReason, until)).rejects.toThrow(
			"simulated defer-proposal interruption after committed",
		);
		const recoveredDefer = new EvoService(service.paths);
		expect((await recoveredDefer.defer(proposal.id, deferReason, until)).status).toBe("deferred");

		const reopenReason = "Scoped evidence arrived";
		const interruptedReopen = new EvoService(service.paths, failOnceAt("reopen-proposal", "committed"));
		await expect(interruptedReopen.reopen(proposal.id, reopenReason)).rejects.toThrow(
			"simulated reopen-proposal interruption after committed",
		);
		const recoveredReopen = new EvoService(service.paths);
		expect((await recoveredReopen.reopen(proposal.id, reopenReason)).status).toBe("pending");

		const history = await historyEntries(recoveredReopen);
		expect(history.filter((entry) => entry.action === "proposal-deferred")).toHaveLength(1);
		expect(history.filter((entry) => entry.action === "proposal-reopened")).toHaveLength(1);
	});

	it("reuses a durable intent and receipt after keep response loss", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "keep-response-loss");
		await service.approve(proposal.id, approval(proposal));
		await attachRetrospectiveFixture(service, proposal);
		const interruptedService = new EvoService(service.paths, failOnceAt("keep-proposal", "committed"));

		await expect(interruptedService.keep("Keep after response loss")).rejects.toThrow(
			"simulated keep-proposal interruption after committed",
		);
		await expect(readFile(service.paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(service.paths.intents)).toHaveLength(2);

		const recoveredService = new EvoService(service.paths);
		expect((await recoveredService.keep("Keep after response loss")).status).toBe("kept");
		expect(await readdir(service.paths.intents)).toHaveLength(2);
		const history = await historyEntries(recoveredService);
		expect(history.filter((entry) => entry.action === "trial-keep")).toHaveLength(1);
	});

	it.each(["default", "explicit"] as const)(
		"reuses a durable intent and receipt after %s rollback response loss",
		async (mode) => {
			const service = await createService();
			const seed = await service.init();
			const proposal = await stageReviewedT1(service, seed.digest, `rollback-response-loss-${mode}`);
			await service.approve(proposal.id, approval(proposal));
			if (!proposal.candidateDigest) throw new Error("Response-loss proposal has no candidate digest");
			const target = mode === "explicit" ? seed.digest : undefined;
			const reason = "Rollback after response loss";
			const interruptedService = new EvoService(service.paths, failOnceAt("rollback-proposal", "committed"));

			await expect(interruptedService.rollback(target, reason)).rejects.toThrow(
				"simulated rollback-proposal interruption after committed",
			);
			await expect(readFile(service.paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readdir(service.paths.intents)).toHaveLength(2);

			const recoveredService = new EvoService(service.paths);
			expect(await recoveredService.rollback(target, reason)).toEqual({
				from: proposal.candidateDigest,
				to: seed.digest,
			});
			expect(await readdir(service.paths.intents)).toHaveLength(2);
			expect((await recoveredService.status()).stableDigest).toBe(seed.digest);
			const history = await historyEntries(recoveredService);
			expect(history.filter((entry) => entry.action === "rollback")).toHaveLength(1);
		},
	);

	it("retains a completed default rollback intent indefinitely while registry state is unchanged", async () => {
		const service = await createService();
		const seed = await service.init();
		const parentProposal = await stageReviewedT1(service, seed.digest, "completed-rollback-parent");
		await service.approve(parentProposal.id, approval(parentProposal));
		await attachRetrospectiveFixture(service, parentProposal);
		await service.keep("Keep parent generation");
		if (!parentProposal.candidateDigest) throw new Error("Parent proposal has no candidate digest");
		const proposal = await stageReviewedT1(service, parentProposal.candidateDigest, "completed-rollback-child");
		await service.approve(proposal.id, approval(proposal));
		if (!proposal.candidateDigest) throw new Error("Completed-intent proposal has no candidate digest");
		const reason = "Retry after losing the service response";

		expect(await service.rollback(undefined, reason)).toEqual({
			from: proposal.candidateDigest,
			to: parentProposal.candidateDigest,
		});
		const rollbackIntentName = (await readdir(service.paths.intents)).find((name) => name.startsWith("rollback-"));
		if (!rollbackIntentName) throw new Error("Completed rollback intent was not retained");
		const rollbackIntentPath = join(service.paths.intents, rollbackIntentName);
		const rollbackIntent = JSON.parse(await readFile(rollbackIntentPath, "utf8")) as Record<string, unknown>;
		expect(rollbackIntent).toMatchObject({
			completedAt: expect.any(String),
		});
		rollbackIntent.completedAt = "2000-01-01T00:00:00.000Z";
		await writeFile(rollbackIntentPath, JSON.stringify(rollbackIntent));

		const recoveredService = new EvoService(service.paths);
		expect(await recoveredService.rollback(undefined, reason)).toEqual({
			from: proposal.candidateDigest,
			to: parentProposal.candidateDigest,
		});
		expect((await recoveredService.status()).stableDigest).toBe(parentProposal.candidateDigest);
		expect(await recoveredService.rollback(undefined, "A distinct rollback request")).toEqual({
			from: parentProposal.candidateDigest,
			to: seed.digest,
		});
		expect((await recoveredService.status()).stableDigest).toBe(seed.digest);
		const history = await historyEntries(recoveredService);
		expect(history.filter((entry) => entry.action === "rollback")).toHaveLength(2);
	});

	it("does not reuse a completed keep intent across different trials", async () => {
		const service = await createService();
		const seed = await service.init();
		const reason = "Keep the successful candidate";
		const first = await stageReviewedT1(service, seed.digest, "keep-state-first");
		await service.approve(first.id, approval(first));
		await attachRetrospectiveFixture(service, first);
		expect((await service.keep(reason)).id).toBe(first.id);
		if (!first.candidateDigest) throw new Error("First keep proposal has no candidate digest");

		const second = await stageReviewedT1(service, first.candidateDigest, "keep-state-second");
		await service.approve(second.id, approval(second));
		await attachRetrospectiveFixture(service, second);
		const kept = await service.keep(reason);

		expect(kept.id).toBe(second.id);
		expect(kept.status).toBe("kept");
		expect((await service.getProposal(first.id)).status).toBe("kept");
		expect((await service.getProposal(second.id)).status).toBe("kept");
		expect((await service.status()).stableDigest).toBe(second.candidateDigest);
		expect((await service.status()).trial).toBeUndefined();
		const history = await historyEntries(service);
		expect(history.filter((entry) => entry.action === "trial-keep")).toHaveLength(2);
	});

	it("does not reuse a completed rollback intent across different trials", async () => {
		const service = await createService();
		const seed = await service.init();
		const reason = "Rollback the unsuccessful candidate";
		const first = await stageReviewedT1(service, seed.digest, "rollback-state-first");
		await service.approve(first.id, approval(first));
		if (!first.candidateDigest) throw new Error("First rollback proposal has no candidate digest");
		expect(await service.rollback(undefined, reason)).toEqual({
			from: first.candidateDigest,
			to: seed.digest,
		});

		const second = await stageReviewedT1(service, seed.digest, "rollback-state-second");
		await service.approve(second.id, approval(second));
		if (!second.candidateDigest) throw new Error("Second rollback proposal has no candidate digest");
		expect(await service.rollback(undefined, reason)).toEqual({
			from: second.candidateDigest,
			to: seed.digest,
		});

		expect((await service.getProposal(first.id)).status).toBe("rolled-back");
		expect((await service.getProposal(second.id)).status).toBe("rolled-back");
		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.status()).trial).toBeUndefined();
		const history = await historyEntries(service);
		expect(history.filter((entry) => entry.action === "rollback")).toHaveLength(2);
	});

	it("defers and reopens a proposal with status counts and history", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A proposal needs maintainer input.",
			draft: {
				motivation: "Persist a scoped preference",
				expectedEffect: "The preference is available after review",
				risk: "The scope needs clarification",
				verifyPlan: "Review the final diff",
				trialPlan: "Use for one week",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/deferred.md", content: "Apply only after clarification.\n" }],
			},
		});
		expect(await service.status()).toMatchObject({ pendingProposals: 1, deferredProposals: 0 });

		const deferred = await service.defer(proposal.id, "Waiting for scope details");
		expect(deferred.status).toBe("deferred");
		expect(await service.status()).toMatchObject({ pendingProposals: 0, deferredProposals: 1 });
		await expect(service.defer(proposal.id, "Duplicate deferral")).rejects.toThrow("is deferred");

		const reopened = await service.reopen(proposal.id, "Scope details received");
		expect(reopened.status).toBe("pending");
		expect(reopened.defer).toBeUndefined();
		expect(await service.status()).toMatchObject({ pendingProposals: 1, deferredProposals: 0 });
		await expect(service.reopen(proposal.id, "Duplicate reopen")).rejects.toThrow("is pending");
		const history = await readFile(service.paths.history, "utf8");
		expect(history).toContain('"action":"proposal-deferred"');
		expect(history).toContain('"action":"proposal-reopened"');
		expect(history).toContain(`"proposalId":"${proposal.id}"`);
	});

	it("approves an exact code context without committing or merging it", async () => {
		const service = await createService();
		const seed = await service.init();
		const repository = await mkdtemp(join(tmpdir(), "pi-evo-code-approval-"));
		temporaryDirectories.push(repository);
		await mkdir(join(repository, "src"), { recursive: true });
		git(repository, ["init", "--quiet"]);
		git(repository, ["config", "user.name", "Evo Test"]);
		git(repository, ["config", "user.email", "evo-test@example.invalid"]);
		await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
		git(repository, ["add", "src/value.ts"]);
		git(repository, ["commit", "--quiet", "-m", "initial"]);
		const headBefore = git(repository, ["rev-parse", "HEAD"]).trim();
		const statusBefore = git(repository, ["status", "--short"]);
		const validator = new PassingCodeValidator();
		const codeDraft: DraftProposal = {
			motivation: "Change the implementation value",
			expectedEffect: "The isolated candidate returns the new value",
			risk: "The code change could affect callers",
			verifyPlan: "Run repository checks and inspect the exact diff",
			trialPlan: "Human commits and merges the approved branch manually",
			source: "explicit-request",
			evidence: [],
			inboxReferences: [],
			replayScenarios: [{ sessionId: "code-approval-fixture", sequence: 1 }],
			codePatch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;"),
		};
		await expect(
			stageProposal({
				paths: service.paths,
				parentDigest: seed.digest,
				observationsMarkdown: "A code change without a replay scenario must fail closed.",
				repositoryCwd: repository,
				codeValidationExecutor: validator,
				draft: { ...codeDraft, replayScenarios: [] },
			}),
		).rejects.toThrow("Code proposals require at least one replay scenario");
		expect(validator.calls).toHaveLength(0);
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "A code change is requested.",
			repositoryCwd: repository,
			codeValidationExecutor: validator,
			draft: codeDraft,
		});
		expect(proposal).toMatchObject({ kind: "code", tier: "T2", status: "pending" });
		expect(proposal.approvalDigest).not.toBe(proposal.diffDigest);
		expect(proposal.codeWorkspace?.baseCommit).toBe(headBefore);
		const workspace = proposal.codeWorkspace;
		if (!workspace) throw new Error("Code proposal has no workspace");
		const attemptLowLevelApproval = () =>
			service.registry.approveCodeProposal({
				proposalId: proposal.id,
				parentDigest: proposal.parentBundleDigest,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				approvalDigest: proposal.approvalDigest,
				branch: workspace.branch,
				reason: "Exercise low-level code approval guards",
				proposalBefore: proposal,
				proposalAfter: { ...proposal, status: "approved" },
			});
		await attachArtifact(service, proposal, "review", "# Review\n\nSupported after L1.\n");
		await expect(attemptLowLevelApproval()).rejects.toThrow("missing required replay artifact");
		await attachArtifact(
			service,
			proposal,
			"replay",
			"# Counterfactual replay\n\nGenerate-only patch hypothesis; no candidate code or tools were executed.\n",
		);
		const replayScenarios = proposal.replayScenarios;
		proposal.replayScenarios = [];
		await saveProposal(service.paths, proposal);
		await expect(attemptLowLevelApproval()).rejects.toThrow("requires a replay scenario");
		proposal.replayScenarios = replayScenarios;
		await saveProposal(service.paths, proposal);
		await expect(
			approveProposal(
				service.paths,
				proposal.id,
				{ revision: proposal.revision, diffDigest: proposal.diffDigest },
				validator,
			),
		).rejects.toThrow("requires confirmation of its code approval context");
		const confirmed = approval(proposal);
		proposal.tier = "T0";
		await saveProposal(service.paths, proposal);
		await expect(attemptLowLevelApproval()).rejects.toThrow("Code approval options do not match the proposal");
		await expect(approveProposal(service.paths, proposal.id, confirmed, validator)).rejects.toThrow(
			"code approval requires kind code and tier T2",
		);
		proposal.tier = "T2";
		proposal.kind = "data";
		await saveProposal(service.paths, proposal);
		await expect(approveProposal(service.paths, proposal.id, confirmed, validator)).rejects.toThrow(
			"code approval requires kind code and tier T2",
		);
		proposal.kind = "code";
		await saveProposal(service.paths, proposal);

		const approved = await approveProposal(service.paths, proposal.id, confirmed, validator);
		expect(approved.status).toBe("approved");
		expect(validator.calls).toHaveLength(2);
		expect(git(repository, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
		expect(git(repository, ["status", "--short"])).toBe(statusBefore);
		expect(await readFile(join(repository, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
		expect(git(proposal.codeWorkspace?.worktreePath ?? "", ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
		expect(git(proposal.codeWorkspace?.worktreePath ?? "", ["diff", "--cached", "--", "src/value.ts"])).toContain(
			"export const value = 2;",
		);
		const history = await readFile(service.paths.history, "utf8");
		expect(history).toContain(`"approvalDigest":"${proposal.approvalDigest}"`);
		expect(history).toContain(`"branch":"${proposal.codeWorkspace?.branch}"`);
	});

	it("stages a proposal against an external bundle with only schemaVersion in policy", async () => {
		const service = await createService();
		const sourceDirectory = join(service.paths.root, "external-minimal-source");
		await mkdir(sourceDirectory, { recursive: true });
		await writeFile(join(sourceDirectory, "policy.json"), '{"schemaVersion":1}\n');
		const seed = await compileBundle({
			paths: service.paths,
			sourceDirectory,
			parentDigest: null,
			summary: "External minimal bundle",
		});
		await service.registry.initialize(seed.digest);

		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "An external bundle needs a memory entry.",
			draft: {
				motivation: "Persist an external preference",
				expectedEffect: "The preference remains available",
				risk: "The preference may be over-applied",
				verifyPlan: "Review the staged diff",
				trialPlan: "Use for one week and review",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/external.md", content: "Preserve the external preference.\n" }],
			},
		});

		expect(JSON.parse(await readFile(join(seed.directory, "policy.json"), "utf8"))).toEqual({ schemaVersion: 1 });
		expect(proposal.tier).toBe("T1");
		expect(proposal.changedPaths).toEqual(["memory/external.md"]);
	});

	it("requires recorder-marked explicit feedback for a T0 direct preference", async () => {
		const service = await createService();
		const seed = await service.init();
		const store = await createRecorderStore({
			paths: service.paths,
			sessionId: "direct-preference",
			bundleDigest: seed.digest,
		});
		const userPreference = "Always include the exact verification command.";
		const userEvent = await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({
				role: "user",
				content: [{ type: "text", text: userPreference }],
				timestamp: 1,
			}),
		});
		const feedbackPreference = "Keep release notes concise.";
		const feedbackEvent = await store.append({
			type: "explicit_feedback",
			source: "interactive",
			text: await store.storePayload(feedbackPreference),
			inboxFile: "feedback.json",
		});

		const userProposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The user supplied a durable preference.",
			draft: {
				motivation: "Record the user preference",
				expectedEffect: "Verification commands stay explicit",
				risk: "The preference may be over-applied",
				verifyPlan: "Compare the memory entry with the recorder event",
				trialPlan: "No trial is required for verbatim direct recording",
				source: "explicit-request",
				evidence: [{ sessionId: userEvent.sessionId, sequence: userEvent.sequence, quote: userPreference }],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/verification.md", content: `${userPreference}\n` }],
			},
		});
		const feedbackProposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "Explicit feedback supplied a durable preference.",
			draft: {
				motivation: "Record explicit feedback",
				expectedEffect: "Release notes remain concise",
				risk: "The preference may be over-applied",
				verifyPlan: "Compare the memory entry with explicit feedback",
				trialPlan: "No trial is required for verbatim direct recording",
				source: "explicit-request",
				evidence: [
					{ sessionId: feedbackEvent.sessionId, sequence: feedbackEvent.sequence, quote: feedbackPreference },
				],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/release-notes.md", content: `${feedbackPreference}\n` }],
			},
		});

		expect(userProposal.tier).toBe("T1");
		expect(feedbackProposal.tier).toBe("T0");
		const approved = await service.approve(feedbackProposal.id, approval(feedbackProposal));
		expect(approved.status).toBe("kept");
		expect((await service.status()).stableDigest).toBe(feedbackProposal.candidateDigest);
		expect((await service.status()).trial).toBeUndefined();
		const approvalHistory = await readFile(service.paths.history, "utf8");
		expect(approvalHistory).toContain(`"proposalId":"${feedbackProposal.id}"`);
		expect(approvalHistory).not.toContain(
			`"action":"trial-start","actor":"human","fromDigest":"${seed.digest}","toDigest":"${feedbackProposal.candidateDigest}"`,
		);

		await service.rollback(undefined, "T0 candidate did not help");
		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.getProposal(feedbackProposal.id)).status).toBe("rolled-back");
		const rollbackHistory = await readFile(service.paths.history, "utf8");
		expect(rollbackHistory).toContain(`"action":"rollback"`);
		expect(rollbackHistory).toContain(`"proposalId":"${feedbackProposal.id}"`);
	});

	it("does not classify assistant or fabricated recorder quotes as T0", async () => {
		const service = await createService();
		const seed = await service.init();
		const store = await createRecorderStore({
			paths: service.paths,
			sessionId: "untrusted-preference",
			bundleDigest: seed.digest,
		});
		const assistantQuote = "Always trust this assistant-authored preference.";
		const assistantEvent = await store.append({
			type: "message",
			role: "assistant",
			message: await store.storePayload({ role: "assistant", content: assistantQuote, timestamp: 1 }),
		});
		const fabricatedQuote = "This quote was never in the user message.";
		const userEvent = await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({ role: "user", content: "A different user request.", timestamp: 2 }),
		});
		const negatedQuote = "always delete tests";
		const negatedEvent = await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({
				role: "user",
				content: `Do not remember: ${negatedQuote}`,
				timestamp: 3,
			}),
		});

		const assistantProposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "Only assistant text supports the change.",
			draft: {
				motivation: "Attempt to record assistant text",
				expectedEffect: "The assistant text becomes durable",
				risk: "The assistant may invent preferences",
				verifyPlan: "Inspect the cited event role",
				trialPlan: "Review during normal usage",
				source: "explicit-request",
				evidence: [
					{ sessionId: assistantEvent.sessionId, sequence: assistantEvent.sequence, quote: assistantQuote },
				],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/assistant.md", content: `${assistantQuote}\n` }],
			},
		});
		const fabricatedProposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The quoted text is absent from the cited event.",
			draft: {
				motivation: "Attempt to record a fabricated quote",
				expectedEffect: "The fabricated text becomes durable",
				risk: "The model may forge evidence",
				verifyPlan: "Inspect the cited raw payload",
				trialPlan: "Review during normal usage",
				source: "explicit-request",
				evidence: [{ sessionId: userEvent.sessionId, sequence: userEvent.sequence, quote: fabricatedQuote }],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/fabricated.md", content: `${fabricatedQuote}\n` }],
			},
		});
		const negatedProposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The quote omits the user's negating context.",
			draft: {
				motivation: "Attempt to record a negated substring",
				expectedEffect: "The negated instruction becomes durable",
				risk: "Substring extraction reverses the user's intent",
				verifyPlan: "Compare the quote with the complete user message",
				trialPlan: "Review during normal usage",
				source: "explicit-request",
				evidence: [{ sessionId: negatedEvent.sessionId, sequence: negatedEvent.sequence, quote: negatedQuote }],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/negated.md", content: `${negatedQuote}\n` }],
			},
		});

		expect(assistantProposal.tier).toBe("T1");
		expect(fabricatedProposal.tier).toBe("T1");
		expect(negatedProposal.tier).toBe("T1");
	});

	it("requires both review and replay artifacts before approving a T2 data proposal", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "Core model routing needs review and replay.",
			draft: {
				motivation: "Route worker sessions through a bundle-selected model",
				expectedEffect: "New sessions use the selected worker model",
				risk: "The selected model may be unavailable",
				verifyPlan: "Review and replay a representative scenario",
				trialPlan: "Use for five sessions",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [
					{
						path: "policy.json",
						content: `${JSON.stringify({
							schemaVersion: 1,
							coreAssets: [],
							modelRouting: { worker: "fake/worker" },
							validation: { requiredChecks: ["bundle-compile"] },
						})}\n`,
					},
				],
			},
		});
		expect(proposal.tier).toBe("T2");
		await attachArtifact(service, proposal, "review", "# Review\n\nUncertain; human decides.\n");
		await expect(service.approve(proposal.id, approval(proposal))).rejects.toThrow(
			"missing required replay artifact",
		);

		await attachArtifact(service, proposal, "replay", "# Replay\n\nGenerate-only comparison.\n");

		expect((await service.approve(proposal.id, approval(proposal))).status).toBe("trialing");
	});
	it("binds low-level data approval to the proposal kind and tier", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageReviewedT1(service, seed.digest, "tier-binding");
		if (!proposal.candidateDigest) throw new Error("Tier-binding proposal has no candidate digest");

		await expect(
			service.registry.approveDataProposal({
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				parentDigest: proposal.parentBundleDigest,
				candidateDigest: proposal.candidateDigest,
				tier: "T0",
				plan: proposal.trialPlan,
				reason: "Attempt to downgrade a T1 proposal",
				proposalBefore: proposal,
				proposalAfter: { ...proposal, status: "kept" },
			}),
		).rejects.toThrow("Data approval options do not match the proposal");

		expect((await service.getProposal(proposal.id)).status).toBe("pending");
		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.status()).trial).toBeUndefined();
		expect(await readFile(service.paths.history, "utf8")).not.toContain('"action":"proposal-approved"');
	});

	it("classifies a limits-only policy change as T2", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The candidate tightens the prompt budget.",
			draft: {
				motivation: "Tighten the prompt byte limit",
				expectedEffect: "Oversized prompts fail earlier",
				risk: "Valid larger prompts may be rejected",
				verifyPlan: "Compile at the new boundary",
				trialPlan: "Use for five sessions",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [
					{
						path: "policy.json",
						content: `${JSON.stringify({
							schemaVersion: 1,
							coreAssets: [],
							limits: { promptBytes: 32 * 1024 },
							modelRouting: {},
							validation: { requiredChecks: [] },
						})}\n`,
					},
				],
			},
		});

		expect(proposal.tier).toBe("T2");
		expect(proposal.changedPaths).toEqual(["policy.json"]);
		expect(proposal.l1.reason).toContain("core policy field");
	});

	it("rejects approval when proposal.json no longer matches the confirmed digest", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The proposal will be tampered after confirmation.",
			draft: {
				motivation: "Persist a confirmed preference",
				expectedEffect: "The confirmed candidate is applied",
				risk: "The proposal could change after review",
				verifyPlan: "Compare the confirmed digest before approval",
				trialPlan: "Use for one week",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/confirmed.md", content: "Only apply the confirmed candidate.\n" }],
			},
		});
		const confirmed = approval(proposal);
		proposal.approvalDigest = `${proposal.approvalDigest.startsWith("0") ? "1" : "0"}${proposal.approvalDigest.slice(1)}`;
		await saveProposal(service.paths, proposal);

		await expect(service.approve(proposal.id, confirmed)).rejects.toThrow(
			"diff digest does not match the confirmed final diff",
		);
		expect((await service.getProposal(proposal.id)).status).toBe("pending");
		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.status()).trial).toBeUndefined();
		expect(await readFile(service.paths.history, "utf8")).not.toContain("proposal-approved");
	});

	it("rejects persisted tier, diff, changedPaths, and L1 tampering after immutable revalidation", async () => {
		const service = await createService();
		const seed = await service.init();
		let proposalIndex = 0;
		const stageCandidate = async () => {
			proposalIndex += 1;
			return stageProposal({
				paths: service.paths,
				parentDigest: seed.digest,
				observationsMarkdown: "The candidate must be revalidated before approval.",
				draft: {
					motivation: "Persist a non-core memory entry",
					expectedEffect: `Candidate ${proposalIndex} remains auditable`,
					risk: "Persisted audit fields could be tampered",
					verifyPlan: "Recompute the immutable candidate diff and tier",
					trialPlan: "Use for one week",
					source: "pattern",
					evidence: [],
					inboxReferences: [],
					replayScenarios: [],
					changes: [
						{
							path: `memory/audit-${proposalIndex}.md`,
							content: `Immutable candidate ${proposalIndex}.\n`,
						},
					],
				},
			});
		};

		const tierProposal = await stageCandidate();
		expect(tierProposal.tier).toBe("T1");
		tierProposal.tier = "T0";
		await saveProposal(service.paths, tierProposal);
		await expect(service.approve(tierProposal.id, approval(tierProposal))).rejects.toThrow(
			"immutable bundle audit: tier",
		);

		const diffProposal = await stageCandidate();
		diffProposal.diff = `${diffProposal.diff}\nforged diff`;
		await saveProposal(service.paths, diffProposal);
		await expect(service.approve(diffProposal.id, approval(diffProposal))).rejects.toThrow(
			"diff digest does not match the confirmed final diff",
		);

		const pathsProposal = await stageCandidate();
		pathsProposal.changedPaths = ["memory/forged.md"];
		await saveProposal(service.paths, pathsProposal);
		await expect(service.approve(pathsProposal.id, approval(pathsProposal))).rejects.toThrow(
			"immutable bundle audit: changedPaths",
		);

		const l1Proposal = await stageCandidate();
		l1Proposal.l1.passed = false;
		await saveProposal(service.paths, l1Proposal);
		await expect(service.approve(l1Proposal.id, approval(l1Proposal))).rejects.toThrow("immutable bundle audit: l1");

		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.status()).trial).toBeUndefined();
		expect(await readFile(service.paths.history, "utf8")).not.toContain("proposal-approved");
	});

	it("reuses a retrospective only while its evidence snapshot is unchanged", async () => {
		const service = await createService();
		const seed = await service.init();
		const proposal = await stageProposal({
			paths: service.paths,
			parentDigest: seed.digest,
			observationsMarkdown: "The trial needs a retrospective.",
			draft: {
				motivation: "Exercise the retrospective lifecycle",
				expectedEffect: "The same memo can be reviewed before keep",
				risk: "A stale memo may miss later evidence",
				verifyPlan: "Call retrospect twice before keep",
				trialPlan: "Review once and keep",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [],
				changes: [{ path: "memory/retrospective.md", content: "Use the fixed retrospective.\n" }],
			},
		});
		await attachArtifact(service, proposal, "review", "# Review\n\nSupported.\n");
		await service.approve(proposal.id, approval(proposal));

		const runner = new FakeRetrospectiveRunner();
		const first = await runRetrospective({ paths: service.paths, runner });
		const second = await runRetrospective({ paths: service.paths, runner });

		expect(runner.requests).toHaveLength(1);
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.retrospectiveMarkdown).toBe(first.retrospectiveMarkdown);
		const firstArtifact = first.proposal.artifacts.retrospective;
		if (!firstArtifact) throw new Error("First retrospective artifact is missing");
		await service.note("retrospective-evidence", "New post-trial evidence requires another review");
		await expect(service.keep("The old retrospective is stale")).rejects.toThrow("does not cover current evidence");
		const third = await runRetrospective({ paths: service.paths, runner });
		const thirdArtifact = third.proposal.artifacts.retrospective;
		if (!thirdArtifact) throw new Error("Updated retrospective artifact is missing");

		expect(runner.requests).toHaveLength(2);
		expect(third.reused).toBe(false);
		expect(third.corpus.evidenceDigest).not.toBe(first.corpus.evidenceDigest);
		expect(thirdArtifact.file).not.toBe(firstArtifact.file);
		expect(await readFile(join(service.paths.proposals, proposal.id, firstArtifact.file), "utf8")).toBe(
			first.retrospectiveMarkdown,
		);
		expect(await readFile(join(service.paths.proposals, proposal.id, thirdArtifact.file), "utf8")).toBe(
			third.retrospectiveMarkdown,
		);

		const kept = await service.keep("Retrospective supports keeping the trial");
		expect(kept.status).toBe("kept");
		expect((await service.status()).trial).toBeUndefined();
	});

	it("writes notes and requests to the recorder inbox", async () => {
		const service = await createService();
		await service.init();
		const note = await service.note("session-1", "keep answers concise");
		const request = await service.request("session-1", "add a release checklist");
		expect(note.entry.text).toBe("NOTE: keep answers concise");
		expect(request.entry.text).toBe("REQUEST: add a release checklist");

		const files = (await readdir(service.paths.inbox)).sort();
		expect(files).toHaveLength(2);
		const entries = await Promise.all(
			files.map(
				async (file) => JSON.parse(await readFile(join(service.paths.inbox, file), "utf8")) as RecorderInboxEntry,
			),
		);
		expect(entries.map((entry) => entry.text).sort()).toEqual([
			"NOTE: keep answers concise",
			"REQUEST: add a release checklist",
		]);
	});
});
