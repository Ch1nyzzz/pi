import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishEvoComponentArtifact } from "../../components/artifact.ts";
import { composeWorkflowEntrypoint } from "../../components/workflow-sdk/index.ts";
import { getEvoPaths } from "../../paths.ts";
import { computeEvoPackIntegrity, type EvoPackManifest, parseEvoPackManifest } from "../pack.ts";

export interface WorkflowPackTemplate {
	/** Workflow component id, also the pack name. */
	id: string;
	/** Slash trigger, e.g. "/deep-review". */
	trigger: string;
	version: string;
	description: string;
	/** Author script body; composed with the workflow SDK prelude. */
	body: string;
}

export interface WrittenWorkflowPack {
	manifest: EvoPackManifest;
	integrity: string;
}

/**
 * Write a complete, importable single-workflow optimization pack into
 * `directory`: the composed workflow artifact plus an integrity-signed
 * pack.json. The staging component store is temporary and removed.
 */
export async function writeWorkflowPack(
	directory: string,
	template: WorkflowPackTemplate,
): Promise<WrittenWorkflowPack> {
	const staging = await mkdtemp(join(tmpdir(), `pi-evo-${template.id}-pack-`));
	try {
		const artifact = await publishEvoComponentArtifact(getEvoPaths(join(staging, "evo")), {
			id: template.id,
			version: template.version,
			abi: "workflow/v1",
			activationBoundary: "invocation",
			capabilities: ["spawn-agent"],
			entrypointContent: await composeWorkflowEntrypoint(template.body),
		});
		const artifactDirectory = join(directory, "workflows", template.id);
		await mkdir(artifactDirectory, { recursive: true });
		await writeFile(
			join(artifactDirectory, "manifest.json"),
			await readFile(join(artifact.directory, "manifest.json")),
		);
		await writeFile(join(artifactDirectory, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
		const unsigned = parseEvoPackManifest({
			packFormat: 1,
			name: template.id,
			version: template.version,
			description: template.description,
			contents: {
				workflows: [
					{
						id: template.id,
						trigger: template.trigger,
						abi: "workflow/v1",
						artifact: `workflows/${template.id}`,
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
