import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompiledBundle } from "../types.ts";

export const PREFERENCES_PATH = "memory/preferences.json";
const PREFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_PREFERENCES = 100;
const MAX_INSTRUCTION_CHARACTERS = 2_000;
const MAX_TOTAL_INSTRUCTION_CHARACTERS = 16_000;

export interface DurablePreferenceSource {
	sessionId: string;
	sequence: number;
	quote: string;
}

export interface DurablePreference {
	id: string;
	instruction: string;
	source: DurablePreferenceSource;
	addedAt: string;
}

export interface PreferenceMemory {
	schemaVersion: 1;
	preferences: DurablePreference[];
}

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

export function parsePreferenceMemory(value: unknown): PreferenceMemory {
	const root = asRecord(value, PREFERENCES_PATH);
	exactKeys(root, ["schemaVersion", "preferences"], PREFERENCES_PATH);
	if (root.schemaVersion !== 1) throw new Error(`${PREFERENCES_PATH} schemaVersion must be 1`);
	if (!Array.isArray(root.preferences) || root.preferences.length > MAX_PREFERENCES) {
		throw new Error(`${PREFERENCES_PATH} preferences must be an array with at most ${MAX_PREFERENCES} entries`);
	}
	const preferences = root.preferences.map((value, index): DurablePreference => {
		const label = `${PREFERENCES_PATH}.preferences[${index}]`;
		const entry = asRecord(value, label);
		exactKeys(entry, ["id", "instruction", "source", "addedAt"], label);
		if (typeof entry.id !== "string" || !PREFERENCE_ID_PATTERN.test(entry.id)) {
			throw new Error(`${label}.id is invalid`);
		}
		if (
			typeof entry.instruction !== "string" ||
			!entry.instruction.trim() ||
			entry.instruction !== entry.instruction.trim() ||
			entry.instruction.length > MAX_INSTRUCTION_CHARACTERS
		) {
			throw new Error(`${label}.instruction must be trimmed and contain 1-${MAX_INSTRUCTION_CHARACTERS} characters`);
		}
		if (typeof entry.addedAt !== "string" || !Number.isFinite(Date.parse(entry.addedAt))) {
			throw new Error(`${label}.addedAt is invalid`);
		}
		const source = asRecord(entry.source, `${label}.source`);
		exactKeys(source, ["sessionId", "sequence", "quote"], `${label}.source`);
		if (typeof source.sessionId !== "string" || !SESSION_ID_PATTERN.test(source.sessionId)) {
			throw new Error(`${label}.source.sessionId is invalid`);
		}
		if (!Number.isSafeInteger(source.sequence) || (source.sequence as number) <= 0) {
			throw new Error(`${label}.source.sequence must be a positive integer`);
		}
		if (
			typeof source.quote !== "string" ||
			!source.quote.includes(entry.instruction) ||
			source.quote.length > 16_000
		) {
			throw new Error(`${label}.source.quote must contain the exact instruction`);
		}
		return {
			id: entry.id,
			instruction: entry.instruction,
			source: {
				sessionId: source.sessionId,
				sequence: source.sequence as number,
				quote: source.quote,
			},
			addedAt: entry.addedAt,
		};
	});
	if (new Set(preferences.map((entry) => entry.id)).size !== preferences.length) {
		throw new Error(`${PREFERENCES_PATH} contains duplicate ids`);
	}
	if (new Set(preferences.map((entry) => entry.instruction)).size !== preferences.length) {
		throw new Error(`${PREFERENCES_PATH} contains duplicate instructions`);
	}
	if (preferences.reduce((total, entry) => total + entry.instruction.length, 0) > MAX_TOTAL_INSTRUCTION_CHARACTERS) {
		throw new Error(`${PREFERENCES_PATH} active instructions exceed ${MAX_TOTAL_INSTRUCTION_CHARACTERS} characters`);
	}
	return { schemaVersion: 1, preferences };
}

export async function readBundlePreferenceMemory(bundle: CompiledBundle): Promise<PreferenceMemory> {
	if (!bundle.manifest.files.some((file) => file.path === PREFERENCES_PATH)) {
		return { schemaVersion: 1, preferences: [] };
	}
	return parsePreferenceMemory(JSON.parse(await readFile(join(bundle.directory, PREFERENCES_PATH), "utf8")));
}

export function renderPreferenceInstructions(memory: PreferenceMemory): string {
	if (memory.preferences.length === 0) return "";
	return [
		"## Durable user preferences",
		"",
		"Treat these as the user's cross-task defaults. A newer explicit instruction in the current conversation may override them.",
		"",
		...memory.preferences.map((preference) => `- ${preference.instruction}`),
	].join("\n");
}

export async function renderBundlePreferenceInstructions(bundle: CompiledBundle): Promise<string> {
	return renderPreferenceInstructions(await readBundlePreferenceMemory(bundle));
}
