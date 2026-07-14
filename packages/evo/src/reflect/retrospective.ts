import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadCompiledBundle } from "../bundle/compile.ts";
import type { EvoPaths } from "../paths.ts";
import { loadProposal, saveProposal } from "../proposal.ts";
import { BundleRegistry } from "../registry/registry.ts";
import { atomicWriteFile } from "../storage.ts";
import type { Proposal, TrialState } from "../types.ts";
import { collectEvidenceCorpus, type EvidenceCorpus } from "./evidence.ts";
import type { ModelRunner, ModelRunResult } from "./model-runner.ts";

const RETROSPECTIVE_PROMPT_URL = new URL("../prompts/retrospective.md", import.meta.url);

export interface RunRetrospectiveOptions {
	paths: EvoPaths;
	runner: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxCorpusBytes?: number;
}

export interface RetrospectiveRunResult {
	proposal: Proposal;
	trial: TrialState;
	corpus: EvidenceCorpus;
	retrospectiveMarkdown: string;
	run: ModelRunResult;
}

export async function runRetrospective(options: RunRetrospectiveOptions): Promise<RetrospectiveRunResult> {
	const registry = new BundleRegistry(options.paths);
	const trial = await registry.readTrial();
	if (!trial) throw new Error("No Evo-Pi trial is active");
	const proposal = await loadProposal(options.paths, trial.proposalId);
	const trialBundle = await loadCompiledBundle(options.paths, trial.digest);
	const reflectorModel = options.model ?? trialBundle.policy.modelRouting?.reflector;
	const corpus = await collectEvidenceCorpus(options.paths, { maxBytes: options.maxCorpusBytes });
	const prompt = [
		"Prepare the trial retrospective from the proposal and recorded corpus.",
		`Treat records with bundleDigest ${trial.parent} as the pre-trial baseline and records with bundleDigest ${trial.digest} at or after ${trial.startedAt} as trial/post evidence.`,
		"Do not treat records from other bundle digests as candidate effects.",
		"",
		"<trial>",
		JSON.stringify(trial, undefined, "\t"),
		"</trial>",
		"",
		"<proposal>",
		JSON.stringify(proposal, undefined, "\t"),
		"</proposal>",
		"",
		`<pre_and_post_corpus truncated="${String(corpus.truncated)}">`,
		corpus.text,
		"</pre_and_post_corpus>",
	].join("\n");
	const run = await options.runner.run({
		cwd: options.cwd ?? process.cwd(),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		systemPrompt: await readFile(RETROSPECTIVE_PROMPT_URL, "utf8"),
		prompt,
		...(reflectorModel ? { model: reflectorModel } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	});
	const retrospectiveMarkdown = `${run.text.trim()}\n`;
	await atomicWriteFile(join(options.paths.proposals, proposal.id, "retrospective.md"), retrospectiveMarkdown);
	proposal.retrospectiveFile = "retrospective.md";
	await saveProposal(options.paths, proposal);
	return { proposal, trial, corpus, retrospectiveMarkdown, run };
}
