import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { getEvoPaths } from "../src/paths.ts";
import { saveProposal, stageProposal } from "../src/proposal.ts";
import type { RecorderInboxEntry } from "../src/recorder/schema.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import { EvoService } from "../src/service.ts";

describe("EvoService", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createService(): Promise<EvoService> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-service-"));
		temporaryDirectories.push(root);
		return new EvoService(getEvoPaths(root));
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
		expect((await service.listProposals()).map((entry) => entry.id)).toEqual([proposal.id]);
		expect((await service.getProposal(proposal.id)).status).toBe("pending");
		await expect(service.approve(proposal.id, proposal.approvalDigest)).rejects.toThrow(
			"requires reviewFile to be review.md",
		);
		proposal.reviewFile = "review.md";
		await saveProposal(service.paths, proposal);
		await expect(service.approve(proposal.id, proposal.approvalDigest)).rejects.toThrow(
			"missing required artifact review.md",
		);
		await writeFile(
			join(service.paths.proposals, proposal.id, "review.md"),
			"# Review\n\nSupported for human review.\n",
		);

		const approved = await service.approve(proposal.id, proposal.approvalDigest);
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

	it("classifies verbatim user and explicit-feedback recorder evidence as T0", async () => {
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

		expect(userProposal.tier).toBe("T0");
		expect(feedbackProposal.tier).toBe("T0");
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
			observationsMarkdown: "Core validation needs review and replay.",
			draft: {
				motivation: "Require typechecking for candidates",
				expectedEffect: "Candidates receive deterministic typechecking",
				risk: "Validation may reject otherwise usable candidates",
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
							modelRouting: {},
							validation: { requiredChecks: ["typecheck"] },
						})}\n`,
					},
				],
			},
		});
		expect(proposal.tier).toBe("T2");
		proposal.reviewFile = "review.md";
		await writeFile(
			join(service.paths.proposals, proposal.id, "review.md"),
			"# Review\n\nUncertain; human decides.\n",
		);
		await saveProposal(service.paths, proposal);
		await expect(service.approve(proposal.id, proposal.approvalDigest)).rejects.toThrow(
			"requires replayFile to be replay.md",
		);

		proposal.replayFile = "replay.md";
		await saveProposal(service.paths, proposal);
		await expect(service.approve(proposal.id, proposal.approvalDigest)).rejects.toThrow(
			"missing required artifact replay.md",
		);
		await writeFile(
			join(service.paths.proposals, proposal.id, "replay.md"),
			"# Replay\n\nGenerate-only comparison.\n",
		);

		expect((await service.approve(proposal.id, proposal.approvalDigest)).status).toBe("trialing");
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
		const confirmedDigest = proposal.approvalDigest;
		proposal.reviewFile = "review.md";
		proposal.approvalDigest = `${confirmedDigest.startsWith("0") ? "1" : "0"}${confirmedDigest.slice(1)}`;
		await writeFile(join(service.paths.proposals, proposal.id, "review.md"), "# Review\n\nSupported.\n");
		await saveProposal(service.paths, proposal);

		await expect(service.approve(proposal.id, confirmedDigest)).rejects.toThrow(
			"approval digest does not match the confirmed digest",
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
		await expect(service.approve(tierProposal.id, tierProposal.approvalDigest)).rejects.toThrow(
			"immutable bundle audit: tier",
		);

		const diffProposal = await stageCandidate();
		diffProposal.reviewFile = "review.md";
		diffProposal.diff = `${diffProposal.diff}\nforged diff`;
		await writeFile(join(service.paths.proposals, diffProposal.id, "review.md"), "# Review\n\nSupported.\n");
		await saveProposal(service.paths, diffProposal);
		await expect(service.approve(diffProposal.id, diffProposal.approvalDigest)).rejects.toThrow(
			"immutable bundle audit: diff",
		);

		const pathsProposal = await stageCandidate();
		pathsProposal.reviewFile = "review.md";
		pathsProposal.changedPaths = ["memory/forged.md"];
		await writeFile(join(service.paths.proposals, pathsProposal.id, "review.md"), "# Review\n\nSupported.\n");
		await saveProposal(service.paths, pathsProposal);
		await expect(service.approve(pathsProposal.id, pathsProposal.approvalDigest)).rejects.toThrow(
			"immutable bundle audit: changedPaths",
		);

		const l1Proposal = await stageCandidate();
		l1Proposal.reviewFile = "review.md";
		l1Proposal.l1.passed = false;
		await writeFile(join(service.paths.proposals, l1Proposal.id, "review.md"), "# Review\n\nSupported.\n");
		await saveProposal(service.paths, l1Proposal);
		await expect(service.approve(l1Proposal.id, l1Proposal.approvalDigest)).rejects.toThrow(
			"immutable bundle audit: l1.passed",
		);

		expect((await service.status()).stableDigest).toBe(seed.digest);
		expect((await service.status()).trial).toBeUndefined();
		expect(await readFile(service.paths.history, "utf8")).not.toContain("proposal-approved");
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
