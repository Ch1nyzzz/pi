import { appendFile, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEvoPaths } from "../src/paths.ts";
import {
	appendApprovalTurn,
	getEvaluationArtifactFile,
	getRetrospectiveArtifactFile,
	readApprovalTurns,
	readEvaluationArtifact,
	readProposalRevisionSnapshot,
	saveProposalRevisionSnapshot,
	validateEvaluationArtifact,
	writeEvaluationArtifact,
	writeRetrospectiveArtifact,
} from "../src/proposal-artifacts.ts";
import type { Proposal } from "../src/types.ts";

const FIRST_DIGEST = "a".repeat(64);
const SECOND_DIGEST = "b".repeat(64);

function proposalFixture(): Proposal {
	return {
		schemaVersion: 2,
		id: "p-artifact-test",
		createdAt: "2026-07-14T00:00:00.000Z",
		revision: 1,
		parentBundleDigest: "c".repeat(64),
		kind: "data",
		tier: "T2",
		motivation: "Exercise revision-bound approval artifacts",
		diff: "--- old\n+++ new\n",
		expectedEffect: "Artifacts remain bound to the reviewed diff",
		risk: "A stale artifact could otherwise be accepted",
		verifyPlan: "Validate the stored hash and revision",
		trialPlan: "Use for five sessions",
		status: "pending",
		source: "pattern",
		evidence: [],
		inboxReferences: [],
		replayScenarios: [],
		changedPaths: ["prompts/system.md"],
		diffDigest: FIRST_DIGEST,
		approvalDigest: FIRST_DIGEST,
		l1: { passed: true, reason: "Bundle compiled", errors: [] },
		artifacts: {},
	};
}

describe("proposal revision artifacts", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function createFixture() {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-proposal-artifacts-"));
		roots.push(root);
		return { root, paths: getEvoPaths(join(root, "evo")) };
	}

	it("stores fixed-path artifacts and a revision snapshot", async () => {
		const fixture = await createFixture();
		const proposal = proposalFixture();
		const content = "# Critic review\n\nSupported with reservations.\n";
		const reference = await writeEvaluationArtifact({
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			kind: "review",
			content,
			now: () => new Date("2026-07-14T01:00:00.000Z"),
		});

		expect(reference).toMatchObject({
			file: "revisions/1/review.md",
			revision: 1,
			diffDigest: FIRST_DIGEST,
			createdAt: "2026-07-14T01:00:00.000Z",
		});
		expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(getEvaluationArtifactFile(1, "review")).toBe(reference.file);
		expect(
			await readEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				kind: "review",
				reference,
			}),
		).toBe(content);
		await expect(
			validateEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				kind: "review",
				reference,
			}),
		).resolves.toBeUndefined();
		const recovered = await writeEvaluationArtifact({
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			kind: "review",
			content,
			now: () => new Date("2026-07-14T02:00:00.000Z"),
		});
		expect(recovered).toMatchObject({ file: reference.file, sha256: reference.sha256 });

		await expect(
			writeEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				kind: "review",
				content: "replacement",
			}),
		).rejects.toThrow("write-once");

		proposal.artifacts.review = reference;
		expect(await saveProposalRevisionSnapshot(fixture.paths, proposal)).toBe("revisions/1/revision.json");
		expect(await readProposalRevisionSnapshot(fixture.paths, proposal.id, proposal.revision)).toEqual(proposal);
	});

	it("rejects tampered, stale-revision, wrong-digest, and relocated artifacts", async () => {
		const fixture = await createFixture();
		const proposal = proposalFixture();
		const reference = await writeEvaluationArtifact({
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: 1,
			diffDigest: FIRST_DIGEST,
			kind: "replay",
			content: "# Replay\n\nOriginal output.\n",
		});
		const options = {
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: 1,
			diffDigest: FIRST_DIGEST,
			kind: "replay" as const,
			reference,
		};
		await writeFile(join(fixture.paths.proposals, proposal.id, reference.file), "tampered\n");
		await expect(readEvaluationArtifact(options)).rejects.toThrow("sha256");
		await expect(readEvaluationArtifact({ ...options, revision: 2 })).rejects.toThrow("different proposal revision");
		await expect(readEvaluationArtifact({ ...options, diffDigest: SECOND_DIGEST })).rejects.toThrow(
			"diff digest does not match",
		);
		await expect(
			readEvaluationArtifact({ ...options, reference: { ...reference, file: "replay.md" } }),
		).rejects.toThrow("fixed revision path");
	});

	it("retains immutable retrospective snapshots for each evidence digest", async () => {
		const fixture = await createFixture();
		const proposal = proposalFixture();
		const firstContent = "# Retrospective\n\nFirst evidence window.\n";
		const secondContent = "# Retrospective\n\nLater evidence window.\n";
		const first = await writeRetrospectiveArtifact({
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			content: firstContent,
			evidenceDigest: FIRST_DIGEST,
			evidenceCutoff: "2026-07-14T01:00:00.000Z",
		});
		const second = await writeRetrospectiveArtifact({
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			content: secondContent,
			evidenceDigest: SECOND_DIGEST,
			evidenceCutoff: "2026-07-14T02:00:00.000Z",
		});

		expect(first).toMatchObject({
			file: getRetrospectiveArtifactFile(1, FIRST_DIGEST),
			evidence: { digest: FIRST_DIGEST, cutoff: "2026-07-14T01:00:00.000Z" },
		});
		expect(second.file).toBe(getRetrospectiveArtifactFile(1, SECOND_DIGEST));
		expect(
			await readEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: 1,
				diffDigest: FIRST_DIGEST,
				kind: "retrospective",
				reference: first,
			}),
		).toBe(firstContent);
		expect(
			await readEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: 1,
				diffDigest: FIRST_DIGEST,
				kind: "retrospective",
				reference: second,
			}),
		).toBe(secondContent);
		await expect(
			writeRetrospectiveArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: 1,
				diffDigest: FIRST_DIGEST,
				content: "replacement",
				evidenceDigest: FIRST_DIGEST,
				evidenceCutoff: "2026-07-14T03:00:00.000Z",
			}),
		).rejects.toThrow("write-once");
		await expect(
			readEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: 1,
				diffDigest: FIRST_DIGEST,
				kind: "retrospective",
				reference: { ...first, evidence: { ...first.evidence!, digest: SECOND_DIGEST } },
			}),
		).rejects.toThrow("fixed revision path");
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked artifact", async () => {
		const fixture = await createFixture();
		const proposal = proposalFixture();
		const reference = await writeEvaluationArtifact({
			paths: fixture.paths,
			proposalId: proposal.id,
			revision: 1,
			diffDigest: FIRST_DIGEST,
			kind: "validation",
			content: "validation passed\n",
		});
		const artifactPath = join(fixture.paths.proposals, proposal.id, reference.file);
		const targetPath = join(fixture.root, "outside-validation.md");
		await writeFile(targetPath, "validation passed\n");
		await unlink(artifactPath);
		await symlink(targetPath, artifactPath);

		await expect(
			readEvaluationArtifact({
				paths: fixture.paths,
				proposalId: proposal.id,
				revision: 1,
				diffDigest: FIRST_DIGEST,
				kind: "validation",
				reference,
			}),
		).rejects.toThrow("regular file");
	});

	it("serializes concurrent approval turns with strict append-only sequences", async () => {
		const fixture = await createFixture();
		const proposalId = "p-concurrent-approval";
		const turns = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				appendApprovalTurn({
					paths: fixture.paths,
					proposalId,
					revision: index < 12 ? 1 : 2,
					diffDigest: index < 12 ? FIRST_DIGEST : SECOND_DIGEST,
					role: index % 2 === 0 ? "human" : "meta",
					kind: index % 2 === 0 ? "question" : "answer",
					text: `turn ${index}`,
					...(index === 0
						? { evidence: [{ sessionId: "recorded-session", sequence: 3, quote: "specific trace" }] }
						: {}),
				}),
			),
		);
		const stored = await readApprovalTurns(fixture.paths, proposalId);

		expect(turns.map((turn) => turn.sequence).sort((left, right) => left - right)).toEqual(
			Array.from({ length: 24 }, (_, index) => index + 1),
		);
		expect(stored.map((turn) => turn.sequence)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
		expect(new Set(stored.map((turn) => turn.text))).toEqual(
			new Set(Array.from({ length: 24 }, (_, index) => `turn ${index}`)),
		);
		expect(stored.find((turn) => turn.evidence)?.evidence).toEqual([
			{ sessionId: "recorded-session", sequence: 3, quote: "specific trace" },
		]);
		expect(
			(await readFile(join(fixture.paths.proposals, proposalId, "approval.jsonl"), "utf8")).trim().split("\n"),
		).toHaveLength(24);
	});
	it("repairs a torn approval-log tail before reading or appending", async () => {
		const fixture = await createFixture();
		const proposalId = "p-torn-approval";
		await appendApprovalTurn({
			paths: fixture.paths,
			proposalId,
			revision: 1,
			diffDigest: FIRST_DIGEST,
			role: "human",
			kind: "question",
			text: "Why is this change needed?",
		});
		const approvalFile = join(fixture.paths.proposals, proposalId, "approval.jsonl");
		await appendFile(approvalFile, '{"schemaVersion":1');

		expect(await readApprovalTurns(fixture.paths, proposalId)).toHaveLength(1);
		expect((await readFile(approvalFile, "utf8")).endsWith("\n")).toBe(true);
		const second = await appendApprovalTurn({
			paths: fixture.paths,
			proposalId,
			revision: 1,
			diffDigest: FIRST_DIGEST,
			role: "meta",
			kind: "answer",
			text: "The recorded evidence supports it.",
		});
		expect(second.sequence).toBe(2);
		expect(await readApprovalTurns(fixture.paths, proposalId)).toHaveLength(2);
	});

	it("rejects unsafe proposal ids and non-contiguous approval logs", async () => {
		const fixture = await createFixture();
		await expect(
			appendApprovalTurn({
				paths: fixture.paths,
				proposalId: "../escape",
				revision: 1,
				diffDigest: FIRST_DIGEST,
				role: "human",
				kind: "defer",
				text: "Review later",
			}),
		).rejects.toThrow("Invalid proposal id");

		const proposalId = "p-sequence-integrity";
		await appendApprovalTurn({
			paths: fixture.paths,
			proposalId,
			revision: 1,
			diffDigest: FIRST_DIGEST,
			role: "human",
			kind: "revision-request",
			text: "Only change Y",
		});
		await appendApprovalTurn({
			paths: fixture.paths,
			proposalId,
			revision: 2,
			diffDigest: SECOND_DIGEST,
			role: "meta",
			kind: "revision-result",
			text: "Revision 2 is ready",
		});
		const approvalFile = join(fixture.paths.proposals, proposalId, "approval.jsonl");
		const lines = (await readFile(approvalFile, "utf8")).trim().split("\n");
		const second = JSON.parse(lines[1]) as Record<string, unknown>;
		second.sequence = 3;
		await writeFile(approvalFile, `${lines[0]}\n${JSON.stringify(second)}\n`);

		await expect(readApprovalTurns(fixture.paths, proposalId)).rejects.toThrow("sequence 2 is invalid");
	});
});
