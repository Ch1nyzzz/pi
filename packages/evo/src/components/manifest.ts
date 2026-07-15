import { basename } from "node:path";
import { isDigest } from "../bundle/schema.ts";
import type { EvoComponentActivationBoundary, EvoComponentManifest } from "../types.ts";

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ABI_ID_PATTERN = /^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const ACTIVATION_BOUNDARIES = new Set<EvoComponentActivationBoundary>(["turn", "session", "process"]);

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

export function assertEvoComponentId(value: string, label = "component id"): void {
	if (!COMPONENT_ID_PATTERN.test(value) || value.length > 128) {
		throw new Error(`${label} must be a lowercase component identifier`);
	}
}

export function assertEvoAbiId(value: string, label = "component ABI"): void {
	if (!ABI_ID_PATTERN.test(value) || value.length > 128) {
		throw new Error(`${label} must have the form surface/vN`);
	}
}

export function assertEvoCapability(value: string, label = "component capability"): void {
	if (!CAPABILITY_PATTERN.test(value) || value.length > 128) {
		throw new Error(`${label} is invalid`);
	}
}

export function parseEvoComponentManifest(value: unknown): EvoComponentManifest {
	const record = asRecord(value, "component manifest");
	exactKeys(
		record,
		[
			"schemaVersion",
			"id",
			"version",
			"artifactDigest",
			"entrypointSha256",
			"abi",
			"activationBoundary",
			"capabilities",
			"entrypoint",
		],
		"component manifest",
	);
	if (record.schemaVersion !== 1) throw new Error("component manifest schemaVersion must be 1");
	if (typeof record.id !== "string") throw new Error("component manifest id must be a string");
	assertEvoComponentId(record.id, "component manifest id");
	if (
		typeof record.version !== "string" ||
		!record.version ||
		record.version.length > 128 ||
		!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(record.version)
	) {
		throw new Error("component manifest version is invalid");
	}
	if (typeof record.artifactDigest !== "string" || !isDigest(record.artifactDigest)) {
		throw new Error("component manifest artifactDigest must be a digest");
	}
	if (typeof record.entrypointSha256 !== "string" || !isDigest(record.entrypointSha256)) {
		throw new Error("component manifest entrypointSha256 must be a digest");
	}
	if (typeof record.abi !== "string") throw new Error("component manifest abi must be a string");
	assertEvoAbiId(record.abi, "component manifest abi");
	if (
		typeof record.activationBoundary !== "string" ||
		!ACTIVATION_BOUNDARIES.has(record.activationBoundary as EvoComponentActivationBoundary)
	) {
		throw new Error("component manifest activationBoundary is invalid");
	}
	if (!Array.isArray(record.capabilities) || record.capabilities.some((entry) => typeof entry !== "string")) {
		throw new Error("component manifest capabilities must be a string array");
	}
	const capabilities = record.capabilities as string[];
	for (const [index, capability] of capabilities.entries()) {
		assertEvoCapability(capability, `component manifest capabilities[${index}]`);
	}
	if (new Set(capabilities).size !== capabilities.length) {
		throw new Error("component manifest capabilities must not contain duplicates");
	}
	if (
		typeof record.entrypoint !== "string" ||
		!record.entrypoint.endsWith(".mjs") ||
		basename(record.entrypoint) !== record.entrypoint ||
		record.entrypoint.length > 128
	) {
		throw new Error("component manifest entrypoint must be a direct .mjs file");
	}
	return {
		schemaVersion: 1,
		id: record.id,
		version: record.version,
		artifactDigest: record.artifactDigest,
		entrypointSha256: record.entrypointSha256,
		abi: record.abi,
		activationBoundary: record.activationBoundary as EvoComponentActivationBoundary,
		capabilities: [...capabilities].sort(),
		entrypoint: record.entrypoint,
	};
}
