import { generateKeyPairSync, type KeyObject, sign as signPayload } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EvoPackDiscoveryClient } from "../src/discovery/client.ts";
import {
	canonicalEvoPackRegistryEntryMetadata,
	type EvoPackRegistryEntry,
	type EvoPackRegistryIndex,
	type EvoRawFileSource,
	parseEvoPackRegistryIndex,
	verifyEvoPackRegistryEntryTrust,
} from "../src/discovery/registry.ts";
import type { EvoPackManifest } from "../src/pack/pack.ts";

const FIRST_INTEGRITY = `sha256:${"1".repeat(64)}`;
const SECOND_INTEGRITY = `sha256:${"2".repeat(64)}`;
const THIRD_INTEGRITY = `sha256:${"3".repeat(64)}`;

function baseEntry(overrides: Partial<EvoPackRegistryEntry> = {}): EvoPackRegistryEntry {
	return {
		name: "review-pack",
		version: "1.0.0",
		integrity: FIRST_INTEGRITY,
		author: "alice",
		description: "Review helpers",
		source: { kind: "https", rawUrl: "https://packs.example/review/pack.json" },
		...overrides,
	};
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

function packManifest(entry: EvoPackRegistryEntry): EvoPackManifest {
	return {
		packFormat: 1,
		name: entry.name,
		version: entry.version,
		...(entry.author === undefined ? {} : { author: entry.author }),
		...(entry.description === undefined ? {} : { description: entry.description }),
		contents: { prompts: [], skills: [], memory: [], components: [], workflows: [] },
		requiresAbis: [],
		requiresCapabilities: [],
		integrity: entry.integrity,
	};
}

describe("optimization pack registry", () => {
	it("parses exact HTTPS, immutable git, and immutable gist provenance", () => {
		const index = parseEvoPackRegistryIndex({
			registryFormat: 1,
			entries: [
				baseEntry(),
				baseEntry({
					name: "git-pack",
					version: "2.0.0",
					integrity: SECOND_INTEGRITY,
					source: {
						kind: "git",
						repository: "https://github.com/example/packs.git",
						revision: "a".repeat(40),
						path: "packs/git/pack.json",
						rawUrl: `https://raw.githubusercontent.com/example/packs/${"a".repeat(40)}/packs/git/pack.json`,
					},
				}),
				baseEntry({
					name: "gist-pack",
					version: "3.0.0",
					integrity: THIRD_INTEGRITY,
					source: {
						kind: "gist",
						gistId: "abcde12345",
						revision: "b".repeat(40),
						file: "pack.json",
						rawUrl: `https://gist.githubusercontent.com/alice/abcde12345/raw/${"b".repeat(40)}/pack.json`,
					},
				}),
			],
		});

		expect(index.entries.map((entry) => entry.source.kind)).toEqual(["https", "git", "gist"]);
		expect(index.entries[1].source).toMatchObject({ revision: "a".repeat(40), path: "packs/git/pack.json" });
	});

	it("rejects unknown fields, insecure sources, mutable revisions, and invalid versions", () => {
		expect(() => parseEvoPackRegistryIndex({ registryFormat: 1, entries: [], extra: true })).toThrow(
			"unknown key: extra",
		);
		expect(() =>
			parseEvoPackRegistryIndex({
				registryFormat: 1,
				entries: [{ ...baseEntry(), source: { kind: "https", rawUrl: "http://packs.example/pack.json" } }],
			}),
		).toThrow("canonical HTTPS URL");
		expect(() =>
			parseEvoPackRegistryIndex({
				registryFormat: 1,
				entries: [
					{
						...baseEntry(),
						source: {
							kind: "git",
							repository: "https://github.com/example/packs.git",
							revision: "main",
							path: "pack.json",
							rawUrl: "https://raw.githubusercontent.com/example/packs/main/pack.json",
						},
					},
				],
			}),
		).toThrow("full lowercase git object ID");
		expect(() =>
			parseEvoPackRegistryIndex({ registryFormat: 1, entries: [baseEntry({ version: "not a version" })] }),
		).toThrow("version is invalid");
	});

	it("rejects terminal control sequences in unsigned display metadata", () => {
		expect(() =>
			parseEvoPackRegistryIndex({
				registryFormat: 1,
				entries: [baseEntry({ author: "alice\u001b]8;;https://attacker.example\u0007click" })],
			}),
		).toThrow("author must not contain terminal control characters");
		expect(() =>
			parseEvoPackRegistryIndex({
				registryFormat: 1,
				entries: [baseEntry({ description: "safe\nforged output" })],
			}),
		).toThrow("description must not contain terminal control characters");
	});

	it("rejects duplicate pack versions even when their URLs and integrity differ", () => {
		expect(() =>
			parseEvoPackRegistryIndex({
				registryFormat: 1,
				entries: [
					baseEntry(),
					baseEntry({
						integrity: SECOND_INTEGRITY,
						source: { kind: "https", rawUrl: "https://mirror.example/review/pack.json" },
					}),
				],
			}),
		).toThrow("duplicate pack version: review-pack@1.0.0");
	});

	it("verifies Ed25519 metadata with the explicitly selected trusted signer", () => {
		const alice = generateKeyPairSync("ed25519");
		const entry = signEntry(baseEntry(), "alice", alice.privateKey);

		expect(
			verifyEvoPackRegistryEntryTrust(entry, [{ id: "alice", publicKeyPem: publicKeyPem(alice.publicKey) }]),
		).toEqual({ status: "trusted", trusted: true, signer: "alice" });
		expect(verifyEvoPackRegistryEntryTrust(entry, [])).toEqual({
			status: "untrusted-signer",
			trusted: false,
			signer: "alice",
		});
	});

	it("fails closed when signed metadata changes or trusted signer IDs are ambiguous", () => {
		const alice = generateKeyPairSync("ed25519");
		const signer = { id: "alice", publicKeyPem: publicKeyPem(alice.publicKey) };
		const signed = signEntry(baseEntry(), "alice", alice.privateKey);

		expect(() => verifyEvoPackRegistryEntryTrust({ ...signed, version: "1.0.1" }, [signer])).toThrow(
			"signature is invalid",
		);
		expect(() => verifyEvoPackRegistryEntryTrust(signed, [signer, signer])).toThrow("duplicate signer id: alice");
	});

	it("binds the signer identity and rejects duplicate aliases for one trusted key", () => {
		const alice = generateKeyPairSync("ed25519");
		const publicKey = publicKeyPem(alice.publicKey);
		const signed = signEntry(baseEntry(), "alice", alice.privateKey);
		if (!signed.signature) throw new Error("signed registry fixture has no signature");
		const relabeled = {
			...signed,
			signature: { ...signed.signature, signer: "bob" },
		};

		expect(() => verifyEvoPackRegistryEntryTrust(relabeled, [{ id: "bob", publicKeyPem: publicKey }])).toThrow(
			"signature is invalid",
		);
		expect(() =>
			verifyEvoPackRegistryEntryTrust(baseEntry(), [
				{ id: "alice", publicKeyPem: publicKey },
				{ id: "bob", publicKeyPem: publicKey },
			]),
		).toThrow("duplicate public key aliases: alice, bob");
	});

	it("keeps unsigned entries visibly untrusted", () => {
		expect(verifyEvoPackRegistryEntryTrust(baseEntry(), [])).toEqual({ status: "unsigned", trusted: false });
	});
});

describe("optimization pack discovery client", () => {
	it("uses injected reads, preserves registry provenance, and cross-checks the pack manifest", async () => {
		const alice = generateKeyPairSync("ed25519");
		const entry = signEntry(baseEntry(), "alice", alice.privateKey);
		const index: EvoPackRegistryIndex = { registryFormat: 1, entries: [entry] };
		const registrySource: EvoRawFileSource = {
			kind: "git",
			repository: "https://github.com/example/registry.git",
			revision: "c".repeat(40),
			path: "registry.json",
			rawUrl: `https://raw.githubusercontent.com/example/registry/${"c".repeat(40)}/registry.json`,
		};
		const readRegistryIndex = vi.fn(async () => JSON.stringify(index));
		const fetchPackManifest = vi.fn(async () => JSON.stringify(packManifest(entry)));
		const client = new EvoPackDiscoveryClient({
			readRegistryIndex,
			fetchPackManifest,
			trustedSigners: [{ id: "alice", publicKeyPem: publicKeyPem(alice.publicKey) }],
		});

		const discovered = await client.discover([registrySource]);

		expect(discovered).toHaveLength(1);
		expect(discovered[0]).toMatchObject({ registrySource, trust: { status: "trusted", trusted: true } });
		expect(readRegistryIndex).toHaveBeenCalledWith(registrySource);
		expect(await client.fetchPackManifest(discovered[0])).toMatchObject({
			name: entry.name,
			version: entry.version,
			integrity: entry.integrity,
		});
		expect(fetchPackManifest).toHaveBeenCalledWith(entry.source);
	});

	it("rejects duplicate identities across independent indexes", async () => {
		const firstSource: EvoRawFileSource = { kind: "https", rawUrl: "https://one.example/registry.json" };
		const secondSource: EvoRawFileSource = { kind: "https", rawUrl: "https://two.example/registry.json" };
		const client = new EvoPackDiscoveryClient({
			readRegistryIndex: async () => JSON.stringify({ registryFormat: 1, entries: [baseEntry()] }),
			fetchPackManifest: async () => {
				throw new Error("not used");
			},
		});

		await expect(client.discover([firstSource, secondSource])).rejects.toThrow(
			"duplicate pack version: review-pack@1.0.0",
		);
	});

	it("rejects a fetched manifest that does not match the registry metadata", async () => {
		const entry = baseEntry();
		const client = new EvoPackDiscoveryClient({
			readRegistryIndex: async () => JSON.stringify({ registryFormat: 1, entries: [entry] }),
			fetchPackManifest: async () => JSON.stringify({ ...packManifest(entry), version: "9.0.0" }),
		});
		const discovered = await client.discover([{ kind: "https", rawUrl: "https://registry.example/registry.json" }]);

		await expect(client.fetchPackManifest(discovered[0])).rejects.toThrow(
			"manifest metadata does not match registry entry",
		);
	});
});
