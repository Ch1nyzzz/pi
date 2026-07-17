import { copyFile, readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@ch1nyzzz/pi-agent-core";
import type { EvoPaths } from "../paths.ts";
import { ensureEvoLayout } from "../paths.ts";
import { atomicWriteFile, atomicWriteJson, readJsonIfExists } from "../storage.ts";
import type { EvoControlConfig, EvoRoleModelConfig } from "../types.ts";

const DEFAULT_WORKFLOW_URL = new URL("../prompts/evolution-workflow.md", import.meta.url);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const DEFAULT_EVO_CONTROL_CONFIG: Readonly<EvoControlConfig> = {
	schemaVersion: 1,
	models: {
		researchPlanner: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "max" },
		builder: { model: "openai-codex/gpt-5.6-terra", thinkingLevel: "max" },
		evaluator: { model: "openai-codex/gpt-5.6-terra", thinkingLevel: "xhigh" },
		triage: { model: "openai-codex/gpt-5.6-luna", thinkingLevel: "low" },
	},
	release: {
		autoApplyT0: true,
		autoStartDataTrial: true,
		autoStartComponentTrial: true,
		autoKeepSuccessfulTrial: true,
	},
	grants: {
		approval: "auto",
	},
	triage: {
		everyNSessions: 5,
	},
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const keys = new Set(allowed);
	for (const key of Object.keys(record)) if (!keys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
}

function parseRole(value: unknown, label: string): EvoRoleModelConfig {
	const role = asRecord(value, label);
	exactKeys(role, ["model", "thinkingLevel"], label);
	if (typeof role.model !== "string" || !role.model || role.model.length > 200 || /\s/.test(role.model)) {
		throw new Error(`${label}.model must be a provider/model route or unique model id`);
	}
	if (role.thinkingLevel !== undefined && !THINKING_LEVELS.has(role.thinkingLevel as ThinkingLevel)) {
		throw new Error(`${label}.thinkingLevel is invalid`);
	}
	return {
		model: role.model,
		...(role.thinkingLevel ? { thinkingLevel: role.thinkingLevel as ThinkingLevel } : {}),
	};
}

function parseEvoControlConfig(value: unknown): EvoControlConfig {
	const config = asRecord(value, "Evo control config");
	exactKeys(config, ["schemaVersion", "models", "release", "grants", "triage"], "Evo control config");
	if (config.schemaVersion !== 1) throw new Error("Evo control config schemaVersion must be 1");
	const models = asRecord(config.models, "Evo control config.models");
	exactKeys(models, ["researchPlanner", "builder", "evaluator", "triage"], "Evo control config.models");
	const release = asRecord(config.release, "Evo control config.release");
	exactKeys(
		release,
		["autoApplyT0", "autoStartDataTrial", "autoStartComponentTrial", "autoKeepSuccessfulTrial"],
		"Evo control config.release",
	);
	for (const key of [
		"autoApplyT0",
		"autoStartDataTrial",
		"autoStartComponentTrial",
		"autoKeepSuccessfulTrial",
	] as const) {
		if (typeof release[key] !== "boolean") throw new Error(`Evo control config.release.${key} must be boolean`);
	}
	let grantApproval: "auto" | "prompt" = "auto";
	if (config.grants !== undefined) {
		const grants = asRecord(config.grants, "Evo control config.grants");
		exactKeys(grants, ["approval"], "Evo control config.grants");
		if (grants.approval !== "auto" && grants.approval !== "prompt") {
			throw new Error("Evo control config.grants.approval must be 'auto' or 'prompt'");
		}
		grantApproval = grants.approval;
	}
	let triageEveryNSessions = DEFAULT_EVO_CONTROL_CONFIG.triage.everyNSessions;
	if (config.triage !== undefined) {
		const triage = asRecord(config.triage, "Evo control config.triage");
		exactKeys(triage, ["everyNSessions"], "Evo control config.triage");
		if (!Number.isSafeInteger(triage.everyNSessions) || (triage.everyNSessions as number) < 1) {
			throw new Error("Evo control config.triage.everyNSessions must be a positive integer");
		}
		triageEveryNSessions = triage.everyNSessions as number;
	}
	return {
		schemaVersion: 1,
		models: {
			researchPlanner: parseRole(models.researchPlanner, "Evo control config.models.researchPlanner"),
			builder: parseRole(models.builder, "Evo control config.models.builder"),
			evaluator: parseRole(models.evaluator, "Evo control config.models.evaluator"),
			triage:
				models.triage === undefined
					? DEFAULT_EVO_CONTROL_CONFIG.models.triage
					: parseRole(models.triage, "Evo control config.models.triage"),
		},
		release: {
			autoApplyT0: release.autoApplyT0 as boolean,
			autoStartDataTrial: release.autoStartDataTrial as boolean,
			autoStartComponentTrial: release.autoStartComponentTrial as boolean,
			autoKeepSuccessfulTrial: release.autoKeepSuccessfulTrial as boolean,
		},
		grants: {
			approval: grantApproval,
		},
		triage: {
			everyNSessions: triageEveryNSessions,
		},
	};
}

export async function ensureEvolutionConfiguration(paths: EvoPaths): Promise<void> {
	await ensureEvoLayout(paths);
	if (!(await readJsonIfExists(paths.config))) await atomicWriteJson(paths.config, DEFAULT_EVO_CONTROL_CONFIG);
	try {
		await readFile(paths.workflow, "utf8");
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		try {
			await copyFile(DEFAULT_WORKFLOW_URL, paths.workflow, 1);
		} catch (copyError) {
			if (
				typeof copyError !== "object" ||
				copyError === null ||
				!("code" in copyError) ||
				copyError.code !== "EEXIST"
			) {
				throw copyError;
			}
		}
	}
}

export async function readEvoControlConfig(paths: EvoPaths): Promise<EvoControlConfig> {
	await ensureEvolutionConfiguration(paths);
	return parseEvoControlConfig(JSON.parse(await readFile(paths.config, "utf8")));
}

const SETTABLE_CONFIG_KEY_PATTERN =
	/^(grants\.approval|triage\.everyNSessions|models\.(researchPlanner|builder|evaluator|triage)\.(model|thinkingLevel)|release\.(autoApplyT0|autoStartDataTrial|autoStartComponentTrial|autoKeepSuccessfulTrial))$/;

function coerceConfigValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^[0-9]+$/.test(raw)) return Number(raw);
	return raw;
}

/**
 * Set one whitelisted dotted config key and persist the result. The updated
 * object is re-validated through the same fail-closed parser as reads, so an
 * invalid value can never reach disk.
 */
export async function updateEvoControlConfigValue(
	paths: EvoPaths,
	key: string,
	rawValue: string,
): Promise<EvoControlConfig> {
	if (!SETTABLE_CONFIG_KEY_PATTERN.test(key)) {
		throw new Error(
			`Unsupported config key: ${key}. Settable keys: grants.approval, triage.everyNSessions, models.<role>.model, models.<role>.thinkingLevel, release.<flag>`,
		);
	}
	const current = await readEvoControlConfig(paths);
	const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
	const segments = key.split(".");
	let cursor: Record<string, unknown> = next;
	for (const segment of segments.slice(0, -1)) {
		cursor[segment] ??= {};
		cursor = cursor[segment] as Record<string, unknown>;
	}
	cursor[segments[segments.length - 1] as string] = coerceConfigValue(rawValue);
	const validated = parseEvoControlConfig(next);
	await atomicWriteJson(paths.config, validated);
	return validated;
}

export async function readEvolutionWorkflow(paths: EvoPaths): Promise<string> {
	await ensureEvolutionConfiguration(paths);
	const workflow = await readFile(paths.workflow, "utf8");
	if (!workflow.trim()) throw new Error("Evo workflow.md must not be empty");
	return workflow;
}

export async function resetEvolutionWorkflow(paths: EvoPaths): Promise<string> {
	await ensureEvoLayout(paths);
	const workflow = await readFile(DEFAULT_WORKFLOW_URL, "utf8");
	await atomicWriteFile(paths.workflow, workflow);
	return workflow;
}
