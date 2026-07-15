import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createDefaultEvoAbiRegistry } from "../components/registry.ts";
import type { EvoPaths } from "../paths.ts";
import type { EvidenceCorpus } from "../reflect/evidence.ts";
import type { ModelRunner, ModelRunResult } from "../reflect/model-runner.ts";
import { recordModelUsage } from "../reflect/usage.ts";
import { atomicWriteFile, atomicWriteJson } from "../storage.ts";
import type { EvoExperimentSpec, EvolutionInboxDecision, EvolutionResearchPlan, EvolutionRun } from "../types.ts";
import { readEvolutionWorkflow } from "./config.ts";
import { createEvolutionResearchTools } from "./research-tools.ts";
import { evolutionRunDirectory, updateEvolutionRun } from "./run.ts";

const CHECK_PROFILES = new Set<EvoExperimentSpec["checkProfiles"][number]>([
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

function extractObject(text: string): Record<string, unknown> {
	const normalized = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const start = normalized.indexOf("{");
	const end = normalized.lastIndexOf("}");
	if (start === -1 || end < start) throw new Error("ResearchPlanner did not return a JSON object");
	return asRecord(JSON.parse(normalized.slice(start, end + 1)), "ResearchPlanner output");
}

export function parseEvolutionResearchPlan(text: string): EvolutionResearchPlan {
	const root = extractObject(text);
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
	return {
		topic: string(root.topic, "ResearchPlanner output.topic"),
		reason: string(root.reason, "ResearchPlanner output.reason"),
		planMarkdown: string(root.planMarkdown, "ResearchPlanner output.planMarkdown"),
		experiment: {
			baseline: string(experiment.baseline, "ResearchPlanner output.experiment.baseline"),
			hypothesis: string(experiment.hypothesis, "ResearchPlanner output.experiment.hypothesis"),
			checkProfiles: [...new Set(checkProfiles)],
			metrics: stringArray(experiment.metrics, "ResearchPlanner output.experiment.metrics"),
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

export async function runEvolutionResearchPlan(
	options: RunEvolutionResearchPlanOptions,
): Promise<EvolutionResearchPlanResult> {
	const workflow = await readEvolutionWorkflow(options.paths);
	const prompt = [
		"Research one worthwhile improvement and freeze its experiment before implementation.",
		options.run.request
			? `The user supplied this priority request: ${options.run.request}`
			: "No user request was supplied; select the best grounded opportunity yourself.",
		"Return exactly one JSON object with: topic, reason, planMarkdown, experiment { baseline, hypothesis, checkProfiles, metrics, minimumEffect, trialPlan, rollbackConditions }, targetAbi (optional), requiresNewAbi, candidateKind, builderInstructions, and inboxDecisions.",
		"Classify every supplied explicit inbox input in inboxDecisions as preference, request, note, or task-local. A preference instruction must be an exact user-authored substring. Feature requests are requests even when they contain words such as every or always. Do not classify the same file twice.",
		"Open durable preferences should be prioritized as a narrow data candidate that appends memory/preferences.json; cite the inbox file and exact source event. Requests remain open until a linked candidate is kept.",
		"A component candidate must target a pre-defined ABI. A missing ABI requires an infrastructure code plan and cannot be activated automatically.",
		"Allowed checkProfiles: bundle-compile, repo-check, related-tests, paired-replay, session-comparison, compaction-replay. Do not emit shell commands.",
		"Use research as a hypothesis source and cite concrete sources in planMarkdown. State when external research is unavailable.",
		"",
		...(options.activePreferences
			? ["<active_preferences>", options.activePreferences, "</active_preferences>", ""]
			: []),
		"<workflow>",
		workflow,
		"</workflow>",
		"",
		`<evidence_corpus truncated="${String(options.corpus.truncated)}">`,
		options.corpus.text,
		"</evidence_corpus>",
	].join("\n");
	const modelRun = await options.runner.run({
		cwd: options.cwd,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt:
			"You are Evo-Pi's ResearchPlanner. Research, reason, and write the frozen plan and experiment. You never implement or activate candidates.",
		prompt,
		model: options.model,
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		tools: ["read", "grep", "find", "ls", "evo_research_search", "evo_research_fetch"],
		customTools: createEvolutionResearchTools(),
		...(options.signal ? { signal: options.signal } : {}),
	});
	await recordModelUsage(options.paths, "research-plan", modelRun);
	const plan = parseEvolutionResearchPlan(modelRun.text);
	const directory = evolutionRunDirectory(options.paths, options.run.id);
	await atomicWriteFile(join(directory, "plan.md"), `${plan.planMarkdown.trim()}\n`);
	await atomicWriteJson(join(directory, "experiment.json"), plan.experiment);
	const state = await updateEvolutionRun(options.paths, options.run.id, {
		status: "planned",
		planFile: "plan.md",
		experimentFile: "experiment.json",
	});
	return { plan, run: modelRun, state };
}
