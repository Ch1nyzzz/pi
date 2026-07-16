import { createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";
import { canonicalJson } from "../storage.ts";

export const EVO_PACK_REGISTRY_FORMAT = 1;
export const EVO_PACK_REGISTRY_MAX_ENTRIES = 10_000;

const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PACK_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SIGNER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const INTEGRITY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIST_ID_PATTERN = /^[0-9a-f]{5,64}$/;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export interface EvoHttpsRawFileSource {
	kind: "https";
	rawUrl: string;
}

export interface EvoGitRawFileSource {
	kind: "git";
	repository: string;
	revision: string;
	path: string;
	rawUrl: string;
}

export interface EvoGistRawFileSource {
	kind: "gist";
	gistId: string;
	revision: string;
	file: string;
	rawUrl: string;
}

/**
 * A raw-file locator records both the retrieval URL and immutable provenance
 * when the file comes from git or a gist. Direct HTTPS locations rely on the
 * signed pack integrity for content identity.
 */
export type EvoRawFileSource = EvoHttpsRawFileSource | EvoGitRawFileSource | EvoGistRawFileSource;

export interface EvoPackRegistrySignature {
	algorithm: "ed25519";
	signer: string;
	value: string;
}

export type EvoPackRegistrySignatureIdentity = Pick<EvoPackRegistrySignature, "algorithm" | "signer">;

export interface EvoPackRegistryEntry {
	name: string;
	version: string;
	integrity: string;
	author?: string;
	description?: string;
	source: EvoRawFileSource;
	signature?: EvoPackRegistrySignature;
}

export interface EvoPackRegistryIndex {
	registryFormat: 1;
	entries: EvoPackRegistryEntry[];
}

export interface EvoTrustedRegistrySigner {
	id: string;
	publicKeyPem: string;
}

export type EvoPackRegistryEntryTrust =
	| { status: "trusted"; trusted: true; signer: string }
	| { status: "unsigned"; trusted: false }
	| { status: "untrusted-signer"; trusted: false; signer: string };

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

function asBoundedString(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string" || !value || value.length > maximumLength || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty string of at most ${maximumLength} characters`);
	}
	return value;
}

function assertNoTerminalControls(value: string, label: string): void {
	if (TERMINAL_CONTROL_PATTERN.test(value)) {
		throw new Error(`${label} must not contain terminal control characters`);
	}
}

function assertHttpsUrl(value: string, label: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be a canonical HTTPS URL`);
	}
	if (
		url.protocol !== "https:" ||
		!url.hostname ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.href !== value
	) {
		throw new Error(`${label} must be a canonical HTTPS URL without credentials, query, or fragment`);
	}
}

function assertSafeRelativePath(value: string, label: string): void {
	if (
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`${label} must be a safe relative POSIX path`);
	}
}

function parseRawFileSource(value: unknown, label: string): EvoRawFileSource {
	const record = asRecord(value, label);
	if (record.kind === "https") {
		exactKeys(record, ["kind", "rawUrl"], label);
		const rawUrl = asBoundedString(record.rawUrl, `${label}.rawUrl`, 4_096);
		assertHttpsUrl(rawUrl, `${label}.rawUrl`);
		return { kind: "https", rawUrl };
	}
	if (record.kind === "git") {
		exactKeys(record, ["kind", "repository", "revision", "path", "rawUrl"], label);
		const repository = asBoundedString(record.repository, `${label}.repository`, 4_096);
		assertHttpsUrl(repository, `${label}.repository`);
		const revision = asBoundedString(record.revision, `${label}.revision`, 64);
		if (!IMMUTABLE_REVISION_PATTERN.test(revision)) {
			throw new Error(`${label}.revision must be a full lowercase git object ID`);
		}
		const path = asBoundedString(record.path, `${label}.path`, 1_024);
		assertSafeRelativePath(path, `${label}.path`);
		const rawUrl = asBoundedString(record.rawUrl, `${label}.rawUrl`, 4_096);
		assertHttpsUrl(rawUrl, `${label}.rawUrl`);
		return { kind: "git", repository, revision, path, rawUrl };
	}
	if (record.kind === "gist") {
		exactKeys(record, ["kind", "gistId", "revision", "file", "rawUrl"], label);
		const gistId = asBoundedString(record.gistId, `${label}.gistId`, 64);
		if (!GIST_ID_PATTERN.test(gistId)) throw new Error(`${label}.gistId is invalid`);
		const revision = asBoundedString(record.revision, `${label}.revision`, 64);
		if (!IMMUTABLE_REVISION_PATTERN.test(revision)) {
			throw new Error(`${label}.revision must be a full lowercase gist revision`);
		}
		const file = asBoundedString(record.file, `${label}.file`, 1_024);
		assertSafeRelativePath(file, `${label}.file`);
		const rawUrl = asBoundedString(record.rawUrl, `${label}.rawUrl`, 4_096);
		assertHttpsUrl(rawUrl, `${label}.rawUrl`);
		return { kind: "gist", gistId, revision, file, rawUrl };
	}
	throw new Error(`${label}.kind must be 'https', 'git', or 'gist'`);
}

/** Parse a registry or pack raw-file locator without performing I/O. */
export function parseEvoRawFileSource(value: unknown): EvoRawFileSource {
	return parseRawFileSource(value, "raw-file source");
}

function assertPackManifestSource(source: EvoRawFileSource, label: string): void {
	if (!new URL(source.rawUrl).pathname.endsWith("/pack.json")) {
		throw new Error(`${label}.rawUrl must identify a pack.json file`);
	}
	if (source.kind === "git" && source.path !== "pack.json" && !source.path.endsWith("/pack.json")) {
		throw new Error(`${label}.path must identify a pack.json file`);
	}
	if (source.kind === "gist" && source.file !== "pack.json" && !source.file.endsWith("/pack.json")) {
		throw new Error(`${label}.file must identify a pack.json file`);
	}
}

function parseSignatureIdentity(value: unknown, label: string): EvoPackRegistrySignatureIdentity {
	const record = asRecord(value, label);
	exactKeys(record, ["algorithm", "signer"], label);
	if (record.algorithm !== "ed25519") throw new Error(`${label}.algorithm must be 'ed25519'`);
	const signer = asBoundedString(record.signer, `${label}.signer`, 128);
	if (!SIGNER_ID_PATTERN.test(signer)) throw new Error(`${label}.signer is invalid`);
	return { algorithm: "ed25519", signer };
}

function parseSignature(value: unknown, label: string): EvoPackRegistrySignature {
	const record = asRecord(value, label);
	exactKeys(record, ["algorithm", "signer", "value"], label);
	const identity = parseSignatureIdentity({ algorithm: record.algorithm, signer: record.signer }, label);
	const signatureValue = asBoundedString(record.value, `${label}.value`, 128);
	decodeEd25519Signature(signatureValue, `${label}.value`);
	return { ...identity, value: signatureValue };
}

/** Parse one exact, signed-or-unsigned pack registry entry. */
export function parseEvoPackRegistryEntry(value: unknown, label = "registry entry"): EvoPackRegistryEntry {
	const record = asRecord(value, label);
	exactKeys(record, ["name", "version", "integrity", "author", "description", "source", "signature"], label);
	const name = asBoundedString(record.name, `${label}.name`, 128);
	if (!PACK_NAME_PATTERN.test(name)) throw new Error(`${label}.name is invalid`);
	const version = asBoundedString(record.version, `${label}.version`, 128);
	if (!PACK_VERSION_PATTERN.test(version)) throw new Error(`${label}.version is invalid`);
	const integrity = asBoundedString(record.integrity, `${label}.integrity`, 71);
	if (!INTEGRITY_PATTERN.test(integrity)) throw new Error(`${label}.integrity is invalid`);
	if (record.author !== undefined && (typeof record.author !== "string" || record.author.length > 256)) {
		throw new Error(`${label}.author must be a string of at most 256 characters`);
	}
	if (
		record.description !== undefined &&
		(typeof record.description !== "string" || record.description.length > 4_096)
	) {
		throw new Error(`${label}.description must be a string of at most 4096 characters`);
	}
	if (typeof record.author === "string") assertNoTerminalControls(record.author, `${label}.author`);
	if (typeof record.description === "string") {
		assertNoTerminalControls(record.description, `${label}.description`);
	}
	const source = parseRawFileSource(record.source, `${label}.source`);
	assertPackManifestSource(source, `${label}.source`);
	return {
		name,
		version,
		integrity,
		...(record.author === undefined ? {} : { author: record.author as string }),
		...(record.description === undefined ? {} : { description: record.description as string }),
		source,
		...(record.signature === undefined ? {} : { signature: parseSignature(record.signature, `${label}.signature`) }),
	};
}

/** Parse a fail-closed v1 registry index and reject ambiguous identities. */
export function parseEvoPackRegistryIndex(value: unknown): EvoPackRegistryIndex {
	const record = asRecord(value, "pack registry index");
	exactKeys(record, ["registryFormat", "entries"], "pack registry index");
	if (record.registryFormat !== EVO_PACK_REGISTRY_FORMAT) {
		throw new Error(`pack registry index registryFormat must be ${EVO_PACK_REGISTRY_FORMAT}`);
	}
	if (!Array.isArray(record.entries)) throw new Error("pack registry index entries must be an array");
	if (record.entries.length > EVO_PACK_REGISTRY_MAX_ENTRIES) {
		throw new Error(`pack registry index exceeds ${EVO_PACK_REGISTRY_MAX_ENTRIES} entries`);
	}
	const entries = record.entries.map((entry, index) => parseEvoPackRegistryEntry(entry, `registry entries[${index}]`));
	const identities = new Set<string>();
	const integrities = new Set<string>();
	const sources = new Set<string>();
	for (const entry of entries) {
		const identity = `${entry.name}\0${entry.version}`;
		if (identities.has(identity))
			throw new Error(`pack registry index has duplicate pack version: ${entry.name}@${entry.version}`);
		if (integrities.has(entry.integrity)) {
			throw new Error(`pack registry index has duplicate pack integrity: ${entry.integrity}`);
		}
		const source = canonicalJson(entry.source);
		if (sources.has(source)) throw new Error(`pack registry index has duplicate pack source: ${entry.source.rawUrl}`);
		identities.add(identity);
		integrities.add(entry.integrity);
		sources.add(source);
	}
	return { registryFormat: EVO_PACK_REGISTRY_FORMAT, entries };
}

function decodeEd25519Signature(value: string, label: string): Buffer {
	if (!value.startsWith("base64:")) throw new Error(`${label} must use the base64: encoding`);
	const encoded = value.slice("base64:".length);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
		throw new Error(`${label} is not canonical base64`);
	}
	const decoded = Buffer.from(encoded, "base64");
	if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
		throw new Error(`${label} must encode one 64-byte Ed25519 signature`);
	}
	return decoded;
}

/** Canonical, domain-separated bytes that bind one entry and its signer provenance. */
export function canonicalEvoPackRegistryEntryMetadata(
	value: unknown,
	signatureIdentity?: EvoPackRegistrySignatureIdentity,
): string {
	const entry = parseEvoPackRegistryEntry(value);
	const { signature: _signature, ...metadata } = entry;
	const identityValue =
		signatureIdentity ??
		(entry.signature ? { algorithm: entry.signature.algorithm, signer: entry.signature.signer } : undefined);
	if (!identityValue) {
		throw new Error("registry entry signature identity is required for canonical signing metadata");
	}
	const identity = parseSignatureIdentity(identityValue, "registry entry signature identity");
	return canonicalJson({
		evoPackRegistryEntrySignatureFormat: 2,
		signature: identity,
		metadata,
	});
}

function trustedSignerPublicKey(signer: EvoTrustedRegistrySigner): KeyObject {
	if (signer.publicKeyPem.includes("PRIVATE KEY")) {
		throw new Error(`trusted signer ${signer.id} must use a public key`);
	}
	let publicKey: KeyObject;
	try {
		publicKey = createPublicKey(signer.publicKeyPem);
	} catch {
		throw new Error(`trusted signer ${signer.id} has an invalid public key`);
	}
	if (publicKey.asymmetricKeyType !== "ed25519") {
		throw new Error(`trusted signer ${signer.id} must use an Ed25519 public key`);
	}
	return publicKey;
}

export function validateTrustedEvoRegistrySigners(signers: readonly EvoTrustedRegistrySigner[]): void {
	const ids = new Set<string>();
	const publicKeyOwners = new Map<string, string>();
	for (const [index, signer] of signers.entries()) {
		if (typeof signer !== "object" || signer === null) throw new Error(`trusted signers[${index}] must be an object`);
		if (!SIGNER_ID_PATTERN.test(signer.id) || signer.id.length > 128) {
			throw new Error(`trusted signers[${index}].id is invalid`);
		}
		if (typeof signer.publicKeyPem !== "string" || !signer.publicKeyPem) {
			throw new Error(`trusted signers[${index}].publicKeyPem must be a non-empty string`);
		}
		if (ids.has(signer.id)) throw new Error(`trusted signers has duplicate signer id: ${signer.id}`);
		ids.add(signer.id);
		const publicKey = trustedSignerPublicKey(signer);
		const fingerprint = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const existingOwner = publicKeyOwners.get(fingerprint);
		if (existingOwner) {
			throw new Error(`trusted signers has duplicate public key aliases: ${existingOwner}, ${signer.id}`);
		}
		publicKeyOwners.set(fingerprint, signer.id);
	}
}

/** Select a trusted key by exact signer ID; keys are never guessed or tried in sequence. */
export function selectTrustedEvoRegistrySigner(
	signers: readonly EvoTrustedRegistrySigner[],
	signerId: string,
): EvoTrustedRegistrySigner | undefined {
	validateTrustedEvoRegistrySigners(signers);
	return signers.find((signer) => signer.id === signerId);
}

/**
 * Evaluate one entry against the caller's trust roots. Unsigned and unknown-key
 * entries remain discoverable but explicitly untrusted. A bad signature from a
 * selected trusted signer rejects the entry.
 */
export function verifyEvoPackRegistryEntryTrust(
	value: unknown,
	trustedSigners: readonly EvoTrustedRegistrySigner[],
): EvoPackRegistryEntryTrust {
	const entry = parseEvoPackRegistryEntry(value);
	if (!entry.signature) {
		validateTrustedEvoRegistrySigners(trustedSigners);
		return { status: "unsigned", trusted: false };
	}
	const signer = selectTrustedEvoRegistrySigner(trustedSigners, entry.signature.signer);
	if (!signer) return { status: "untrusted-signer", trusted: false, signer: entry.signature.signer };
	const publicKey = trustedSignerPublicKey(signer);
	const payload = Buffer.from(canonicalEvoPackRegistryEntryMetadata(entry), "utf8");
	const signature = decodeEd25519Signature(entry.signature.value, "registry entry signature.value");
	if (!verifySignature(null, payload, publicKey, signature)) {
		throw new Error(`registry entry signature is invalid for trusted signer ${signer.id}`);
	}
	return { status: "trusted", trusted: true, signer: signer.id };
}
