import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDigest } from "../bundle/schema.ts";
import type { EvoPaths } from "../paths.ts";
import { ensureEvoLayout } from "../paths.ts";
import { canonicalJson, sha256 } from "../storage.ts";
import type { EvoComponentManifest, EvoComponentSelection } from "../types.ts";
import { parseEvoComponentManifest } from "./manifest.ts";
import type { EvoAbiRegistry } from "./registry.ts";

export interface LoadedEvoComponentArtifact {
	directory: string;
	entrypoint: string;
	manifest: EvoComponentManifest;
}

export interface PublishEvoComponentArtifactInput {
	id: string;
	version: string;
	abi: string;
	activationBoundary: EvoComponentManifest["activationBoundary"];
	capabilities: string[];
	entrypointName?: string;
	entrypointContent: string | Uint8Array;
}

function identityDigest(manifest: Omit<EvoComponentManifest, "artifactDigest">): string {
	return sha256(canonicalJson({ componentArtifactSchemaVersion: 1, manifest }));
}

async function writeExclusive(path: string, content: string | Uint8Array, mode: number): Promise<void> {
	const handle = await open(path, "wx", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function componentArtifactDirectory(paths: EvoPaths, digest: string): string {
	if (!isDigest(digest)) throw new Error(`Invalid component artifact digest: ${digest}`);
	return join(paths.components, digest);
}

export async function publishEvoComponentArtifact(
	paths: EvoPaths,
	input: PublishEvoComponentArtifactInput,
): Promise<LoadedEvoComponentArtifact> {
	await ensureEvoLayout(paths);
	const entrypoint = input.entrypointName ?? "component.mjs";
	const entrypointBytes = Buffer.from(input.entrypointContent);
	const unsigned = parseEvoComponentManifest({
		schemaVersion: 1,
		id: input.id,
		version: input.version,
		artifactDigest: "0".repeat(64),
		entrypointSha256: sha256(entrypointBytes),
		abi: input.abi,
		activationBoundary: input.activationBoundary,
		capabilities: input.capabilities,
		entrypoint,
	});
	const { artifactDigest: _, ...identity } = unsigned;
	const digest = identityDigest(identity);
	const manifest: EvoComponentManifest = { ...identity, artifactDigest: digest };
	const destination = componentArtifactDirectory(paths, digest);
	try {
		return await loadEvoComponentArtifact(paths, digest);
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const temporary = join(paths.components, `.tmp-${process.pid}-${digest.slice(0, 12)}`);
	await rm(temporary, { recursive: true, force: true });
	await mkdir(temporary, { mode: 0o700 });
	try {
		await writeExclusive(join(temporary, entrypoint), entrypointBytes, 0o400);
		await writeExclusive(join(temporary, "manifest.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`, 0o400);
		try {
			await rename(temporary, destination);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				(error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
			) {
				throw error;
			}
		}
		return await loadEvoComponentArtifact(paths, digest);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

export async function loadEvoComponentArtifact(
	paths: EvoPaths,
	digest: string,
	registry?: EvoAbiRegistry,
): Promise<LoadedEvoComponentArtifact> {
	const directory = componentArtifactDirectory(paths, digest);
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Component artifact is not a directory");
	const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
	if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
		throw new Error("Component artifact contains a non-regular file");
	}
	const manifest = parseEvoComponentManifest(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
	if (manifest.artifactDigest !== digest)
		throw new Error("Component manifest artifact digest does not match its path");
	const expectedFiles = [manifest.entrypoint, "manifest.json"].sort();
	if (entries.map((entry) => entry.name).join("\n") !== expectedFiles.join("\n")) {
		throw new Error("Component artifact file set is invalid");
	}
	const entrypoint = join(directory, manifest.entrypoint);
	const entrypointMetadata = await lstat(entrypoint);
	if (!entrypointMetadata.isFile() || entrypointMetadata.isSymbolicLink()) {
		throw new Error("Component entrypoint is not a regular file");
	}
	if (sha256(await readFile(entrypoint)) !== manifest.entrypointSha256) {
		throw new Error("Component entrypoint digest mismatch");
	}
	const { artifactDigest: _, ...identity } = manifest;
	if (identityDigest(identity) !== digest) throw new Error("Component artifact identity digest mismatch");
	if (registry) {
		const abi = registry.require(manifest.abi);
		if (abi.activationBoundary !== manifest.activationBoundary) {
			throw new Error(`Component activation boundary does not match ABI ${manifest.abi}`);
		}
		const ceiling = new Set(abi.capabilityCeiling);
		for (const capability of manifest.capabilities) {
			if (!ceiling.has(capability)) throw new Error(`Component capability exceeds ABI ceiling: ${capability}`);
		}
	}
	return { directory, entrypoint, manifest };
}

export async function validateEvoComponentSelection(
	paths: EvoPaths,
	surface: string,
	selection: EvoComponentSelection,
	registry: EvoAbiRegistry,
): Promise<LoadedEvoComponentArtifact> {
	registry.validateSelection(surface, selection);
	const artifact = await loadEvoComponentArtifact(paths, selection.artifactDigest, registry);
	if (artifact.manifest.id !== selection.id)
		throw new Error(`Component selection id does not match artifact: ${surface}`);
	if (artifact.manifest.abi !== selection.abi)
		throw new Error(`Component selection ABI does not match artifact: ${surface}`);
	return artifact;
}
