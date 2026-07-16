import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { readRegularFileNoFollow } from "../secure-file.ts";
import { canonicalJson } from "../storage.ts";
import {
	type EvoRawFileSource,
	type EvoTrustedRegistrySigner,
	parseEvoRawFileSource,
	validateTrustedEvoRegistrySigners,
} from "./registry.ts";

export const EVO_PACK_DISCOVERY_CONFIG_VERSION = 1;
export const EVO_PACK_DISCOVERY_CONFIG_MAX_BYTES = 1024 * 1024;
export const EVO_PACK_DISCOVERY_CONFIG_MAX_REGISTRIES = 64;
export const EVO_PACK_DISCOVERY_CONFIG_MAX_SIGNERS = 256;
export const EVO_PACK_DISCOVERY_CONFIG_FILE = "pack-discovery.json";

export interface EvoPackDiscoveryConfig {
	schemaVersion: 1;
	registrySources: EvoRawFileSource[];
	trustedSigners: EvoTrustedRegistrySigner[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

/** Parse the strict local v1 registry/trust-root configuration. */
export function parseEvoPackDiscoveryConfig(value: unknown): EvoPackDiscoveryConfig {
	const record = asRecord(value, "pack discovery config");
	exactKeys(record, ["schemaVersion", "registrySources", "trustedSigners"], "pack discovery config");
	if (record.schemaVersion !== EVO_PACK_DISCOVERY_CONFIG_VERSION) {
		throw new Error(`pack discovery config schemaVersion must be ${EVO_PACK_DISCOVERY_CONFIG_VERSION}`);
	}
	if (!Array.isArray(record.registrySources) || record.registrySources.length === 0) {
		throw new Error("pack discovery config registrySources must be a non-empty array");
	}
	if (record.registrySources.length > EVO_PACK_DISCOVERY_CONFIG_MAX_REGISTRIES) {
		throw new Error(`pack discovery config exceeds ${EVO_PACK_DISCOVERY_CONFIG_MAX_REGISTRIES} registry sources`);
	}
	const registrySources = record.registrySources.map((source) => parseEvoRawFileSource(source));
	const sourceKeys = registrySources.map((source) => canonicalJson(source));
	if (new Set(sourceKeys).size !== sourceKeys.length) {
		throw new Error("pack discovery config registrySources must not contain duplicates");
	}

	if (!Array.isArray(record.trustedSigners)) {
		throw new Error("pack discovery config trustedSigners must be an array");
	}
	if (record.trustedSigners.length > EVO_PACK_DISCOVERY_CONFIG_MAX_SIGNERS) {
		throw new Error(`pack discovery config exceeds ${EVO_PACK_DISCOVERY_CONFIG_MAX_SIGNERS} trusted signers`);
	}
	const trustedSigners = record.trustedSigners.map((value, index): EvoTrustedRegistrySigner => {
		const signer = asRecord(value, `pack discovery config trustedSigners[${index}]`);
		exactKeys(signer, ["id", "publicKeyPem"], `pack discovery config trustedSigners[${index}]`);
		return {
			id: typeof signer.id === "string" ? signer.id : "",
			publicKeyPem: typeof signer.publicKeyPem === "string" ? signer.publicKeyPem : "",
		};
	});
	validateTrustedEvoRegistrySigners(trustedSigners);
	return { schemaVersion: EVO_PACK_DISCOVERY_CONFIG_VERSION, registrySources, trustedSigners };
}

export function getEvoPackDiscoveryConfigPath(paths: EvoPaths): string {
	return join(paths.registry, EVO_PACK_DISCOVERY_CONFIG_FILE);
}

/** Read one regular, bounded local discovery config without following symlinks. */
export async function readEvoPackDiscoveryConfig(path: string): Promise<EvoPackDiscoveryConfig> {
	let bytes: Buffer;
	try {
		const absolutePath = resolve(path);
		const canonicalParent = await realpath(dirname(absolutePath));
		bytes = await readRegularFileNoFollow(
			join(canonicalParent, basename(absolutePath)),
			`pack discovery config ${path}`,
			EVO_PACK_DISCOVERY_CONFIG_MAX_BYTES,
		);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			throw new Error(`pack discovery config not found: ${path}`);
		}
		throw error;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`pack discovery config is not valid UTF-8: ${path}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`pack discovery config is not valid JSON: ${path}`);
	}
	return parseEvoPackDiscoveryConfig(value);
}
