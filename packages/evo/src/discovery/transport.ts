import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { parseEvoComponentManifest } from "../components/manifest.ts";
import { type EvoPackManifest, parseEvoPackManifest } from "../pack/pack.ts";
import { canonicalJson } from "../storage.ts";
import { EVO_DISCOVERY_PACK_MANIFEST_MAX_BYTES, EVO_PACK_REGISTRY_MAX_BYTES } from "./client.ts";
import { type EvoRawFileSource, parseEvoRawFileSource } from "./registry.ts";

export const EVO_DISCOVERY_DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const EVO_DISCOVERY_DEFAULT_MAX_PACK_BYTES = 64 * 1024 * 1024;
export const EVO_DISCOVERY_DEFAULT_MAX_PACK_FILES = 1_000;
export const EVO_DISCOVERY_DEFAULT_TIMEOUT_MS = 30_000;

export type EvoDiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface EvoPackDiscoveryTransportOptions {
	fetch: EvoDiscoveryFetch;
	maxFileBytes?: number;
	maxPackBytes?: number;
	maxPackFiles?: number;
	timeoutMs?: number;
}

export interface EvoMaterializedPack {
	directory: string;
	manifest: EvoPackManifest;
	fileCount: number;
	totalBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new Error(`discovery ${label} must be a positive safe integer`);
	}
	return resolved;
}

function canonicalRelativePath(value: string, label: string): string {
	if (
		!value ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`${label} must be a canonical relative POSIX path`);
	}
	return value;
}

function encodePath(value: string): string {
	return value
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function githubRepositoryIdentity(repository: string): { owner: string; name: string } {
	const url = new URL(repository);
	if (url.origin !== "https://github.com") {
		throw new Error(`unsupported immutable git repository host: ${url.hostname}`);
	}
	const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname);
	if (!match) throw new Error("immutable git repository must identify one GitHub repository");
	return { owner: match[1], name: match[2] };
}

function gitlabRepositoryIdentity(repository: string): string {
	const url = new URL(repository);
	if (url.origin !== "https://gitlab.com") {
		throw new Error(`unsupported immutable git repository host: ${url.hostname}`);
	}
	const segments = url.pathname.slice(1).split("/");
	if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))) {
		throw new Error("immutable git repository must identify one GitLab repository");
	}
	const last = segments.at(-1);
	if (!last) throw new Error("immutable git repository must identify one GitLab repository");
	segments[segments.length - 1] = last.endsWith(".git") ? last.slice(0, -4) : last;
	if (!segments.at(-1)) throw new Error("immutable git repository must identify one GitLab repository");
	return segments.join("/");
}

/**
 * Verify that an immutable locator's retrieval URL is derived from its stated
 * repository/gist revision. Unknown git hosting conventions fail closed.
 */
export function assertEvoRawFileSourceProvenance(value: unknown): EvoRawFileSource {
	const source = parseEvoRawFileSource(value);
	if (source.kind === "https") return source;
	if (source.kind === "gist") {
		const url = new URL(source.rawUrl);
		const match = /^\/([A-Za-z0-9_.-]+)\/([0-9a-f]+)\/raw\/([0-9a-f]+)\/(.+)$/.exec(url.pathname);
		if (
			url.origin !== "https://gist.githubusercontent.com" ||
			!match ||
			match[2] !== source.gistId ||
			match[3] !== source.revision ||
			match[4] !== encodePath(canonicalRelativePath(source.file, "gist source file"))
		) {
			throw new Error("gist rawUrl does not match its immutable gistId, revision, and file provenance");
		}
		return source;
	}

	const path = encodePath(canonicalRelativePath(source.path, "git source path"));
	const repository = new URL(source.repository);
	let expected: string;
	if (repository.origin === "https://github.com") {
		const identity = githubRepositoryIdentity(source.repository);
		expected = `https://raw.githubusercontent.com/${identity.owner}/${identity.name}/${source.revision}/${path}`;
	} else if (repository.origin === "https://gitlab.com") {
		const identity = gitlabRepositoryIdentity(source.repository);
		expected = `https://gitlab.com/${identity}/-/raw/${source.revision}/${path}`;
	} else {
		throw new Error(`unsupported immutable git repository host: ${repository.hostname}`);
	}
	if (source.rawUrl !== expected) {
		throw new Error("git rawUrl does not match its immutable repository, revision, and path provenance");
	}
	return source;
}

function resolvePackFileSource(sourceValue: EvoRawFileSource, relativePath: string): EvoRawFileSource {
	const source = assertEvoRawFileSourceProvenance(sourceValue);
	const relative = canonicalRelativePath(relativePath, "pack file path");
	const rawUrl = new URL(encodePath(relative), source.rawUrl).href;
	if (new URL(rawUrl).origin !== new URL(source.rawUrl).origin) {
		throw new Error(`pack file escaped its source origin: ${relative}`);
	}
	if (source.kind === "https") return { kind: "https", rawUrl };
	if (source.kind === "git") {
		return assertEvoRawFileSourceProvenance({
			...source,
			path: posix.join(posix.dirname(source.path), relative),
			rawUrl,
		});
	}
	return assertEvoRawFileSourceProvenance({
		...source,
		file: posix.join(posix.dirname(source.file), relative),
		rawUrl,
	});
}

function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return [...left].sort().join("\n") === [...right].sort().join("\n");
}

async function boundedResponseBody(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
			throw new Error(`${label} returned an invalid content-length`);
		}
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared > maximumBytes) {
			throw new Error(`${label} exceeds ${maximumBytes} bytes`);
		}
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel();
			throw new Error(`${label} exceeds ${maximumBytes} bytes`);
		}
		chunks.push(Buffer.from(next.value));
	}
	return Buffer.concat(chunks, bytes);
}

/** Bounded, redirect-free raw-file retrieval over an explicitly injected fetch implementation. */
export class EvoPackDiscoveryTransport {
	private readonly fetchImpl: EvoDiscoveryFetch;
	private readonly maxFileBytes: number;
	private readonly maxPackBytes: number;
	private readonly maxPackFiles: number;
	private readonly timeoutMs: number;

	constructor(options: EvoPackDiscoveryTransportOptions) {
		if (typeof options.fetch !== "function") throw new Error("discovery fetch must be a function");
		this.fetchImpl = options.fetch;
		this.maxFileBytes = positiveInteger(options.maxFileBytes, EVO_DISCOVERY_DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
		this.maxPackBytes = positiveInteger(options.maxPackBytes, EVO_DISCOVERY_DEFAULT_MAX_PACK_BYTES, "maxPackBytes");
		this.maxPackFiles = positiveInteger(options.maxPackFiles, EVO_DISCOVERY_DEFAULT_MAX_PACK_FILES, "maxPackFiles");
		this.timeoutMs = positiveInteger(options.timeoutMs, EVO_DISCOVERY_DEFAULT_TIMEOUT_MS, "timeoutMs");
	}

	private async readBytes(
		sourceValue: EvoRawFileSource,
		maximumBytes: number,
		label: string,
		signal?: AbortSignal,
	): Promise<Buffer> {
		const source = assertEvoRawFileSourceProvenance(sourceValue);
		signal?.throwIfAborted();
		const controller = new AbortController();
		const abort = (): void => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), this.timeoutMs);
		timer.unref();
		try {
			const response = await this.fetchImpl(source.rawUrl, {
				method: "GET",
				redirect: "error",
				signal: controller.signal,
				headers: {
					accept: "application/json, text/plain;q=0.9, application/octet-stream;q=0.8",
					"user-agent": "Evo-Pi pack discovery",
				},
			});
			if (response.url && response.url !== source.rawUrl) {
				throw new Error(`${label} redirected away from its verified source URL`);
			}
			if (response.status !== 200) throw new Error(`${label} returned HTTP ${response.status}`);
			return await boundedResponseBody(response, maximumBytes, label);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	async readRegistryIndex(source: EvoRawFileSource, signal?: AbortSignal): Promise<string> {
		return (
			await this.readBytes(
				source,
				Math.min(this.maxFileBytes, EVO_PACK_REGISTRY_MAX_BYTES),
				`pack registry ${source.rawUrl}`,
				signal,
			)
		).toString("utf8");
	}

	async fetchPackManifest(source: EvoRawFileSource, signal?: AbortSignal): Promise<string> {
		return (
			await this.readBytes(
				source,
				Math.min(this.maxFileBytes, EVO_DISCOVERY_PACK_MANIFEST_MAX_BYTES),
				`pack manifest ${source.rawUrl}`,
				signal,
			)
		).toString("utf8");
	}

	/**
	 * Materialize the exact v1 pack file set needed by the existing importer.
	 * The destination must not exist and is removed on every failure.
	 */
	async materializePack(options: {
		source: EvoRawFileSource;
		expectedManifest: EvoPackManifest;
		destination: string;
		signal?: AbortSignal;
	}): Promise<EvoMaterializedPack> {
		const source = assertEvoRawFileSourceProvenance(options.source);
		const expectedManifest = parseEvoPackManifest(options.expectedManifest);
		if (!expectedManifest.integrity) throw new Error("remote pack manifest must declare integrity");
		let totalBytes = 0;
		let fileCount = 0;
		const written = new Set<string>();

		const fetchFile = async (
			relativePath: string,
			label: string,
			maximumBytes = this.maxFileBytes,
		): Promise<Buffer> => {
			const relative = canonicalRelativePath(relativePath, label);
			if (written.has(relative)) throw new Error(`remote pack has overlapping file reference: ${relative}`);
			if (fileCount >= this.maxPackFiles) {
				throw new Error(`remote pack exceeds ${this.maxPackFiles} files`);
			}
			const remaining = this.maxPackBytes - totalBytes;
			if (remaining < 0) throw new Error(`remote pack exceeds ${this.maxPackBytes} bytes`);
			const bytes = await this.readBytes(
				relative === "pack.json" ? source : resolvePackFileSource(source, relative),
				Math.min(maximumBytes, remaining),
				label,
				options.signal,
			);
			totalBytes += bytes.byteLength;
			fileCount += 1;
			written.add(relative);
			await mkdir(dirname(join(options.destination, relative)), { recursive: true, mode: 0o700 });
			await writeFile(join(options.destination, relative), bytes, { flag: "wx", mode: 0o600 });
			return bytes;
		};

		await mkdir(options.destination, { mode: 0o700 });
		try {
			const manifestBytes = await fetchFile(
				"pack.json",
				`pack manifest ${source.rawUrl}`,
				Math.min(this.maxFileBytes, EVO_DISCOVERY_PACK_MANIFEST_MAX_BYTES),
			);
			const fetchedManifest = parseEvoPackManifest(
				parseJson(manifestBytes.toString("utf8"), `pack manifest ${source.rawUrl}`),
			);
			if (canonicalJson(fetchedManifest) !== canonicalJson(expectedManifest)) {
				throw new Error("pack manifest changed after registry preflight");
			}

			for (const prompt of fetchedManifest.contents.prompts) {
				await fetchFile(prompt.file, `pack prompt ${prompt.file}`);
			}
			for (const skill of fetchedManifest.contents.skills) {
				await fetchFile(`${skill.dir}/SKILL.md`, `pack skill ${skill.name}`);
			}
			for (const memory of fetchedManifest.contents.memory) {
				await fetchFile(memory.file, `pack memory ${memory.file}`);
			}

			const codeParts = [
				...fetchedManifest.contents.components.map((part) => ({ part, kind: "component" as const })),
				...fetchedManifest.contents.workflows.map((part) => ({ part, kind: "workflow" as const })),
			];
			for (const codePart of codeParts) {
				const manifestPath = `${codePart.part.artifact}/manifest.json`;
				const artifactManifestBytes = await fetchFile(
					manifestPath,
					`pack ${codePart.kind} manifest ${codePart.part.id}`,
					EVO_DISCOVERY_PACK_MANIFEST_MAX_BYTES,
				);
				const artifactManifest = parseEvoComponentManifest(
					parseJson(artifactManifestBytes.toString("utf8"), `component manifest ${codePart.part.id}`),
				);
				if (
					artifactManifest.id !== codePart.part.id ||
					artifactManifest.abi !== codePart.part.abi ||
					!sameStringSet(artifactManifest.capabilities, codePart.part.capabilities)
				) {
					throw new Error(
						`pack ${codePart.kind} declaration does not match artifact manifest: ${codePart.part.id}`,
					);
				}
				await fetchFile(
					`${codePart.part.artifact}/${artifactManifest.entrypoint}`,
					`pack ${codePart.kind} entrypoint ${codePart.part.id}`,
				);
			}

			return {
				directory: options.destination,
				manifest: fetchedManifest,
				fileCount,
				totalBytes,
			};
		} catch (error) {
			await rm(options.destination, { recursive: true, force: true });
			throw error;
		}
	}
}
