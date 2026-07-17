import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateUnifiedPatch } from "@ch1nyzzz/pi-coding-agent";
import { compileBundle, loadCompiledBundle, materializeBundle } from "./bundle/compile.ts";
import { assertAssetPath } from "./bundle/schema.ts";
import {
	type CodeL1Result,
	type CodeValidationExecutor,
	codeApprovalDigest,
	revalidateCodeWorktree,
	stageCodeWorktree,
} from "./code/worktree.ts";
import { createDefaultEvoAbiRegistry } from "./components/registry.ts";
import { PREFERENCES_PATH, parsePreferenceMemory } from "./memory/preferences.ts";
import type { EvoPaths } from "./paths.ts";
import {
	saveProposalRevisionSnapshot,
	validateEvaluationArtifact,
	writeEvaluationArtifact,
	writeRetrospectiveArtifact,
} from "./proposal-artifacts.ts";
import { readSessionLog, resolveStoredPayload } from "./recorder/store.ts";
import { BundleRegistry } from "./registry/registry.ts";
import { atomicWriteJson, canonicalJson, readJson, sha256, withFileLock } from "./storage.ts";
import type {
	BundlePolicy,
	CompiledBundle,
	DataApprovalActivation,
	EvidenceReference,
	Proposal,
	ProposalApproval,
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
	targetAbi?: string;
	requiresNewAbi?: boolean;
	suggestedTier?: ProposalTier;
	changes?: DraftChange[];
	codePatch?: string;
}

export interface ReflectorOutput {
	observationsMarkdown: string;
	observationEvidence: EvidenceReference[];
	proposals: DraftProposal[];
}

function assertCodeDraftReplayScenario(draft: DraftProposal): void {
	if (
		(draft.codePatch !== undefined || draft.changes === undefined) &&
		!draft.requiresNewAbi &&
		!draft.replayScenarios[0]
	) {
		throw new Error("Code proposals require at least one replay scenario");
	}
}

function assertDraftAbi(draft: DraftProposal): void {
	if (draft.requiresNewAbi) {
		if (draft.codePatch === undefined && draft.changes !== undefined) {
			throw new Error("A new ABI requires an infrastructure code proposal");
		}
		return;
	}
	if (draft.targetAbi) createDefaultEvoAbiRegistry().require(draft.targetAbi);
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
	return parseReflectorOutputValue(extractJsonObject(text));
}

export function parseReflectorOutputValue(value: unknown): ReflectorOutput {
	const root = asRecord(value, "reflector output");
	const observationsMarkdown = requiredString(root, "observationsMarkdown", "reflector output");
	const observationEvidence = parseEvidence(root.observationEvidence ?? [], "reflector output.observationEvidence");
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
		const targetAbi = record.targetAbi;
		if (targetAbi !== undefined && typeof targetAbi !== "string") {
			throw new Error(`proposals[${index}].targetAbi must be a string`);
		}
		const requiresNewAbi = record.requiresNewAbi;
		if (requiresNewAbi !== undefined && typeof requiresNewAbi !== "boolean") {
			throw new Error(`proposals[${index}].requiresNewAbi must be boolean`);
		}
		const suggestedTier = record.suggestedTier;
		if (suggestedTier !== undefined && suggestedTier !== "T0" && suggestedTier !== "T1" && suggestedTier !== "T2") {
			throw new Error(`proposals[${index}].suggestedTier must be T0, T1, or T2`);
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
			targetAbi: targetAbi as string | undefined,
			requiresNewAbi: requiresNewAbi as boolean | undefined,
			suggestedTier: suggestedTier as ProposalTier | undefined,
			changes: parseChanges(record.changes, `proposals[${index}].changes`),
			codePatch,
		} satisfies DraftProposal;
	});
	return { observationsMarkdown, observationEvidence, proposals };
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

function stricterTier(determined: ProposalTier, suggested: ProposalTier | undefined): ProposalTier {
	if (!suggested) return determined;
	const rank: Record<ProposalTier, number> = { T0: 0, T1: 1, T2: 2 };
	return rank[suggested] > rank[determined] ? suggested : determined;
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
		enabledFeatures: parentPolicy.enabledFeatures ?? [],
		enabledTools: parentPolicy.enabledTools ?? [],
		limits: parentPolicy.limits ?? {},
		managedSources: parentPolicy.managedSources ?? [],
		components: parentPolicy.components ?? {},
		modelRouting: parentPolicy.modelRouting ?? {},
		validation: parentPolicy.validation ?? {},
	};
	const candidateCorePolicy = {
		coreAssets: candidatePolicy.coreAssets ?? [],
		enabledFeatures: candidatePolicy.enabledFeatures ?? [],
		enabledTools: candidatePolicy.enabledTools ?? [],
		limits: candidatePolicy.limits ?? {},
		managedSources: candidatePolicy.managedSources ?? [],
		components: candidatePolicy.components ?? {},
		modelRouting: candidatePolicy.modelRouting ?? {},
		validation: candidatePolicy.validation ?? {},
	};
	return canonicalJson(parentCorePolicy) !== canonicalJson(candidateCorePolicy);
}

function withoutComponentSurface(policy: BundlePolicy, surface: string): BundlePolicy {
	const components = { ...(policy.components ?? {}) };
	delete components[surface];
	const stripped = { ...policy };
	if (Object.keys(components).length === 0) delete stripped.components;
	else stripped.components = components;
	return stripped;
}

function isRegisteredComponentSelectionChange(options: {
	parentPolicy: BundlePolicy;
	candidatePolicy: BundlePolicy;
	changedPaths: string[];
	targetAbi?: string;
	requiresNewAbi?: boolean;
}): boolean {
	if (
		options.requiresNewAbi !== false ||
		options.targetAbi === undefined ||
		options.changedPaths.length !== 1 ||
		options.changedPaths[0] !== "policy.json"
	) {
		return false;
	}
	const abi = createDefaultEvoAbiRegistry().get(options.targetAbi);
	if (!abi) return false;
	const before = options.parentPolicy.components?.[abi.surface];
	const after = options.candidatePolicy.components?.[abi.surface];
	if (!after || after.abi !== abi.id || canonicalJson(before ?? null) === canonicalJson(after)) return false;
	return (
		canonicalJson(withoutComponentSurface(options.parentPolicy, abi.surface)) ===
		canonicalJson(withoutComponentSurface(options.candidatePolicy, abi.surface))
	);
}

function containsText(value: unknown, quote: string): boolean {
	if (typeof value === "string") return value.includes(quote);
	if (Array.isArray(value)) return value.some((entry) => containsText(entry, quote));
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value as Record<string, unknown>).some((entry) => containsText(entry, quote));
}

async function evidenceContainsPreferenceSource(
	paths: EvoPaths,
	evidence: EvidenceReference[],
	source: { sessionId: string; sequence: number; quote: string },
): Promise<boolean> {
	const reference = evidence.find(
		(entry) =>
			entry.sessionId === source.sessionId &&
			entry.sequence === source.sequence &&
			entry.quote !== undefined &&
			source.quote.includes(entry.quote),
	);
	if (!reference?.quote) return false;
	const event = (await readSessionLog(paths, source.sessionId)).find((entry) => entry.sequence === source.sequence);
	if (!event) return false;
	if (event.type === "explicit_feedback") {
		return containsText(await resolveStoredPayload(paths, event.text), source.quote);
	}
	if (event.type === "message") {
		return containsText(await resolveStoredPayload(paths, event.message), source.quote);
	}
	if (event.type === "before_agent_start") {
		return containsText(await resolveStoredPayload(paths, event.prompt), source.quote);
	}
	return false;
}

async function isDirectPreference(
	paths: EvoPaths,
	evidence: EvidenceReference[],
	changedPaths: string[],
	before: Map<string, string>,
	after: Map<string, string>,
): Promise<boolean> {
	if (changedPaths.length !== 1) return false;
	if (changedPaths[0] !== PREFERENCES_PATH) {
		const path = changedPaths[0];
		if (!path?.startsWith("memory/") || before.has(path)) return false;
		const content = after.get(path);
		if (!content || !normalizeText(content)) return false;
		for (const reference of evidence) {
			if (reference.quote === undefined || normalizeText(reference.quote) !== normalizeText(content)) continue;
			const event = (await readSessionLog(paths, reference.sessionId)).find(
				(candidate) => candidate.sequence === reference.sequence,
			);
			if (event?.type !== "explicit_feedback") continue;
			const text = await resolveStoredPayload(paths, event.text);
			if (typeof text === "string" && normalizeText(text) === normalizeText(reference.quote)) return true;
		}
		return false;
	}
	const afterContent = after.get(PREFERENCES_PATH);
	if (!afterContent) return false;
	const previous = before.has(PREFERENCES_PATH)
		? parsePreferenceMemory(JSON.parse(before.get(PREFERENCES_PATH) ?? ""))
		: { schemaVersion: 1 as const, preferences: [] };
	const next = parsePreferenceMemory(JSON.parse(afterContent));
	if (next.preferences.length <= previous.preferences.length) return false;
	for (const [index, preference] of previous.preferences.entries()) {
		if (canonicalJson(preference) !== canonicalJson(next.preferences[index])) return false;
	}
	for (const preference of next.preferences.slice(previous.preferences.length)) {
		if (!("sessionId" in preference.source)) return false;
		if (!preference.source.quote.includes(preference.instruction)) return false;
		if (!(await evidenceContainsPreferenceSource(paths, evidence, preference.source))) return false;
	}
	return true;
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
	targetAbi?: string;
	requiresNewAbi?: boolean;
}): Promise<{ tier: ProposalTier; reason: string }> {
	if (isRegisteredComponentSelectionChange(options)) {
		return {
			tier: "T1",
			reason: "The diff selects a sandboxed component on an existing registered ABI for Canary review",
		};
	}
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
	suggestedTier?: ProposalTier;
	targetAbi?: string;
	requiresNewAbi?: boolean;
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
		targetAbi: options.targetAbi,
		requiresNewAbi: options.requiresNewAbi,
	});
	const tier = stricterTier(classification.tier, options.suggestedTier);
	return {
		kind: "data",
		tier,
		changedPaths,
		diff: renderDiff(before, after, changedPaths),
		l1: {
			passed: true,
			reason:
				tier === classification.tier ? classification.reason : `${classification.reason}; model requested ${tier}`,
			errors: [],
		},
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

function renderCodeValidation(result: CodeL1Result): string {
	const checks = result.checks
		.map(({ name, result: command }) => {
			const outcome = command.code === 0 && !command.killed && !command.outputLimitExceeded ? "passed" : "failed";
			return `- ${name}: ${outcome} (exit ${command.code ?? "signal"})`;
		})
		.join("\n");
	return [
		"# Sandboxed L1 validation",
		"",
		`Result: ${result.passed ? "passed" : "failed"}`,
		...(checks ? ["", checks] : []),
		...(result.errors.length > 0 ? ["", "## Errors", "", ...result.errors.map((error) => `- ${error}`)] : []),
		"",
	].join("\n");
}

export async function stageProposal(options: {
	paths: EvoPaths;
	parentDigest: string;
	draft: DraftProposal;
	observationsMarkdown: string;
	repositoryCwd?: string;
	expectedCodeBase?: {
		repositoryRoot: string;
		repositoryIdentity: string;
		baseCommit: string;
	};
	codeValidationExecutor?: CodeValidationExecutor;
	signal?: AbortSignal;
}): Promise<Proposal> {
	assertCodeDraftReplayScenario(options.draft);
	assertDraftAbi(options.draft);
	const id = formatProposalId();
	const temporaryDirectory = join(options.paths.proposals, `.tmp-${id}`);
	const proposalDirectory = join(options.paths.proposals, id);
	await mkdir(temporaryDirectory, { recursive: true });
	try {
		if (options.draft.codePatch !== undefined || options.draft.changes === undefined) {
			const codePatch = options.draft.codePatch ?? "";
			await rm(temporaryDirectory, { recursive: true, force: true });
			const staged = await stageCodeWorktree({
				paths: options.paths,
				repositoryCwd: options.repositoryCwd ?? process.cwd(),
				proposalId: id,
				revision: 1,
				parentBundleDigest: options.parentDigest,
				patch: codePatch,
				...(options.expectedCodeBase
					? {
							expectedRepositoryRoot: options.expectedCodeBase.repositoryRoot,
							expectedRepositoryIdentity: options.expectedCodeBase.repositoryIdentity,
							expectedBaseCommit: options.expectedCodeBase.baseCommit,
						}
					: {}),
				...(options.codeValidationExecutor ? { validationExecutor: options.codeValidationExecutor } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			const diffDigest = staged.diffDigest;
			const proposal: Proposal = {
				schemaVersion: 2,
				id,
				createdAt: new Date().toISOString(),
				revision: 1,
				parentBundleDigest: options.parentDigest,
				kind: "code",
				tier: "T2",
				motivation: options.draft.motivation,
				diff: staged.diff,
				expectedEffect: options.draft.expectedEffect,
				risk: options.draft.risk,
				verifyPlan: options.draft.verifyPlan,
				trialPlan: options.draft.trialPlan,
				status: "pending",
				source: options.draft.source,
				evidence: options.draft.evidence,
				inboxReferences: options.draft.inboxReferences,
				replayScenarios: options.draft.replayScenarios,
				...(options.draft.targetAbi ? { targetAbi: options.draft.targetAbi } : {}),
				...(options.draft.requiresNewAbi !== undefined ? { requiresNewAbi: options.draft.requiresNewAbi } : {}),
				changedPaths: staged.changedPaths,
				diffDigest,
				approvalDigest: staged.approvalDigest,
				codePatch,
				codeWorkspace: {
					repositoryRoot: staged.repositoryRoot,
					repositoryId: staged.repositoryIdentity,
					worktreePath: staged.worktreePath,
					branch: staged.branch,
					baseCommit: staged.baseCommit,
					integrityDigest: staged.approvalDigest,
				},
				suggestedTier: options.draft.suggestedTier,
				l1: {
					passed: staged.l1.passed,
					reason: staged.l1.passed ? "Sandboxed code validation passed" : "Sandboxed code validation failed",
					errors: staged.l1.errors,
				},
				artifacts: {},
			};
			await writeFile(join(proposalDirectory, "observations.md"), options.observationsMarkdown, "utf8");
			proposal.artifacts.validation = await writeEvaluationArtifact({
				paths: options.paths,
				proposalId: id,
				revision: proposal.revision,
				diffDigest,
				kind: "validation",
				content: renderCodeValidation(staged.l1),
			});
			await saveProposal(options.paths, proposal);
			await saveProposalRevisionSnapshot(options.paths, proposal);
			return proposal;
		}

		options.signal?.throwIfAborted();
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
			suggestedTier: options.draft.suggestedTier,
			targetAbi: options.draft.targetAbi,
			requiresNewAbi: options.draft.requiresNewAbi,
		});
		const diffDigest = sha256(evaluation.diff);
		const proposal: Proposal = {
			schemaVersion: 2,
			id,
			createdAt: new Date().toISOString(),
			revision: 1,
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
			...(options.draft.targetAbi ? { targetAbi: options.draft.targetAbi } : {}),
			...(options.draft.requiresNewAbi !== undefined ? { requiresNewAbi: options.draft.requiresNewAbi } : {}),
			changedPaths: evaluation.changedPaths,
			diffDigest,
			approvalDigest: diffDigest,
			candidateDigest: candidate.digest,
			suggestedTier: options.draft.suggestedTier,
			l1: evaluation.l1,
			artifacts: {},
		};
		await rm(candidateDirectory, { recursive: true, force: true });
		await writeFile(join(temporaryDirectory, "observations.md"), options.observationsMarkdown, "utf8");
		await atomicWriteJson(join(temporaryDirectory, "proposal.json"), proposal);
		await rename(temporaryDirectory, proposalDirectory);
		await saveProposalRevisionSnapshot(options.paths, proposal);
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

function withProposalLock<T>(paths: EvoPaths, id: string, operation: () => Promise<T>): Promise<T> {
	assertProposalId(id);
	return withFileLock(paths, `proposal-${id}`, operation, { staleAfterMs: 4 * 60 * 60 * 1000 });
}

export async function attachProposalArtifact(options: {
	paths: EvoPaths;
	proposalId: string;
	expected: ProposalApproval;
	kind: "review" | "replay" | "validation";
	content: string;
	allowedStatuses: readonly Proposal["status"][];
}): Promise<Proposal> {
	return withProposalLock(options.paths, options.proposalId, async () => {
		const proposal = await loadProposal(options.paths, options.proposalId);
		assertProposalApproval(proposal, options.expected);
		if (!options.allowedStatuses.includes(proposal.status)) {
			throw new Error(`Proposal ${proposal.id} is ${proposal.status}; cannot attach ${options.kind}`);
		}
		const existing = proposal.artifacts[options.kind];
		if (existing) {
			await validateEvaluationArtifact({
				paths: options.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				kind: options.kind,
				reference: existing,
			});
			if (existing.sha256 !== sha256(options.content)) {
				throw new Error(`Proposal ${options.kind} artifact is already fixed for revision ${proposal.revision}`);
			}
			return proposal;
		}
		proposal.artifacts[options.kind] = await writeEvaluationArtifact({
			paths: options.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			kind: options.kind,
			content: options.content,
		});
		await saveProposal(options.paths, proposal);
		await saveProposalRevisionSnapshot(options.paths, proposal);
		return proposal;
	});
}

export async function attachRetrospectiveArtifact(options: {
	paths: EvoPaths;
	proposalId: string;
	expected: ProposalApproval;
	content: string;
	evidenceDigest: string;
	evidenceCutoff: string;
}): Promise<Proposal> {
	return withProposalLock(options.paths, options.proposalId, async () => {
		const proposal = await loadProposal(options.paths, options.proposalId);
		assertProposalApproval(proposal, options.expected);
		if (proposal.status !== "trialing") {
			throw new Error(`Proposal ${proposal.id} is ${proposal.status}; cannot attach retrospective`);
		}
		const existing = proposal.artifacts.retrospective;
		if (existing) {
			await validateEvaluationArtifact({
				paths: options.paths,
				proposalId: proposal.id,
				revision: proposal.revision,
				diffDigest: proposal.diffDigest,
				kind: "retrospective",
				reference: existing,
			});
			if (existing.evidence?.digest === options.evidenceDigest) {
				if (existing.sha256 !== sha256(options.content)) {
					throw new Error(`Proposal retrospective is already fixed for evidence ${options.evidenceDigest}`);
				}
				return proposal;
			}
		}
		proposal.artifacts.retrospective = await writeRetrospectiveArtifact({
			paths: options.paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			content: options.content,
			evidenceDigest: options.evidenceDigest,
			evidenceCutoff: options.evidenceCutoff,
		});
		await saveProposal(options.paths, proposal);
		await saveProposalRevisionSnapshot(options.paths, proposal);
		return proposal;
	});
}

async function assertApprovalArtifact(paths: EvoPaths, proposal: Proposal, kind: "review" | "replay" | "validation") {
	const reference = proposal.artifacts[kind];
	if (!reference) throw new Error(`Proposal ${proposal.id} is missing required ${kind} artifact`);
	await validateEvaluationArtifact({
		paths,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		kind,
		reference,
	});
}

function matchesApprovalDigest(expected: string, current: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(current)) return false;
	return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(current, "hex"));
}

function approvalArtifactsDigest(proposal: Proposal): string {
	return sha256(
		canonicalJson({
			schemaVersion: 1,
			review: proposal.artifacts.review ?? null,
			replay: proposal.artifacts.replay ?? null,
			validation: proposal.artifacts.validation ?? null,
		}),
	);
}

async function revalidateDataProposal(
	paths: EvoPaths,
	proposal: Proposal,
): Promise<{ candidate: CompiledBundle; evaluation: DataCandidateEvaluation }> {
	if (!proposal.candidateDigest) throw new Error("Data proposal has no candidate bundle");
	if (
		!matchesApprovalDigest(proposal.approvalDigest, proposal.diffDigest) ||
		!matchesApprovalDigest(proposal.diffDigest, sha256(proposal.diff))
	) {
		throw new Error("Proposal approval digest does not match its displayed diff");
	}
	const [parent, candidate] = await Promise.all([
		loadCompiledBundle(paths, proposal.parentBundleDigest),
		loadCompiledBundle(paths, proposal.candidateDigest),
	]);
	const evaluation = await evaluateDataCandidate({
		paths,
		parent,
		candidate,
		evidence: proposal.evidence,
		suggestedTier: proposal.suggestedTier,
		targetAbi: proposal.targetAbi,
		requiresNewAbi: proposal.requiresNewAbi,
	});
	const mismatches: string[] = [];
	if (proposal.kind !== evaluation.kind) mismatches.push("kind");
	if (proposal.tier !== evaluation.tier) mismatches.push("tier");
	if (canonicalJson(proposal.changedPaths) !== canonicalJson(evaluation.changedPaths)) mismatches.push("changedPaths");
	if (proposal.diff !== evaluation.diff) mismatches.push("diff");
	if (proposal.diffDigest !== sha256(evaluation.diff)) mismatches.push("diffDigest");
	if (canonicalJson(proposal.l1) !== canonicalJson(evaluation.l1)) mismatches.push("l1");
	if (mismatches.length > 0) {
		throw new Error(`Proposal ${proposal.id} does not match immutable bundle audit: ${mismatches.join(", ")}`);
	}
	return { candidate, evaluation };
}

export function assertProposalApproval(proposal: Proposal, expected: ProposalApproval): void {
	if (proposal.revision !== expected.revision) {
		throw new Error(`Proposal ${proposal.id} revision changed from ${expected.revision} to ${proposal.revision}`);
	}
	if (
		!matchesApprovalDigest(expected.diffDigest, proposal.diffDigest) ||
		!matchesApprovalDigest(proposal.diffDigest, sha256(proposal.diff))
	) {
		throw new Error(`Proposal ${proposal.id} diff digest does not match the confirmed final diff`);
	}
	if (
		expected.artifactsDigest !== undefined &&
		!matchesApprovalDigest(expected.artifactsDigest, approvalArtifactsDigest(proposal))
	) {
		throw new Error(`Proposal ${proposal.id} approval artifacts changed after confirmation`);
	}
	if (
		(proposal.kind === "code" || proposal.codeWorkspace !== undefined || expected.approvalDigest !== undefined) &&
		(proposal.kind !== "code" || proposal.tier !== "T2")
	) {
		throw new Error(`Proposal ${proposal.id} code approval requires kind code and tier T2`);
	}
	if (proposal.kind === "data") {
		if (!matchesApprovalDigest(proposal.approvalDigest, proposal.diffDigest)) {
			throw new Error(`Proposal ${proposal.id} diff digest does not match the confirmed final diff`);
		}
		return;
	}
	const workspace = proposal.codeWorkspace;
	if (!workspace || !expected.approvalDigest) {
		throw new Error(`Proposal ${proposal.id} requires confirmation of its code approval context`);
	}
	const computed = codeApprovalDigest({
		repositoryRoot: workspace.repositoryRoot,
		repositoryIdentity: workspace.repositoryId,
		baseCommit: workspace.baseCommit,
		parentBundleDigest: proposal.parentBundleDigest,
		diff: proposal.diff,
	});
	if (
		!matchesApprovalDigest(expected.approvalDigest, proposal.approvalDigest) ||
		!matchesApprovalDigest(proposal.approvalDigest, workspace.integrityDigest) ||
		!matchesApprovalDigest(proposal.approvalDigest, computed)
	) {
		throw new Error(`Proposal ${proposal.id} code approval context changed after confirmation`);
	}
}

export function proposalApproval(proposal: Proposal): ProposalApproval {
	return {
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		...(proposal.kind === "code" ? { approvalDigest: proposal.approvalDigest } : {}),
		artifactsDigest: approvalArtifactsDigest(proposal),
	};
}

export async function reviseProposal(options: {
	paths: EvoPaths;
	id: string;
	expected: ProposalApproval;
	draft: DraftProposal;
	observationsMarkdown: string;
	repositoryCwd?: string;
	codeValidationExecutor?: CodeValidationExecutor;
}): Promise<Proposal> {
	assertCodeDraftReplayScenario(options.draft);
	assertDraftAbi(options.draft);
	const stableDigest = await new BundleRegistry(options.paths).readStableDigest();
	return withProposalLock(options.paths, options.id, async () => {
		const current = await loadProposal(options.paths, options.id);
		assertProposalApproval(current, options.expected);
		if (current.status !== "pending") throw new Error(`Proposal ${options.id} is ${current.status}`);
		if (stableDigest !== current.parentBundleDigest) {
			throw new Error("Proposal parent is no longer stable; regenerate or rebase it");
		}
		const revision = current.revision + 1;
		let proposal: Proposal;
		if (options.draft.codePatch !== undefined || options.draft.changes === undefined) {
			const codePatch = options.draft.codePatch ?? "";
			const staged = await stageCodeWorktree({
				paths: options.paths,
				repositoryCwd: options.repositoryCwd ?? current.codeWorkspace?.repositoryRoot ?? process.cwd(),
				proposalId: current.id,
				revision,
				parentBundleDigest: current.parentBundleDigest,
				patch: codePatch,
				...(options.codeValidationExecutor ? { validationExecutor: options.codeValidationExecutor } : {}),
			});
			proposal = {
				schemaVersion: 2,
				id: current.id,
				createdAt: current.createdAt,
				revision,
				parentBundleDigest: current.parentBundleDigest,
				kind: "code",
				tier: "T2",
				motivation: options.draft.motivation,
				diff: staged.diff,
				expectedEffect: options.draft.expectedEffect,
				risk: options.draft.risk,
				verifyPlan: options.draft.verifyPlan,
				trialPlan: options.draft.trialPlan,
				status: "pending",
				source: options.draft.source,
				evidence: options.draft.evidence,
				inboxReferences: options.draft.inboxReferences,
				replayScenarios: options.draft.replayScenarios,
				...(options.draft.targetAbi ? { targetAbi: options.draft.targetAbi } : {}),
				...(options.draft.requiresNewAbi !== undefined ? { requiresNewAbi: options.draft.requiresNewAbi } : {}),
				changedPaths: staged.changedPaths,
				diffDigest: staged.diffDigest,
				approvalDigest: staged.approvalDigest,
				codePatch,
				codeWorkspace: {
					repositoryRoot: staged.repositoryRoot,
					repositoryId: staged.repositoryIdentity,
					worktreePath: staged.worktreePath,
					branch: staged.branch,
					baseCommit: staged.baseCommit,
					integrityDigest: staged.approvalDigest,
				},
				suggestedTier: options.draft.suggestedTier,
				l1: {
					passed: staged.l1.passed,
					reason: staged.l1.passed ? "Sandboxed code validation passed" : "Sandboxed code validation failed",
					errors: staged.l1.errors,
				},
				artifacts: {},
			};
			proposal.artifacts.validation = await writeEvaluationArtifact({
				paths: options.paths,
				proposalId: proposal.id,
				revision,
				diffDigest: proposal.diffDigest,
				kind: "validation",
				content: renderCodeValidation(staged.l1),
			});
		} else {
			const temporaryDirectory = join(
				options.paths.proposals,
				`.tmp-${current.id}-r${revision}-${randomUUID().slice(0, 8)}`,
			);
			const candidateDirectory = join(temporaryDirectory, "candidate");
			await mkdir(temporaryDirectory, { recursive: true });
			try {
				const parent = await loadCompiledBundle(options.paths, current.parentBundleDigest);
				await materializeBundle(options.paths, current.parentBundleDigest, candidateDirectory);
				await applyDraftChanges(candidateDirectory, options.draft.changes);
				const candidate = await compileBundle({
					paths: options.paths,
					sourceDirectory: candidateDirectory,
					parentDigest: current.parentBundleDigest,
					summary: options.draft.expectedEffect.slice(0, 240),
				});
				const evaluation = await evaluateDataCandidate({
					paths: options.paths,
					parent,
					candidate,
					evidence: options.draft.evidence,
					suggestedTier: options.draft.suggestedTier,
					targetAbi: options.draft.targetAbi,
					requiresNewAbi: options.draft.requiresNewAbi,
				});
				const diffDigest = sha256(evaluation.diff);
				proposal = {
					schemaVersion: 2,
					id: current.id,
					createdAt: current.createdAt,
					revision,
					parentBundleDigest: current.parentBundleDigest,
					kind: "data",
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
					...(options.draft.targetAbi ? { targetAbi: options.draft.targetAbi } : {}),
					...(options.draft.requiresNewAbi !== undefined ? { requiresNewAbi: options.draft.requiresNewAbi } : {}),
					changedPaths: evaluation.changedPaths,
					diffDigest,
					approvalDigest: diffDigest,
					candidateDigest: candidate.digest,
					suggestedTier: options.draft.suggestedTier,
					l1: evaluation.l1,
					artifacts: {},
				};
			} finally {
				await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
			}
		}
		await writeFile(
			join(options.paths.proposals, current.id, "observations.md"),
			options.observationsMarkdown,
			"utf8",
		);
		await saveProposal(options.paths, proposal);
		await saveProposalRevisionSnapshot(options.paths, proposal);
		return proposal;
	});
}

export async function approveProposal(
	paths: EvoPaths,
	id: string,
	expected: ProposalApproval,
	codeValidationExecutor?: CodeValidationExecutor,
	registry: BundleRegistry = new BundleRegistry(paths),
	idempotencyKey?: string,
	expectedStateDigest?: string,
	dataActivation?: DataApprovalActivation,
): Promise<Proposal> {
	const prepared = await withProposalLock(paths, id, async () => {
		const proposal = await loadProposal(paths, id);
		assertProposalApproval(proposal, expected);
		if (expected.artifactsDigest === undefined) {
			throw new Error(`Proposal ${id} requires confirmation of its approval artifacts`);
		}
		if (proposal.kind === "code") {
			if (proposal.status !== "pending" && proposal.status !== "approved") {
				throw new Error(`Proposal ${id} is ${proposal.status}`);
			}
			if (!proposal.codeWorkspace) throw new Error(`Proposal ${id} has no isolated code workspace`);
			if (!proposal.replayScenarios[0]) {
				throw new Error(`Code proposal ${id} requires a replay scenario`);
			}
			const workspace = proposal.codeWorkspace;
			const staged = await revalidateCodeWorktree({
				paths,
				proposalId: id,
				revision: proposal.revision,
				expectedApprovalDigest: workspace.integrityDigest,
				expectedRepositoryRoot: workspace.repositoryRoot,
				expectedRepositoryIdentity: workspace.repositoryId,
				expectedBaseCommit: workspace.baseCommit,
				expectedParentBundleDigest: proposal.parentBundleDigest,
				...(codeValidationExecutor ? { validationExecutor: codeValidationExecutor } : {}),
			});
			const mismatches: string[] = [];
			if (staged.repositoryRoot !== workspace.repositoryRoot) mismatches.push("repositoryRoot");
			if (staged.repositoryIdentity !== workspace.repositoryId) mismatches.push("repositoryId");
			if (staged.worktreePath !== workspace.worktreePath) mismatches.push("worktreePath");
			if (staged.branch !== workspace.branch) mismatches.push("branch");
			if (staged.baseCommit !== workspace.baseCommit) mismatches.push("baseCommit");
			if (staged.diff !== proposal.diff) mismatches.push("diff");
			if (staged.diffDigest !== proposal.diffDigest) mismatches.push("diffDigest");
			if (canonicalJson(staged.changedPaths) !== canonicalJson(proposal.changedPaths))
				mismatches.push("changedPaths");
			if (mismatches.length > 0) {
				throw new Error(`Proposal ${id} does not match its isolated worktree: ${mismatches.join(", ")}`);
			}
			if (!staged.l1.passed) throw new Error(`Proposal ${id} failed approval-time L1 revalidation`);
			if (!proposal.l1.passed) throw new Error(`Proposal ${id} did not pass its staged L1 validation`);
			await assertApprovalArtifact(paths, proposal, "validation");
			await assertApprovalArtifact(paths, proposal, "replay");
			await assertApprovalArtifact(paths, proposal, "review");
			return { kind: "code" as const, proposal, workspace };
		}
		const { candidate, evaluation } = await revalidateDataProposal(paths, proposal);
		if (dataActivation?.mode === "direct" && !proposal.targetAbi) {
			throw new Error("Direct activation is limited to an existing host-defined component ABI");
		}
		const targetStatus: Proposal["status"] =
			evaluation.tier === "T0" || dataActivation?.mode === "direct" ? "kept" : "trialing";
		if (proposal.status !== "pending" && proposal.status !== targetStatus) {
			throw new Error(`Proposal ${id} is ${proposal.status}`);
		}
		if (evaluation.tier !== "T0") await assertApprovalArtifact(paths, proposal, "review");
		if (evaluation.tier === "T2") await assertApprovalArtifact(paths, proposal, "replay");
		if (dataActivation?.mode === "direct") await assertApprovalArtifact(paths, proposal, "validation");
		return { kind: "data" as const, proposal, candidate, evaluation, targetStatus };
	});

	if (prepared.kind === "code") {
		return registry.approveCodeProposal({
			...(idempotencyKey ? { idempotencyKey } : {}),
			...(expectedStateDigest ? { expectedStateDigest } : {}),
			proposalId: id,
			parentDigest: prepared.proposal.parentBundleDigest,
			revision: prepared.proposal.revision,
			diffDigest: prepared.proposal.diffDigest,
			approvalDigest: prepared.proposal.approvalDigest,
			branch: prepared.workspace.branch,
			reason: `Approved code context ${prepared.proposal.approvalDigest} for manual commit and merge from ${prepared.workspace.branch}`,
			proposalBefore: prepared.proposal,
			proposalAfter: { ...prepared.proposal, status: "approved" },
		});
	}
	const result = await registry.approveDataProposal({
		...(idempotencyKey ? { idempotencyKey } : {}),
		...(expectedStateDigest ? { expectedStateDigest } : {}),
		proposalId: id,
		revision: prepared.proposal.revision,
		diffDigest: prepared.proposal.diffDigest,
		parentDigest: prepared.proposal.parentBundleDigest,
		candidateDigest: prepared.candidate.digest,
		tier: prepared.evaluation.tier,
		plan: prepared.proposal.trialPlan,
		activation: dataActivation ?? { mode: "trial" },
		reason:
			dataActivation?.mode === "direct"
				? `Human directly activated exact component diff ${prepared.proposal.diffDigest}`
				: `Approved exact data diff ${prepared.proposal.diffDigest}`,
		proposalBefore: prepared.proposal,
		proposalAfter: { ...prepared.proposal, status: prepared.targetStatus },
	});
	return result.proposal;
}

export async function rejectProposal(
	paths: EvoPaths,
	id: string,
	reason: string,
	registry: BundleRegistry = new BundleRegistry(paths),
	idempotencyKey?: string,
	expectedStateDigest?: string,
): Promise<Proposal> {
	const prepared = await withProposalLock(paths, id, async () => {
		const proposal = await loadProposal(paths, id);
		if (proposal.status !== "pending" && proposal.status !== "deferred" && proposal.status !== "rejected") {
			throw new Error(`Proposal ${id} is ${proposal.status}`);
		}
		const proposalAfter: Proposal = { ...proposal, status: "rejected" };
		delete proposalAfter.defer;
		return { proposalBefore: proposal, proposalAfter };
	});
	return registry.transitionProposal({
		...(idempotencyKey ? { idempotencyKey } : {}),
		...(expectedStateDigest ? { expectedStateDigest } : {}),
		action: "reject-proposal",
		...prepared,
		reason,
	});
}

export async function deferProposal(
	paths: EvoPaths,
	id: string,
	reason: string,
	until?: string,
	registry: BundleRegistry = new BundleRegistry(paths),
	idempotencyKey?: string,
	expectedStateDigest?: string,
): Promise<Proposal> {
	const prepared = await withProposalLock(paths, id, async () => {
		const proposal = await loadProposal(paths, id);
		if (proposal.status !== "pending" && proposal.status !== "deferred") {
			throw new Error(`Proposal ${id} is ${proposal.status}`);
		}
		const proposalAfter: Proposal =
			proposal.status === "deferred"
				? proposal
				: {
						...proposal,
						status: "deferred",
						defer: { deferredAt: new Date().toISOString(), reason, ...(until ? { until } : {}) },
					};
		return { proposalBefore: proposal, proposalAfter };
	});
	return registry.transitionProposal({
		...(idempotencyKey ? { idempotencyKey } : {}),
		...(expectedStateDigest ? { expectedStateDigest } : {}),
		action: "defer-proposal",
		...prepared,
		reason,
	});
}

export async function reopenProposal(
	paths: EvoPaths,
	id: string,
	reason: string,
	registry: BundleRegistry = new BundleRegistry(paths),
	idempotencyKey?: string,
	expectedStateDigest?: string,
): Promise<Proposal> {
	const prepared = await withProposalLock(paths, id, async () => {
		const proposal = await loadProposal(paths, id);
		if (proposal.status !== "deferred" && proposal.status !== "pending") {
			throw new Error(`Proposal ${id} is ${proposal.status}`);
		}
		const proposalAfter: Proposal = { ...proposal, status: "pending" };
		delete proposalAfter.defer;
		return { proposalBefore: proposal, proposalAfter };
	});
	return registry.transitionProposal({
		...(idempotencyKey ? { idempotencyKey } : {}),
		...(expectedStateDigest ? { expectedStateDigest } : {}),
		action: "reopen-proposal",
		...prepared,
		reason,
	});
}
