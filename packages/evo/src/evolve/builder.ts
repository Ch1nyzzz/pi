import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { publishEvoComponentArtifact } from "../components/artifact.ts";
import { createDefaultEvoAbiRegistry } from "../components/registry.ts";
import type { EvoPaths } from "../paths.ts";
import { type DraftProposal, parseReflectorOutputValue, type ReflectorOutput } from "../proposal.ts";
import type { EvidenceCorpus } from "../reflect/evidence.ts";
import type { ModelRunner, ModelRunResult } from "../reflect/model-runner.ts";
import { recordModelUsage } from "../reflect/usage.ts";
import type { EvolutionResearchPlan } from "../types.ts";
import { readEvolutionWorkflow } from "./config.ts";
import type { MaterializedCorpus } from "./research-corpus.ts";

export interface RunEvolutionBuilderOptions {
	paths: EvoPaths;
	plan: EvolutionResearchPlan;
	parentDigest: string;
	corpus: EvidenceCorpus;
	/** On-disk corpus tree; when present the prompt carries only its index. */
	materializedCorpus?: MaterializedCorpus;
	runner: ModelRunner;
	cwd: string;
	agentDir?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	activePreferences?: string;
	/** Stable provider session identity so retries hit the provider prompt cache. */
	sessionIdentity?: string;
	signal?: AbortSignal;
}

export interface EvolutionBuilderResult {
	draft: DraftProposal;
	observationsMarkdown: string;
	run: ModelRunResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Shape-level contract for the submission tool; kind-specific semantics live in the
// validate hook, whose errors flow back to the model as tool errors.
const BUILDER_PARAMETERS = Type.Object(
	{
		observationsMarkdown: Type.String({ minLength: 1 }),
		observationEvidence: Type.Array(Type.Object({}, { additionalProperties: true })),
		proposals: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
		proposal: Type.Optional(Type.Object({}, { additionalProperties: true })),
		component: Type.Optional(Type.Object({}, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

async function materializeComponentDraft(options: {
	paths: EvoPaths;
	parentDigest: string;
	plan: EvolutionResearchPlan;
	output: Record<string, unknown>;
}): Promise<{ draft: DraftProposal; observationsMarkdown: string }> {
	if (!options.plan.targetAbi) throw new Error("Component plan has no target ABI");
	const output = options.output;
	const component = output.component;
	if (typeof component !== "object" || component === null || Array.isArray(component)) {
		throw new Error("Component Builder output must contain component");
	}
	const record = component as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.version !== "string" ||
		typeof record.entrypointContent !== "string" ||
		(typeof record.config !== "object" && record.config !== undefined) ||
		(record.config === null && record.config !== undefined) ||
		!Array.isArray(record.capabilities) ||
		record.capabilities.some((entry) => typeof entry !== "string")
	) {
		throw new Error("Component Builder output component is invalid");
	}
	const abi = createDefaultEvoAbiRegistry().require(options.plan.targetAbi);
	const config = abi.validateConfig(record.config ?? {});
	const artifact = await publishEvoComponentArtifact(options.paths, {
		id: record.id,
		version: record.version,
		abi: abi.id,
		activationBoundary: abi.activationBoundary,
		capabilities: record.capabilities as string[],
		entrypointContent: record.entrypointContent,
	});
	const parsed = parseReflectorOutputValue({
		observationsMarkdown: output.observationsMarkdown,
		observationEvidence: output.observationEvidence ?? [],
		proposals: [output.proposal],
	});
	if (parsed.proposals.length !== 1) throw new Error("Component Builder must return one proposal");
	const parent = await loadCompiledBundle(options.paths, options.parentDigest);
	const policy = {
		...parent.policy,
		components: {
			...(parent.policy.components ?? {}),
			[abi.surface]: {
				id: artifact.manifest.id,
				abi: artifact.manifest.abi,
				artifactDigest: artifact.manifest.artifactDigest,
				config: config as Record<string, unknown>,
			},
		},
	};
	const proposal = parsed.proposals[0];
	return {
		observationsMarkdown: parsed.observationsMarkdown,
		draft: {
			...proposal,
			targetAbi: abi.id,
			requiresNewAbi: false,
			codePatch: undefined,
			changes: [{ path: "policy.json", content: `${JSON.stringify(policy, undefined, "\t")}\n` }],
			trialPlan: options.plan.experiment.trialPlan,
			verifyPlan: [
				proposal.verifyPlan,
				`Frozen check profiles: ${options.plan.experiment.checkProfiles.join(", ") || "none"}.`,
			].join("\n"),
		},
	};
}

export async function runEvolutionBuilder(options: RunEvolutionBuilderOptions): Promise<EvolutionBuilderResult> {
	const workflow = await readEvolutionWorkflow(options.paths);
	const outputInstruction =
		options.plan.candidateKind === "component"
			? "Deliver the candidate by calling the submit_candidate tool with observationsMarkdown, observationEvidence, proposal metadata, and component { id, version, capabilities, config, entrypointContent }. The .mjs entrypoint must implement Evo-Pi's line-delimited process protocol: read {id,method,payload} from stdin and answer {id,ok,result|error}. The proposal contains motivation, expectedEffect, risk, verifyPlan, trialPlan, source, evidence, inboxReferences, and replayScenarios but no changes or codePatch."
			: "Deliver the candidate by calling the submit_candidate tool with observationsMarkdown, observationEvidence, and exactly one entry in proposals. The proposal must include motivation, expectedEffect, risk, verifyPlan, trialPlan, source, evidence, inboxReferences, replayScenarios, and either complete data changes or a unified codePatch.";
	const prompt = [
		"Implement the frozen Evo-Pi plan as one narrow candidate.",
		outputInstruction,
		"Do not change the frozen experiment. Cite real supplied session evidence. Code proposals require a replay scenario.",
		"For a durable-preference plan, update only memory/preferences.json. Preserve every existing entry and append entries using schemaVersion 1 and { id, instruction, source { sessionId, sequence, quote }, addedAt }. instruction must be the exact user-authored substring classified by ResearchPlanner; source.quote must contain it. Reference the originating inbox file.",
		options.plan.targetAbi
			? `The candidate must implement the exact pre-defined ABI ${options.plan.targetAbi}. Do not invent another ABI.`
			: "This plan does not target an existing component ABI.",
		options.plan.requiresNewAbi
			? "This is an infrastructure proposal for a new ABI. It cannot activate itself and must remain a T2 code patch."
			: "Do not set requiresNewAbi.",
		"",
		...(options.activePreferences
			? ["<active_preferences>", options.activePreferences, "</active_preferences>", ""]
			: []),
		"<workflow>",
		workflow,
		"</workflow>",
		"",
		"<research_plan>",
		JSON.stringify(options.plan, undefined, "\t"),
		"</research_plan>",
		"",
		...(options.materializedCorpus
			? [
					`<evidence_corpus_index truncated="${String(options.corpus.truncated)}">`,
					options.materializedCorpus.indexText,
					"</evidence_corpus_index>",
				]
			: [
					`<evidence_corpus truncated="${String(options.corpus.truncated)}">`,
					options.corpus.text,
					"</evidence_corpus>",
				]),
	].join("\n");
	const modelRun = await options.runner.run({
		cwd: options.cwd,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt:
			"You are Evo-Pi's Builder. Implement the saved plan, but never approve, activate, or alter its experiment and evaluation rules.",
		prompt,
		model: options.model,
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		// Read-only repository inspection keeps implementation generation from mutating
		// the caller's worktree. The returned patch is staged in Evo's isolated worktree.
		tools: ["read", "grep", "find", "ls"],
		...(options.sessionIdentity ? { sessionIdentity: options.sessionIdentity } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		submission: {
			toolName: "submit_candidate",
			description: "Deliver the implemented candidate. Validation errors are returned for correction.",
			parameters: BUILDER_PARAMETERS,
			validate: (params) => {
				if (options.plan.candidateKind === "component") {
					if (!isRecord(params.component)) throw new Error("Component Builder output must contain component");
					if (!isRecord(params.proposal)) throw new Error("Component Builder output must contain proposal");
					return params;
				}
				const output = parseReflectorOutputValue(params);
				if (output.proposals.length !== 1) throw new Error("Builder must return exactly one candidate proposal");
				const candidate = output.proposals[0];
				if (options.plan.candidateKind === "data" && candidate.changes === undefined) {
					throw new Error("Builder returned code for a data plan");
				}
				if (options.plan.candidateKind === "code" && candidate.codePatch === undefined) {
					throw new Error("Builder returned data for a code plan");
				}
				return output;
			},
		},
	});
	await recordModelUsage(options.paths, "builder", modelRun);
	if (options.plan.candidateKind === "component") {
		const component = await materializeComponentDraft({
			paths: options.paths,
			parentDigest: options.parentDigest,
			plan: options.plan,
			output: modelRun.submission as Record<string, unknown>,
		});
		return { ...component, run: modelRun };
	}
	const output = modelRun.submission as ReflectorOutput;
	const candidate = output.proposals[0];
	const draft: DraftProposal = {
		...candidate,
		...(options.plan.targetAbi ? { targetAbi: options.plan.targetAbi } : {}),
		requiresNewAbi: options.plan.requiresNewAbi,
		trialPlan: options.plan.experiment.trialPlan,
		verifyPlan: [
			candidate.verifyPlan,
			`Frozen check profiles: ${options.plan.experiment.checkProfiles.join(", ") || "none"}.`,
		].join("\n"),
	};
	return { draft, observationsMarkdown: output.observationsMarkdown, run: modelRun };
}
