import { isAbsolute, normalize } from "node:path";
import type { EvoCapabilityGrant } from "../components/capabilities/broker.ts";
import { EVO_CAPABILITY_NAMES } from "../components/capabilities/protocol.ts";
import type {
	BundleManagedSource,
	BundleManagedSourceKind,
	BundleManifest,
	BundleModelRouting,
	BundlePolicy,
	BundlePolicyLimits,
	BundleValidationPolicy,
	DeterministicCheck,
	EvoComponentSelection,
	EvoWorkflowSelection,
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
	"components",
	"tools",
	"workflows",
	"validation",
	"managedSources",
]);
const LIMIT_KEYS = new Set(["promptBytes", "skillBytes", "totalBytes"]);
const MODEL_ROUTING_KEYS = new Set(["worker", "reflector", "critic"]);
const COMPONENT_SELECTION_KEYS = new Set(["id", "abi", "artifactDigest", "config", "grants"]);
const COMPONENT_SURFACE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const COMPONENT_ID_PATTERN = COMPONENT_SURFACE_PATTERN;
const COMPONENT_ABI_PATTERN = /^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/;
const WORKFLOW_TRIGGER_PATTERN = /^\/[a-z0-9][a-z0-9-]*$/;
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
const CAPABILITY_NAMES = new Set<string>(EVO_CAPABILITY_NAMES);

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

function requirePositiveInteger(value: unknown, label: string): number {
	const parsed = parsePositiveInteger(value, label);
	if (parsed === undefined) throw new Error(`${label} is required`);
	return parsed;
}

function requirePositiveNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive finite number`);
	}
	return value;
}

function requireStringArray(value: unknown, label: string, allowEmpty: boolean): string[] {
	const parsed = parseStringArray(value, label);
	if (!parsed || (!allowEmpty && parsed.length === 0)) {
		throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`);
	}
	return [...parsed].sort();
}

function parseCapabilityGrant(value: unknown, label: string): EvoCapabilityGrant {
	const grant = asRecord(value, label);
	if (typeof grant.capability !== "string" || !CAPABILITY_NAMES.has(grant.capability)) {
		throw new Error(`${label}.capability is unsupported`);
	}
	if (grant.capability !== "infer" && grant.capability !== "spawn-agent") {
		rejectUnknownKeys(grant, new Set(["capability", "maxCalls"]), label);
		return {
			capability: grant.capability,
			maxCalls: requirePositiveInteger(grant.maxCalls, `${label}.maxCalls`),
		} as EvoCapabilityGrant;
	}
	rejectUnknownKeys(
		grant,
		new Set([
			"capability",
			"maxCalls",
			"models",
			"maxInputTokens",
			"maxOutputTokens",
			"maxTotalTokens",
			"maxCostUsd",
			"maxOutputTokensPerCall",
			"tools",
		]),
		label,
	);
	if (grant.capability === "infer" && grant.tools !== undefined) {
		throw new Error(`${label}.tools is only supported for spawn-agent`);
	}
	const parsed: EvoCapabilityGrant = {
		capability: grant.capability,
		maxCalls: requirePositiveInteger(grant.maxCalls, `${label}.maxCalls`),
		models: requireStringArray(grant.models, `${label}.models`, false),
		maxInputTokens: requirePositiveInteger(grant.maxInputTokens, `${label}.maxInputTokens`),
		maxOutputTokens: requirePositiveInteger(grant.maxOutputTokens, `${label}.maxOutputTokens`),
		maxTotalTokens: requirePositiveInteger(grant.maxTotalTokens, `${label}.maxTotalTokens`),
		maxCostUsd: requirePositiveNumber(grant.maxCostUsd, `${label}.maxCostUsd`),
		maxOutputTokensPerCall: requirePositiveInteger(grant.maxOutputTokensPerCall, `${label}.maxOutputTokensPerCall`),
		...(grant.tools === undefined ? {} : { tools: requireStringArray(grant.tools, `${label}.tools`, true) }),
	};
	if (parsed.maxTotalTokens < parsed.maxInputTokens || parsed.maxTotalTokens < parsed.maxOutputTokens) {
		throw new Error(`${label}.maxTotalTokens must cover each token sub-budget`);
	}
	if (parsed.maxOutputTokensPerCall > parsed.maxOutputTokens) {
		throw new Error(`${label}.maxOutputTokensPerCall exceeds maxOutputTokens`);
	}
	return parsed;
}

function parseCapabilityGrants(value: unknown, label: string): EvoCapabilityGrant[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const grants = value.map((grant, index) => parseCapabilityGrant(grant, `${label}[${index}]`));
	if (new Set(grants.map((grant) => grant.capability)).size !== grants.length) {
		throw new Error(`${label} must not contain duplicate capabilities`);
	}
	return grants.sort((left, right) => left.capability.localeCompare(right.capability));
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

function assertJsonData(value: unknown, label: string): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			assertJsonData(entry, `${label}[${index}]`);
		});
		return;
	}
	if (typeof value !== "object" || value === null) throw new Error(`${label} must contain JSON data`);
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key.includes("\0")) throw new Error(`${label} contains an invalid key`);
		assertJsonData(entry, `${label}.${key}`);
	}
}

function parseComponentSelection(value: unknown, label: string): EvoComponentSelection {
	const selection = asRecord(value, label);
	rejectUnknownKeys(selection, COMPONENT_SELECTION_KEYS, label);
	if (typeof selection.id !== "string" || !COMPONENT_ID_PATTERN.test(selection.id) || selection.id.length > 128) {
		throw new Error(`${label}.id is invalid`);
	}
	if (typeof selection.abi !== "string" || !COMPONENT_ABI_PATTERN.test(selection.abi) || selection.abi.length > 128) {
		throw new Error(`${label}.abi is invalid`);
	}
	if (typeof selection.artifactDigest !== "string" || !isDigest(selection.artifactDigest)) {
		throw new Error(`${label}.artifactDigest must be a digest`);
	}
	let config: Record<string, unknown> | undefined;
	if (selection.config !== undefined) {
		config = asRecord(selection.config, `${label}.config`);
		assertJsonData(config, `${label}.config`);
	}
	const grants = parseCapabilityGrants(selection.grants, `${label}.grants`);
	return {
		id: selection.id,
		abi: selection.abi,
		artifactDigest: selection.artifactDigest,
		...(config ? { config } : {}),
		...(grants ? { grants } : {}),
	};
}

function parseComponents(value: unknown): Record<string, EvoComponentSelection> | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value, "policy.components");
	const result: Record<string, EvoComponentSelection> = {};
	for (const surface of Object.keys(record).sort()) {
		if (!COMPONENT_SURFACE_PATTERN.test(surface) || surface.length > 128) {
			throw new Error(`policy.components has an invalid surface: ${surface}`);
		}
		if (surface === "tool" || surface === "workflow") {
			throw new Error(`policy.components.${surface} must use the plural policy field`);
		}
		result[surface] = parseComponentSelection(record[surface], `policy.components.${surface}`);
	}
	return result;
}

function parseTools(value: unknown): EvoComponentSelection[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("policy.tools must be an array");
	const tools = value.map((entry, index) => {
		const tool = parseComponentSelection(entry, `policy.tools[${index}]`);
		if (tool.abi !== "tool/v1") throw new Error(`policy.tools[${index}].abi must be tool/v1`);
		return tool;
	});
	if (new Set(tools.map((tool) => tool.id)).size !== tools.length) {
		throw new Error("policy.tools must not contain duplicate ids");
	}
	return tools;
}

function parseWorkflows(value: unknown): EvoWorkflowSelection[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("policy.workflows must be an array");
	const workflows = value.map((entry, index): EvoWorkflowSelection => {
		const label = `policy.workflows[${index}]`;
		const record = asRecord(entry, label);
		rejectUnknownKeys(record, new Set([...COMPONENT_SELECTION_KEYS, "trigger"]), label);
		if (typeof record.trigger !== "string" || !WORKFLOW_TRIGGER_PATTERN.test(record.trigger)) {
			throw new Error(`${label}.trigger must look like /name`);
		}
		const selection = parseComponentSelection(
			{
				id: record.id,
				abi: record.abi,
				artifactDigest: record.artifactDigest,
				...(record.config === undefined ? {} : { config: record.config }),
				...(record.grants === undefined ? {} : { grants: record.grants }),
			},
			label,
		);
		if (selection.abi !== "workflow/v1") throw new Error(`${label}.abi must be workflow/v1`);
		return { ...selection, trigger: record.trigger };
	});
	if (new Set(workflows.map((workflow) => workflow.id)).size !== workflows.length) {
		throw new Error("policy.workflows must not contain duplicate ids");
	}
	if (new Set(workflows.map((workflow) => workflow.trigger)).size !== workflows.length) {
		throw new Error("policy.workflows must not contain duplicate triggers");
	}
	return workflows;
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
		path === "memory/preferences.json" ||
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
		components: parseComponents(record.components),
		tools: parseTools(record.tools),
		workflows: parseWorkflows(record.workflows),
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
	const codePartIds = [
		...Object.values(policy.components ?? {}).map((selection) => selection.id),
		...(policy.tools ?? []).map((selection) => selection.id),
		...(policy.workflows ?? []).map((selection) => selection.id),
	];
	if (new Set(codePartIds).size !== codePartIds.length) {
		throw new Error("policy code selections must not contain duplicate ids");
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
