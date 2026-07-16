import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishEvoComponentArtifact } from "../../components/artifact.ts";
import { composeWorkflowEntrypoint } from "../../components/workflow-sdk/index.ts";
import { getEvoPaths } from "../../paths.ts";
import { computeEvoPackIntegrity, type EvoPackManifest, parseEvoPackManifest } from "../pack.ts";

export const DEEP_REVIEW_WORKFLOW_ID = "deep-review";
export const DEEP_REVIEW_TRIGGER = "/deep-review";

/**
 * The /deep-review workflow body: discover changed files, review each one,
 * adversarially verify every finding, and return only the confirmed ones.
 * Fixed orchestration — the script holds the control flow; child agents do
 * the reading and judging.
 */
export const DEEP_REVIEW_WORKFLOW_BODY = String.raw`
const FILES_SCHEMA = {
	type: "object",
	required: ["files"],
	properties: { files: { type: "array", items: { type: "string" } } },
};
const FINDINGS_SCHEMA = {
	type: "object",
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				required: ["summary", "severity"],
				properties: {
					summary: { type: "string" },
					severity: { enum: ["low", "medium", "high"] },
					line: { type: "integer" },
				},
			},
		},
	},
};
const VERDICT_SCHEMA = {
	type: "object",
	required: ["confirmed"],
	properties: { confirmed: { type: "boolean" }, reason: { type: "string" } },
};

runWorkflow(async ({ args }) => {
	const scope = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "the current working tree";
	const discovered = await agent(
		"List the source files with pending changes in " +
			scope +
			". Run 'git diff --name-only HEAD' (fall back to 'git status --porcelain') in the workspace and report the changed source files. Exclude lockfiles and generated output.",
		{ schema: FILES_SCHEMA },
	);
	const reviews = await pipeline(
		discovered.files,
		(file) =>
			agent(
				"Review the file " +
					file +
					" strictly for correctness bugs in its pending changes: logic errors, broken edge cases, wrong conditions, unsafe assumptions. Read the file before judging. Report only defects you are confident about; do not report style issues.",
				{ schema: FINDINGS_SCHEMA },
			),
		async (review, file) => {
			const verified = await parallel(
				review.findings.map((finding) => async () => {
					const verdict = await agent(
						"Adversarially verify this code-review finding for " +
							file +
							': "' +
							finding.summary +
							'". Read the file and try to REFUTE the finding. Confirm it only if you can point to the concrete failure; default to refuted when uncertain.',
						{ schema: VERDICT_SCHEMA },
					);
					return verdict.confirmed ? { ...finding, file, reason: verdict.reason ?? "" } : null;
				}),
			);
			return verified.filter(Boolean);
		},
	);
	const findings = reviews
		.filter(Boolean)
		.flat()
		.sort((left, right) => {
			const rank = { high: 0, medium: 1, low: 2 };
			return (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3);
		});
	log("deep-review: " + findings.length + " confirmed finding(s)");
	return { scope, findings };
});
`;

/** The composed single-file component entrypoint (SDK prelude + body). */
export function composeDeepReviewEntrypoint(): Promise<string> {
	return composeWorkflowEntrypoint(DEEP_REVIEW_WORKFLOW_BODY);
}

export interface WrittenDeepReviewPack {
	manifest: EvoPackManifest;
	integrity: string;
}

/**
 * Write a complete, importable /deep-review optimization pack into
 * `directory`: the composed workflow artifact plus a signed-integrity
 * pack.json. The staging component store is temporary and removed.
 */
export async function writeDeepReviewPack(directory: string): Promise<WrittenDeepReviewPack> {
	const staging = await mkdtemp(join(tmpdir(), "pi-evo-deep-review-pack-"));
	try {
		const artifact = await publishEvoComponentArtifact(getEvoPaths(join(staging, "evo")), {
			id: DEEP_REVIEW_WORKFLOW_ID,
			version: "1.0.0",
			abi: "workflow/v1",
			activationBoundary: "invocation",
			capabilities: ["spawn-agent"],
			entrypointContent: await composeDeepReviewEntrypoint(),
		});
		const artifactDirectory = join(directory, "workflows", DEEP_REVIEW_WORKFLOW_ID);
		await mkdir(artifactDirectory, { recursive: true });
		await writeFile(
			join(artifactDirectory, "manifest.json"),
			await readFile(join(artifact.directory, "manifest.json")),
		);
		await writeFile(join(artifactDirectory, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
		const unsigned = parseEvoPackManifest({
			packFormat: 1,
			name: "deep-review",
			version: "1.0.0",
			description: "Voting-style code review workflow: per-file reviewers plus adversarial verification.",
			contents: {
				workflows: [
					{
						id: DEEP_REVIEW_WORKFLOW_ID,
						trigger: DEEP_REVIEW_TRIGGER,
						abi: "workflow/v1",
						artifact: `workflows/${DEEP_REVIEW_WORKFLOW_ID}`,
						capabilities: ["spawn-agent"],
					},
				],
			},
			requiresAbis: ["workflow/v1"],
			requiresCapabilities: ["spawn-agent"],
		});
		const integrity = await computeEvoPackIntegrity(directory, unsigned);
		const manifest: EvoPackManifest = { ...unsigned, integrity };
		await writeFile(join(directory, "pack.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`);
		return { manifest, integrity };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
