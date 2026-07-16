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
import type { EvoPaths } from "../paths.ts";
import { type DraftChange, type DraftProposal, stageProposal } from "../proposal.ts";
import type { Proposal } from "../types.ts";
import { type EvoPackManifest, loadEvoPack } from "./pack.ts";

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

export interface PackImportResult {
	manifest: EvoPackManifest;
	/** The staged data proposal, or undefined when the pack has no data-type parts. */
	proposal: Proposal | undefined;
	addedSkillPaths: string[];
	addedPromptPaths: string[];
	/** Memory parts skipped (structured merge deferred). */
	skippedMemory: number;
	/** Code-type parts (components + workflows) not handled by the data path. */
	skippedCode: number;
}

/**
 * Import a pack's data-type parts against the current stable bundle: verify
 * integrity, map skills/prompts to bundle changes, and stage a reversible data
 * proposal (T0/T1) via the existing proposal pipeline. Skills load from the
 * bundle `skills/` directory and prompts from `prompts/` automatically, so no
 * policy edit is required. Code-type parts (components/workflows) are counted
 * and left to the ABI activation path.
 */
export async function importPackData(options: {
	paths: EvoPaths;
	parentDigest: string;
	packDir: string;
}): Promise<PackImportResult> {
	const { manifest, integrity } = await loadEvoPack(options.packDir);
	if (!integrity.ok) {
		throw new Error(
			`pack integrity check failed: expected ${integrity.expected ?? "(none declared)"}, got ${integrity.actual}`,
		);
	}
	const data = await buildPackDataChanges(options.packDir, manifest);
	const skippedCode = manifest.contents.components.length + manifest.contents.workflows.length;

	if (data.changes.length === 0) {
		return {
			manifest,
			proposal: undefined,
			addedSkillPaths: [],
			addedPromptPaths: [],
			skippedMemory: data.skippedMemory,
			skippedCode,
		};
	}

	const draft: DraftProposal = {
		motivation: `Import optimization pack "${manifest.name}"`,
		expectedEffect: `Add ${data.addedSkillPaths.length} skill(s) and ${data.addedPromptPaths.length} prompt(s) from pack ${manifest.name}@${manifest.version}`,
		risk: "Data-only bundle additions (skills/prompts); reversible via trial/rollback.",
		verifyPlan: "bundle-compile",
		trialPlan: "Activate in a reversible data trial, then keep or rollback.",
		source: "explicit-request",
		evidence: [],
		inboxReferences: [],
		replayScenarios: [],
		changes: data.changes,
	};

	const proposal = await stageProposal({
		paths: options.paths,
		parentDigest: options.parentDigest,
		draft,
		observationsMarkdown: `Imported from optimization pack ${manifest.name}@${manifest.version}.`,
	});

	return {
		manifest,
		proposal,
		addedSkillPaths: data.addedSkillPaths,
		addedPromptPaths: data.addedPromptPaths,
		skippedMemory: data.skippedMemory,
		skippedCode,
	};
}
