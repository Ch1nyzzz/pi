import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { compileBundle, loadCompiledBundle, materializeBundle } from "./bundle/compile.ts";
import { assertAssetPath } from "./bundle/schema.ts";
import type { EvoPaths } from "./paths.ts";
import type { RecordedEvent } from "./recorder/schema.ts";
import { readSessionLog, resolveStoredPayload } from "./recorder/store.ts";
import { BundleRegistry } from "./registry/registry.ts";
import { atomicWriteJson, canonicalJson, readJson, sha256 } from "./storage.ts";
import type {
	BundlePolicy,
	CompiledBundle,
	EvidenceReference,
	Proposal,
	ProposalTier,
	ReplayScenario,
} from "./types.ts";

export interface DraftChange {
	path: string;
	content: string | null;
}

export interface DraftProposal {
	motivation: string;
	expectedEffect: string;
	risk: string;
	verifyPlan: string;
	trialPlan: string;
	source: "pattern" | "explicit-request";
	evidence: EvidenceReference[];
	inboxReferences: string[];
	replayScenarios: ReplayScenario[];
	changes?: DraftChange[];
	codePatch?: string;
}

export interface ReflectorOutput {
	observationsMarkdown: string;
	proposals: DraftProposal[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label}.${key} must be a string`);
	return value;
}

function parseEvidence(value: unknown, label: string): EvidenceReference[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => {
		const record = asRecord(entry, `${label}[${index}]`);
		if (typeof record.sessionId !== "string" || !Number.isSafeInteger(record.sequence)) {
			throw new Error(`${label}[${index}] must contain sessionId and sequence`);
		}
		if (record.quote !== undefined && typeof record.quote !== "string")
			throw new Error(`${label}[${index}].quote must be a string`);
		return {
			sessionId: record.sessionId,
			sequence: record.sequence as number,
			quote: record.quote as string | undefined,
		};
	});
}

function parseReplays(value: unknown, label: string): ReplayScenario[] {
	if (value === undefined) return [];
	return parseEvidence(value, label).map(({ sessionId, sequence }) => ({ sessionId, sequence }));
}

function parseStringArray(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
		throw new Error(`${label} must be a string array`);
	return [...(value as string[])];
}

function parseChanges(value: unknown, label: string): DraftChange[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => {
		const record = asRecord(entry, `${label}[${index}]`);
		if (typeof record.path !== "string" || (record.content !== null && typeof record.content !== "string")) {
			throw new Error(`${label}[${index}] must contain path and string|null content`);
		}
		return { path: record.path, content: record.content } as DraftChange;
	});
}

function extractJsonObject(text: string): unknown {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start === -1 || end < start) throw new Error("Reflector did not return a JSON object");
	return JSON.parse(trimmed.slice(start, end + 1));
}

export function parseReflectorOutput(text: string): ReflectorOutput {
	const root = asRecord(extractJsonObject(text), "reflector output");
	const observationsMarkdown = requiredString(root, "observationsMarkdown", "reflector output");
	if (!Array.isArray(root.proposals)) throw new Error("reflector output.proposals must be an array");
	const proposals = root.proposals.map((entry, index) => {
		const record = asRecord(entry, `proposals[${index}]`);
		const source = record.source;
		if (source !== "pattern" && source !== "explicit-request") {
			throw new Error(`proposals[${index}].source must be pattern or explicit-request`);
		}
		const codePatch = record.codePatch;
		if (codePatch !== undefined && typeof codePatch !== "string") {
			throw new Error(`proposals[${index}].codePatch must be a string`);
		}
		return {
			motivation: requiredString(record, "motivation", `proposals[${index}]`),
			expectedEffect: requiredString(record, "expectedEffect", `proposals[${index}]`),
			risk: requiredString(record, "risk", `proposals[${index}]`),
			verifyPlan: requiredString(record, "verifyPlan", `proposals[${index}]`),
			trialPlan: requiredString(record, "trialPlan", `proposals[${index}]`),
			source,
			evidence: parseEvidence(record.evidence, `proposals[${index}].evidence`),
			inboxReferences: parseStringArray(record.inboxReferences, `proposals[${index}].inboxReferences`),
			replayScenarios: parseReplays(record.replayScenarios, `proposals[${index}].replayScenarios`),
			changes: parseChanges(record.changes, `proposals[${index}].changes`),
			codePatch,
		} satisfies DraftProposal;
	});
	return { observationsMarkdown, proposals };
}

function formatProposalId(): string {
	return `p-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function normalizeText(content: string): string {
	return content
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function withoutLayoutPolicy(policy: BundlePolicy): Record<string, unknown> {
	const record = { ...policy } as Record<string, unknown>;
	delete record.promptOrder;
	delete record.stablePromptPaths;
	delete record.dynamicPromptPaths;
	return record;
}

async function isReorderOnly(
	parentDirectory: string,
	candidateDirectory: string,
	parentPolicy: BundlePolicy,
	candidatePolicy: BundlePolicy,
	parentPaths: string[],
	candidatePaths: string[],
): Promise<boolean> {
	if (canonicalJson(withoutLayoutPolicy(parentPolicy)) !== canonicalJson(withoutLayoutPolicy(candidatePolicy)))
		return false;
	const parentAssets = parentPaths.filter((path) => path !== "policy.json");
	const candidateAssets = candidatePaths.filter((path) => path !== "policy.json");
	if ([...parentAssets, ...candidateAssets].some((path) => !path.startsWith("prompts/"))) return false;
	const contentDigests = async (directory: string, paths: string[]) =>
		Promise.all(paths.map(async (path) => sha256(normalizeText(await readFile(join(directory, path), "utf8")))));
	const parentDigests = (await contentDigests(parentDirectory, parentAssets)).sort();
	const candidateDigests = (await contentDigests(candidateDirectory, candidateAssets)).sort();
	return parentDigests.join("\n") === candidateDigests.join("\n");
}

function isCoreChange(parentPolicy: BundlePolicy, candidatePolicy: BundlePolicy, changedPaths: string[]): boolean {
	const coreAssets = new Set([...(parentPolicy.coreAssets ?? []), ...(candidatePolicy.coreAssets ?? [])]);
	if (changedPaths.some((path) => coreAssets.has(path))) return true;
	const parentCorePolicy = {
		coreAssets: parentPolicy.coreAssets ?? [],
		limits: parentPolicy.limits ?? {},
		modelRouting: parentPolicy.modelRouting ?? {},
		validation: parentPolicy.validation ?? {},
	};
	const candidateCorePolicy = {
		coreAssets: candidatePolicy.coreAssets ?? [],
		limits: candidatePolicy.limits ?? {},
		modelRouting: candidatePolicy.modelRouting ?? {},
		validation: candidatePolicy.validation ?? {},
	};
	return canonicalJson(parentCorePolicy) !== canonicalJson(candidateCorePolicy);
}

function userMessageText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const message = value as Record<string, unknown>;
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		const content = block as Record<string, unknown>;
		if (content.type === "text" && typeof content.text === "string") parts.push(content.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

async function isDirectPreference(
	paths: EvoPaths,
	evidence: EvidenceReference[],
	changedPaths: string[],
	before: Map<string, string>,
	after: Map<string, string>,
): Promise<boolean> {
	if (changedPaths.length !== 1 || !changedPaths[0].startsWith("memory/") || before.has(changedPaths[0])) return false;
	const content = after.get(changedPaths[0]);
	if (!content || !normalizeText(content)) return false;
	const logs = new Map<string, Promise<RecordedEvent[]>>();
	for (const reference of evidence) {
		if (reference.quote === undefined || normalizeText(reference.quote) !== normalizeText(content)) continue;
		let events = logs.get(reference.sessionId);
		if (!events) {
			events = readSessionLog(paths, reference.sessionId);
			logs.set(reference.sessionId, events);
		}
		const event = (await events).find((candidate) => candidate.sequence === reference.sequence);
		if (event?.type === "explicit_feedback") {
			const text = await resolveStoredPayload(paths, event.text);
			if (typeof text === "string" && normalizeText(text) === normalizeText(reference.quote)) return true;
		}
		if (event?.type === "message" && event.role === "user") {
			const message = await resolveStoredPayload(paths, event.message);
			const text = userMessageText(message);
			if (text !== undefined && normalizeText(text) === normalizeText(reference.quote)) return true;
		}
	}
	return false;
}

async function readBundleFileMap(directory: string, paths: string[]): Promise<Map<string, string>> {
	return new Map(
		await Promise.all(paths.map(async (path) => [path, await readFile(join(directory, path), "utf8")] as const)),
	);
}

function renderDiff(before: Map<string, string>, after: Map<string, string>, changedPaths: string[]): string {
	return changedPaths
		.map((path) => generateUnifiedPatch(path, before.get(path) ?? "", after.get(path) ?? ""))
		.join("\n");
}

async function classifyDataTier(options: {
	paths: EvoPaths;
	evidence: EvidenceReference[];
	parentDirectory: string;
	candidateDirectory: string;
	parentPolicy: BundlePolicy;
	candidatePolicy: BundlePolicy;
	parentPaths: string[];
	candidatePaths: string[];
	changedPaths: string[];
	before: Map<string, string>;
	after: Map<string, string>;
}): Promise<{ tier: ProposalTier; reason: string }> {
	if (isCoreChange(options.parentPolicy, options.candidatePolicy, options.changedPaths)) {
		return { tier: "T2", reason: "The diff touches a core asset or core policy field" };
	}
	if (
		await isReorderOnly(
			options.parentDirectory,
			options.candidateDirectory,
			options.parentPolicy,
			options.candidatePolicy,
			options.parentPaths,
			options.candidatePaths,
		)
	) {
		return { tier: "T0", reason: "Normalized prompt contents are unchanged; only layout changed" };
	}
	if (await isDirectPreference(options.paths, options.evidence, options.changedPaths, options.before, options.after)) {
		return { tier: "T0", reason: "A single memory entry copies an explicitly cited user preference" };
	}
	return { tier: "T1", reason: "The diff is a non-core data change" };
}

interface DataCandidateEvaluation {
	kind: "data";
	tier: ProposalTier;
	changedPaths: string[];
	diff: string;
	l1: Proposal["l1"];
}

async function evaluateDataCandidate(options: {
	paths: EvoPaths;
	parent: CompiledBundle;
	candidate: CompiledBundle;
	evidence: EvidenceReference[];
}): Promise<DataCandidateEvaluation> {
	if (options.candidate.manifest.parentDigest !== options.parent.digest) {
		throw new Error("Candidate bundle parent does not match the proposal parent");
	}
	const parentPaths = options.parent.manifest.files.map((file) => file.path);
	const candidatePaths = options.candidate.manifest.files.map((file) => file.path);
	const before = await readBundleFileMap(options.parent.directory, parentPaths);
	const after = await readBundleFileMap(options.candidate.directory, candidatePaths);
	const changedPaths = [...new Set([...parentPaths, ...candidatePaths])]
		.filter((path) => before.get(path) !== after.get(path))
		.sort();
	if (changedPaths.length === 0) throw new Error("Proposal does not change the bundle");
	const classification = await classifyDataTier({
		paths: options.paths,
		evidence: options.evidence,
		parentDirectory: options.parent.directory,
		candidateDirectory: options.candidate.directory,
		parentPolicy: options.parent.policy,
		candidatePolicy: options.candidate.policy,
		parentPaths,
		candidatePaths,
		changedPaths,
		before,
		after,
	});
	return {
		kind: "data",
		tier: classification.tier,
		changedPaths,
		diff: renderDiff(before, after, changedPaths),
		l1: { passed: true, reason: classification.reason, errors: [] },
	};
}

async function applyDraftChanges(candidateDirectory: string, changes: DraftChange[]): Promise<void> {
	const seen = new Set<string>();
	for (const change of changes) {
		assertAssetPath(change.path);
		if (change.path === "bundle.json") throw new Error("Reflector cannot edit bundle.json");
		if (seen.has(change.path)) throw new Error(`Proposal changes ${change.path} more than once`);
		seen.add(change.path);
		const target = join(candidateDirectory, change.path);
		if (change.content === null) {
			if (change.path === "policy.json") throw new Error("Proposal cannot delete policy.json");
			await unlink(target);
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, change.content, "utf8");
	}
}

export async function stageProposal(options: {
	paths: EvoPaths;
	parentDigest: string;
	draft: DraftProposal;
	observationsMarkdown: string;
}): Promise<Proposal> {
	const id = formatProposalId();
	const temporaryDirectory = join(options.paths.proposals, `.tmp-${id}`);
	const proposalDirectory = join(options.paths.proposals, id);
	await mkdir(temporaryDirectory, { recursive: true });
	try {
		if (options.draft.codePatch !== undefined || options.draft.changes === undefined) {
			const codePatch = options.draft.codePatch ?? "";
			const proposal: Proposal = {
				schemaVersion: 1,
				id,
				createdAt: new Date().toISOString(),
				parentBundleDigest: options.parentDigest,
				kind: "code",
				tier: "T2",
				motivation: options.draft.motivation,
				diff: codePatch,
				expectedEffect: options.draft.expectedEffect,
				risk: options.draft.risk,
				verifyPlan: options.draft.verifyPlan,
				trialPlan: options.draft.trialPlan,
				status: "pending",
				source: options.draft.source,
				evidence: options.draft.evidence,
				inboxReferences: options.draft.inboxReferences,
				replayScenarios: options.draft.replayScenarios,
				changedPaths: [],
				approvalDigest: sha256(codePatch),
				codePatch,
				l1: {
					passed: false,
					reason: "Code proposals require the M4 isolated-worktree validation flow",
					errors: ["No isolated worktree is attached to this proposal"],
				},
			};
			await writeFile(join(temporaryDirectory, "observations.md"), options.observationsMarkdown, "utf8");
			await atomicWriteJson(join(temporaryDirectory, "proposal.json"), proposal);
			await rename(temporaryDirectory, proposalDirectory);
			return proposal;
		}

		const parent = await loadCompiledBundle(options.paths, options.parentDigest);
		const candidateDirectory = join(temporaryDirectory, "candidate");
		await materializeBundle(options.paths, options.parentDigest, candidateDirectory);
		await applyDraftChanges(candidateDirectory, options.draft.changes);
		const candidate = await compileBundle({
			paths: options.paths,
			sourceDirectory: candidateDirectory,
			parentDigest: options.parentDigest,
			summary: options.draft.expectedEffect.slice(0, 240),
		});
		const evaluation = await evaluateDataCandidate({
			paths: options.paths,
			parent,
			candidate,
			evidence: options.draft.evidence,
		});
		const proposal: Proposal = {
			schemaVersion: 1,
			id,
			createdAt: new Date().toISOString(),
			parentBundleDigest: options.parentDigest,
			kind: evaluation.kind,
			tier: evaluation.tier,
			motivation: options.draft.motivation,
			diff: evaluation.diff,
			expectedEffect: options.draft.expectedEffect,
			risk: options.draft.risk,
			verifyPlan: options.draft.verifyPlan,
			trialPlan: options.draft.trialPlan,
			status: "pending",
			source: options.draft.source,
			evidence: options.draft.evidence,
			inboxReferences: options.draft.inboxReferences,
			replayScenarios: options.draft.replayScenarios,
			changedPaths: evaluation.changedPaths,
			approvalDigest: candidate.digest,
			candidateDigest: candidate.digest,
			l1: evaluation.l1,
		};
		await rm(candidateDirectory, { recursive: true, force: true });
		await writeFile(join(temporaryDirectory, "observations.md"), options.observationsMarkdown, "utf8");
		await atomicWriteJson(join(temporaryDirectory, "proposal.json"), proposal);
		await rename(temporaryDirectory, proposalDirectory);
		return proposal;
	} catch (error) {
		await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function assertProposalId(id: string): void {
	if (!/^p-[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid proposal id: ${id}`);
}

export async function loadProposal(paths: EvoPaths, id: string): Promise<Proposal> {
	assertProposalId(id);
	return readJson<Proposal>(join(paths.proposals, id, "proposal.json"));
}

export async function saveProposal(paths: EvoPaths, proposal: Proposal): Promise<void> {
	assertProposalId(proposal.id);
	await atomicWriteJson(join(paths.proposals, proposal.id, "proposal.json"), proposal);
}

async function assertApprovalArtifact(
	paths: EvoPaths,
	proposal: Proposal,
	field: "reviewFile" | "replayFile",
	expectedFile: "review.md" | "replay.md",
): Promise<void> {
	if (proposal[field] !== expectedFile) {
		throw new Error(`Proposal ${proposal.id} requires ${field} to be ${expectedFile} before approval`);
	}
	try {
		if (!(await lstat(join(paths.proposals, proposal.id, expectedFile))).isFile()) {
			throw new Error(`Proposal ${proposal.id} ${expectedFile} is not a regular file`);
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			throw new Error(`Proposal ${proposal.id} is missing required artifact ${expectedFile}`);
		}
		throw error;
	}
}

function matchesApprovalDigest(expected: string, current: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(current)) return false;
	return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(current, "hex"));
}

async function revalidateDataProposal(
	paths: EvoPaths,
	proposal: Proposal,
): Promise<{ candidate: CompiledBundle; evaluation: DataCandidateEvaluation }> {
	if (!proposal.candidateDigest || !matchesApprovalDigest(proposal.approvalDigest, proposal.candidateDigest)) {
		throw new Error("Proposal approval digest does not match its candidate bundle");
	}
	const [parent, candidate] = await Promise.all([
		loadCompiledBundle(paths, proposal.parentBundleDigest),
		loadCompiledBundle(paths, proposal.candidateDigest),
	]);
	const evaluation = await evaluateDataCandidate({ paths, parent, candidate, evidence: proposal.evidence });
	const mismatches: string[] = [];
	if (proposal.kind !== evaluation.kind) mismatches.push("kind");
	if (proposal.tier !== evaluation.tier) mismatches.push("tier");
	if (canonicalJson(proposal.changedPaths) !== canonicalJson(evaluation.changedPaths)) mismatches.push("changedPaths");
	if (proposal.diff !== evaluation.diff) mismatches.push("diff");
	if (proposal.l1.passed !== evaluation.l1.passed) mismatches.push("l1.passed");
	if (mismatches.length > 0) {
		throw new Error(`Proposal ${proposal.id} does not match immutable bundle audit: ${mismatches.join(", ")}`);
	}
	return { candidate, evaluation };
}

export async function approveProposal(paths: EvoPaths, id: string, expectedApprovalDigest: string): Promise<Proposal> {
	const proposal = await loadProposal(paths, id);
	if (!matchesApprovalDigest(expectedApprovalDigest, proposal.approvalDigest)) {
		throw new Error(`Proposal ${id} approval digest does not match the confirmed digest`);
	}
	if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}`);
	if (proposal.kind === "code") {
		if (!proposal.l1.passed) throw new Error(`Proposal ${id} failed L1: ${proposal.l1.errors.join("; ")}`);
		throw new Error(`Proposal ${id} failed L1: Code proposals require the M4 isolated-worktree validation flow`);
	}
	const { candidate, evaluation } = await revalidateDataProposal(paths, proposal);
	if (evaluation.tier !== "T0") await assertApprovalArtifact(paths, proposal, "reviewFile", "review.md");
	if (evaluation.tier === "T2") {
		await assertApprovalArtifact(paths, proposal, "replayFile", "replay.md");
	}
	const registry = new BundleRegistry(paths);
	if ((await registry.readStableDigest()) !== proposal.parentBundleDigest) {
		throw new Error("Proposal parent is no longer stable; regenerate or rebase it");
	}
	await registry.recordDecision({ proposalId: id, approved: true, reason: `Approved ${candidate.digest}` });
	if (evaluation.tier === "T0") {
		await registry.activateTrial({ digest: candidate.digest, proposalId: id, plan: proposal.trialPlan });
		await registry.keepTrial("T0 deterministic change applied");
		proposal.status = "kept";
	} else {
		await registry.activateTrial({ digest: candidate.digest, proposalId: id, plan: proposal.trialPlan });
		proposal.status = "trialing";
	}
	await saveProposal(paths, proposal);
	return proposal;
}

export async function rejectProposal(paths: EvoPaths, id: string, reason: string): Promise<Proposal> {
	const proposal = await loadProposal(paths, id);
	if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}`);
	await new BundleRegistry(paths).recordDecision({ proposalId: id, approved: false, reason });
	proposal.status = "rejected";
	await saveProposal(paths, proposal);
	return proposal;
}
