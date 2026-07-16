import { join } from "node:path";
import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import { StringEnum } from "@ch1nyzzz/pi-ai";
import { Type } from "typebox";
import { isTrialMetricName, parseTrialDurationDays, TRIAL_METRIC_DIRECTIONS } from "../comparison.ts";
import { createDefaultEvoAbiRegistry } from "../components/registry.ts";
import type { EvoPaths } from "../paths.ts";
import type { EvidenceCorpus } from "../reflect/evidence.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../reflect/model-runner.ts";
import { recordModelUsage } from "../reflect/usage.ts";
import { atomicWriteFile, atomicWriteJson, canonicalJson, sha256 } from "../storage.ts";
import type {
	EvoCheckProfile,
	EvoEvidenceStrategy,
	EvoExperimentSpec,
	EvolutionInboxDecision,
	EvolutionResearchPlan,
	EvolutionRun,
} from "../types.ts";
import {
	declarableProfiles,
	type EvolutionCandidateKind,
	HISTORICAL_PROFILE_CAPABILITIES,
	OFFLINE_PROFILE_CAPABILITIES,
} from "./check-profiles.ts";
import { readEvolutionWorkflow } from "./config.ts";
import type { MaterializedCorpus } from "./research-corpus.ts";
import { createEvolutionResearchTools } from "./research-tools.ts";
import { evolutionRunDirectory, updateEvolutionRun } from "./run.ts";

const CHECK_PROFILES = new Set<EvoCheckProfile>([
	"bundle-compile",
	"repo-check",
	"related-tests",
	"paired-replay",
	"session-comparison",
	"compaction-replay",
]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		throw new Error(`${label} must be a non-empty string array`);
	}
	return [...new Set(value as string[])];
}

const PATCH_CLASSES = new Set(["pure-transform", "component", "routing", "prompt", "tool", "infrastructure"]);

// Shape-level contract for the submission tool; cross-field semantics live in
// parseEvolutionResearchPlanValue, whose errors flow back to the model as tool errors.
const RESEARCH_PLAN_PARAMETERS = Type.Object({
	topic: Type.String({ minLength: 1 }),
	reason: Type.String({ minLength: 1 }),
	planMarkdown: Type.String({ minLength: 1 }),
	experiment: Type.Object({}, { additionalProperties: true }),
	targetAbi: Type.Optional(Type.String({ minLength: 1 })),
	requiresNewAbi: Type.Boolean(),
	candidateKind: StringEnum(["none", "data", "component", "code"] as const),
	builderInstructions: Type.String({ minLength: 1 }),
	inboxDecisions: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
});

function profileArray(value: unknown, label: string, allowed: ReadonlySet<EvoCheckProfile>): EvoCheckProfile[] {
	const profiles = stringArray(value, label);
	if (profiles.length === 0) throw new Error(`${label} must not be empty`);
	for (const profile of profiles) {
		if (!allowed.has(profile as EvoCheckProfile)) {
			throw new Error(`${label} contains profile ${profile}, which cannot execute for this candidate kind`);
		}
	}
	return profiles as EvoCheckProfile[];
}

function nonEmptyStringArray(value: unknown, label: string): string[] {
	const values = stringArray(value, label);
	if (values.length === 0) throw new Error(`${label} must not be empty`);
	return values;
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
	return value as number;
}

function trialDuration(value: unknown, label: string): string {
	const duration = string(value, label);
	if (parseTrialDurationDays(duration) === undefined) {
		throw new Error(`${label} must be a whole number of days such as "14d"`);
	}
	return duration;
}

function parseEvidenceStrategy(
	value: unknown,
	checkProfiles: readonly EvoCheckProfile[],
	candidateKind: EvolutionCandidateKind,
): EvoEvidenceStrategy {
	const root = asRecord(value, "ResearchPlanner output.experiment.evidenceStrategy");
	if (typeof root.patchClass !== "string" || !PATCH_CLASSES.has(root.patchClass)) {
		throw new Error("ResearchPlanner output.experiment.evidenceStrategy.patchClass is invalid");
	}
	const offline = asRecord(root.offline, "ResearchPlanner output.experiment.evidenceStrategy.offline");
	const parsedOffline: EvoEvidenceStrategy["offline"] | undefined =
		offline.mode === "required"
			? {
					mode: "required" as const,
					profiles: profileArray(
						offline.profiles,
						"evidenceStrategy.offline.profiles",
						declarableProfiles(OFFLINE_PROFILE_CAPABILITIES, candidateKind),
					) as Array<Extract<EvoCheckProfile, "bundle-compile" | "repo-check" | "related-tests">>,
				}
			: offline.mode === "not-applicable"
				? { mode: "not-applicable" as const, reason: string(offline.reason, "evidenceStrategy.offline.reason") }
				: undefined;
	if (!parsedOffline) throw new Error("evidenceStrategy.offline.mode is invalid");
	const historical = asRecord(
		root.historicalReplay,
		"ResearchPlanner output.experiment.evidenceStrategy.historicalReplay",
	);
	const parsedHistorical: EvoEvidenceStrategy["historicalReplay"] | undefined =
		historical.mode === "required"
			? {
					mode: "required" as const,
					profiles: profileArray(
						historical.profiles,
						"evidenceStrategy.historicalReplay.profiles",
						declarableProfiles(HISTORICAL_PROFILE_CAPABILITIES, candidateKind),
					) as Array<Extract<EvoCheckProfile, "paired-replay" | "session-comparison" | "compaction-replay">>,
					datasets: nonEmptyStringArray(historical.datasets, "evidenceStrategy.historicalReplay.datasets"),
					minimumSamples: positiveInteger(
						historical.minimumSamples,
						"evidenceStrategy.historicalReplay.minimumSamples",
					),
				}
			: historical.mode === "optional" || historical.mode === "not-applicable"
				? { mode: historical.mode, reason: string(historical.reason, "evidenceStrategy.historicalReplay.reason") }
				: undefined;
	if (!parsedHistorical) throw new Error("evidenceStrategy.historicalReplay.mode is invalid");
	const online = asRecord(root.online, "ResearchPlanner output.experiment.evidenceStrategy.online");
	const parsedOnline: EvoEvidenceStrategy["online"] | undefined =
		online.mode === "none"
			? { mode: "none" as const }
			: online.mode === "shadow" || online.mode === "canary"
				? {
						mode: online.mode,
						minimumSamples: positiveInteger(online.minimumSamples, "evidenceStrategy.online.minimumSamples"),
						maximumDuration: trialDuration(online.maximumDuration, "evidenceStrategy.online.maximumDuration"),
					}
				: undefined;
	if (!parsedOnline) throw new Error("evidenceStrategy.online.mode is invalid");
	if (root.rollout !== "direct" && root.rollout !== "shadow-first" && root.rollout !== "canary-first") {
		throw new Error("evidenceStrategy.rollout is invalid");
	}
	if ((root.rollout === "direct") !== (parsedOnline.mode === "none")) {
		throw new Error("Direct rollout requires online.mode none and online evidence requires a staged rollout");
	}
	if (root.rollout === "shadow-first" && parsedOnline.mode !== "shadow")
		throw new Error("shadow-first requires shadow mode");
	if (root.rollout === "canary-first" && parsedOnline.mode !== "canary")
		throw new Error("canary-first requires canary mode");
	const selected = new Set(checkProfiles);
	for (const profile of [
		...(parsedOffline.mode === "required" ? parsedOffline.profiles : []),
		...(parsedHistorical.mode === "required" ? parsedHistorical.profiles : []),
	]) {
		if (!selected.has(profile)) throw new Error(`Evidence strategy profile ${profile} is missing from checkProfiles`);
	}
	return {
		patchClass: root.patchClass as EvoEvidenceStrategy["patchClass"],
		offline: parsedOffline,
		historicalReplay: parsedHistorical,
		online: parsedOnline,
		rollout: root.rollout,
	};
}

function parseInboxDecisions(value: unknown): EvolutionInboxDecision[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("ResearchPlanner output.inboxDecisions must be an array");
	return value.map((entry, index) => {
		const label = `ResearchPlanner output.inboxDecisions[${index}]`;
		const decision = asRecord(entry, label);
		if (typeof decision.file !== "string" || !decision.file.endsWith(".json")) {
			throw new Error(`${label}.file must be an inbox JSON file`);
		}
		if (
			decision.kind !== "preference" &&
			decision.kind !== "request" &&
			decision.kind !== "note" &&
			decision.kind !== "task-local"
		) {
			throw new Error(`${label}.kind is invalid`);
		}
		if (typeof decision.reason !== "string" || !decision.reason.trim()) {
			throw new Error(`${label}.reason must be a non-empty string`);
		}
		if (decision.kind === "preference") {
			if (typeof decision.instruction !== "string" || !decision.instruction.trim()) {
				throw new Error(`${label}.instruction is required for a preference`);
			}
		} else if (decision.instruction !== undefined) {
			throw new Error(`${label}.instruction is only valid for a preference`);
		}
		return {
			file: decision.file,
			kind: decision.kind,
			reason: decision.reason,
			...(decision.instruction ? { instruction: decision.instruction } : {}),
		} as EvolutionInboxDecision;
	});
}

export function parseEvolutionResearchPlanValue(value: unknown): EvolutionResearchPlan {
	const root = asRecord(value, "ResearchPlanner output");
	const experiment = asRecord(root.experiment, "ResearchPlanner output.experiment");
	if (!Array.isArray(experiment.checkProfiles)) {
		throw new Error("ResearchPlanner output.experiment.checkProfiles must be an array");
	}
	const checkProfiles = experiment.checkProfiles.map((entry, index) => {
		if (typeof entry !== "string" || !CHECK_PROFILES.has(entry as EvoExperimentSpec["checkProfiles"][number])) {
			throw new Error(`ResearchPlanner output.experiment.checkProfiles[${index}] is unsupported`);
		}
		return entry as EvoExperimentSpec["checkProfiles"][number];
	});
	const minimumEffectRecord = asRecord(experiment.minimumEffect, "ResearchPlanner output.experiment.minimumEffect");
	const minimumEffect: Record<string, number> = {};
	for (const [metric, value] of Object.entries(minimumEffectRecord)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`ResearchPlanner output.experiment.minimumEffect.${metric} must be non-negative`);
		}
		minimumEffect[metric] = value;
	}
	const candidateKind = root.candidateKind;
	if (
		candidateKind !== "none" &&
		candidateKind !== "data" &&
		candidateKind !== "component" &&
		candidateKind !== "code"
	) {
		throw new Error("ResearchPlanner output.candidateKind is invalid");
	}
	if (typeof root.requiresNewAbi !== "boolean")
		throw new Error("ResearchPlanner output.requiresNewAbi must be boolean");
	if (root.targetAbi !== undefined && typeof root.targetAbi !== "string") {
		throw new Error("ResearchPlanner output.targetAbi must be a string");
	}
	if (candidateKind === "component" && !root.targetAbi) {
		throw new Error("Component plans require targetAbi");
	}
	if (root.requiresNewAbi === true && candidateKind !== "code") {
		throw new Error("A plan requiring a new ABI must be an infrastructure code plan");
	}
	if (root.requiresNewAbi === false && root.targetAbi) {
		createDefaultEvoAbiRegistry().require(root.targetAbi);
	}
	const evidenceStrategy = parseEvidenceStrategy(
		experiment.evidenceStrategy,
		checkProfiles,
		candidateKind as EvolutionCandidateKind,
	);
	if (candidateKind === "component" && evidenceStrategy.patchClass !== "component") {
		throw new Error("Component candidates require patchClass component");
	}
	if (candidateKind === "component" && evidenceStrategy.rollout === "direct") {
		throw new Error("Component candidates require shadow or Canary rollout");
	}
	// The experiment is a contract: every metric must be one the trial comparison
	// actually measures, and a declared trial pre-registers one decision metric.
	const metrics = stringArray(experiment.metrics, "ResearchPlanner output.experiment.metrics");
	for (const metric of metrics) {
		if (!isTrialMetricName(metric)) {
			throw new Error(
				`ResearchPlanner output.experiment.metrics contains unmeasurable metric ${metric}; measurable metrics: ${Object.keys(TRIAL_METRIC_DIRECTIONS).join(", ")}`,
			);
		}
	}
	for (const key of Object.keys(minimumEffect)) {
		if (!metrics.includes(key)) {
			throw new Error(`ResearchPlanner output.experiment.minimumEffect.${key} is not one of the declared metrics`);
		}
	}
	const trialDeclared = evidenceStrategy.online.mode !== "none";
	const primaryMetric = experiment.primaryMetric;
	if (primaryMetric !== undefined && typeof primaryMetric !== "string") {
		throw new Error("ResearchPlanner output.experiment.primaryMetric must be a string");
	}
	if (trialDeclared) {
		if (!primaryMetric) {
			throw new Error("A plan that declares shadow or canary evidence must pre-register experiment.primaryMetric");
		}
		if (!metrics.includes(primaryMetric)) {
			throw new Error("ResearchPlanner output.experiment.primaryMetric must be one of the declared metrics");
		}
		const threshold = minimumEffect[primaryMetric];
		if (typeof threshold !== "number" || threshold <= 0) {
			throw new Error("ResearchPlanner output.experiment.minimumEffect must set a positive value for primaryMetric");
		}
	} else if (primaryMetric && !metrics.includes(primaryMetric)) {
		throw new Error("ResearchPlanner output.experiment.primaryMetric must be one of the declared metrics");
	}
	return {
		topic: string(root.topic, "ResearchPlanner output.topic"),
		reason: string(root.reason, "ResearchPlanner output.reason"),
		planMarkdown: string(root.planMarkdown, "ResearchPlanner output.planMarkdown"),
		experiment: {
			baseline: string(experiment.baseline, "ResearchPlanner output.experiment.baseline"),
			hypothesis: string(experiment.hypothesis, "ResearchPlanner output.experiment.hypothesis"),
			checkProfiles: [...new Set(checkProfiles)],
			evidenceStrategy,
			metrics,
			...(primaryMetric ? { primaryMetric } : {}),
			minimumEffect,
			trialPlan: string(experiment.trialPlan, "ResearchPlanner output.experiment.trialPlan"),
			rollbackConditions: stringArray(
				experiment.rollbackConditions,
				"ResearchPlanner output.experiment.rollbackConditions",
			),
		},
		...(root.targetAbi ? { targetAbi: root.targetAbi } : {}),
		requiresNewAbi: root.requiresNewAbi,
		candidateKind,
		builderInstructions: string(root.builderInstructions, "ResearchPlanner output.builderInstructions"),
		inboxDecisions: parseInboxDecisions(root.inboxDecisions),
	};
}

export interface RunEvolutionResearchPlanOptions {
	paths: EvoPaths;
	run: EvolutionRun;
	corpus: EvidenceCorpus;
	/** On-disk corpus tree; when present the prompt carries only its index. */
	materializedCorpus?: MaterializedCorpus;
	runner: ModelRunner;
	cwd: string;
	agentDir?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	activePreferences?: string;
	signal?: AbortSignal;
}

export interface EvolutionResearchPlanResult {
	plan: EvolutionResearchPlan;
	run: ModelRunResult;
	state: EvolutionRun;
}

export async function persistEvolutionResearchPlan(options: {
	paths: EvoPaths;
	run: EvolutionRun;
	plan: unknown;
}): Promise<{ plan: EvolutionResearchPlan; state: EvolutionRun }> {
	const plan = parseEvolutionResearchPlanValue(options.plan);
	const directory = evolutionRunDirectory(options.paths, options.run.id);
	await atomicWriteFile(join(directory, "plan.md"), `${plan.planMarkdown.trim()}\n`);
	await atomicWriteJson(join(directory, "experiment.json"), plan.experiment);
	// The full plan object enables evidence resumption and deterministic Builder
	// inputs without re-running research.
	await atomicWriteJson(join(directory, "plan.json"), plan);
	const state = await updateEvolutionRun(options.paths, options.run.id, {
		status: "planned",
		planFile: "plan.md",
		experimentFile: "experiment.json",
		experimentDigest: sha256(canonicalJson(plan.experiment)),
	});
	return { plan, state };
}

export async function runEvolutionResearchPlan(
	options: RunEvolutionResearchPlanOptions,
): Promise<EvolutionResearchPlanResult> {
	const workflow = await readEvolutionWorkflow(options.paths);
	const prompt = [
		"Research one worthwhile improvement and freeze its experiment before implementation.",
		options.run.request
			? `The user supplied this priority request: ${options.run.request}`
			: "No user request was supplied; select the best grounded opportunity yourself.",
		"Deliver exactly one plan by calling the submit_research_plan tool with: topic, reason, planMarkdown, experiment { baseline, hypothesis, checkProfiles, evidenceStrategy, metrics, primaryMetric, minimumEffect, trialPlan, rollbackConditions }, targetAbi (optional), requiresNewAbi, candidateKind, builderInstructions, and inboxDecisions.",
		`experiment.metrics must come from the measured set: ${Object.keys(TRIAL_METRIC_DIRECTIONS).join(", ")}. A plan declaring shadow or canary evidence must pre-register primaryMetric (one of its metrics) with a positive minimumEffect; keep and rollback are decided against that frozen threshold.`,
		"Classify every supplied explicit inbox input in inboxDecisions as preference, request, note, or task-local. A preference instruction must be an exact user-authored substring. Feature requests are requests even when they contain words such as every or always. Do not classify the same file twice.",
		"Open durable preferences should be prioritized as a narrow data candidate that appends memory/preferences.json; cite the inbox file and exact source event. Requests remain open until a linked candidate is kept.",
		"A component candidate must target a pre-defined ABI. A missing ABI requires an infrastructure code plan and cannot be activated automatically.",
		"Allowed checkProfiles: bundle-compile, repo-check, related-tests, paired-replay, session-comparison, compaction-replay. evidenceStrategy must classify patchClass; mark offline and historicalReplay required or explicitly not applicable with a concrete causal reason; choose online none, shadow, or canary with sample bounds; and choose the matching direct, shadow-first, or canary-first rollout. Offline infeasibility never implies direct rollout. Component replacement cannot use direct rollout. Do not emit shell commands.",
		"Use research as a hypothesis source and cite concrete sources in planMarkdown. State when external research is unavailable.",
		"",
		...(options.activePreferences
			? ["<active_preferences>", options.activePreferences, "</active_preferences>", ""]
			: []),
		"<workflow>",
		workflow,
		"</workflow>",
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
	let failureUsage: Parameters<NonNullable<ModelRunRequest["onSessionStats"]>> | undefined;
	let modelRun: ModelRunResult;
	try {
		modelRun = await options.runner.run({
			cwd: options.cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			systemPrompt:
				"You are Evo-Pi's ResearchPlanner. Research, reason, and write the frozen plan and experiment. You never implement or activate candidates.",
			prompt,
			model: options.model,
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			tools: ["read", "grep", "find", "ls", "evo_research_search", "evo_research_fetch"],
			customTools: createEvolutionResearchTools(),
			// A stable identity lets recovery retries and later phases hit the provider prompt cache.
			sessionIdentity: `evo-research-${options.run.id}`,
			recoveryPrompt:
				"You ran out of output space. Call the submit_research_plan tool now with the complete plan. Do not call other tools and do not repeat your analysis.",
			submission: {
				toolName: "submit_research_plan",
				description:
					"Deliver the frozen research plan and experiment. Validation errors are returned for correction.",
				parameters: RESEARCH_PLAN_PARAMETERS,
				validate: (params) => parseEvolutionResearchPlanValue(params),
			},
			onSessionStats: (...usage) => {
				failureUsage = usage;
			},
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		// Preserve the usage of failed research runs so window pressure stays diagnosable.
		const [stats, model] = failureUsage ?? [];
		if (stats && model) {
			await recordModelUsage(options.paths, "research-plan", { text: "", stats, model }).catch(() => {});
		}
		throw error;
	}
	await recordModelUsage(options.paths, "research-plan", modelRun);
	const persisted = await persistEvolutionResearchPlan({
		paths: options.paths,
		run: options.run,
		plan: modelRun.submission,
	});
	return { ...persisted, run: modelRun };
}
