import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type EvoPaths, ensureEvoLayout } from "../paths.ts";
import { canonicalJson, sha256 } from "../storage.ts";
import type { BundleFileEntry, BundleManifest, BundlePolicy, CompiledBundle } from "../types.ts";
import { assertAssetPath, isDigest, parseBundleManifest, parseBundlePolicy } from "./schema.ts";

const DEFAULT_PROMPT_BYTES = 64 * 1024;
const DEFAULT_SKILL_BYTES = 15 * 1024;
const DEFAULT_TOTAL_BYTES = 1024 * 1024;

function normalizeRelativePath(path: string): string {
	return path.split(sep).join("/");
}

async function listSourceFiles(sourceDirectory: string, currentDirectory = sourceDirectory): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
		const absolutePath = join(currentDirectory, entry.name);
		const pathStat = await lstat(absolutePath);
		if (pathStat.isSymbolicLink()) throw new Error(`Bundle cannot contain symbolic links: ${entry.name}`);
		if (entry.isDirectory()) {
			result.push(...(await listSourceFiles(sourceDirectory, absolutePath)));
			continue;
		}
		if (!entry.isFile()) throw new Error(`Bundle contains a non-regular file: ${entry.name}`);
		if ((pathStat.mode & 0o111) !== 0) throw new Error(`Bundle cannot contain executable files: ${entry.name}`);
		result.push(normalizeRelativePath(relative(sourceDirectory, absolutePath)));
	}
	return result.sort();
}

function sortManifestFiles(files: BundleFileEntry[]): BundleFileEntry[] {
	return [...files].sort((left, right) => {
		if (left.path === "policy.json") return -1;
		if (right.path === "policy.json") return 1;
		return left.path.localeCompare(right.path);
	});
}

function validatePolicyAssetReferences(policy: BundlePolicy, paths: Set<string>): void {
	for (const path of policy.promptOrder ?? []) {
		if (!path.startsWith("prompts/") || !paths.has(path))
			throw new Error(`policy.promptOrder references missing prompt: ${path}`);
	}
	for (const path of [...(policy.stablePromptPaths ?? []), ...(policy.dynamicPromptPaths ?? [])]) {
		if (!path.startsWith("prompts/") || !paths.has(path))
			throw new Error(`Prompt layout references missing prompt: ${path}`);
	}
	for (const path of policy.coreAssets ?? []) {
		if (!paths.has(path)) throw new Error(`policy.coreAssets references missing asset: ${path}`);
	}
}

function validateSizes(files: BundleFileEntry[], policy: BundlePolicy): void {
	const promptLimit = Math.min(policy.limits?.promptBytes ?? DEFAULT_PROMPT_BYTES, DEFAULT_PROMPT_BYTES);
	const skillLimit = Math.min(policy.limits?.skillBytes ?? DEFAULT_SKILL_BYTES, DEFAULT_SKILL_BYTES);
	const totalLimit = Math.min(policy.limits?.totalBytes ?? DEFAULT_TOTAL_BYTES, DEFAULT_TOTAL_BYTES);
	const promptBytes = files
		.filter((file) => file.path.startsWith("prompts/"))
		.reduce((total, file) => total + file.bytes, 0);
	if (promptBytes > promptLimit) throw new Error(`Prompt bytes ${promptBytes} exceed limit ${promptLimit}`);
	for (const file of files.filter((entry) => entry.path.startsWith("skills/"))) {
		if (file.bytes > skillLimit) throw new Error(`${file.path} exceeds skill byte limit ${skillLimit}`);
	}
	const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
	if (totalBytes > totalLimit) throw new Error(`Bundle bytes ${totalBytes} exceed limit ${totalLimit}`);
}

async function writeBundleDirectory(
	sourceDirectory: string,
	temporaryDirectory: string,
	manifest: BundleManifest,
): Promise<void> {
	await mkdir(temporaryDirectory, { recursive: false });
	for (const file of manifest.files) {
		const target = join(temporaryDirectory, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, await readFile(join(sourceDirectory, file.path)), { mode: 0o444 });
		await chmod(target, 0o444);
	}
	const manifestPath = join(temporaryDirectory, "bundle.json");
	await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, "\t")}\n`, { mode: 0o444 });
	await chmod(manifestPath, 0o444);
}

export async function loadCompiledBundle(paths: EvoPaths, digest: string): Promise<CompiledBundle> {
	if (!isDigest(digest)) throw new Error(`Invalid bundle digest: ${digest}`);
	const directory = join(paths.bundles, digest);
	const manifest = parseBundleManifest(JSON.parse(await readFile(join(directory, "bundle.json"), "utf8")));
	if (sha256(canonicalJson(manifest)) !== digest) throw new Error(`Bundle manifest digest mismatch: ${digest}`);
	const actualPaths = (await listSourceFiles(directory)).filter((path) => path !== "bundle.json");
	if (
		actualPaths.join("\n") !==
		manifest.files
			.map((file) => file.path)
			.sort()
			.join("\n")
	) {
		throw new Error(`Bundle file set does not match manifest: ${digest}`);
	}
	for (const file of manifest.files) {
		const content = await readFile(join(directory, file.path));
		if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
			throw new Error(`Bundle file digest mismatch: ${file.path}`);
		}
	}
	const policy = parseBundlePolicy(JSON.parse(await readFile(join(directory, "policy.json"), "utf8")));
	validatePolicyAssetReferences(policy, new Set(actualPaths));
	validateSizes(manifest.files, policy);
	return { digest, directory, manifest, policy };
}

export async function compileBundle(options: {
	paths: EvoPaths;
	sourceDirectory: string;
	parentDigest: string | null;
	summary: string;
}): Promise<CompiledBundle> {
	await ensureEvoLayout(options.paths);
	if (options.parentDigest !== null && !isDigest(options.parentDigest))
		throw new Error("parentDigest must be a digest");
	if (options.summary.length === 0 || options.summary.length > 240)
		throw new Error("summary must contain 1-240 characters");
	const sourceDirectory = resolve(options.sourceDirectory);
	const sourcePaths = await listSourceFiles(sourceDirectory);
	for (const path of sourcePaths) assertAssetPath(path);
	const dataPaths = sourcePaths.filter((path) => path !== "bundle.json");
	if (!dataPaths.includes("policy.json")) throw new Error("Bundle must contain policy.json");
	const files = sortManifestFiles(
		await Promise.all(
			dataPaths.map(async (path) => {
				const content = await readFile(join(sourceDirectory, path));
				return { path, sha256: sha256(content), bytes: content.byteLength };
			}),
		),
	);
	const policy = parseBundlePolicy(JSON.parse(await readFile(join(sourceDirectory, "policy.json"), "utf8")));
	validatePolicyAssetReferences(policy, new Set(dataPaths));
	validateSizes(files, policy);
	const manifest: BundleManifest = {
		schemaVersion: 1,
		parentDigest: options.parentDigest,
		summary: options.summary,
		files,
	};
	const digest = sha256(canonicalJson(manifest));
	const destination = join(options.paths.bundles, digest);
	try {
		return await loadCompiledBundle(options.paths, digest);
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const temporaryDirectory = join(options.paths.bundles, `.tmp-${process.pid}-${randomUUID()}`);
	try {
		await writeBundleDirectory(sourceDirectory, temporaryDirectory, manifest);
		try {
			await rename(temporaryDirectory, destination);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				(error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
			) {
				throw error;
			}
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
		return await loadCompiledBundle(options.paths, digest);
	} catch (error) {
		await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

export async function materializeBundle(paths: EvoPaths, digest: string, targetDirectory: string): Promise<void> {
	const bundle = await loadCompiledBundle(paths, digest);
	await mkdir(targetDirectory, { recursive: true });
	for (const file of bundle.manifest.files) {
		const target = join(targetDirectory, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, await readFile(join(bundle.directory, file.path)), { mode: 0o600, flag: "wx" });
	}
}
