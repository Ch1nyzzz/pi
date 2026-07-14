import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { renderRuntimeBundle, replaceRuntimeBundlePrompt } from "../bundle/runtime.ts";
import type { EvoPaths } from "../paths.ts";
import { saveProposal } from "../proposal.ts";
import { atomicWriteFile } from "../storage.ts";
import type { Proposal, ReplayScenario } from "../types.ts";
import { loadReplayScenario } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";

export const REPLAY_LIMITATION =
	"This is a generate-only counterfactual replay. It does not restore a workspace snapshot, does not provide tool schemas, and does not execute tools, so it evaluates only the first response or intended first action, not end-to-end task completion.";

export interface CounterfactualReplayResult {
	scenario: ReplayScenario;
	limitation: string;
	old: ModelRunResult;
	candidate: ModelRunResult;
	markdown: string;
}

export interface RunCounterfactualReplayOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	proposal: Proposal;
	scenario?: ReplayScenario;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

function formatRun(label: string, result: ModelRunResult): string {
	return [
		`## ${label}`,
		"",
		`Model: \`${result.model.provider}/${result.model.id}\``,
		`Usage: \`${JSON.stringify(result.stats.tokens)}\``,
		"",
		result.text,
	].join("\n");
}

export async function runCounterfactualReplay(
	options: RunCounterfactualReplayOptions,
): Promise<CounterfactualReplayResult> {
	if (options.proposal.kind !== "data" || !options.proposal.candidateDigest) {
		throw new Error(`Proposal ${options.proposal.id} has no replayable candidate bundle`);
	}
	const scenario = options.scenario ?? options.proposal.replayScenarios[0];
	if (!scenario) throw new Error(`Proposal ${options.proposal.id} has no replay scenario`);

	const loaded = await loadReplayScenario(options.paths, scenario);
	const [parentBundle, candidateBundle] = await Promise.all([
		loadCompiledBundle(options.paths, options.proposal.parentBundleDigest),
		loadCompiledBundle(options.paths, options.proposal.candidateDigest),
	]);
	const candidateRuntime = await renderRuntimeBundle(candidateBundle);
	const oldModel = options.model ?? parentBundle.policy.modelRouting?.worker;
	const candidateModel = options.model ?? candidateBundle.policy.modelRouting?.worker;
	const candidateSystemPrompt = replaceRuntimeBundlePrompt(
		loaded.oldSystemPrompt,
		candidateRuntime.systemPromptAppend,
	);
	const sharedRequest = {
		cwd: loaded.cwd,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		prompt: loaded.targetPrompt,
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		history: loaded.history,
		sessionIdentity: loaded.sessionIdentity,
	};

	// Keep these sequential and share the original identity so providers can reuse
	// the recorded transcript prefix within their prompt-cache TTL.
	const old = await options.runner.run({
		...sharedRequest,
		...(oldModel ? { model: oldModel } : {}),
		systemPrompt: loaded.oldSystemPrompt,
	});
	const candidate = await options.runner.run({
		...sharedRequest,
		...(candidateModel ? { model: candidateModel } : {}),
		systemPrompt: candidateSystemPrompt,
	});
	const markdown = [
		"# Counterfactual replay",
		"",
		`Scenario: \`${scenario.sessionId}:${scenario.sequence}\``,
		"",
		`> ${REPLAY_LIMITATION}`,
		"",
		formatRun("Recorded bundle", old),
		"",
		formatRun("Candidate bundle", candidate),
		"",
	].join("\n");

	await atomicWriteFile(join(options.paths.proposals, options.proposal.id, "replay.md"), markdown);
	options.proposal.replayFile = "replay.md";
	await saveProposal(options.paths, options.proposal);
	return { scenario, limitation: REPLAY_LIMITATION, old, candidate, markdown };
}
