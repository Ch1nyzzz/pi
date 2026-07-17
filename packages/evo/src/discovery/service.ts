import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvoCapabilityGrant } from "../components/capabilities/broker.ts";
import { type EvoPackImportPreflight, type EvoPackImportResult, importEvoPack } from "../pack/import.ts";
import { type EvoPackManifest, loadEvoPack } from "../pack/pack.ts";
import type { EvoPaths } from "../paths.ts";
import { canonicalJson } from "../storage.ts";
import { type EvoDiscoveredPack, EvoPackDiscoveryClient } from "./client.ts";
import {
	type EvoPackRegistryEntry,
	type EvoPackRegistryEntryTrust,
	type EvoRawFileSource,
	type EvoTrustedRegistrySigner,
	parseEvoRawFileSource,
} from "./registry.ts";
import { EvoPackDiscoveryTransport } from "./transport.ts";

type EvoTrustedPackRegistryEntryTrust = Extract<EvoPackRegistryEntryTrust, { trusted: true }>;

interface EvoTrustedDiscoveredPack extends Omit<EvoDiscoveredPack, "trust"> {
	trust: EvoTrustedPackRegistryEntryTrust;
}

export interface EvoPackRegistryServiceOptions {
	registrySources: readonly EvoRawFileSource[];
	transport: EvoPackDiscoveryTransport;
	trustedSigners: readonly EvoTrustedRegistrySigner[];
	temporaryDirectory?: string;
}

export interface EvoPackRegistrySearchOptions {
	query?: string;
	trustedOnly?: boolean;
	limit?: number;
	includeTrustedManifests?: boolean;
	signal?: AbortSignal;
}

export interface EvoPackRegistrySearchResult extends EvoDiscoveredPack {
	manifest?: EvoPackManifest;
}

export interface EvoPackRegistryInstallOptions {
	name: string;
	version?: string;
	/** Pin the content identity shown by a prior trusted inspection. */
	expectedIntegrity: string;
	paths: EvoPaths;
	parentDigest: string;
	grantsByComponent?: Readonly<Record<string, readonly EvoCapabilityGrant[]>>;
	signal?: AbortSignal;
	/** Runs after full pack preflight and before any pack-owned artifact or proposal is persisted. */
	beforeStage?: (context: EvoPackRegistryBeforeStageContext) => Promise<void>;
	/** Sandbox mode for the post-stage executable validation of imported components. */
	sandbox?: boolean;
}

export interface EvoPackRegistryInspection {
	registrySource: EvoRawFileSource;
	packSource: EvoRawFileSource;
	entry: EvoPackRegistryEntry;
	trust: EvoTrustedPackRegistryEntryTrust;
	manifest: EvoPackManifest;
}

export interface EvoPackRegistryBeforeStageContext extends EvoPackRegistryInspection {
	packDirectory: string;
	fileCount: number;
	totalBytes: number;
	preflight: EvoPackImportPreflight;
}

export interface EvoPackRegistryInstallResult {
	registrySource: EvoRawFileSource;
	packSource: EvoRawFileSource;
	trust: EvoTrustedPackRegistryEntryTrust;
	fileCount: number;
	totalBytes: number;
	imported: EvoPackImportResult;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function positiveLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
		throw new Error("registry search limit must be an integer from 1 to 10000");
	}
	return value;
}

function matchesQuery(pack: EvoDiscoveredPack, query: string): boolean {
	const needle = query.toLocaleLowerCase("en-US");
	return [pack.entry.name, pack.entry.version, pack.entry.author, pack.entry.description]
		.filter((value): value is string => value !== undefined)
		.some((value) => value.toLocaleLowerCase("en-US").includes(needle));
}

/** Read-only registry search plus trusted, fully verified staging installs. */
export class EvoPackRegistryService {
	private readonly registrySources: readonly EvoRawFileSource[];
	private readonly transport: EvoPackDiscoveryTransport;
	private readonly trustedSigners: readonly EvoTrustedRegistrySigner[];
	private readonly temporaryDirectory: string;

	constructor(options: EvoPackRegistryServiceOptions) {
		if (!(options.transport instanceof EvoPackDiscoveryTransport)) {
			throw new Error("registry service transport must be an EvoPackDiscoveryTransport");
		}
		if (!Array.isArray(options.registrySources) || options.registrySources.length === 0) {
			throw new Error("registry service requires at least one registry source");
		}
		this.registrySources = options.registrySources.map((source) => parseEvoRawFileSource(source));
		this.transport = options.transport;
		this.trustedSigners = [...options.trustedSigners];
		this.temporaryDirectory = options.temporaryDirectory ?? tmpdir();
	}

	private client(signal?: AbortSignal): EvoPackDiscoveryClient {
		return new EvoPackDiscoveryClient({
			readRegistryIndex: (source) => this.transport.readRegistryIndex(source, signal),
			fetchPackManifest: (source) => this.transport.fetchPackManifest(source, signal),
			trustedSigners: this.trustedSigners,
		});
	}

	private async selectTrusted(
		name: string,
		version?: string,
		signal?: AbortSignal,
	): Promise<{ client: EvoPackDiscoveryClient; selected: EvoTrustedDiscoveredPack }> {
		signal?.throwIfAborted();
		const client = this.client(signal);
		const discovered = await client.discover(this.registrySources);
		const matches = discovered.filter(
			(pack) => pack.entry.name === name && (version === undefined || pack.entry.version === version),
		);
		if (matches.length === 0) {
			throw new Error(`pack registry has no matching pack: ${name}${version === undefined ? "" : `@${version}`}`);
		}
		if (matches.length > 1) {
			throw new Error(`pack registry selection is ambiguous; specify an exact version for ${name}`);
		}
		const selected = matches[0];
		if (!selected.trust.trusted || selected.trust.status !== "trusted") {
			throw new Error(
				`refusing to install untrusted registry entry ${selected.entry.name}@${selected.entry.version}: ${selected.trust.status}; trusted inspection is also required`,
			);
		}
		return { client, selected: { ...selected, trust: selected.trust } };
	}

	async search(options: EvoPackRegistrySearchOptions = {}): Promise<EvoPackRegistrySearchResult[]> {
		const limit = positiveLimit(options.limit);
		const query = options.query?.trim();
		options.signal?.throwIfAborted();
		const client = this.client(options.signal);
		const discovered = await client.discover(this.registrySources);
		const filtered = discovered.filter(
			(pack) =>
				(!options.trustedOnly || pack.trust.trusted) &&
				(query === undefined || query.length === 0 || matchesQuery(pack, query)),
		);
		filtered.sort(
			(left, right) =>
				compareText(left.entry.name, right.entry.name) ||
				compareText(left.entry.version, right.entry.version) ||
				compareText(left.registrySource.rawUrl, right.registrySource.rawUrl),
		);
		const selected = limit === undefined ? filtered : filtered.slice(0, limit);
		if (!options.includeTrustedManifests) return selected;
		const results: EvoPackRegistrySearchResult[] = [];
		for (const pack of selected) {
			options.signal?.throwIfAborted();
			results.push(pack.trust.trusted ? { ...pack, manifest: await client.fetchPackManifest(pack) } : pack);
		}
		return results;
	}

	/** Fetch and cross-check one exactly selected, trusted manifest without downloading its contents. */
	async inspect(name: string, version?: string, signal?: AbortSignal): Promise<EvoPackRegistryInspection> {
		const { client, selected } = await this.selectTrusted(name, version, signal);
		const manifest = await client.fetchPackManifest(selected);
		return {
			registrySource: selected.registrySource,
			packSource: selected.entry.source,
			entry: selected.entry,
			trust: selected.trust,
			manifest,
		};
	}

	async install(options: EvoPackRegistryInstallOptions): Promise<EvoPackRegistryInstallResult> {
		const { client, selected } = await this.selectTrusted(options.name, options.version, options.signal);
		if (selected.entry.integrity !== options.expectedIntegrity) {
			throw new Error(
				`registry entry changed after inspection: expected ${options.expectedIntegrity}, got ${selected.entry.integrity}`,
			);
		}
		const manifest = await client.fetchPackManifest(selected);
		options.signal?.throwIfAborted();
		const temporaryRoot = await mkdtemp(join(this.temporaryDirectory, "evo-pack-registry-"));
		try {
			const materialized = await this.transport.materializePack({
				source: selected.entry.source,
				expectedManifest: manifest,
				destination: join(temporaryRoot, "pack"),
				signal: options.signal,
			});
			const loaded = await loadEvoPack(materialized.directory);
			if (!loaded.integrity.ok || loaded.integrity.actual !== selected.entry.integrity) {
				throw new Error(
					`downloaded pack integrity does not match registry entry ${selected.entry.name}@${selected.entry.version}`,
				);
			}
			if (canonicalJson(loaded.manifest) !== canonicalJson(manifest)) {
				throw new Error("downloaded pack manifest changed after verification");
			}
			options.signal?.throwIfAborted();
			const beforeStage = options.beforeStage;
			const imported = await importEvoPack({
				paths: options.paths,
				parentDigest: options.parentDigest,
				packDir: materialized.directory,
				expectedIntegrity: options.expectedIntegrity,
				...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
				...(options.grantsByComponent === undefined ? {} : { grantsByComponent: options.grantsByComponent }),
				...(beforeStage === undefined
					? {}
					: {
							beforeStage: (preflight: EvoPackImportPreflight) =>
								beforeStage({
									registrySource: selected.registrySource,
									packSource: selected.entry.source,
									entry: selected.entry,
									trust: selected.trust,
									manifest: preflight.manifest,
									packDirectory: preflight.packDirectory,
									fileCount: materialized.fileCount,
									totalBytes: materialized.totalBytes,
									preflight,
								}),
						}),
			});
			return {
				registrySource: selected.registrySource,
				packSource: selected.entry.source,
				trust: selected.trust,
				fileCount: materialized.fileCount,
				totalBytes: materialized.totalBytes,
				imported,
			};
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}
}
