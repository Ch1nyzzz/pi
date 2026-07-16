/**
 * Pack import — data-type parts (S1).
 *
 * Maps a pack's data-type contents (skills, prompts) to bundle-relative
 * DraftChanges. This module is the pure mapping layer: it produces the file
 * changes and reports which bundle assets were added, so the integration layer
 * can update policy.json (prompt order / managed sources) and stage a data
 * proposal against the current stable bundle.
 *
 * Scope note (v1): skills and prompts are pure-additive bundle assets. Structured
 * `memory/preferences.json` requires a schema-aware merge with the parent bundle
 * and is intentionally deferred — pack memory is reported as skipped rather than
 * silently overwriting active preferences. Code-type parts (components,
 * workflows) are handled by the ABI activation path, not here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DraftChange } from "../proposal.ts";
import type { EvoPackManifest } from "./pack.ts";

const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Derive a bundle-legal asset name (ASSET_NAME_PATTERN) from arbitrary text. */
function sanitizeAssetName(raw: string): string {
	const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
	return cleaned.length > 0 ? cleaned.slice(0, 64) : "pack";
}

export interface PackDataChanges {
	/** Bundle-relative file changes to stage in a data proposal. */
	changes: DraftChange[];
	/** Bundle paths of prompt assets added (for policy promptOrder update). */
	addedPromptPaths: string[];
	/** Bundle paths of skill assets added. */
	addedSkillPaths: string[];
	/** Count of memory parts skipped (structured merge deferred). */
	skippedMemory: number;
}

/**
 * Build the bundle DraftChanges for a pack's data-type contents. Reads each
 * referenced file from `packDir`. Pure w.r.t. the registry: no bundle is
 * mutated; the caller stages these as a proposal.
 */
export async function buildPackDataChanges(packDir: string, manifest: EvoPackManifest): Promise<PackDataChanges> {
	const changes: DraftChange[] = [];
	const addedPromptPaths: string[] = [];
	const addedSkillPaths: string[] = [];
	const usedPaths = new Set<string>();

	// Skills — pure-additive `skills/<name>/SKILL.md`.
	for (const skill of manifest.contents.skills) {
		if (!ASSET_NAME_PATTERN.test(skill.name)) {
			throw new Error(`pack skill name is not a valid bundle asset name: ${skill.name}`);
		}
		const path = `skills/${skill.name}/SKILL.md`;
		if (usedPaths.has(path)) throw new Error(`pack has duplicate skill target: ${path}`);
		usedPaths.add(path);
		const content = await readFile(join(packDir, skill.dir, "SKILL.md"), "utf8");
		changes.push({ path, content });
		addedSkillPaths.push(path);
	}

	// Prompts — mapped to uniquely-named `prompts/<name>.md` assets.
	const usedNames = new Set<string>();
	for (const [index, prompt] of manifest.contents.prompts.entries()) {
		let name = sanitizeAssetName(`${manifest.name}-${prompt.target}-${index + 1}`);
		while (usedNames.has(name)) name = sanitizeAssetName(`${name}-x`);
		usedNames.add(name);
		if (!ASSET_NAME_PATTERN.test(name)) throw new Error(`derived prompt asset name is invalid: ${name}`);
		const path = `prompts/${name}.md`;
		if (usedPaths.has(path)) throw new Error(`pack has duplicate prompt target: ${path}`);
		usedPaths.add(path);
		const content = await readFile(join(packDir, prompt.file), "utf8");
		changes.push({ path, content });
		addedPromptPaths.push(path);
	}

	return {
		changes,
		addedPromptPaths,
		addedSkillPaths,
		skippedMemory: manifest.contents.memory.length,
	};
}
