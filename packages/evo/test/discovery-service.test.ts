import { generateKeyPairSync, type KeyObject, sign as signPayload } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileBundle, loadCompiledBundle } from "../src/bundle/compile.ts";
import {
	canonicalEvoPackRegistryEntryMetadata,
	type EvoPackRegistryEntry,
	type EvoRawFileSource,
} from "../src/discovery/registry.ts";
import { EvoPackRegistryService } from "../src/discovery/service.ts";
import { type EvoDiscoveryFetch, EvoPackDiscoveryTransport } from "../src/discovery/transport.ts";
import { computeEvoPackIntegrity, loadEvoPack, parseEvoPackManifest } from "../src/pack/pack.ts";
import { ensureEvoLayout, getEvoPaths } from "../src/paths.ts";
import { EvoService } from "../src/service.ts";
import { sha256 } from "../src/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

async function seedBundle(root: string) {
	const paths = getEvoPaths(join(root, "evo"));
	await ensureEvoLayout(paths);
	const source = join(root, "seed");
	await mkdir(source);
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({
		paths,
		sourceDirectory: source,
		parentDigest: null,
		summary: "registry install seed",
	});
	return { paths, bundle };
}

async function promptPack(directory: string) {
	await mkdir(join(directory, "prompts"), { recursive: true });
	await writeFile(join(directory, "prompts", "review.md"), "Review the smallest coherent diff.\n");
	const unsigned = parseEvoPackManifest({
		packFormat: 1,
		name: "focused-review",
		version: "1.0.0",
		author: "alice",
		description: "Focused review prompt",
		contents: {
			prompts: [{ target: "append-system", file: "prompts/review.md" }],
		},
		requiresAbis: [],
		requiresCapabilities: [],
	});
	const manifest = parseEvoPackManifest({
		...unsigned,
		integrity: await computeEvoPackIntegrity(directory, unsigned),
	});
	const manifestText = `${JSON.stringify(manifest, undefined, "\t")}\n`;
	await writeFile(join(directory, "pack.json"), manifestText);
	return { manifest, manifestText, promptText: await readFile(join(directory, "prompts", "review.md"), "utf8") };
}

function signEntry(entry: EvoPackRegistryEntry, signer: string, privateKey: KeyObject): EvoPackRegistryEntry {
	const signature = signPayload(
		null,
		Buffer.from(canonicalEvoPackRegistryEntryMetadata(entry, { algorithm: "ed25519", signer }), "utf8"),
		privateKey,
	);
	return {
		...entry,
		signature: {
			algorithm: "ed25519",
			signer,
			value: `base64:${signature.toString("base64")}`,
		},
	};
}

function publicKeyPem(publicKey: KeyObject): string {
	return publicKey.export({ format: "pem", type: "spki" }).toString();
}

function mappedFetch(files: ReadonlyMap<string, string>): ReturnType<typeof vi.fn<EvoDiscoveryFetch>> {
	return vi.fn<EvoDiscoveryFetch>(async (url, init) => {
		if (init.redirect !== "error") throw new Error("transport did not disable redirects");
		const body = files.get(url);
		if (body === undefined) return new Response("not found", { status: 404 });
		return new Response(body, {
			status: 200,
			headers: { "content-length": String(Buffer.byteLength(body)) },
		});
	});
}

describe("pack discovery transport", () => {
	it("materializes HTTPS data and code files with a bounded exact file set", async () => {
		const sourceDirectory = await temporary("evo-discovery-source-");
		const destinationRoot = await temporary("evo-discovery-destination-");
		await mkdir(join(sourceDirectory, "components", "view"), { recursive: true });
		const entrypoint = "export default function view() { return {}; }\n";
		const componentManifest = {
			schemaVersion: 1,
			id: "view",
			version: "1.0.0",
			artifactDigest: "a".repeat(64),
			entrypointSha256: sha256(entrypoint),
			abi: "context/v1",
			activationBoundary: "session",
			capabilities: [],
			entrypoint: "component.mjs",
		};
		await writeFile(
			join(sourceDirectory, "components", "view", "manifest.json"),
			`${JSON.stringify(componentManifest)}\n`,
		);
		await writeFile(join(sourceDirectory, "components", "view", "component.mjs"), entrypoint);
		const unsigned = parseEvoPackManifest({
			packFormat: 1,
			name: "view-pack",
			version: "1.0.0",
			contents: {
				components: [
					{
						surface: "context",
						abi: "context/v1",
						id: "view",
						artifact: "components/view",
						capabilities: [],
					},
				],
			},
			requiresAbis: ["context/v1"],
			requiresCapabilities: [],
		});
		const manifest = parseEvoPackManifest({
			...unsigned,
			integrity: await computeEvoPackIntegrity(sourceDirectory, unsigned),
		});
		const source: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://packs.example/view/pack.json",
		};
		const files = new Map<string, string>([
			[source.rawUrl, JSON.stringify(manifest)],
			["https://packs.example/view/components/view/manifest.json", `${JSON.stringify(componentManifest)}\n`],
			["https://packs.example/view/components/view/component.mjs", entrypoint],
		]);
		const fetchImpl = mappedFetch(files);
		const transport = new EvoPackDiscoveryTransport({ fetch: fetchImpl, maxPackFiles: 3 });

		const result = await transport.materializePack({
			source,
			expectedManifest: manifest,
			destination: join(destinationRoot, "pack"),
		});

		expect(result.fileCount).toBe(3);
		expect((await loadEvoPack(result.directory)).integrity.ok).toBe(true);
		expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([...files.keys()]);
		await expect(
			new EvoPackDiscoveryTransport({ fetch: fetchImpl, maxPackFiles: 2 }).materializePack({
				source,
				expectedManifest: manifest,
				destination: join(destinationRoot, "too-many-files"),
			}),
		).rejects.toThrow("exceeds 2 files");
		expect(await readdir(destinationRoot)).toEqual(["pack"]);
	});

	it("rejects byte-limit excess and immutable provenance mismatches before use", async () => {
		const fetchImpl = mappedFetch(new Map([["https://registry.example/index.json", "12345"]]));
		const transport = new EvoPackDiscoveryTransport({ fetch: fetchImpl, maxFileBytes: 4 });
		await expect(
			transport.readRegistryIndex({ kind: "https", rawUrl: "https://registry.example/index.json" }),
		).rejects.toThrow("exceeds 4 bytes");

		fetchImpl.mockClear();
		await expect(
			transport.readRegistryIndex({
				kind: "git",
				repository: "https://github.com/example/registry.git",
				revision: "a".repeat(40),
				path: "registry.json",
				rawUrl: `https://raw.githubusercontent.com/example/registry/${"b".repeat(40)}/registry.json`,
			}),
		).rejects.toThrow("does not match its immutable repository");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("enforces streamed byte limits, redirect identity, and request timeouts", async () => {
		const source: EvoRawFileSource = { kind: "https", rawUrl: "https://registry.example/index.json" };
		const streamedFetch = vi.fn<EvoDiscoveryFetch>(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("12345"));
					controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-length": "4" } });
		});
		await expect(
			new EvoPackDiscoveryTransport({ fetch: streamedFetch, maxFileBytes: 4 }).readRegistryIndex(source),
		).rejects.toThrow("exceeds 4 bytes");

		const redirectedFetch = vi.fn<EvoDiscoveryFetch>(async () => {
			const response = new Response("{}", { status: 200 });
			Object.defineProperty(response, "url", { value: "https://redirect.example/index.json" });
			return response;
		});
		await expect(new EvoPackDiscoveryTransport({ fetch: redirectedFetch }).readRegistryIndex(source)).rejects.toThrow(
			"redirected away from its verified source URL",
		);

		const hangingFetch = vi.fn<EvoDiscoveryFetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init.signal;
					if (!signal) throw new Error("transport did not provide an abort signal");
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		await expect(
			new EvoPackDiscoveryTransport({ fetch: hangingFetch, timeoutMs: 10 }).readRegistryIndex(source),
		).rejects.toThrow("timed out");
	});
});

describe("pack registry service", () => {
	it("searches a signed gist registry and stages a fully verified immutable git pack", async () => {
		const root = await temporary("evo-registry-root-");
		const packDirectory = await temporary("evo-registry-pack-");
		const scratch = await temporary("evo-registry-scratch-");
		const { paths, bundle } = await seedBundle(root);
		const pack = await promptPack(packDirectory);
		const revision = "a".repeat(40);
		const packSource: EvoRawFileSource = {
			kind: "git",
			repository: "https://github.com/example/packs.git",
			revision,
			path: "packs/focused-review/pack.json",
			rawUrl: `https://raw.githubusercontent.com/example/packs/${revision}/packs/focused-review/pack.json`,
		};
		const alice = generateKeyPairSync("ed25519");
		const entry = signEntry(
			{
				name: pack.manifest.name,
				version: pack.manifest.version,
				integrity: pack.manifest.integrity as string,
				author: pack.manifest.author,
				description: pack.manifest.description,
				source: packSource,
			},
			"alice",
			alice.privateKey,
		);
		const gistRevision = "b".repeat(40);
		const registrySource: EvoRawFileSource = {
			kind: "gist",
			gistId: "abcde12345",
			revision: gistRevision,
			file: "registry.json",
			rawUrl: `https://gist.githubusercontent.com/alice/abcde12345/raw/${gistRevision}/registry.json`,
		};
		const files = new Map<string, string>([
			[registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [entry] })],
			[packSource.rawUrl, pack.manifestText],
			[
				`https://raw.githubusercontent.com/example/packs/${revision}/packs/focused-review/prompts/review.md`,
				pack.promptText,
			],
		]);
		const fetchImpl = mappedFetch(files);
		const service = new EvoPackRegistryService({
			registrySources: [registrySource],
			transport: new EvoPackDiscoveryTransport({ fetch: fetchImpl }),
			trustedSigners: [{ id: "alice", publicKeyPem: publicKeyPem(alice.publicKey) }],
			temporaryDirectory: scratch,
		});

		const found = await service.search({ query: "review", trustedOnly: true });
		expect(found).toHaveLength(1);
		expect(found[0].trust).toEqual({ status: "trusted", trusted: true, signer: "alice" });

		const installed = await service.install({
			name: "focused-review",
			version: "1.0.0",
			expectedIntegrity: pack.manifest.integrity as string,
			paths,
			parentDigest: bundle.digest,
		});

		expect(installed).toMatchObject({
			registrySource,
			packSource,
			trust: { status: "trusted", trusted: true, signer: "alice" },
			fileCount: 2,
		});
		const candidateDigest = installed.imported.proposal?.candidateDigest;
		if (!candidateDigest) throw new Error("registry install did not stage its data proposal");
		const candidate = await loadCompiledBundle(paths, candidateDigest);
		expect(await readFile(join(candidate.directory, installed.imported.addedPromptPaths[0]), "utf8")).toBe(
			pack.promptText,
		);
		expect(await readdir(scratch)).toEqual([]);
	});

	it("refuses unsigned entries before fetching their pack", async () => {
		const root = await temporary("evo-registry-untrusted-root-");
		const { paths, bundle } = await seedBundle(root);
		const registrySource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://registry.example/index.json",
		};
		const entry: EvoPackRegistryEntry = {
			name: "unsigned-pack",
			version: "1.0.0",
			integrity: `sha256:${"1".repeat(64)}`,
			source: { kind: "https", rawUrl: "https://packs.example/unsigned/pack.json" },
		};
		const fetchImpl = mappedFetch(
			new Map([[registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [entry] })]]),
		);
		const service = new EvoPackRegistryService({
			registrySources: [registrySource],
			transport: new EvoPackDiscoveryTransport({ fetch: fetchImpl }),
			trustedSigners: [],
		});

		await expect(
			service.install({
				name: entry.name,
				version: entry.version,
				expectedIntegrity: entry.integrity,
				paths,
				parentDigest: bundle.digest,
			}),
		).rejects.toThrow("refusing to install untrusted registry entry");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("rejects a registry entry whose integrity changed after trusted inspection", async () => {
		const root = await temporary("evo-registry-inspection-drift-root-");
		const packDirectory = await temporary("evo-registry-inspection-drift-pack-");
		const { paths, bundle } = await seedBundle(root);
		const pack = await promptPack(packDirectory);
		const source: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://packs.example/drift/pack.json",
		};
		const alice = generateKeyPairSync("ed25519");
		const baseEntry: EvoPackRegistryEntry = {
			name: pack.manifest.name,
			version: pack.manifest.version,
			description: pack.manifest.description,
			source,
			integrity: pack.manifest.integrity as string,
		};
		const inspectedEntry = signEntry(baseEntry, "alice", alice.privateKey);
		const changedEntry = signEntry(
			{ ...baseEntry, integrity: `sha256:${"9".repeat(64)}` },
			"alice",
			alice.privateKey,
		);
		const registrySource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://registry.example/index.json",
		};
		const files = new Map([
			[registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [inspectedEntry] })],
			[source.rawUrl, pack.manifestText],
		]);
		const fetchImpl = mappedFetch(files);
		const service = new EvoPackRegistryService({
			registrySources: [registrySource],
			trustedSigners: [{ id: "alice", publicKeyPem: publicKeyPem(alice.publicKey) }],
			transport: new EvoPackDiscoveryTransport({ fetch: fetchImpl }),
		});

		const inspection = await service.inspect(inspectedEntry.name, inspectedEntry.version);
		files.set(registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [changedEntry] }));

		await expect(
			service.install({
				name: inspection.entry.name,
				version: inspection.entry.version,
				expectedIntegrity: inspection.entry.integrity,
				paths,
				parentDigest: bundle.digest,
			}),
		).rejects.toThrow(
			`registry entry changed after inspection: expected ${inspection.entry.integrity}, got ${changedEntry.integrity}`,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(await new EvoService(paths).listProposals()).toEqual([]);
	});

	it("rejects content tampering before staging any proposal", async () => {
		const root = await temporary("evo-registry-tamper-root-");
		const packDirectory = await temporary("evo-registry-tamper-pack-");
		const { paths, bundle } = await seedBundle(root);
		const pack = await promptPack(packDirectory);
		const source: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://packs.example/focused/pack.json",
		};
		const alice = generateKeyPairSync("ed25519");
		const entry = signEntry(
			{
				name: pack.manifest.name,
				version: pack.manifest.version,
				integrity: pack.manifest.integrity as string,
				source,
			},
			"alice",
			alice.privateKey,
		);
		const registrySource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://registry.example/tampered.json",
		};
		const fetchImpl = mappedFetch(
			new Map([
				[registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [entry] })],
				[source.rawUrl, pack.manifestText],
				["https://packs.example/focused/prompts/review.md", "tampered\n"],
			]),
		);
		const service = new EvoPackRegistryService({
			registrySources: [registrySource],
			transport: new EvoPackDiscoveryTransport({ fetch: fetchImpl }),
			trustedSigners: [{ id: "alice", publicKeyPem: publicKeyPem(alice.publicKey) }],
		});

		await expect(
			service.install({
				name: entry.name,
				version: entry.version,
				expectedIntegrity: entry.integrity,
				paths,
				parentDigest: bundle.digest,
			}),
		).rejects.toThrow("downloaded pack integrity does not match registry entry");
		expect(await new EvoService(paths).listProposals()).toEqual([]);
	});
});
