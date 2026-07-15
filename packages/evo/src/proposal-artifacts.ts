import { randomUUID } from "node:crypto";
import { type FileHandle, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvoPaths } from "./paths.ts";
import { ensureEvoLayout } from "./paths.ts";
import {
	appendJsonLine,
	atomicWriteJson,
	canonicalJson,
	readJson,
	sha256,
	truncateIncompleteFinalLine,
	withFileLock,
} from "./storage.ts";
import type { EvaluationArtifactRef, EvidenceReference, Proposal, ProposalArtifactKind } from "./types.ts";

const PROPOSAL_ID_PATTERN = /^p-[A-Za-z0-9._-]+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_KINDS = new Set<ProposalArtifactKind>(["review", "replay", "validation", "comparison", "retrospective"]);
const APPROVAL_ROLES = new Set<ApprovalTurnRole>(["human", "meta"]);
const APPROVAL_KINDS = new Set<ApprovalTurnKind>([
	"question",
	"answer",
	"revision-request",
	"revision-result",
	"defer",
	"reopen",
]);
const APPROVAL_LOCK_TIMEOUT_MS = 30_000;
const APPROVAL_LOCK_STALE_MS = 10 * 60_000;

export type ApprovalTurnRole = "human" | "meta";
export type ApprovalTurnKind = "question" | "answer" | "revision-request" | "revision-result" | "defer" | "reopen";

export interface ApprovalTurn {
	schemaVersion: 1;
	proposalId: string;
	sequence: number;
	timestamp: string;
	revision: number;
	diffDigest: string;
	role: ApprovalTurnRole;
	kind: ApprovalTurnKind;
	text: string;
	evidence?: EvidenceReference[];
}

export type FixedEvaluationArtifactKind = Exclude<ProposalArtifactKind, "comparison" | "retrospective">;

export interface WriteEvaluationArtifactOptions {
	paths: EvoPaths;
	proposalId: string;
	revision: number;
	diffDigest: string;
	kind: FixedEvaluationArtifactKind;
	content: string;
	now?: () => Date;
}
export interface WriteEvidenceArtifactOptions {
	paths: EvoPaths;
	proposalId: string;
	revision: number;
	diffDigest: string;
	kind: "comparison" | "retrospective";
	content: string;
	evidenceDigest: string;
	evidenceCutoff: string;
	now?: () => Date;
}

export type WriteRetrospectiveArtifactOptions = Omit<WriteEvidenceArtifactOptions, "kind">;
export type WriteComparisonArtifactOptions = Omit<WriteEvidenceArtifactOptions, "kind"> & {
	markdownContent: string;
};

export interface ReadEvaluationArtifactOptions {
	paths: EvoPaths;
	proposalId: string;
	revision: number;
	diffDigest: string;
	kind: ProposalArtifactKind;
	reference: EvaluationArtifactRef;
}

export interface AppendApprovalTurnOptions {
	paths: EvoPaths;
	proposalId: string;
	revision: number;
	diffDigest: string;
	role: ApprovalTurnRole;
	kind: ApprovalTurnKind;
	text: string;
	evidence?: EvidenceReference[];
	now?: () => Date;
}

interface RevisionPaths {
	proposalDirectory: string;
	revisionsDirectory: string;
	revisionDirectory: string;
	revisionFile: string;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function syncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		await handle?.close();
	}
}

async function durableWriteOnceFile(path: string, content: string): Promise<boolean> {
	const directory = dirname(path);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle: FileHandle | undefined;
	let temporaryCreated = false;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			await link(temporaryPath, path);
			return true;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return false;
			throw error;
		}
	} finally {
		await handle?.close().catch(() => {});
		if (temporaryCreated) {
			await unlink(temporaryPath).catch((error: unknown) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
		}
		await syncDirectory(directory);
	}
}

function assertProposalRevision(proposalId: string, revision: number): void {
	if (!PROPOSAL_ID_PATTERN.test(proposalId) || proposalId.length > 200) {
		throw new Error(`Invalid proposal id: ${proposalId}`);
	}
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new Error("revision must be a positive safe integer");
	}
}

function assertDigest(digest: string, label: string): void {
	if (!DIGEST_PATTERN.test(digest)) throw new Error(`${label} must be a sha256 digest`);
}

function assertArtifactKind(kind: ProposalArtifactKind): void {
	if (!ARTIFACT_KINDS.has(kind)) throw new Error(`Unsupported proposal artifact kind: ${kind}`);
}

function revisionPaths(paths: EvoPaths, proposalId: string, revision: number): RevisionPaths {
	const proposalDirectory = join(paths.proposals, proposalId);
	const revisionsDirectory = join(proposalDirectory, "revisions");
	const revisionDirectory = join(revisionsDirectory, String(revision));
	return {
		proposalDirectory,
		revisionsDirectory,
		revisionDirectory,
		revisionFile: join(revisionDirectory, "revision.json"),
	};
}

export function getEvaluationArtifactFile(revision: number, kind: FixedEvaluationArtifactKind): string {
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new Error("revision must be a positive safe integer");
	}
	assertArtifactKind(kind);
	return `revisions/${revision}/${kind}.md`;
}

function getEvidenceArtifactFile(
	revision: number,
	kind: "comparison" | "retrospective",
	evidenceDigest: string,
): string {
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new Error("revision must be a positive safe integer");
	}
	assertDigest(evidenceDigest, `${kind} evidence digest`);
	const extension = kind === "comparison" ? "json" : "md";
	return `revisions/${revision}/${kind}s/${evidenceDigest}.${extension}`;
}

export function getRetrospectiveArtifactFile(revision: number, evidenceDigest: string): string {
	return getEvidenceArtifactFile(revision, "retrospective", evidenceDigest);
}

function getComparisonArtifactFile(revision: number, evidenceDigest: string): string {
	return getEvidenceArtifactFile(revision, "comparison", evidenceDigest);
}

function getComparisonMarkdownArtifactFile(revision: number, evidenceDigest: string): string {
	return getComparisonArtifactFile(revision, evidenceDigest).replace(/\.json$/, ".md");
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
	const pathStat = await lstat(path);
	if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory`);
	}
}

async function ensurePlainDirectory(path: string, label: string): Promise<void> {
	let created = false;
	try {
		await mkdir(path, { mode: 0o700 });
		created = true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	await assertPlainDirectory(path, label);
	if (created) {
		await syncDirectory(path);
		await syncDirectory(dirname(path));
	}
}

async function ensureRevisionDirectory(paths: EvoPaths, proposalId: string, revision: number): Promise<RevisionPaths> {
	await ensureEvoLayout(paths);
	await assertPlainDirectory(paths.proposals, "Proposal root");
	const resolved = revisionPaths(paths, proposalId, revision);
	await ensurePlainDirectory(resolved.proposalDirectory, "Proposal directory");
	await ensurePlainDirectory(resolved.revisionsDirectory, "Proposal revisions directory");
	await ensurePlainDirectory(resolved.revisionDirectory, "Proposal revision directory");
	return resolved;
}

async function assertRevisionDirectory(paths: EvoPaths, proposalId: string, revision: number): Promise<RevisionPaths> {
	const resolved = revisionPaths(paths, proposalId, revision);
	await assertPlainDirectory(paths.proposals, "Proposal root");
	await assertPlainDirectory(resolved.proposalDirectory, "Proposal directory");
	await assertPlainDirectory(resolved.revisionsDirectory, "Proposal revisions directory");
	await assertPlainDirectory(resolved.revisionDirectory, "Proposal revision directory");
	return resolved;
}

async function assertRegularFile(path: string, label: string): Promise<void> {
	const pathStat = await lstat(path);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

async function assertWritableFilePath(path: string, label: string): Promise<void> {
	try {
		await assertRegularFile(path, label);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function assertArtifactReference(
	reference: EvaluationArtifactRef,
	expectedFile: string,
	revision: number,
	diffDigest: string,
	kind: ProposalArtifactKind,
): void {
	if (reference.revision !== revision) throw new Error("Artifact reference belongs to a different proposal revision");
	if (reference.diffDigest !== diffDigest)
		throw new Error("Artifact reference diff digest does not match the revision");
	if (reference.file !== expectedFile) throw new Error("Artifact reference does not match its fixed revision path");
	if (reference.evidence) {
		if (kind !== "comparison" && kind !== "retrospective") {
			throw new Error("Only comparison and retrospective artifacts may bind an evidence snapshot");
		}
		assertDigest(reference.evidence.digest, "Artifact evidence digest");
		if (!reference.evidence.cutoff || !Number.isFinite(Date.parse(reference.evidence.cutoff))) {
			throw new Error("Artifact evidence cutoff is invalid");
		}
	}
	assertDigest(reference.sha256, "Artifact reference sha256");
	if (!reference.createdAt || Number.isNaN(Date.parse(reference.createdAt))) {
		throw new Error("Artifact reference createdAt is invalid");
	}
}

export async function writeEvaluationArtifact(options: WriteEvaluationArtifactOptions): Promise<EvaluationArtifactRef> {
	assertProposalRevision(options.proposalId, options.revision);
	assertDigest(options.diffDigest, "diffDigest");
	assertArtifactKind(options.kind);
	const resolved = await ensureRevisionDirectory(options.paths, options.proposalId, options.revision);
	const file = getEvaluationArtifactFile(options.revision, options.kind);
	const absolutePath = join(resolved.proposalDirectory, file);
	const contentDigest = sha256(options.content);
	if (!(await durableWriteOnceFile(absolutePath, options.content))) {
		await assertRegularFile(absolutePath, "Proposal artifact");
		if (sha256(await readFile(absolutePath)) !== contentDigest) {
			throw new Error(`Proposal ${options.kind} artifact is write-once for revision ${options.revision}`);
		}
	}
	await assertRegularFile(absolutePath, "Proposal artifact");
	return {
		file,
		sha256: contentDigest,
		revision: options.revision,
		diffDigest: options.diffDigest,
		createdAt: (options.now?.() ?? new Date()).toISOString(),
	};
}

async function writeEvidenceArtifact(options: WriteEvidenceArtifactOptions): Promise<EvaluationArtifactRef> {
	assertProposalRevision(options.proposalId, options.revision);
	assertDigest(options.diffDigest, "diffDigest");
	assertDigest(options.evidenceDigest, `${options.kind} evidence digest`);
	if (!options.evidenceCutoff || !Number.isFinite(Date.parse(options.evidenceCutoff))) {
		throw new Error(`${options.kind} evidence cutoff is invalid`);
	}
	const resolved = await ensureRevisionDirectory(options.paths, options.proposalId, options.revision);
	const directory = `${options.kind}s`;
	await ensurePlainDirectory(join(resolved.revisionDirectory, directory), `${options.kind} snapshot directory`);
	const file = getEvidenceArtifactFile(options.revision, options.kind, options.evidenceDigest);
	const absolutePath = join(resolved.proposalDirectory, file);
	const contentDigest = sha256(options.content);
	if (!(await durableWriteOnceFile(absolutePath, options.content))) {
		await assertRegularFile(absolutePath, `${options.kind} snapshot`);
		if (sha256(await readFile(absolutePath)) !== contentDigest) {
			throw new Error(`${options.kind} snapshot is write-once for evidence ${options.evidenceDigest}`);
		}
	}
	await assertRegularFile(absolutePath, `${options.kind} snapshot`);
	return {
		file,
		sha256: contentDigest,
		revision: options.revision,
		diffDigest: options.diffDigest,
		createdAt: (options.now?.() ?? new Date()).toISOString(),
		evidence: {
			digest: options.evidenceDigest,
			cutoff: options.evidenceCutoff,
		},
	};
}

export function writeRetrospectiveArtifact(options: WriteRetrospectiveArtifactOptions): Promise<EvaluationArtifactRef> {
	return writeEvidenceArtifact({ ...options, kind: "retrospective" });
}

export async function writeComparisonArtifact(options: WriteComparisonArtifactOptions): Promise<EvaluationArtifactRef> {
	const reference = await writeEvidenceArtifact({ ...options, kind: "comparison" });
	const markdownFile = getComparisonMarkdownArtifactFile(options.revision, options.evidenceDigest);
	const markdownPath = join(options.paths.proposals, options.proposalId, markdownFile);
	const markdownDigest = sha256(options.markdownContent);
	if (!(await durableWriteOnceFile(markdownPath, options.markdownContent))) {
		await assertRegularFile(markdownPath, "comparison markdown snapshot");
		if (sha256(await readFile(markdownPath)) !== markdownDigest) {
			throw new Error(`comparison markdown snapshot is write-once for evidence ${options.evidenceDigest}`);
		}
	}
	await assertRegularFile(markdownPath, "comparison markdown snapshot");
	return reference;
}

export async function readEvaluationArtifact(options: ReadEvaluationArtifactOptions): Promise<string> {
	assertProposalRevision(options.proposalId, options.revision);
	assertDigest(options.diffDigest, "diffDigest");
	assertArtifactKind(options.kind);
	let expectedFile: string;
	if (options.kind === "comparison" || options.kind === "retrospective") {
		if (!options.reference.evidence) throw new Error(`${options.kind} artifact has no evidence binding`);
		expectedFile = getEvidenceArtifactFile(options.revision, options.kind, options.reference.evidence.digest);
	} else {
		expectedFile = getEvaluationArtifactFile(options.revision, options.kind);
	}
	assertArtifactReference(options.reference, expectedFile, options.revision, options.diffDigest, options.kind);
	const resolved = await assertRevisionDirectory(options.paths, options.proposalId, options.revision);
	const absolutePath = join(resolved.proposalDirectory, expectedFile);
	await assertRegularFile(absolutePath, "Proposal artifact");
	const content = await readFile(absolutePath, "utf8");
	if (sha256(content) !== options.reference.sha256)
		throw new Error("Proposal artifact sha256 does not match its reference");
	return content;
}

export async function validateEvaluationArtifact(options: ReadEvaluationArtifactOptions): Promise<void> {
	await readEvaluationArtifact(options);
}

export async function saveProposalRevisionSnapshot(paths: EvoPaths, proposal: Proposal): Promise<string> {
	assertProposalRevision(proposal.id, proposal.revision);
	assertDigest(proposal.diffDigest, "proposal.diffDigest");
	const resolved = await ensureRevisionDirectory(paths, proposal.id, proposal.revision);
	const changeFile = join(resolved.revisionDirectory, "change.json");
	const changeContent = `${canonicalJson({
		schemaVersion: 1,
		proposalId: proposal.id,
		revision: proposal.revision,
		parentBundleDigest: proposal.parentBundleDigest,
		...(proposal.candidateDigest ? { candidateDigest: proposal.candidateDigest } : {}),
		kind: proposal.kind,
		tier: proposal.tier,
		motivation: proposal.motivation,
		expectedEffect: proposal.expectedEffect,
		risk: proposal.risk,
		verifyPlan: proposal.verifyPlan,
		trialPlan: proposal.trialPlan,
		changedPaths: proposal.changedPaths,
		diff: proposal.diff,
		diffDigest: proposal.diffDigest,
		approvalDigest: proposal.approvalDigest,
	})}\n`;
	const changeDigest = sha256(changeContent);
	if (!(await durableWriteOnceFile(changeFile, changeContent))) {
		await assertRegularFile(changeFile, "Proposal change snapshot");
		if (sha256(await readFile(changeFile)) !== changeDigest) {
			throw new Error(`Proposal change snapshot is write-once for revision ${proposal.revision}`);
		}
	}
	await assertWritableFilePath(resolved.revisionFile, "Proposal revision snapshot");
	await atomicWriteJson(resolved.revisionFile, proposal);
	await assertRegularFile(resolved.revisionFile, "Proposal revision snapshot");
	return `revisions/${proposal.revision}/revision.json`;
}

export async function readProposalRevisionSnapshot(
	paths: EvoPaths,
	proposalId: string,
	revision: number,
): Promise<Proposal> {
	assertProposalRevision(proposalId, revision);
	const resolved = await assertRevisionDirectory(paths, proposalId, revision);
	await assertRegularFile(resolved.revisionFile, "Proposal revision snapshot");
	const value = await readJson<unknown>(resolved.revisionFile);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Proposal revision snapshot must be an object");
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 2 || record.id !== proposalId || record.revision !== revision) {
		throw new Error("Proposal revision snapshot identity does not match its path");
	}
	if (typeof record.diffDigest !== "string") throw new Error("Proposal revision snapshot has no diff digest");
	assertDigest(record.diffDigest, "Proposal revision snapshot diffDigest");
	return value as Proposal;
}

function assertEvidence(evidence: readonly EvidenceReference[] | undefined): void {
	if (!evidence) return;
	for (const reference of evidence) {
		if (!reference.sessionId || !Number.isSafeInteger(reference.sequence) || reference.sequence <= 0) {
			throw new Error("Approval evidence must contain a sessionId and positive sequence");
		}
		if (reference.quote !== undefined && typeof reference.quote !== "string") {
			throw new Error("Approval evidence quote must be a string");
		}
	}
}

function parseApprovalTurn(value: unknown, proposalId: string, expectedSequence: number): ApprovalTurn {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Approval turn ${expectedSequence} must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.proposalId !== proposalId || record.sequence !== expectedSequence) {
		throw new Error(`Approval turn sequence ${expectedSequence} is invalid`);
	}
	if (!Number.isSafeInteger(record.revision) || (record.revision as number) <= 0) {
		throw new Error(`Approval turn ${expectedSequence} has an invalid revision`);
	}
	if (typeof record.diffDigest !== "string") throw new Error(`Approval turn ${expectedSequence} has no diff digest`);
	assertDigest(record.diffDigest, `Approval turn ${expectedSequence} diffDigest`);
	if (typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))) {
		throw new Error(`Approval turn ${expectedSequence} has an invalid timestamp`);
	}
	if (typeof record.role !== "string" || !APPROVAL_ROLES.has(record.role as ApprovalTurnRole)) {
		throw new Error(`Approval turn ${expectedSequence} has an invalid role`);
	}
	if (typeof record.kind !== "string" || !APPROVAL_KINDS.has(record.kind as ApprovalTurnKind)) {
		throw new Error(`Approval turn ${expectedSequence} has an invalid kind`);
	}
	if (typeof record.text !== "string" || !record.text.trim()) {
		throw new Error(`Approval turn ${expectedSequence} has empty text`);
	}
	if (record.evidence !== undefined && !Array.isArray(record.evidence)) {
		throw new Error(`Approval turn ${expectedSequence} evidence must be an array`);
	}
	const evidence = record.evidence as EvidenceReference[] | undefined;
	assertEvidence(evidence);
	return {
		schemaVersion: 1,
		proposalId,
		sequence: expectedSequence,
		timestamp: record.timestamp,
		revision: record.revision as number,
		diffDigest: record.diffDigest,
		role: record.role as ApprovalTurnRole,
		kind: record.kind as ApprovalTurnKind,
		text: record.text,
		...(evidence ? { evidence: evidence.map((reference) => ({ ...reference })) } : {}),
	};
}

async function readApprovalTurnsUnlocked(paths: EvoPaths, proposalId: string): Promise<ApprovalTurn[]> {
	const approvalFile = join(paths.proposals, proposalId, "approval.jsonl");
	await truncateIncompleteFinalLine(approvalFile);
	try {
		await assertRegularFile(approvalFile, "Proposal approval log");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const content = await readFile(approvalFile, "utf8");
	if (!content) return [];
	if (!content.endsWith("\n")) throw new Error("Proposal approval log has an incomplete final line");
	const lines = content.slice(0, -1).split("\n");
	return lines.map((line, index) => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`Proposal approval log line ${index + 1} is invalid JSON`);
		}
		return parseApprovalTurn(value, proposalId, index + 1);
	});
}

function withApprovalLock<T>(paths: EvoPaths, proposalId: string, operation: () => Promise<T>): Promise<T> {
	return withFileLock(paths, `approval-${proposalId}`, operation, {
		timeoutMs: APPROVAL_LOCK_TIMEOUT_MS,
		staleAfterMs: APPROVAL_LOCK_STALE_MS,
	});
}

export async function appendApprovalTurn(options: AppendApprovalTurnOptions): Promise<ApprovalTurn> {
	assertProposalRevision(options.proposalId, options.revision);
	assertDigest(options.diffDigest, "diffDigest");
	if (!APPROVAL_ROLES.has(options.role)) throw new Error(`Unsupported approval role: ${options.role}`);
	if (!APPROVAL_KINDS.has(options.kind)) throw new Error(`Unsupported approval turn kind: ${options.kind}`);
	if (!options.text.trim()) throw new Error("Approval turn text must not be empty");
	assertEvidence(options.evidence);
	return withApprovalLock(options.paths, options.proposalId, async () => {
		const resolved = await ensureRevisionDirectory(options.paths, options.proposalId, options.revision);
		const approvalFile = join(resolved.proposalDirectory, "approval.jsonl");
		await assertWritableFilePath(approvalFile, "Proposal approval log");
		const previous = await readApprovalTurnsUnlocked(options.paths, options.proposalId);
		const turn: ApprovalTurn = {
			schemaVersion: 1,
			proposalId: options.proposalId,
			sequence: previous.length + 1,
			timestamp: (options.now?.() ?? new Date()).toISOString(),
			revision: options.revision,
			diffDigest: options.diffDigest,
			role: options.role,
			kind: options.kind,
			text: options.text,
			...(options.evidence ? { evidence: options.evidence.map((reference) => ({ ...reference })) } : {}),
		};
		await appendJsonLine(approvalFile, turn);
		return turn;
	});
}

export async function readApprovalTurns(paths: EvoPaths, proposalId: string): Promise<ApprovalTurn[]> {
	assertProposalRevision(proposalId, 1);
	return withApprovalLock(paths, proposalId, () => readApprovalTurnsUnlocked(paths, proposalId));
}
