import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import type { CodeValidationExecutor } from "../code/worktree.ts";
import type { EvoPaths } from "../paths.ts";
import {
	assertProposalApproval,
	type DraftProposal,
	loadProposal,
	parseReflectorOutput,
	proposalApproval,
	reviseProposal,
} from "../proposal.ts";
import { type ApprovalTurn, appendApprovalTurn, readApprovalTurns } from "../proposal-artifacts.ts";
import type { EvidenceReference, Proposal, ProposalApproval } from "../types.ts";
import { runCritic } from "./critic.ts";
import { collectEvidenceCorpus, type EvidenceCorpus, validateDraftGrounding } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";
import { type CounterfactualReplayResult, runCounterfactualReplay } from "./replay.ts";
import { recordModelUsage } from "./usage.ts";

const PERMIT_PROMPT_URL = new URL("../prompts/permit.md", import.meta.url);

interface PermitModelOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	proposalId: string;
	expected: ProposalApproval;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxCorpusBytes?: number;
}

export interface AskProposalQuestionOptions extends PermitModelOptions {
	question: string;
}

export interface AskProposalQuestionResult {
	proposal: Proposal;
	questionTurn: ApprovalTurn;
	answerTurn: ApprovalTurn;
	answerMarkdown: string;
	evidence: EvidenceReference[];
	corpus: EvidenceCorpus;
	run: ModelRunResult;
}

export interface ReviseProposalFromInstructionOptions extends PermitModelOptions {
	instruction: string;
	repositoryCwd?: string;
	codeValidationExecutor?: CodeValidationExecutor;
	criticModel?: string;
	criticThinkingLevel?: ThinkingLevel;
	replayModel?: string;
	replayThinkingLevel?: ThinkingLevel;
}

export interface RecordPermitDecisionOptions {
	paths: EvoPaths;
	proposalId: string;
	revision: number;
	diffDigest: string;
	reason: string;
	until?: string;
}

interface PermitAnswer {
	answerMarkdown: string;
	evidence: EvidenceReference[];
}

function assertExpectedProposal(
	proposal: Proposal,
	expected: ProposalApproval,
	allowedStatuses: ReadonlySet<Proposal["status"]>,
): void {
	if (!allowedStatuses.has(proposal.status)) throw new Error(`Proposal ${proposal.id} is ${proposal.status}`);
	if (proposal.tier === "T0") throw new Error(`Proposal ${proposal.id} does not require conversational approval`);
	assertProposalApproval(proposal, expected);
}

function parseExactJson(text: string, label: string): Record<string, unknown> {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		throw new Error(`${label} must be exactly one JSON object`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be exactly one JSON object`);
	}
	return value as Record<string, unknown>;
}

function parsePermitAnswer(text: string): PermitAnswer {
	const record = parseExactJson(text, "Permit answer");
	if (typeof record.answerMarkdown !== "string" || !record.answerMarkdown.trim()) {
		throw new Error("Permit answer.answerMarkdown must be a non-empty string");
	}
	if (!Array.isArray(record.evidence)) throw new Error("Permit answer.evidence must be an array");
	const evidence = record.evidence.map((value, index) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`Permit answer.evidence[${index}] must be an object`);
		}
		const reference = value as Record<string, unknown>;
		if (
			typeof reference.sessionId !== "string" ||
			!reference.sessionId ||
			!Number.isSafeInteger(reference.sequence) ||
			(reference.sequence as number) <= 0
		) {
			throw new Error(`Permit answer.evidence[${index}] must contain sessionId and sequence`);
		}
		if (reference.quote !== undefined && typeof reference.quote !== "string") {
			throw new Error(`Permit answer.evidence[${index}].quote must be a string`);
		}
		return {
			sessionId: reference.sessionId,
			sequence: reference.sequence as number,
			...(reference.quote !== undefined ? { quote: reference.quote } : {}),
		} satisfies EvidenceReference;
	});
	return { answerMarkdown: record.answerMarkdown, evidence };
}

function groundingDraft(proposal: Proposal, evidence: EvidenceReference[]): DraftProposal {
	return {
		motivation: proposal.motivation,
		expectedEffect: proposal.expectedEffect,
		risk: proposal.risk,
		verifyPlan: proposal.verifyPlan,
		trialPlan: proposal.trialPlan,
		source: proposal.source,
		evidence,
		inboxReferences: proposal.inboxReferences,
		replayScenarios: [],
		changes: [],
	};
}

async function validatePermitAnswer(
	paths: EvoPaths,
	proposal: Proposal,
	answer: PermitAnswer,
): Promise<EvidenceReference[]> {
	if (answer.evidence.length === 0 && proposal.inboxReferences.length === 0) {
		throw new Error("Permit answer must cite concrete evidence");
	}
	const evidence = await validateDraftGrounding(paths, groundingDraft(proposal, answer.evidence));
	for (const reference of evidence) {
		if (!answer.answerMarkdown.includes(`${reference.sessionId}:${reference.sequence}`)) {
			throw new Error(`Permit answer does not cite ${reference.sessionId}:${reference.sequence} in its text`);
		}
	}
	if (
		evidence.length === 0 &&
		!proposal.inboxReferences.some((fileName) => answer.answerMarkdown.includes(fileName))
	) {
		throw new Error("Permit answer does not cite a concrete inbox reference");
	}
	return evidence;
}

function renderApprovalTranscript(turns: ApprovalTurn[]): string {
	return turns.length === 0 ? "No prior approval turns." : turns.map((turn) => JSON.stringify(turn)).join("\n");
}

function permitRunRequest(options: {
	proposal: Proposal;
	corpus: EvidenceCorpus;
	turns: ApprovalTurn[];
	instruction: string;
	mode: "QUESTION" | "REVISION";
}): string {
	return [
		`${options.mode} MODE`,
		"",
		`Human ${options.mode === "QUESTION" ? "question" : "revision instruction"}:`,
		options.instruction,
		"",
		"<proposal>",
		JSON.stringify(options.proposal, undefined, "\t"),
		"</proposal>",
		"",
		"<approval_transcript>",
		renderApprovalTranscript(options.turns),
		"</approval_transcript>",
		"",
		`<evidence_corpus truncated="${String(options.corpus.truncated)}">`,
		options.corpus.text,
		"</evidence_corpus>",
	].join("\n");
}

async function proposalModels(paths: EvoPaths, proposal: Proposal): Promise<{ reflector?: string; critic?: string }> {
	const bundle = await loadCompiledBundle(paths, proposal.parentBundleDigest);
	return bundle.policy.modelRouting ?? {};
}

export async function askProposalQuestion(options: AskProposalQuestionOptions): Promise<AskProposalQuestionResult> {
	const question = options.question.trim();
	if (!question) throw new Error("Permit question must not be empty");
	const proposal = await loadProposal(options.paths, options.proposalId);
	assertExpectedProposal(proposal, options.expected, new Set(["pending", "deferred"]));
	const questionTurn = await appendApprovalTurn({
		paths: options.paths,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		role: "human",
		kind: "question",
		text: question,
	});
	const [corpus, models, systemPrompt, turns] = await Promise.all([
		collectEvidenceCorpus(options.paths, { maxBytes: options.maxCorpusBytes, mode: "full" }),
		proposalModels(options.paths, proposal),
		readFile(PERMIT_PROMPT_URL, "utf8"),
		readApprovalTurns(options.paths, proposal.id),
	]);
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt,
		prompt: permitRunRequest({ proposal, corpus, turns, instruction: question, mode: "QUESTION" }),
		...((options.model ?? models.reflector) ? { model: options.model ?? models.reflector } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		sessionIdentity: `evo-permit-${proposal.id}-r${proposal.revision}`,
	});
	await recordModelUsage(options.paths, "permit", run);
	const parsed = parsePermitAnswer(run.text);
	const evidence = await validatePermitAnswer(options.paths, proposal, parsed);
	const current = await loadProposal(options.paths, proposal.id);
	assertExpectedProposal(current, options.expected, new Set(["pending", "deferred"]));
	const answerTurn = await appendApprovalTurn({
		paths: options.paths,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		role: "meta",
		kind: "answer",
		text: parsed.answerMarkdown,
		...(evidence.length > 0 ? { evidence } : {}),
	});
	return {
		proposal: current,
		questionTurn,
		answerTurn,
		answerMarkdown: parsed.answerMarkdown,
		evidence,
		corpus,
		run,
	};
}

export async function reviseProposalFromInstruction(options: ReviseProposalFromInstructionOptions): Promise<Proposal> {
	const instruction = options.instruction.trim();
	if (!instruction) throw new Error("Permit revision instruction must not be empty");
	const current = await loadProposal(options.paths, options.proposalId);
	assertExpectedProposal(current, options.expected, new Set(["pending"]));
	await appendApprovalTurn({
		paths: options.paths,
		proposalId: current.id,
		revision: current.revision,
		diffDigest: current.diffDigest,
		role: "human",
		kind: "revision-request",
		text: instruction,
	});
	const [corpus, models, systemPrompt, turns] = await Promise.all([
		collectEvidenceCorpus(options.paths, { maxBytes: options.maxCorpusBytes, mode: "full" }),
		proposalModels(options.paths, current),
		readFile(PERMIT_PROMPT_URL, "utf8"),
		readApprovalTurns(options.paths, current.id),
	]);
	const run = await options.runner.run({
		cwd: options.cwd ?? options.repositoryCwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt,
		prompt: permitRunRequest({ proposal: current, corpus, turns, instruction, mode: "REVISION" }),
		...((options.model ?? models.reflector) ? { model: options.model ?? models.reflector } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		sessionIdentity: `evo-permit-${current.id}-r${current.revision}`,
	});
	await recordModelUsage(options.paths, "permit", run);
	const output = parseReflectorOutput(run.text);
	if (output.proposals.length !== 1) throw new Error("Permit revision must return exactly one proposal draft");
	const draft = output.proposals[0];
	draft.evidence = await validateDraftGrounding(options.paths, draft);
	let revised = await reviseProposal({
		paths: options.paths,
		id: current.id,
		expected: options.expected,
		draft,
		observationsMarkdown: output.observationsMarkdown,
		...(options.repositoryCwd ? { repositoryCwd: options.repositoryCwd } : {}),
		...(options.codeValidationExecutor ? { codeValidationExecutor: options.codeValidationExecutor } : {}),
	});
	let replay: CounterfactualReplayResult | undefined;
	if (revised.tier === "T2") {
		replay = await runCounterfactualReplay({
			paths: options.paths,
			runner: options.runner,
			proposal: revised,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			...(options.replayModel ? { model: options.replayModel } : {}),
			...(options.replayThinkingLevel ? { thinkingLevel: options.replayThinkingLevel } : {}),
		});
		revised = replay.proposal;
	}
	if (revised.tier === "T1" || revised.tier === "T2") {
		revised = (
			await runCritic({
				paths: options.paths,
				runner: options.runner,
				proposal: revised,
				corpus,
				...(replay ? { replay } : {}),
				cwd: options.cwd ?? options.repositoryCwd ?? process.cwd(),
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				...((options.criticModel ?? models.critic) ? { model: options.criticModel ?? models.critic } : {}),
				...(options.criticThinkingLevel ? { thinkingLevel: options.criticThinkingLevel } : {}),
			})
		).proposal;
	}
	const stored = await loadProposal(options.paths, revised.id);
	assertExpectedProposal(stored, proposalApproval(revised), new Set(["pending"]));
	await appendApprovalTurn({
		paths: options.paths,
		proposalId: stored.id,
		revision: stored.revision,
		diffDigest: stored.diffDigest,
		role: "meta",
		kind: "revision-result",
		text: `Revision ${stored.revision} is ready as ${stored.tier}/${stored.kind}; L1 ${stored.l1.passed ? "passed" : "failed"}; diff digest ${stored.diffDigest}.`,
		...(stored.evidence.length > 0 ? { evidence: stored.evidence } : {}),
	});
	return stored;
}

export function recordPermitDefer(options: RecordPermitDecisionOptions): Promise<ApprovalTurn> {
	const detail = options.until ? `${options.reason} (until ${options.until})` : options.reason;
	return appendApprovalTurn({
		paths: options.paths,
		proposalId: options.proposalId,
		revision: options.revision,
		diffDigest: options.diffDigest,
		role: "human",
		kind: "defer",
		text: detail,
	});
}

export function recordPermitReopen(options: RecordPermitDecisionOptions): Promise<ApprovalTurn> {
	return appendApprovalTurn({
		paths: options.paths,
		proposalId: options.proposalId,
		revision: options.revision,
		diffDigest: options.diffDigest,
		role: "human",
		kind: "reopen",
		text: options.reason,
	});
}
