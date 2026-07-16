import { generateKeyPairSync, type KeyObject, sign as signPayload } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import {
	canonicalEvoPackRegistryEntryMetadata,
	type EvoPackRegistryEntry,
	type EvoRawFileSource,
} from "../src/discovery/registry.ts";
import { EvoPackRegistryService } from "../src/discovery/service.ts";
import { type EvoDiscoveryFetch, EvoPackDiscoveryTransport } from "../src/discovery/transport.ts";
import { computeEvoPackIntegrity, parseEvoPackManifest } from "../src/pack/pack.ts";
import { ensureEvoLayout, getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

function signEntry(entry: EvoPackRegistryEntry, privateKey: KeyObject): EvoPackRegistryEntry {
	const signature = signPayload(
		null,
		Buffer.from(canonicalEvoPackRegistryEntryMetadata(entry, { algorithm: "ed25519", signer: "alice" }), "utf8"),
		privateKey,
	);
	return {
		...entry,
		signature: {
			algorithm: "ed25519",
			signer: "alice",
			value: `base64:${signature.toString("base64")}`,
		},
	};
}

describe("trusted registry inspection", () => {
	it("runs the verified callback before pack staging and always removes its snapshot", async () => {
		const root = await temporary("evo-discovery-inspect-root-");
		const sourceDirectory = await temporary("evo-discovery-inspect-pack-");
		const scratch = await temporary("evo-discovery-inspect-scratch-");
		const paths = getEvoPaths(join(root, "evo"));
		await ensureEvoLayout(paths);
		const seed = join(root, "seed");
		await mkdir(seed);
		await writeFile(join(seed, "policy.json"), '{ "schemaVersion": 1 }\n');
		const bundle = await compileBundle({ paths, sourceDirectory: seed, parentDigest: null, summary: "seed" });

		await mkdir(join(sourceDirectory, "prompts"));
		const prompt = "Inspect before installing.\n";
		await writeFile(join(sourceDirectory, "prompts", "inspect.md"), prompt);
		const unsigned = parseEvoPackManifest({
			packFormat: 1,
			name: "inspect-pack",
			version: "1.0.0",
			contents: { prompts: [{ target: "append-system", file: "prompts/inspect.md" }] },
			requiresAbis: [],
			requiresCapabilities: [],
		});
		const manifest = parseEvoPackManifest({
			...unsigned,
			integrity: await computeEvoPackIntegrity(sourceDirectory, unsigned),
		});
		const packSource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://packs.example/inspect/pack.json",
		};
		const keyPair = generateKeyPairSync("ed25519");
		const entry = signEntry(
			{
				name: manifest.name,
				version: manifest.version,
				integrity: manifest.integrity as string,
				source: packSource,
			},
			keyPair.privateKey,
		);
		const registrySource: EvoRawFileSource = {
			kind: "https",
			rawUrl: "https://registry.example/index.json",
		};
		const files = new Map<string, string>([
			[registrySource.rawUrl, JSON.stringify({ registryFormat: 1, entries: [entry] })],
			[packSource.rawUrl, JSON.stringify(manifest)],
			["https://packs.example/inspect/prompts/inspect.md", prompt],
		]);
		const fetchImpl = vi.fn<EvoDiscoveryFetch>(async (url) => {
			const body = files.get(url);
			return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
		});
		const service = new EvoPackRegistryService({
			registrySources: [registrySource],
			transport: new EvoPackDiscoveryTransport({ fetch: fetchImpl }),
			trustedSigners: [
				{
					id: "alice",
					publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
				},
			],
			temporaryDirectory: scratch,
		});

		const inspection = await service.inspect("inspect-pack");
		expect(inspection).toMatchObject({
			registrySource,
			packSource,
			trust: { status: "trusted", trusted: true, signer: "alice" },
			manifest: { name: "inspect-pack", requiresAbis: [], requiresCapabilities: [] },
		});

		let callbackDirectory: string | undefined;
		await expect(
			service.install({
				name: "inspect-pack",
				version: "1.0.0",
				expectedIntegrity: entry.integrity,
				paths,
				parentDigest: bundle.digest,
				beforeStage: async (context) => {
					callbackDirectory = context.packDirectory;
					expect(context.preflight.integrity).toBe(entry.integrity);
					await expect(access(join(context.packDirectory, "pack.json"))).resolves.toBeUndefined();
					throw new Error("builder failed");
				},
			}),
		).rejects.toThrow("builder failed");
		if (!callbackDirectory) throw new Error("verified callback was not invoked");
		await expect(access(callbackDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(scratch)).toEqual([]);
		expect(await readdir(paths.proposals)).toEqual([]);
		expect(await readdir(paths.components)).toEqual([]);
	});
});
