import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvolutionBuilder } from "../src/evolve/builder.ts";
import { ensureEvoLayout, getEvoPaths } from "../src/paths.ts";
import type { EvidenceCorpus } from "../src/reflect/evidence.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import type { EvolutionResearchPlan } from "../src/types.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

class EditingBuilderRunner implements ModelRunner {
	request?: ModelRunRequest;

	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.request = request;
		await writeFile(join(request.cwd, "src", "value.ts"), "export const value = 2;\n");
		await writeFile(join(request.cwd, "src", "added.ts"), "export const added = true;\n");
		const params = {
			observationsMarkdown: "# Builder evidence",
			observationEvidence: [],
			proposals: [
				{
					motivation: "Isolate Builder edits.",
					expectedEffect: "Git generates a valid patch.",
					risk: "The candidate may fail later checks.",
					verifyPlan: "Run repository checks.",
					trialPlan: "Use the frozen trial.",
					source: "explicit-request",
					evidence: [],
					inboxReferences: [],
					replayScenarios: [{ sessionId: "session", sequence: 1 }],
				},
			],
		};
		const submission = (await request.submission?.validate?.(params)) ?? params;
		return {
			text: "",
			submission,
			model: { provider: "fake", id: "builder" },
			stats: {
				sessionFile: undefined,
				sessionId: "builder",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 3,
				toolResults: 3,
				totalMessages: 2,
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				cost: 0,
			},
		};
	}
}

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evolution code Builder", () => {
	it("edits an isolated worktree and returns a host-generated patch", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-builder-"));
		roots.push(root);
		const repository = join(root, "repository");
		await mkdir(join(repository, "src"), { recursive: true });
		git(repository, ["init", "--quiet"]);
		git(repository, ["config", "user.name", "Evo Test"]);
		git(repository, ["config", "user.email", "evo-test@example.invalid"]);
		await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
		git(repository, ["add", "src/value.ts"]);
		git(repository, ["commit", "--quiet", "-m", "initial"]);

		const paths = getEvoPaths(join(root, "evo"));
		await ensureEvoLayout(paths);
		await writeFile(paths.workflow, "# Test workflow\n");
		const runId = "r-builder-generated-patch";
		await mkdir(join(paths.runs, runId));
		const plan: EvolutionResearchPlan = {
			topic: "Builder patch generation",
			reason: "Model-authored patch text is unreliable.",
			planMarkdown: "# Plan",
			experiment: {
				baseline: "Model emits patch text.",
				hypothesis: "Git-generated patches are structurally valid.",
				checkProfiles: ["repo-check", "related-tests"],
				evidenceStrategy: {
					patchClass: "infrastructure",
					offline: { mode: "required", profiles: ["repo-check", "related-tests"] },
					historicalReplay: { mode: "optional", reason: "Not causal." },
					online: { mode: "none" },
					rollout: "direct",
				},
				metrics: [],
				minimumEffect: {},
				trialPlan: "No runtime trial.",
				rollbackConditions: ["Patch cannot be reconstructed."],
			},
			requiresNewAbi: false,
			candidateKind: "code",
			builderInstructions: "Edit src/value.ts and add src/added.ts.",
			inboxDecisions: [],
		};
		const corpus: EvidenceCorpus = {
			text: "evidence",
			bytes: 8,
			maxBytes: 1024,
			truncated: false,
			mode: "full",
			evidenceDigest: "a".repeat(64),
			sources: Object.fromEntries(
				["bundle", "history", "inbox", "sessions"].map((source) => [
					source,
					{ bytes: 0, maxBytes: 256, truncated: false },
				]),
			) as EvidenceCorpus["sources"],
			fragments: [],
			sessionIds: [],
			inboxFiles: [],
			nextReviewCursor: {
				schemaVersion: 1,
				updatedAt: new Date(0).toISOString(),
				inboxFiles: [],
				sessionSequences: {},
			},
		};
		const runner = new EditingBuilderRunner();
		const result = await runEvolutionBuilder({
			paths,
			runId,
			plan,
			parentDigest: "b".repeat(64),
			corpus,
			runner,
			cwd: repository,
			model: "fake/builder",
		});

		expect(runner.request?.cwd).not.toBe(repository);
		expect(runner.request?.tools).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
		expect(result.draft.codePatch).toContain("diff --git a/src/added.ts b/src/added.ts");
		expect(result.draft.codePatch).toContain("export const value = 2;");
		expect(await readFile(join(repository, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
		expect(await readFile(join(paths.runs, runId, "candidate.patch"), "utf8")).toBe(result.draft.codePatch);
		expect(git(repository, ["apply", "--check", join(paths.runs, runId, "candidate.patch")])).toBe("");
		expect(result.codeBase?.baseCommit).toBe(git(repository, ["rev-parse", "HEAD"]).trim());
	});
});
