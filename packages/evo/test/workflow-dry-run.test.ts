import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import { composeWorkflowEntrypoint } from "../src/components/workflow-sdk/index.ts";
import { dryRunWorkflowSelection } from "../src/evolve/workflow-dry-run.ts";
import { composeDeepResearchEntrypoint } from "../src/pack/templates/deep-research.ts";
import { composeDeepReviewEntrypoint } from "../src/pack/templates/deep-review.ts";
import { composeDeepcodeEntrypoint } from "../src/pack/templates/deepcode.ts";
import { getEvoPaths } from "../src/paths.ts";
import type { EvoWorkflowSelection } from "../src/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workflowSelection(
	id: string,
	source: string,
): Promise<{ paths: ReturnType<typeof getEvoPaths>; selection: EvoWorkflowSelection }> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-workflow-dry-run-"));
	roots.push(root);
	const paths = getEvoPaths(join(root, "evo"));
	const artifact = await publishEvoComponentArtifact(paths, {
		id,
		version: "1.0.0",
		abi: "workflow/v1",
		activationBoundary: "invocation",
		capabilities: ["spawn-agent"],
		entrypointContent: source,
	});
	return {
		paths,
		selection: {
			id: artifact.manifest.id,
			abi: artifact.manifest.abi,
			artifactDigest: artifact.manifest.artifactDigest,
			config: {},
			trigger: `/${id}`,
		},
	};
}

describe("workflow dry run", () => {
	it("passes a capability-free workflow with a real result", async () => {
		const { paths, selection } = await workflowSelection(
			"echo-flow",
			await composeWorkflowEntrypoint(`runWorkflow(async ({ trigger }) => ({ ok: true, trigger }));`),
		);
		const outcome = await dryRunWorkflowSelection(paths, selection, { sandbox: false });
		expect(outcome.passed).toBe(true);
		expect(outcome.invokeOutcome).toBe("result");
		expect(outcome.markdown).toContain("verdict: passed");
	});

	it("passes the deep-review template: stub data yields a clean structured error or result", async () => {
		const { paths, selection } = await workflowSelection("deep-review", await composeDeepReviewEntrypoint());
		const outcome = await dryRunWorkflowSelection(paths, selection, { sandbox: false });
		expect(outcome.passed).toBe(true);
		expect(["result", "clean-error"]).toContain(outcome.invokeOutcome);
	});

	it("passes the deep-research and deepcode templates", async () => {
		for (const [id, entrypoint] of [
			["deep-research", await composeDeepResearchEntrypoint()],
			["deepcode", await composeDeepcodeEntrypoint()],
		] as const) {
			const { paths, selection } = await workflowSelection(id, entrypoint);
			const outcome = await dryRunWorkflowSelection(paths, selection, { sandbox: false });
			expect(outcome.passed).toBe(true);
			expect(["result", "clean-error"]).toContain(outcome.invokeOutcome);
		}
	});

	it("fails a protocol-violating component", async () => {
		const { paths, selection } = await workflowSelection(
			"broken-flow",
			[
				`import { createInterface } from "node:readline";`,
				`const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });`,
				`lines.on("line", (line) => {`,
				`  const message = JSON.parse(line);`,
				`  if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, ok: true, result: {} }) + "\\n");`,
				`  if (message.method === "health") process.stdout.write(JSON.stringify({ id: message.id, ok: true, result: { healthy: true } }) + "\\n");`,
				`  if (message.method === "invoke") process.stdout.write(JSON.stringify({ id: 999999, ok: true, result: {} }) + "\\n");`,
				`});`,
			].join("\n"),
		);
		const outcome = await dryRunWorkflowSelection(paths, selection, { sandbox: false });
		expect(outcome.passed).toBe(false);
		expect(outcome.invokeOutcome).toBe("protocol-failure");
	});
});
