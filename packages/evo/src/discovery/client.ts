import type { EvoPackManifest } from "../pack/pack.ts";
import { parseEvoPackManifest } from "../pack/pack.ts";
import { canonicalJson } from "../storage.ts";
import {
	type EvoPackRegistryEntry,
	type EvoPackRegistryEntryTrust,
	type EvoRawFileSource,
	type EvoTrustedRegistrySigner,
	parseEvoPackRegistryEntry,
	parseEvoPackRegistryIndex,
	parseEvoRawFileSource,
	validateTrustedEvoRegistrySigners,
	verifyEvoPackRegistryEntryTrust,
} from "./registry.ts";

export const EVO_PACK_REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
export const EVO_DISCOVERY_PACK_MANIFEST_MAX_BYTES = 1024 * 1024;

export interface EvoPackDiscoveryClientOptions {
	readRegistryIndex: (source: EvoRawFileSource) => Promise<string>;
	fetchPackManifest: (source: EvoRawFileSource) => Promise<string>;
	trustedSigners?: readonly EvoTrustedRegistrySigner[];
}

export interface EvoDiscoveredPack {
	registrySource: EvoRawFileSource;
	entry: EvoPackRegistryEntry;
	trust: EvoPackRegistryEntryTrust;
}

function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}

function assertByteLimit(text: string, maximumBytes: number, label: string): void {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
}

/**
 * Read-only discovery over caller-provided transports. The client has no
 * ambient network or filesystem access: registry reads and manifest fetches
 * are explicit injected functions.
 */
export class EvoPackDiscoveryClient {
	private readonly readRegistryIndex: (source: EvoRawFileSource) => Promise<string>;
	private readonly fetchManifestText: (source: EvoRawFileSource) => Promise<string>;
	private readonly trustedSigners: readonly EvoTrustedRegistrySigner[];

	constructor(options: EvoPackDiscoveryClientOptions) {
		if (typeof options.readRegistryIndex !== "function") {
			throw new Error("discovery readRegistryIndex must be a function");
		}
		if (typeof options.fetchPackManifest !== "function") {
			throw new Error("discovery fetchPackManifest must be a function");
		}
		this.readRegistryIndex = options.readRegistryIndex;
		this.fetchManifestText = options.fetchPackManifest;
		this.trustedSigners = [...(options.trustedSigners ?? [])];
		validateTrustedEvoRegistrySigners(this.trustedSigners);
	}

	/** Read, validate, and merge registry indexes without downloading packs. */
	async discover(registrySources: readonly EvoRawFileSource[]): Promise<EvoDiscoveredPack[]> {
		const discovered: EvoDiscoveredPack[] = [];
		const registryKeys = new Set<string>();
		const packIdentities = new Set<string>();
		const packIntegrities = new Set<string>();
		for (const sourceValue of registrySources) {
			const registrySource = parseEvoRawFileSource(sourceValue);
			const registryKey = canonicalJson(registrySource);
			if (registryKeys.has(registryKey)) {
				throw new Error(`duplicate pack registry source: ${registrySource.rawUrl}`);
			}
			registryKeys.add(registryKey);
			const text = await this.readRegistryIndex(registrySource);
			if (typeof text !== "string") throw new Error("discovery readRegistryIndex must return a string");
			assertByteLimit(text, EVO_PACK_REGISTRY_MAX_BYTES, `pack registry ${registrySource.rawUrl}`);
			const index = parseEvoPackRegistryIndex(parseJson(text, `pack registry ${registrySource.rawUrl}`));
			for (const entry of index.entries) {
				const identity = `${entry.name}\0${entry.version}`;
				if (packIdentities.has(identity)) {
					throw new Error(`discovery found duplicate pack version: ${entry.name}@${entry.version}`);
				}
				if (packIntegrities.has(entry.integrity)) {
					throw new Error(`discovery found duplicate pack integrity: ${entry.integrity}`);
				}
				packIdentities.add(identity);
				packIntegrities.add(entry.integrity);
				discovered.push({
					registrySource,
					entry,
					trust: verifyEvoPackRegistryEntryTrust(entry, this.trustedSigners),
				});
			}
		}
		return discovered;
	}

	/** Fetch and cross-check a discovered pack's declared manifest metadata. */
	async fetchPackManifest(pack: EvoDiscoveredPack): Promise<EvoPackManifest> {
		const entry = parseEvoPackRegistryEntry(pack.entry);
		verifyEvoPackRegistryEntryTrust(entry, this.trustedSigners);
		const text = await this.fetchManifestText(entry.source);
		if (typeof text !== "string") throw new Error("discovery fetchPackManifest must return a string");
		assertByteLimit(text, EVO_DISCOVERY_PACK_MANIFEST_MAX_BYTES, `pack manifest ${entry.source.rawUrl}`);
		const manifest = parseEvoPackManifest(parseJson(text, `pack manifest ${entry.source.rawUrl}`));
		if (
			manifest.name !== entry.name ||
			manifest.version !== entry.version ||
			manifest.integrity !== entry.integrity
		) {
			throw new Error(`pack manifest metadata does not match registry entry ${entry.name}@${entry.version}`);
		}
		if (entry.author !== undefined && manifest.author !== entry.author) {
			throw new Error(`pack manifest author does not match registry entry ${entry.name}@${entry.version}`);
		}
		if (entry.description !== undefined && manifest.description !== entry.description) {
			throw new Error(`pack manifest description does not match registry entry ${entry.name}@${entry.version}`);
		}
		return manifest;
	}
}
