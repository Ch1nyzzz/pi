/**
 * Pack import — data-type parts (S1).
 *
 * Maps a pack's data-type contents (skills, prompts) to bundle-relative
 * DraftChanges. This module is the pure mapping layer: it produces the file
 * changes and reports which bundle assets were added, so the integration layer
 * can update policy.json (prompt order / managed sources) and stage a data
 * proposal against the current stable bundle.
 *
 * Skills and prompts are pure-additive bundle assets. Structured preference
 * memory is parsed, merged append-only with the parent bundle, and rewritten
 * with pack provenance. Code-type parts (components, workflows) are handled by
 * the ABI activation path, not here.
 */

import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadCompiledBundle } from "../bundle/compile.ts";
import { parseBundlePolicy } from "../bundle/schema.ts";
import {
	type InspectedEvoComponentArtifact,
	inspectEvoComponentArtifact,
	publishInspectedEvoComponentArtifact,
} from "../components/artifact.ts";
import { type EvoCapabilityGrant, parseEvoCapabilityGrants } from "../components/capabilities/broker.ts";
import { createDefaultEvoAbiRegistry } from "../components/registry.ts";
import { createUnknownAbiBuilderRequestsFromPack, type UnknownAbiBuilderRequest } from "../evolve/unknown-abi.ts";
import {
	PREFERENCES_PATH,
	type PreferenceMemory,
	parsePreferenceMemory,
	readBundlePreferenceMemory,
} from "../memory/preferences.ts";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "../paths.ts";
import { type DraftChange, type DraftProposal, stageProposal } from "../proposal.ts";
import { copyRegularFileNoFollow, readRegularDirectoryNoFollow, resolveRegularDirectory } from "../secure-file.ts";
import type { BundlePolicy, Proposal } from "../types.ts";
import {
	computeEvoPackIntegrity,
	type EvoPackComponent,
	type EvoPackManifest,
	type EvoPackWorkflow,
	loadEvoPack,
} from "./pack.ts";

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
	/** Number of new durable preferences appended from memory parts. */
	addedMemoryPreferences: number;
}

/**
 * Build the bundle DraftChanges for a pack's data-type contents. Reads each
 * referenced file from `packDir`. Pure w.r.t. the registry: no bundle is
 * mutated; the caller stages these as a proposal.
 */
export async function buildPackDataChanges(
	packDir: string,
	manifest: EvoPackManifest,
	parentMemory: PreferenceMemory = { schemaVersion: 1, preferences: [] },
): Promise<PackDataChanges> {
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

	const mergedMemory: PreferenceMemory = {
		schemaVersion: 1,
		preferences: [...parentMemory.preferences],
	};
	let addedMemoryPreferences = 0;
	const integrity = manifest.integrity ?? (await computeEvoPackIntegrity(packDir, manifest));
	for (const memory of manifest.contents.memory) {
		const fragment = parsePreferenceMemory(JSON.parse(await readFile(join(packDir, memory.file), "utf8")) as unknown);
		for (const preference of fragment.preferences) {
			const existingId = mergedMemory.preferences.find((entry) => entry.id === preference.id);
			if (existingId) {
				if (existingId.instruction !== preference.instruction) {
					throw new Error(`pack preference id conflicts with the active bundle: ${preference.id}`);
				}
				continue;
			}
			if (mergedMemory.preferences.some((entry) => entry.instruction === preference.instruction)) continue;
			mergedMemory.preferences.push({
				...preference,
				source: {
					packName: manifest.name,
					packVersion: manifest.version,
					integrity,
					file: memory.file,
				},
			});
			addedMemoryPreferences += 1;
		}
	}
	if (addedMemoryPreferences > 0) {
		const validated = parsePreferenceMemory(mergedMemory);
		changes.push({ path: PREFERENCES_PATH, content: `${JSON.stringify(validated, undefined, "\t")}\n` });
	}

	return {
		changes,
		addedPromptPaths,
		addedSkillPaths,
		addedMemoryPreferences,
	};
}

export interface PackImportResult {
	manifest: EvoPackManifest;
	/** The staged data proposal, or undefined when the pack has no data-type parts. */
	proposal: Proposal | undefined;
	addedSkillPaths: string[];
	addedPromptPaths: string[];
	addedMemoryPreferences: number;
	/** Code-type parts (components + workflows) not handled by the data path. */
	skippedCode: number;
}

function createPackDataDraft(manifest: EvoPackManifest, data: PackDataChanges): DraftProposal | undefined {
	if (data.changes.length === 0) return undefined;
	return {
		motivation: `Import optimization pack "${manifest.name}"`,
		expectedEffect: `Add ${data.addedSkillPaths.length} skill(s), ${data.addedPromptPaths.length} prompt(s), and ${data.addedMemoryPreferences} preference(s) from pack ${manifest.name}@${manifest.version}`,
		risk: "Data-only bundle additions (skills/prompts/preferences); reversible via trial/rollback.",
		verifyPlan: "bundle-compile",
		trialPlan: "Activate in a reversible data trial, then keep or rollback.",
		source: "explicit-request",
		evidence: [],
		inboxReferences: [],
		replayScenarios: [],
		changes: data.changes,
	};
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
	/** Reject if the pack changed after a caller's read-only preflight. */
	expectedIntegrity?: string;
}): Promise<PackImportResult> {
	const { manifest, integrity } = await loadEvoPack(options.packDir);
	if (!integrity.ok) {
		throw new Error(
			`pack integrity check failed: expected ${integrity.expected ?? "(none declared)"}, got ${integrity.actual}`,
		);
	}
	if (options.expectedIntegrity !== undefined && integrity.actual !== options.expectedIntegrity) {
		throw new Error(`pack changed after preflight: expected ${options.expectedIntegrity}, got ${integrity.actual}`);
	}
	const snapshotDirectory = await createVerifiedPackSnapshot({
		paths: options.paths,
		packDir: options.packDir,
		manifest,
		expectedIntegrity: integrity.actual,
	});
	try {
		const parent = await loadCompiledBundle(options.paths, options.parentDigest);
		const data = await buildPackDataChanges(snapshotDirectory, manifest, await readBundlePreferenceMemory(parent));
		const skippedCode = manifest.contents.components.length + manifest.contents.workflows.length;
		const draft = createPackDataDraft(manifest, data);
		if (!draft) {
			return {
				manifest,
				proposal: undefined,
				addedSkillPaths: [],
				addedPromptPaths: [],
				addedMemoryPreferences: data.addedMemoryPreferences,
				skippedCode,
			};
		}
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
			addedMemoryPreferences: data.addedMemoryPreferences,
			skippedCode,
		};
	} finally {
		await rm(snapshotDirectory, { recursive: true, force: true });
	}
}

export interface ImportedPackComponent {
	surface: string;
	abi: string;
	id: string;
	trigger?: string;
	artifactDigest: string;
	proposal: Proposal;
}

export interface EvoPackImportResult extends PackImportResult {
	importedComponents: ImportedPackComponent[];
	/** ABIs that require a T2 host-wiring proposal before their parts can activate. */
	unregisteredAbis: string[];
	/** Workflow parts whose ABI is not registered and therefore cannot be staged yet. */
	pendingWorkflows: number;
	/** Frozen, fully validated Builder inputs for code parts whose ABI is not registered. */
	unknownAbiRequests: UnknownAbiBuilderRequest[];
}

export interface EvoPackImportPreflight {
	manifest: EvoPackManifest;
	integrity: string;
	/** Private verified snapshot; valid only until the beforeStage callback returns. */
	packDirectory: string;
	unregisteredAbis: string[];
	pendingWorkflows: number;
	unknownAbiRequests: UnknownAbiBuilderRequest[];
}

type EvoPackCodePart = { kind: "component"; part: EvoPackComponent } | { kind: "workflow"; part: EvoPackWorkflow };

function referencedPackPaths(manifest: EvoPackManifest): string[] {
	return [
		...manifest.contents.prompts.map((part) => part.file),
		...manifest.contents.skills.map((part) => part.dir),
		...manifest.contents.memory.map((part) => part.file),
		...manifest.contents.components.map((part) => part.artifact),
		...manifest.contents.workflows.map((part) => part.artifact),
	];
}

async function copyPackSnapshotPath(sourceRoot: string, targetRoot: string, relativePath: string): Promise<void> {
	const source = join(sourceRoot, relativePath);
	const target = join(targetRoot, relativePath);
	const metadata = await lstat(source);
	if (metadata.isSymbolicLink()) throw new Error(`pack path is a symlink: ${relativePath}`);
	if (metadata.isDirectory()) {
		await mkdir(target, { recursive: true, mode: 0o700 });
		const entries = (await readRegularDirectoryNoFollow(source, `pack directory ${relativePath}`)).sort(
			(left, right) => left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new Error(`pack path is a symlink: ${relativePath}/${entry.name}`);
			await copyPackSnapshotPath(sourceRoot, targetRoot, `${relativePath}/${entry.name}`);
		}
		return;
	}
	if (!metadata.isFile()) throw new Error(`pack path is neither file nor directory: ${relativePath}`);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await copyRegularFileNoFollow(source, target, `pack file ${relativePath}`);
}

async function createVerifiedPackSnapshot(options: {
	paths: EvoPaths;
	packDir: string;
	manifest: EvoPackManifest;
	expectedIntegrity: string;
}): Promise<string> {
	const snapshotDirectory = await mkdtemp(join(options.paths.root, ".pack-import-"));
	try {
		const sourceRoot = await resolveRegularDirectory(options.packDir, "pack directory");
		for (const relativePath of new Set(referencedPackPaths(options.manifest))) {
			await copyPackSnapshotPath(sourceRoot, snapshotDirectory, relativePath);
		}
		await writeFile(join(snapshotDirectory, "pack.json"), `${JSON.stringify(options.manifest, undefined, "\t")}\n`, {
			mode: 0o600,
		});
		const snapshot = await loadEvoPack(snapshotDirectory);
		if (!snapshot.integrity.ok || snapshot.integrity.actual !== options.expectedIntegrity) {
			throw new Error(
				`pack changed while creating import snapshot: expected ${options.expectedIntegrity}, got ${snapshot.integrity.actual}`,
			);
		}
		return snapshotDirectory;
	} catch (error) {
		await rm(snapshotDirectory, { recursive: true, force: true });
		throw error;
	}
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function preflightPackGrants(
	codeParts: readonly EvoPackCodePart[],
	grantsByComponent: Readonly<Record<string, readonly EvoCapabilityGrant[]>> | undefined,
): Readonly<Record<string, readonly EvoCapabilityGrant[]>> {
	const codePartIds = new Set(codeParts.map((codePart) => codePart.part.id));
	for (const id of Object.keys(grantsByComponent ?? {})) {
		if (!codePartIds.has(id)) throw new Error(`Capability grants reference an unknown pack component: ${id}`);
	}
	const normalized: Record<string, readonly EvoCapabilityGrant[]> = {};
	for (const codePart of codeParts) {
		const part = codePart.part;
		const grants = parseEvoCapabilityGrants(grantsByComponent?.[part.id] ?? [], `grants for ${part.id}`);
		if (
			!sameStringSet(
				part.capabilities,
				grants.map((grant) => grant.capability),
			)
		) {
			throw new Error(
				`Component ${part.id} requires an explicit grant for every declared capability: ${part.capabilities.join(", ") || "(none)"}`,
			);
		}
		normalized[part.id] = grants;
	}
	return normalized;
}

interface PreparedPackCodePart {
	codePart: EvoPackCodePart;
	surface: string;
	abi: string;
	artifact: InspectedEvoComponentArtifact;
	policy: BundlePolicy;
}

function addCodeSelectionToPolicy(
	policy: BundlePolicy,
	codePart: EvoPackCodePart,
	surface: string,
	selection: {
		id: string;
		abi: string;
		artifactDigest: string;
		config: Record<string, unknown>;
		grants?: EvoCapabilityGrant[];
	},
): BundlePolicy {
	return parseBundlePolicy(
		codePart.kind === "workflow"
			? {
					...policy,
					workflows: [...(policy.workflows ?? []), { ...selection, trigger: codePart.part.trigger }],
				}
			: surface === "tool"
				? {
						...policy,
						...(policy.enabledTools === undefined
							? {}
							: { enabledTools: [...new Set([...policy.enabledTools, selection.id])] }),
						tools: [...(policy.tools ?? []), selection],
					}
				: {
						...policy,
						components: {
							...(policy.components ?? {}),
							[surface]: selection,
						},
					},
	);
}

async function prepareRegisteredCodeParts(options: {
	packDirectory: string;
	codeParts: readonly EvoPackCodePart[];
	grantsByComponent: Readonly<Record<string, readonly EvoCapabilityGrant[]>>;
	parentPolicy: BundlePolicy;
}): Promise<{ prepared: PreparedPackCodePart[]; unregisteredAbis: string[]; pendingWorkflows: number }> {
	const registry = createDefaultEvoAbiRegistry();
	const prepared: PreparedPackCodePart[] = [];
	const unregisteredAbis = new Set<string>();
	let pendingWorkflows = 0;
	let policy = options.parentPolicy;
	for (const codePart of options.codeParts) {
		const part = codePart.part;
		const abi = registry.get(part.abi);
		if (!abi) {
			unregisteredAbis.add(part.abi);
			if (codePart.kind === "workflow") pendingWorkflows += 1;
			continue;
		}
		const surface = codePart.kind === "workflow" ? "workflow" : codePart.part.surface;
		if (abi.surface !== surface) {
			throw new Error(
				`Pack component ${part.id} declares surface ${surface}, but ${abi.id} belongs to ${abi.surface}`,
			);
		}
		const artifact = await inspectEvoComponentArtifact(join(options.packDirectory, part.artifact), registry);
		if (
			artifact.manifest.id !== part.id ||
			artifact.manifest.abi !== part.abi ||
			!sameStringSet(artifact.manifest.capabilities, part.capabilities)
		) {
			throw new Error(`Pack component declaration does not match imported artifact: ${part.id}`);
		}
		const grants = [...(options.grantsByComponent[part.id] ?? [])];
		const selectionWithoutConfig = {
			id: artifact.manifest.id,
			abi: artifact.manifest.abi,
			artifactDigest: artifact.manifest.artifactDigest,
			...(grants.length === 0 ? {} : { grants }),
		};
		const config = registry.validateSelection(surface, { ...selectionWithoutConfig, config: {} }) as Record<
			string,
			unknown
		>;
		policy = addCodeSelectionToPolicy(policy, codePart, surface, { ...selectionWithoutConfig, config });
		prepared.push({ codePart, surface, abi: abi.id, artifact, policy });
	}
	return { prepared, unregisteredAbis: [...unregisteredAbis].sort(), pendingWorkflows };
}

async function stagePreparedCodePart(options: {
	paths: EvoPaths;
	parentDigest: string;
	packName: string;
	packVersion: string;
	prepared: PreparedPackCodePart;
}): Promise<ImportedPackComponent> {
	const part = options.prepared.codePart.part;
	const artifact = await publishInspectedEvoComponentArtifact(options.paths, options.prepared.artifact);
	const proposal = await stageProposal({
		paths: options.paths,
		parentDigest: options.parentDigest,
		draft: {
			motivation: `Import component ${part.id} from optimization pack "${options.packName}"`,
			expectedEffect: `Register ${part.id} on the registered ${options.prepared.abi} host ABI`,
			risk: "Sandboxed empty-ceiling component selection; activation is limited to a reversible Canary trial.",
			verifyPlan: `Verify artifact identity and execute the deterministic ${options.prepared.abi} fixture before Canary approval.`,
			trialPlan: "Activate for new sessions as a reversible Canary; keep or rollback after focused review.",
			source: "explicit-request",
			evidence: [],
			inboxReferences: [],
			replayScenarios: [],
			targetAbi: options.prepared.abi,
			requiresNewAbi: false,
			changes: [{ path: "policy.json", content: `${JSON.stringify(options.prepared.policy, undefined, "\t")}\n` }],
		},
		observationsMarkdown: `Imported component from optimization pack ${options.packName}@${options.packVersion}.`,
	});
	return {
		surface: options.prepared.surface,
		abi: options.prepared.abi,
		id: artifact.manifest.id,
		...(options.prepared.codePart.kind === "workflow" ? { trigger: options.prepared.codePart.part.trigger } : {}),
		artifactDigest: artifact.manifest.artifactDigest,
		proposal,
	};
}

async function preflightPackStages(options: {
	targetPaths: EvoPaths;
	snapshotDirectory: string;
	parentDigest: string;
	parentPolicy: BundlePolicy;
	parentDirectory: string;
	manifest: EvoPackManifest;
	dataDraft?: DraftProposal;
	preparedCode: readonly PreparedPackCodePart[];
}): Promise<void> {
	const shadowPaths = getEvoPaths(join(options.snapshotDirectory, ".staging-preflight"));
	await ensureEvoLayout(shadowPaths);
	await cp(options.parentDirectory, join(shadowPaths.bundles, options.parentDigest), { recursive: true });
	for (const selection of Object.values(options.parentPolicy.components ?? {})) {
		await cp(
			join(options.targetPaths.components, selection.artifactDigest),
			join(shadowPaths.components, selection.artifactDigest),
			{ recursive: true },
		);
	}
	let candidateParentDigest = options.parentDigest;
	if (options.dataDraft) {
		const proposal = await stageProposal({
			paths: shadowPaths,
			parentDigest: candidateParentDigest,
			draft: options.dataDraft,
			observationsMarkdown: `Preflight optimization pack ${options.manifest.name}@${options.manifest.version}.`,
		});
		if (!proposal.candidateDigest) throw new Error("Pack data preflight proposal has no candidate bundle");
		candidateParentDigest = proposal.candidateDigest;
	}
	for (const prepared of options.preparedCode) {
		const imported = await stagePreparedCodePart({
			paths: shadowPaths,
			parentDigest: candidateParentDigest,
			packName: options.manifest.name,
			packVersion: options.manifest.version,
			prepared,
		});
		if (!imported.proposal.candidateDigest) {
			throw new Error(`Pack component preflight proposal has no candidate bundle: ${prepared.codePart.part.id}`);
		}
		candidateParentDigest = imported.proposal.candidateDigest;
	}
}

/**
 * Full pack staging entry point. Data assets use the existing reversible data
 * proposal. Registered, empty-ceiling components are verified into the local
 * content-addressed store and each receives its own focused selection proposal.
 * Unknown ABIs are reported for the later T2 Builder path; nothing activates
 * during import.
 */
export async function importEvoPack(options: {
	paths: EvoPaths;
	parentDigest: string;
	packDir: string;
	/** Reject if the pack changed after a caller's read-only approval preview. */
	expectedIntegrity?: string;
	/** Explicit artifact grants keyed by the pack's globally unique component id. */
	grantsByComponent?: Readonly<Record<string, readonly EvoCapabilityGrant[]>>;
	/**
	 * Runs after the entire pack is validated but before this importer publishes
	 * artifacts or stages proposals. A failure leaves no pack-owned durable state.
	 * Side effects created inside the callback belong to that independent
	 * transaction and are not deleted by this importer.
	 */
	beforeStage?: (preflight: EvoPackImportPreflight) => Promise<void>;
}): Promise<EvoPackImportResult> {
	const preflight = await loadEvoPack(options.packDir);
	if (!preflight.integrity.ok) {
		throw new Error(
			`pack integrity check failed: expected ${preflight.integrity.expected ?? "(none declared)"}, got ${preflight.integrity.actual}`,
		);
	}
	if (options.expectedIntegrity !== undefined && preflight.integrity.actual !== options.expectedIntegrity) {
		throw new Error(
			`pack changed after preflight: expected ${options.expectedIntegrity}, got ${preflight.integrity.actual}`,
		);
	}
	const codeParts: EvoPackCodePart[] = [
		...preflight.manifest.contents.components.map((part): EvoPackCodePart => ({ kind: "component", part })),
		...preflight.manifest.contents.workflows.map((part): EvoPackCodePart => ({ kind: "workflow", part })),
	];
	const grantsByComponent = preflightPackGrants(codeParts, options.grantsByComponent);
	const snapshotDirectory = await createVerifiedPackSnapshot({
		paths: options.paths,
		packDir: options.packDir,
		manifest: preflight.manifest,
		expectedIntegrity: preflight.integrity.actual,
	});
	try {
		const parent = await loadCompiledBundle(options.paths, options.parentDigest);
		const data = await buildPackDataChanges(
			snapshotDirectory,
			preflight.manifest,
			await readBundlePreferenceMemory(parent),
		);
		const dataDraft = createPackDataDraft(preflight.manifest, data);
		const preparedCode = await prepareRegisteredCodeParts({
			packDirectory: snapshotDirectory,
			codeParts,
			grantsByComponent,
			parentPolicy: parent.policy,
		});
		const unknownAbiRequests = await createUnknownAbiBuilderRequestsFromPack({
			packDirectory: snapshotDirectory,
			grantsByComponent,
		});
		if (
			unknownAbiRequests
				.map((request) => request.targetAbi)
				.sort()
				.join("\n") !== preparedCode.unregisteredAbis.join("\n")
		) {
			throw new Error("Pack registered and unknown-ABI preflight disagreed");
		}
		await preflightPackStages({
			targetPaths: options.paths,
			snapshotDirectory,
			parentDigest: options.parentDigest,
			parentPolicy: parent.policy,
			parentDirectory: parent.directory,
			manifest: preflight.manifest,
			...(dataDraft ? { dataDraft } : {}),
			preparedCode: preparedCode.prepared,
		});
		await rm(join(snapshotDirectory, ".staging-preflight"), { recursive: true, force: true });
		await options.beforeStage?.({
			manifest: preflight.manifest,
			integrity: preflight.integrity.actual,
			packDirectory: snapshotDirectory,
			unregisteredAbis: preparedCode.unregisteredAbis,
			pendingWorkflows: preparedCode.pendingWorkflows,
			unknownAbiRequests,
		});

		const proposal = dataDraft
			? await stageProposal({
					paths: options.paths,
					parentDigest: options.parentDigest,
					draft: dataDraft,
					observationsMarkdown: `Imported from optimization pack ${preflight.manifest.name}@${preflight.manifest.version}.`,
				})
			: undefined;
		const importedComponents: ImportedPackComponent[] = [];
		let candidateParentDigest = proposal?.candidateDigest ?? options.parentDigest;
		for (const prepared of preparedCode.prepared) {
			const imported = await stagePreparedCodePart({
				paths: options.paths,
				parentDigest: candidateParentDigest,
				packName: preflight.manifest.name,
				packVersion: preflight.manifest.version,
				prepared,
			});
			importedComponents.push(imported);
			if (!imported.proposal.candidateDigest) {
				throw new Error(`Imported component proposal has no candidate bundle: ${prepared.codePart.part.id}`);
			}
			candidateParentDigest = imported.proposal.candidateDigest;
		}
		return {
			manifest: preflight.manifest,
			proposal,
			addedSkillPaths: data.addedSkillPaths,
			addedPromptPaths: data.addedPromptPaths,
			addedMemoryPreferences: data.addedMemoryPreferences,
			skippedCode: codeParts.length,
			importedComponents,
			unregisteredAbis: preparedCode.unregisteredAbis,
			pendingWorkflows: preparedCode.pendingWorkflows,
			unknownAbiRequests,
		};
	} finally {
		await rm(snapshotDirectory, { recursive: true, force: true });
	}
}
