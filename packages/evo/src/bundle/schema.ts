import { isAbsolute, normalize } from "node:path";
import type {
	BundleManagedSource,
	BundleManagedSourceKind,
	BundleManifest,
	BundleModelRouting,
	BundlePolicy,
	BundlePolicyLimits,
	BundleValidationPolicy,
	DeterministicCheck,
} from "../types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const POLICY_KEYS = new Set([
	"schemaVersion",
	"promptOrder",
	"stablePromptPaths",
	"dynamicPromptPaths",
	"enabledTools",
	"enabledFeatures",
	"coreAssets",
	"limits",
	"modelRouting",
	"validation",
	"managedSources",
]);
const LIMIT_KEYS = new Set(["promptBytes", "skillBytes", "totalBytes"]);
const MODEL_ROUTING_KEYS = new Set(["worker", "reflector", "critic"]);
const VALIDATION_KEYS = new Set(["requiredChecks"]);
const MANAGED_SOURCE_KEYS = new Set(["kind", "sourceRoot", "relativePath", "targetPath", "sourceSha256"]);
const MANAGED_SOURCE_KINDS = new Set<BundleManagedSourceKind>([
	"custom-prompt",
	"append-prompt",
	"context",
	"prompt",
	"skill",
	"memory",
	"preference",
]);
const DETERMINISTIC_CHECKS = new Set<DeterministicCheck>(["bundle-compile"]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`${label} has unknown key: ${key}`);
	}
}

function parseStringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	const result = value as string[];
	if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
	return [...result];
}

function parsePositiveInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
	return value as number;
}

function parseLimits(value: unknown): BundlePolicyLimits | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value, "policy.limits");
	rejectUnknownKeys(record, LIMIT_KEYS, "policy.limits");
	return {
		promptBytes: parsePositiveInteger(record.promptBytes, "policy.limits.promptBytes"),
		skillBytes: parsePositiveInteger(record.skillBytes, "policy.limits.skillBytes"),
		totalBytes: parsePositiveInteger(record.totalBytes, "policy.limits.totalBytes"),
	};
}

function parseModelRouting(value: unknown): BundleModelRouting | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value, "policy.modelRouting");
	rejectUnknownKeys(record, MODEL_ROUTING_KEYS, "policy.modelRouting");
	const result: BundleModelRouting = {};
	for (const key of MODEL_ROUTING_KEYS) {
		const route = record[key];
		if (route === undefined) continue;
		if (typeof route !== "string" || route.length === 0 || route.length > 200 || /\s/.test(route)) {
			throw new Error(`policy.modelRouting.${key} must be a non-empty provider/model identifier`);
		}
		result[key as keyof BundleModelRouting] = route;
	}
	return result;
}

function parseValidation(value: unknown): BundleValidationPolicy | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value, "policy.validation");
	rejectUnknownKeys(record, VALIDATION_KEYS, "policy.validation");
	const checks = parseStringArray(record.requiredChecks, "policy.validation.requiredChecks");
	if (checks?.some((check) => !DETERMINISTIC_CHECKS.has(check as DeterministicCheck))) {
		throw new Error("policy.validation.requiredChecks contains an unsupported check");
	}
	return { requiredChecks: checks as DeterministicCheck[] | undefined };
}

function assertManagedSourceRelativePath(path: string, label: string): void {
	if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) {
		throw new Error(`${label} must be a normalized relative path`);
	}
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`${label} contains an unsafe segment`);
	}
}

function parseManagedSources(value: unknown): BundleManagedSource[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("policy.managedSources must be an array");
	const sources = value.map((entry, index) => {
		const label = `policy.managedSources[${index}]`;
		const record = asRecord(entry, label);
		rejectUnknownKeys(record, MANAGED_SOURCE_KEYS, label);
		if (typeof record.kind !== "string" || !MANAGED_SOURCE_KINDS.has(record.kind as BundleManagedSourceKind)) {
			throw new Error(`${label}.kind is unsupported`);
		}
		if (
			typeof record.sourceRoot !== "string" ||
			!record.sourceRoot ||
			record.sourceRoot.length > 4096 ||
			record.sourceRoot.includes("\0") ||
			!isAbsolute(record.sourceRoot) ||
			normalize(record.sourceRoot) !== record.sourceRoot
		) {
			throw new Error(`${label}.sourceRoot must be a canonical absolute path`);
		}
		if (typeof record.relativePath !== "string") throw new Error(`${label}.relativePath must be a string`);
		assertManagedSourceRelativePath(record.relativePath, `${label}.relativePath`);
		if (typeof record.targetPath !== "string") throw new Error(`${label}.targetPath must be a string`);
		assertAssetPath(record.targetPath);
		if (record.targetPath === "policy.json" || record.targetPath === "bundle.json") {
			throw new Error(`${label}.targetPath must reference a managed data asset`);
		}
		if (typeof record.sourceSha256 !== "string" || !isDigest(record.sourceSha256)) {
			throw new Error(`${label}.sourceSha256 must be a digest`);
		}
		const kind = record.kind as BundleManagedSourceKind;
		const expectedPrefix =
			kind === "custom-prompt" || kind === "append-prompt" || kind === "prompt"
				? "prompts/"
				: kind === "skill"
					? "skills/"
					: "memory/";
		if (!record.targetPath.startsWith(expectedPrefix)) {
			throw new Error(`${label}.targetPath does not match kind ${kind}`);
		}
		return {
			kind,
			sourceRoot: record.sourceRoot,
			relativePath: record.relativePath,
			targetPath: record.targetPath,
			sourceSha256: record.sourceSha256,
		};
	});
	const targets = sources.map((source) => source.targetPath);
	if (new Set(targets).size !== targets.length) {
		throw new Error("policy.managedSources must not contain duplicate target paths");
	}
	const origins = sources.map((source) => `${source.sourceRoot}\0${source.relativePath}`);
	if (new Set(origins).size !== origins.length) {
		throw new Error("policy.managedSources must not contain duplicate source paths");
	}
	for (const singletonKind of ["custom-prompt", "append-prompt"] as const) {
		if (sources.filter((source) => source.kind === singletonKind).length > 1) {
			throw new Error(`policy.managedSources may contain at most one ${singletonKind}`);
		}
	}
	return sources;
}

export function isDigest(value: string): boolean {
	return DIGEST_PATTERN.test(value);
}

export function assertAssetPath(path: string): void {
	if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) {
		throw new Error(`Bundle path is not a normalized relative path: ${path}`);
	}
	const parts = path.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
		throw new Error(`Bundle path contains an unsafe segment: ${path}`);
	}
	const allowed =
		path === "policy.json" ||
		path === "bundle.json" ||
		(parts.length === 2 &&
			(parts[0] === "prompts" || parts[0] === "memory") &&
			parts[1].endsWith(".md") &&
			ASSET_NAME_PATTERN.test(parts[1].slice(0, -3))) ||
		(parts.length === 3 && parts[0] === "skills" && ASSET_NAME_PATTERN.test(parts[1]) && parts[2] === "SKILL.md");
	if (!allowed) throw new Error(`Bundle contains a disallowed data path: ${path}`);
}

export function parseBundlePolicy(value: unknown): BundlePolicy {
	const record = asRecord(value, "policy.json");
	rejectUnknownKeys(record, POLICY_KEYS, "policy.json");
	if (record.schemaVersion !== 1) throw new Error("policy.json schemaVersion must be 1");
	const policy: BundlePolicy = {
		schemaVersion: 1,
		promptOrder: parseStringArray(record.promptOrder, "policy.promptOrder"),
		stablePromptPaths: parseStringArray(record.stablePromptPaths, "policy.stablePromptPaths"),
		dynamicPromptPaths: parseStringArray(record.dynamicPromptPaths, "policy.dynamicPromptPaths"),
		enabledTools: parseStringArray(record.enabledTools, "policy.enabledTools"),
		enabledFeatures: parseStringArray(record.enabledFeatures, "policy.enabledFeatures"),
		coreAssets: parseStringArray(record.coreAssets, "policy.coreAssets"),
		limits: parseLimits(record.limits),
		modelRouting: parseModelRouting(record.modelRouting),
		validation: parseValidation(record.validation),
		managedSources: parseManagedSources(record.managedSources),
	};
	for (const path of [
		...(policy.promptOrder ?? []),
		...(policy.stablePromptPaths ?? []),
		...(policy.dynamicPromptPaths ?? []),
		...(policy.coreAssets ?? []),
	]) {
		assertAssetPath(path);
	}
	const stable = new Set(policy.stablePromptPaths ?? []);
	if (policy.dynamicPromptPaths?.some((path) => stable.has(path))) {
		throw new Error("A prompt cannot be both stable and dynamic");
	}
	return policy;
}

export function parseBundleManifest(value: unknown): BundleManifest {
	const record = asRecord(value, "bundle.json");
	rejectUnknownKeys(record, new Set(["schemaVersion", "parentDigest", "summary", "files"]), "bundle.json");
	if (record.schemaVersion !== 1) throw new Error("bundle.json schemaVersion must be 1");
	if (record.parentDigest !== null && (typeof record.parentDigest !== "string" || !isDigest(record.parentDigest))) {
		throw new Error("bundle.json parentDigest must be null or a sha256 digest");
	}
	if (typeof record.summary !== "string" || record.summary.length === 0 || record.summary.length > 240) {
		throw new Error("bundle.json summary must contain 1-240 characters");
	}
	if (!Array.isArray(record.files) || record.files.length === 0)
		throw new Error("bundle.json files must not be empty");
	const files = record.files.map((entry, index) => {
		const file = asRecord(entry, `bundle.json files[${index}]`);
		rejectUnknownKeys(file, new Set(["path", "sha256", "bytes"]), `bundle.json files[${index}]`);
		if (typeof file.path !== "string") throw new Error(`bundle.json files[${index}].path must be a string`);
		assertAssetPath(file.path);
		if (file.path === "bundle.json") throw new Error("bundle.json cannot include itself in files");
		if (typeof file.sha256 !== "string" || !isDigest(file.sha256)) {
			throw new Error(`bundle.json files[${index}].sha256 must be a digest`);
		}
		if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) {
			throw new Error(`bundle.json files[${index}].bytes must be a non-negative integer`);
		}
		return { path: file.path, sha256: file.sha256, bytes: file.bytes as number };
	});
	if (files[0]?.path !== "policy.json") throw new Error("policy.json must be the first manifest file");
	if (new Set(files.map((file) => file.path)).size !== files.length)
		throw new Error("bundle.json has duplicate files");
	const sorted = [...files].sort((left, right) => {
		if (left.path === "policy.json") return -1;
		if (right.path === "policy.json") return 1;
		return left.path.localeCompare(right.path);
	});
	if (files.some((file, index) => file.path !== sorted[index].path))
		throw new Error("bundle.json files are not sorted");
	return {
		schemaVersion: 1,
		parentDigest: record.parentDigest as string | null,
		summary: record.summary,
		files,
	};
}
