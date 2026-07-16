import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EVO_PACK_DISCOVERY_CONFIG_FILE,
	getEvoPackDiscoveryConfigPath,
	parseEvoPackDiscoveryConfig,
	readEvoPackDiscoveryConfig,
} from "../src/discovery/config.ts";
import { getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];
const alice = generateKeyPairSync("ed25519");
const bob = generateKeyPairSync("ed25519");
const ALICE_PUBLIC_KEY = alice.publicKey.export({ format: "pem", type: "spki" }).toString();
const BOB_PUBLIC_KEY = bob.publicKey.export({ format: "pem", type: "spki" }).toString();

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "evo-discovery-config-"));
	roots.push(root);
	return root;
}

function config() {
	return {
		schemaVersion: 1,
		registrySources: [
			{ kind: "https", rawUrl: "https://registry.example/packs.json" },
			{
				kind: "git",
				repository: "https://github.com/example/registry.git",
				revision: "a".repeat(40),
				path: "registry.json",
				rawUrl: `https://raw.githubusercontent.com/example/registry/${"a".repeat(40)}/registry.json`,
			},
		],
		trustedSigners: [{ id: "alice", publicKeyPem: ALICE_PUBLIC_KEY }],
	};
}

describe("pack discovery config", () => {
	it("parses the exact v1 schema and derives the registry-local default path", () => {
		const parsed = parseEvoPackDiscoveryConfig(config());
		expect(parsed).toMatchObject({
			schemaVersion: 1,
			registrySources: [{ kind: "https" }, { kind: "git", revision: "a".repeat(40) }],
			trustedSigners: [{ id: "alice" }],
		});
		const paths = getEvoPaths("/tmp/evo-config-path");
		expect(getEvoPackDiscoveryConfigPath(paths)).toBe(join(paths.registry, EVO_PACK_DISCOVERY_CONFIG_FILE));
	});

	it("rejects unknown keys and duplicate sources or signers", () => {
		expect(() => parseEvoPackDiscoveryConfig({ ...config(), extra: true })).toThrow("unknown key: extra");
		expect(() =>
			parseEvoPackDiscoveryConfig({
				...config(),
				trustedSigners: [{ id: "alice", publicKeyPem: ALICE_PUBLIC_KEY, privateKey: "no" }],
			}),
		).toThrow("unknown key: privateKey");
		const duplicateSource = config().registrySources[0];
		expect(() =>
			parseEvoPackDiscoveryConfig({ ...config(), registrySources: [duplicateSource, duplicateSource] }),
		).toThrow("registrySources must not contain duplicates");
		expect(() =>
			parseEvoPackDiscoveryConfig({
				...config(),
				trustedSigners: [
					{ id: "alice", publicKeyPem: ALICE_PUBLIC_KEY },
					{ id: "alice", publicKeyPem: BOB_PUBLIC_KEY },
				],
			}),
		).toThrow("duplicate signer id: alice");
		expect(() =>
			parseEvoPackDiscoveryConfig({
				...config(),
				trustedSigners: [
					{ id: "alice", publicKeyPem: ALICE_PUBLIC_KEY },
					{ id: "alice-alias", publicKeyPem: ALICE_PUBLIC_KEY },
				],
			}),
		).toThrow("duplicate public key aliases: alice, alice-alias");
		expect(() =>
			parseEvoPackDiscoveryConfig({
				...config(),
				trustedSigners: [{ id: "alice", publicKeyPem: "PUBLIC KEY" }],
			}),
		).toThrow("invalid public key");
	});

	it("reads only a bounded regular local file and reports a missing config", async () => {
		const root = await temporary();
		const path = join(root, "pack-discovery.json");
		await writeFile(path, `${JSON.stringify(config())}\n`);
		expect(await readEvoPackDiscoveryConfig(path)).toEqual(parseEvoPackDiscoveryConfig(config()));

		const link = join(root, "linked.json");
		await symlink(path, link);
		await expect(readEvoPackDiscoveryConfig(link)).rejects.toThrow("must be a regular file");
		await expect(readEvoPackDiscoveryConfig(join(root, "missing.json"))).rejects.toThrow(
			"pack discovery config not found",
		);
	});
});
