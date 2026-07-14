import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEvoPaths } from "../src/paths.ts";
import { stageProposal } from "../src/proposal.ts";
import { EvoService } from "../src/service.ts";
import type { BundlePolicy } from "../src/types.ts";

interface CorePolicyCase {
	name: string;
	mutate(policy: BundlePolicy): void;
}

const CORE_POLICY_CASES: readonly CorePolicyCase[] = [
	{
		name: "enabledTools",
		mutate(policy) {
			policy.enabledTools = ["bash", "read"];
		},
	},
	{
		name: "enabledFeatures",
		mutate(policy) {
			policy.enabledFeatures = ["review-hook"];
		},
	},
	{
		name: "managedSources",
		mutate(policy) {
			delete policy.managedSources;
		},
	},
];

describe("core policy proposal tiers", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function createMigratedService(): Promise<{
		service: EvoService;
		policy: BundlePolicy;
		parentDigest: string;
	}> {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-policy-tier-"));
		temporaryDirectories.push(root);
		const promptDirectory = join(root, "prompts");
		await mkdir(promptDirectory);
		await writeFile(join(promptDirectory, "review.md"), "Review changes before applying them.\n");
		const service = new EvoService(getEvoPaths(join(root, "evo")));
		const seed = await service.init(["read"], { systemPromptDirectories: [promptDirectory] });
		expect(seed.policy.managedSources).toHaveLength(1);
		return { service, policy: seed.policy, parentDigest: seed.digest };
	}

	for (const testCase of CORE_POLICY_CASES) {
		it(`classifies ${testCase.name} changes as T2`, async () => {
			const { service, policy: seedPolicy, parentDigest } = await createMigratedService();
			const candidatePolicy = structuredClone(seedPolicy);
			testCase.mutate(candidatePolicy);
			const proposal = await stageProposal({
				paths: service.paths,
				parentDigest,
				observationsMarkdown: `${testCase.name} changes the runtime trust or capability boundary.`,
				draft: {
					motivation: `Change the ${testCase.name} runtime policy`,
					expectedEffect: "The runtime uses the explicitly approved core policy",
					risk: "The change can alter loaded resources or executable capabilities",
					verifyPlan: "Replay a representative session and review the exact policy diff",
					trialPlan: "Use for five sessions",
					source: "pattern",
					evidence: [],
					inboxReferences: [],
					replayScenarios: [],
					changes: [
						{
							path: "policy.json",
							content: `${JSON.stringify(candidatePolicy, undefined, "\t")}\n`,
						},
					],
				},
			});

			expect(proposal).toMatchObject({
				kind: "data",
				tier: "T2",
				changedPaths: ["policy.json"],
			});
			expect(proposal.l1.reason).toContain("core policy field");
		});
	}
});
