import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { type LoadedEvoComponentArtifact, validateEvoComponentSelection } from "../components/artifact.ts";
import { createDefaultEvoAbiRegistry, type EvoAbiRegistry } from "../components/registry.ts";
import { PREFERENCES_PATH } from "../memory/preferences.ts";
import type { EvoPaths } from "../paths.ts";
import type { EvoComponentSelection } from "../types.ts";
import {
	computeEvoPackIntegrity,
	type EvoPackComponent,
	type EvoPackManifest,
	type EvoPackMemory,
	type EvoPackPrompt,
	type EvoPackSkill,
	type EvoPackWorkflow,
	parseEvoPackManifest,
} from "./pack.ts";

async function copyFile(source: string, destination: string): Promise<void> {
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	await writeFile(destination, await readFile(source), { mode: 0o600, flag: "wx" });
}

async function copySelectedArtifact(options: {
	paths: EvoPaths;
	registry: EvoAbiRegistry;
	surface: string;
	selection: EvoComponentSelection;
	targetDirectory: string;
	relativeDirectory: string;
}): Promise<LoadedEvoComponentArtifact> {
	const artifact = await validateEvoComponentSelection(
		options.paths,
		options.surface,
		options.selection,
		options.registry,
	);
	await copyFile(
		join(artifact.directory, "manifest.json"),
		join(options.targetDirectory, options.relativeDirectory, "manifest.json"),
	);
	await copyFile(
		artifact.entrypoint,
		join(options.targetDirectory, options.relativeDirectory, artifact.manifest.entrypoint),
	);
	return artifact;
}

export interface ExportEvoPackOptions {
	paths: EvoPaths;
	bundleDigest: string;
	targetDirectory: string;
	name: string;
	version: string;
	author?: string;
	description?: string;
}

/**
 * Export bundle-owned data and selected registered components as pack.json v1.
 * The destination must not already exist; failures remove the incomplete tree.
 */
export async function exportEvoPack(options: ExportEvoPackOptions): Promise<EvoPackManifest> {
	const bundle = await loadCompiledBundle(options.paths, options.bundleDigest);
	await mkdir(options.targetDirectory, { mode: 0o700 });
	try {
		const prompts: EvoPackPrompt[] = [];
		const skills: EvoPackSkill[] = [];
		const memory: EvoPackMemory[] = [];
		const components: EvoPackComponent[] = [];
		const workflows: EvoPackWorkflow[] = [];
		for (const file of bundle.manifest.files) {
			if (file.path.startsWith("prompts/")) {
				await copyFile(join(bundle.directory, file.path), join(options.targetDirectory, file.path));
				prompts.push({
					target: file.path === "prompts/system.md" ? "system" : "append-system",
					file: file.path,
				});
				continue;
			}
			if (file.path.startsWith("skills/")) {
				await copyFile(join(bundle.directory, file.path), join(options.targetDirectory, file.path));
				skills.push({ name: file.path.split("/")[1], dir: dirname(file.path) });
				continue;
			}
			if (file.path === PREFERENCES_PATH) {
				const destination = `memory/${basename(file.path)}`;
				await copyFile(join(bundle.directory, file.path), join(options.targetDirectory, destination));
				memory.push({ file: destination });
			}
		}
		const registry = createDefaultEvoAbiRegistry();
		for (const [surface, selection] of Object.entries(bundle.policy.components ?? {})) {
			const relativeDirectory = `components/${selection.id}`;
			const artifact = await copySelectedArtifact({
				paths: options.paths,
				registry,
				surface,
				selection,
				targetDirectory: options.targetDirectory,
				relativeDirectory,
			});
			components.push({
				surface,
				abi: artifact.manifest.abi,
				id: artifact.manifest.id,
				artifact: relativeDirectory,
				capabilities: artifact.manifest.capabilities,
			});
		}
		for (const selection of bundle.policy.tools ?? []) {
			const relativeDirectory = `components/${selection.id}`;
			const artifact = await copySelectedArtifact({
				paths: options.paths,
				registry,
				surface: "tool",
				selection,
				targetDirectory: options.targetDirectory,
				relativeDirectory,
			});
			components.push({
				surface: "tool",
				abi: artifact.manifest.abi,
				id: artifact.manifest.id,
				artifact: relativeDirectory,
				capabilities: artifact.manifest.capabilities,
			});
		}
		for (const selection of bundle.policy.workflows ?? []) {
			const relativeDirectory = `workflows/${selection.id}`;
			const artifact = await copySelectedArtifact({
				paths: options.paths,
				registry,
				surface: "workflow",
				selection,
				targetDirectory: options.targetDirectory,
				relativeDirectory,
			});
			workflows.push({
				id: artifact.manifest.id,
				trigger: selection.trigger,
				abi: artifact.manifest.abi,
				artifact: relativeDirectory,
				capabilities: artifact.manifest.capabilities,
			});
		}
		const codeParts = [...components, ...workflows];
		const unsigned = parseEvoPackManifest({
			packFormat: 1,
			name: options.name,
			version: options.version,
			...(options.author === undefined ? {} : { author: options.author }),
			...(options.description === undefined ? {} : { description: options.description }),
			contents: { prompts, skills, memory, components, workflows },
			requiresAbis: [...new Set(codeParts.map((component) => component.abi))],
			requiresCapabilities: [...new Set(codeParts.flatMap((component) => component.capabilities))],
		});
		const integrity = await computeEvoPackIntegrity(options.targetDirectory, unsigned);
		const manifest = parseEvoPackManifest({ ...unsigned, integrity });
		await writeFile(join(options.targetDirectory, "pack.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		return manifest;
	} catch (error) {
		await rm(options.targetDirectory, { recursive: true, force: true });
		throw error;
	}
}
