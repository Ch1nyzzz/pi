import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { replaceManagedHostResources } from "../src/bundle/managed-sources.ts";
import { renderRuntimeBundle, renderRuntimeBundlePrompt, replaceRuntimeBundlePrompt } from "../src/bundle/runtime.ts";
import { migratePiDataToBundleSource } from "../src/migration.ts";
import { getEvoPaths } from "../src/paths.ts";
import { stageProposal } from "../src/proposal.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { runCounterfactualReplay } from "../src/reflect/replay.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { BundlePolicy } from "../src/types.ts";

const HOST_PROMPT = "HOST_SYSTEM_SOURCE\n";
const PARENT_PROMPT = "PARENT_MANAGED_SYSTEM\n";
const CANDIDATE_PROMPT = "CANDIDATE_MANAGED_SYSTEM\n";

class FakeReplayRunner implements ModelRunner {
	readonly requests: ModelRunRequest[] = [];

	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.requests.push(request);
		return {
			text: this.requests.length === 1 ? "Parent response" : "Candidate response",
			model: { provider: "fake", id: "replay" },
			stats: {
				sessionFile: undefined,
				sessionId: request.sessionIdentity ?? "managed-replay",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
				cost: 0,
			},
		};
	}
}

function countOccurrences(content: string, needle: string): number {
	return content.split(needle).length - 1;
}

describe("managed-source counterfactual replay", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("reconstructs the candidate managed base once while preserving recorded extension wrappers", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-managed-replay-"));
		temporaryDirectories.push(root);
		const agentDirectory = join(root, "agent");
		const sourceDirectory = join(root, "source");
		const paths = getEvoPaths(join(root, "evo"));
		await mkdir(agentDirectory);
		await mkdir(sourceDirectory);
		await writeFile(join(agentDirectory, "SYSTEM.md"), HOST_PROMPT);
		const migration = await migratePiDataToBundleSource({
			bundleSourceDirectory: sourceDirectory,
			sources: { agentDirectory },
		});
		await writeFile(join(sourceDirectory, "prompts", "system.md"), PARENT_PROMPT);
		const policy = {
			schemaVersion: 1,
			promptOrder: migration.promptPaths,
			stablePromptPaths: migration.promptPaths,
			enabledFeatures: [],
			coreAssets: ["prompts/system.md"],
			modelRouting: {},
			validation: { requiredChecks: [] },
			managedSources: migration.assets,
		} satisfies BundlePolicy;
		await writeFile(join(sourceDirectory, "policy.json"), `${JSON.stringify(policy, undefined, "\t")}\n`);
		const parent = await compileBundle({
			paths,
			sourceDirectory,
			parentDigest: null,
			summary: "Managed replay parent",
		});
		await new BundleRegistry(paths).initialize(parent.digest);

		const systemPromptOptions: BuildSystemPromptOptions = {
			cwd: root,
			selectedTools: ["read"],
			customPrompt: HOST_PROMPT,
		};
		const parentRuntime = await renderRuntimeBundle(parent);
		const parentManaged = replaceManagedHostResources({
			event: {
				systemPrompt: buildSystemPrompt(systemPromptOptions),
				systemPromptOptions,
			},
			bundle: parent,
			resources: parentRuntime.managedResources,
		});
		const activeParentPrompt = replaceRuntimeBundlePrompt(
			parentManaged.systemPrompt,
			renderRuntimeBundlePrompt(parentRuntime, parentManaged.excludedTargets),
		).replace(/Current date: \d{4}-\d{2}-\d{2}/, "Current date: 2020-01-02");
		const recordedSystemPrompt = `OTHER_EXTENSION_PREFIX\n\n${activeParentPrompt}\n\nOTHER_EXTENSION_SUFFIX`;

		const store = await createRecorderStore({
			paths,
			sessionId: "managed-replay-session",
			bundleDigest: parent.digest,
		});
		await store.append({ type: "session_start", reason: "startup", cwd: root });
		await store.append({
			type: "before_agent_start",
			prompt: await store.storePayload("Review the managed change"),
			systemPrompt: await store.storePayload(recordedSystemPrompt),
			systemPromptOptions: await store.storePayload(systemPromptOptions),
		});
		const target = await store.append({
			type: "message",
			role: "user",
			message: await store.storePayload({
				role: "user",
				content: "Review the managed change",
				timestamp: 1,
			}),
		});
		const proposal = await stageProposal({
			paths,
			parentDigest: parent.digest,
			observationsMarkdown: "The managed system contract needs a reviewed change.",
			draft: {
				motivation: "Update the managed system contract",
				expectedEffect: "The candidate contract replaces the parent contract",
				risk: "The new contract may alter behavior",
				verifyPlan: "Replay the recorded first decision",
				trialPlan: "Use for five sessions",
				source: "pattern",
				evidence: [],
				inboxReferences: [],
				replayScenarios: [{ sessionId: target.sessionId, sequence: target.sequence }],
				changes: [{ path: "prompts/system.md", content: CANDIDATE_PROMPT }],
			},
		});
		expect(proposal.tier).toBe("T2");

		const runner = new FakeReplayRunner();
		const result = await runCounterfactualReplay({ paths, runner, proposal });

		expect(result.mode).toBe("bundle-candidate");
		expect(runner.requests).toHaveLength(2);
		expect(runner.requests[0]?.systemPrompt).toBe(recordedSystemPrompt);
		const candidateSystemPrompt = runner.requests[1]?.systemPrompt ?? "";
		expect(countOccurrences(candidateSystemPrompt, CANDIDATE_PROMPT.trim())).toBe(1);
		expect(candidateSystemPrompt).not.toContain(PARENT_PROMPT.trim());
		expect(candidateSystemPrompt).not.toContain(HOST_PROMPT.trim());
		expect(candidateSystemPrompt).toContain("OTHER_EXTENSION_PREFIX");
		expect(candidateSystemPrompt).toContain("OTHER_EXTENSION_SUFFIX");
		expect(candidateSystemPrompt).toContain(`Current working directory: ${root}`);
		expect(countOccurrences(candidateSystemPrompt, "evo-pi bundle begin")).toBe(1);
	});
});
