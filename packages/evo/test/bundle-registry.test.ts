import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileBundle, loadCompiledBundle } from "../src/bundle/compile.ts";
import { renderRuntimeBundle, replaceRuntimeBundlePrompt } from "../src/bundle/runtime.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { BundlePolicy, CompiledBundle } from "../src/types.ts";

interface BundleSourceOptions {
	files?: ReadonlyArray<readonly [path: string, content: string]>;
	policy?: BundlePolicy;
}

const DEFAULT_FILES: ReadonlyArray<readonly [path: string, content: string]> = [
	["prompts/system.md", "Follow the repository instructions."],
	["memory/user.md", "The user prefers concise technical prose."],
];

const DEFAULT_POLICY: BundlePolicy = {
	schemaVersion: 1,
	promptOrder: ["prompts/system.md"],
	stablePromptPaths: ["prompts/system.md"],
	enabledTools: ["read"],
};

async function writeBundleSource(directory: string, options: BundleSourceOptions = {}): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "policy.json"),
		`${JSON.stringify(options.policy ?? DEFAULT_POLICY, undefined, "\t")}\n`,
	);
	for (const [path, content] of options.files ?? DEFAULT_FILES) {
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

async function compileSource(
	paths: EvoPaths,
	sourceDirectory: string,
	parentDigest: string | null = null,
	summary = "Test bundle",
): Promise<CompiledBundle> {
	return compileBundle({ paths, sourceDirectory, parentDigest, summary });
}

async function compileRegistryPair(
	paths: EvoPaths,
	temporaryRoot: string,
	label: string,
): Promise<{ initial: CompiledBundle; candidate: CompiledBundle }> {
	const initialSource = join(temporaryRoot, `${label}-initial-source`);
	const candidateSource = join(temporaryRoot, `${label}-candidate-source`);
	await writeBundleSource(initialSource);
	const initial = await compileSource(paths, initialSource, null, `${label} initial bundle`);
	await writeBundleSource(candidateSource, {
		files: [
			["prompts/system.md", "Follow repository instructions and preserve atomic registry state."],
			["memory/user.md", "The user prefers concise technical prose."],
		],
	});
	const candidate = await compileSource(paths, candidateSource, initial.digest, `${label} candidate bundle`);
	return { initial, candidate };
}

describe("bundle compilation and registry", () => {
	let temporaryRoot: string;
	let paths: EvoPaths;

	beforeEach(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "pi-evo-bundle-test-"));
		paths = getEvoPaths(join(temporaryRoot, "evo"));
	});

	afterEach(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	it("compiles identical content to one deterministic validated bundle", async () => {
		const firstSource = join(temporaryRoot, "source-a");
		const secondSource = join(temporaryRoot, "source-b");
		await writeBundleSource(firstSource);
		await writeBundleSource(secondSource, { files: [...DEFAULT_FILES].reverse() });

		const first = await compileSource(paths, firstSource);
		const second = await compileSource(paths, secondSource);
		const loaded = await loadCompiledBundle(paths, first.digest);

		expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(second.digest).toBe(first.digest);
		expect(second.directory).toBe(first.directory);
		expect(loaded.manifest.files.map((file) => file.path)).toEqual([
			"policy.json",
			"memory/user.md",
			"prompts/system.md",
		]);
		expect(loaded.policy).toMatchObject(DEFAULT_POLICY);
	});

	it("publishes concurrent identical compilations as one validated bundle", async () => {
		const source = join(temporaryRoot, "concurrent-source");
		await writeBundleSource(source);

		const bundles = await Promise.all(
			Array.from({ length: 8 }, () => compileSource(paths, source, null, "Concurrent bundle")),
		);

		expect(new Set(bundles.map((bundle) => bundle.digest)).size).toBe(1);
		expect((await loadCompiledBundle(paths, bundles[0].digest)).digest).toBe(bundles[0].digest);
	});

	it("rejects TypeScript files in bundle data", async () => {
		const source = join(temporaryRoot, "typescript-source");
		await writeBundleSource(source, {
			files: [...DEFAULT_FILES, ["prompts/injected.ts", "export const injected = true;"]],
		});

		await expect(compileSource(paths, source)).rejects.toThrow(
			"Bundle contains a disallowed data path: prompts/injected.ts",
		);
	});

	it.skipIf(process.platform === "win32")("rejects executable files", async () => {
		const source = join(temporaryRoot, "executable-source");
		await writeBundleSource(source, {
			files: [...DEFAULT_FILES, ["prompts/executable.md", "Executable data is forbidden."]],
		});
		await chmod(join(source, "prompts", "executable.md"), 0o755);

		await expect(compileSource(paths, source)).rejects.toThrow(
			"Bundle cannot contain executable files: executable.md",
		);
	});

	it("rejects an oversized skill", async () => {
		const source = join(temporaryRoot, "oversized-skill-source");
		await writeBundleSource(source, {
			files: [...DEFAULT_FILES, ["skills/review/SKILL.md", "x".repeat(15 * 1024 + 1)]],
		});

		await expect(compileSource(paths, source)).rejects.toThrow(
			"skills/review/SKILL.md exceeds skill byte limit 15360",
		);
	});

	it("does not allow policy limits to relax the hard prompt ceiling", async () => {
		const source = join(temporaryRoot, "oversized-prompt-source");
		await writeBundleSource(source, {
			files: [["prompts/oversized.md", "x".repeat(64 * 1024 + 1)]],
			policy: {
				schemaVersion: 1,
				promptOrder: ["prompts/oversized.md"],
				limits: { promptBytes: 128 * 1024 },
			},
		});

		await expect(compileSource(paths, source)).rejects.toThrow("Prompt bytes 65537 exceed limit 65536");
	});

	it("accepts the bundle compilation check that staging actually executes", async () => {
		const source = join(temporaryRoot, "bundle-check-source");
		await writeBundleSource(source, {
			policy: { ...DEFAULT_POLICY, validation: { requiredChecks: ["bundle-compile"] } },
		});

		const bundle = await compileSource(paths, source);
		expect(bundle.policy.validation?.requiredChecks).toEqual(["bundle-compile"]);
	});

	it.each(["lint", "typecheck", "unit-tests"])("rejects the unimplemented %s policy check", async (check) => {
		const source = join(temporaryRoot, `${check}-check-source`);
		await writeBundleSource(source);
		await writeFile(
			join(source, "policy.json"),
			`${JSON.stringify({ ...DEFAULT_POLICY, validation: { requiredChecks: [check] } }, undefined, "\t")}\n`,
		);

		await expect(compileSource(paths, source)).rejects.toThrow(
			"policy.validation.requiredChecks contains an unsupported check",
		);
	});

	it("rejects path traversal in policy asset references", async () => {
		const source = join(temporaryRoot, "traversal-source");
		await writeBundleSource(source, {
			policy: { schemaVersion: 1, promptOrder: ["../secret.md"] },
		});

		await expect(compileSource(paths, source)).rejects.toThrow(
			"Bundle path contains an unsafe segment: ../secret.md",
		);
	});

	it("detects content tampering in an immutable bundle", async () => {
		const source = join(temporaryRoot, "tamper-source");
		await writeBundleSource(source);
		const bundle = await compileSource(paths, source);
		const promptPath = join(bundle.directory, "prompts", "system.md");
		await chmod(promptPath, 0o644);
		await writeFile(promptPath, "Tampered content");

		await expect(loadCompiledBundle(paths, bundle.digest)).rejects.toThrow(
			"Bundle file digest mismatch: prompts/system.md",
		);
	});

	it("initializes, trials, keeps, and rolls back bundles", async () => {
		const initialSource = join(temporaryRoot, "initial-source");
		const candidateSource = join(temporaryRoot, "candidate-source");
		await writeBundleSource(initialSource);
		const initial = await compileSource(paths, initialSource, null, "Initial bundle");
		await writeBundleSource(candidateSource, {
			files: [
				["prompts/system.md", "Follow the repository instructions and verify changes."],
				["memory/user.md", "The user prefers concise technical prose."],
			],
		});
		const candidate = await compileSource(paths, candidateSource, initial.digest, "Candidate bundle");
		const registry = new BundleRegistry(paths);

		await registry.initialize(initial.digest, "Start Evo-Pi");
		expect(await registry.readStableDigest()).toBe(initial.digest);
		await expect(registry.initialize(initial.digest)).rejects.toThrow("Evo-Pi registry is already initialized");

		const trial = await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "proposal-1",
			plan: "Use for five sessions",
		});
		expect(trial).toMatchObject({
			digest: candidate.digest,
			parent: initial.digest,
			proposalId: "proposal-1",
			plan: "Use for five sessions",
		});
		expect(await registry.readStableDigest()).toBe(candidate.digest);
		expect(await registry.readTrial()).toEqual(trial);

		expect(await registry.keepTrial("Observed improvement")).toEqual(trial);
		expect(await registry.readTrial()).toBeUndefined();
		expect(await registry.readStableDigest()).toBe(candidate.digest);

		expect(await registry.rollback(undefined, "Restore previous bundle")).toEqual({
			from: candidate.digest,
			to: initial.digest,
		});
		expect(await registry.readStableDigest()).toBe(initial.digest);

		const historyActions = (await readFile(paths.history, "utf8"))
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { action: string }).action);
		expect(historyActions).toEqual(["initialize", "trial-start", "trial-keep", "rollback"]);
	});

	it("fails closed when recovery sees a state outside the recorded before/after images", async () => {
		const initialSource = join(temporaryRoot, "recovery-initial-source");
		const candidateSource = join(temporaryRoot, "recovery-candidate-source");
		await writeBundleSource(initialSource);
		const initial = await compileSource(paths, initialSource, null, "Recovery initial bundle");
		await writeBundleSource(candidateSource, {
			files: [
				["prompts/system.md", "Follow the repository instructions and recover safely."],
				["memory/user.md", "The user prefers concise technical prose."],
			],
		});
		const candidate = await compileSource(paths, candidateSource, initial.digest, "Recovery candidate");
		await new BundleRegistry(paths).initialize(initial.digest);

		let failed = false;
		const interrupted = new BundleRegistry(paths, {
			afterTransitionStep(step, action) {
				if (!failed && action === "activate-trial" && step === "prepared") {
					failed = true;
					throw new Error("simulated registry interruption");
				}
			},
		});
		await expect(
			interrupted.activateTrial({
				digest: candidate.digest,
				proposalId: "proposal-recovery",
				plan: "Exercise crash recovery",
			}),
		).rejects.toThrow("simulated registry interruption");

		const thirdDigest = "f".repeat(64);
		await writeFile(paths.stable, `${thirdDigest}\n`);
		const recovering = new BundleRegistry(paths);
		await expect(recovering.pause("Trigger pending recovery")).rejects.toThrow(
			"unexpected stable state; refusing to overwrite it",
		);
		expect((await readFile(paths.stable, "utf8")).trim()).toBe(thirdDigest);
		expect(JSON.parse(await readFile(paths.transition, "utf8"))).toMatchObject({
			action: "activate-trial",
			stableBefore: initial.digest,
			stableAfter: candidate.digest,
		});
	});

	it.each(["stable", "trial", "paused", "status"] as const)(
		"recovers a half-committed transition before the %s read API returns",
		async (reader) => {
			const { initial, candidate } = await compileRegistryPair(paths, temporaryRoot, `consistent-read-${reader}`);
			await new BundleRegistry(paths).initialize(initial.digest);
			let failed = false;
			const interrupted = new BundleRegistry(paths, {
				afterTransitionStep(step, action) {
					if (!failed && action === "activate-trial" && step === "trial-written") {
						failed = true;
						throw new Error("simulated half-commit");
					}
				},
			});
			await expect(
				interrupted.activateTrial({
					digest: candidate.digest,
					proposalId: "proposal-consistent-read",
					plan: "Recover before public reads",
				}),
			).rejects.toThrow("simulated half-commit");

			const recovering = new BundleRegistry(paths);
			if (reader === "stable") {
				expect(await recovering.readStableDigest()).toBe(candidate.digest);
			} else if (reader === "trial") {
				expect(await recovering.readTrial()).toMatchObject({ digest: candidate.digest });
			} else if (reader === "paused") {
				expect(await recovering.isPaused()).toBe(false);
			} else {
				expect(await recovering.getStatus()).toMatchObject({
					stableDigest: candidate.digest,
					trial: { digest: candidate.digest },
					paused: false,
				});
			}

			expect((await readFile(paths.stable, "utf8")).trim()).toBe(candidate.digest);
			expect(JSON.parse(await readFile(paths.trial, "utf8"))).toMatchObject({ digest: candidate.digest });
			await expect(readFile(paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("repairs a torn history tail before replaying a valid pending transition", async () => {
		const { initial, candidate } = await compileRegistryPair(paths, temporaryRoot, "torn-history");
		await new BundleRegistry(paths).initialize(initial.digest);
		let failed = false;
		const interrupted = new BundleRegistry(paths, {
			afterTransitionStep(step, action) {
				if (!failed && action === "activate-trial" && step === "history-appended") {
					failed = true;
					throw new Error("simulated response interruption");
				}
			},
		});
		await expect(
			interrupted.activateTrial({
				digest: candidate.digest,
				proposalId: "proposal-torn-history",
				plan: "Repair torn history",
			}),
		).rejects.toThrow("simulated response interruption");
		await appendFile(paths.history, '{"eventId":"torn');

		expect(await new BundleRegistry(paths).readStableDigest()).toBe(candidate.digest);
		const content = await readFile(paths.history, "utf8");
		expect(content.endsWith("\n")).toBe(true);
		const history = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string });
		expect(history.filter((entry) => entry.action === "trial-start")).toHaveLength(1);
		await expect(readFile(paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["deleted", "corrupted"] as const)("fails closed when a prepared candidate bundle is %s", async (mode) => {
		const { initial, candidate } = await compileRegistryPair(paths, temporaryRoot, `invalid-candidate-${mode}`);
		await new BundleRegistry(paths).initialize(initial.digest);
		let failed = false;
		const interrupted = new BundleRegistry(paths, {
			afterTransitionStep(step, action) {
				if (!failed && action === "activate-trial" && step === "prepared") {
					failed = true;
					throw new Error("simulated prepared interruption");
				}
			},
		});
		await expect(
			interrupted.activateTrial({
				digest: candidate.digest,
				proposalId: "proposal-invalid-candidate",
				plan: "Validate before replay",
			}),
		).rejects.toThrow("simulated prepared interruption");

		if (mode === "deleted") {
			await rm(candidate.directory, { recursive: true, force: true });
		} else {
			const promptPath = join(candidate.directory, "prompts", "system.md");
			await chmod(promptPath, 0o644);
			await writeFile(promptPath, "corrupted candidate");
		}

		await expect(new BundleRegistry(paths).readStableDigest()).rejects.toThrow();
		expect((await readFile(paths.stable, "utf8")).trim()).toBe(initial.digest);
		await expect(readFile(paths.trial, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.parse(await readFile(paths.transition, "utf8"))).toMatchObject({
			action: "activate-trial",
			stableAfter: candidate.digest,
		});
	});

	it("does not treat a different reason as a retry of a pending operation", async () => {
		const { initial, candidate } = await compileRegistryPair(paths, temporaryRoot, "distinct-reason");
		const registry = new BundleRegistry(paths);
		await registry.initialize(initial.digest);
		await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "proposal-distinct-reason",
			plan: "Exercise distinct requests",
		});
		let failed = false;
		const interrupted = new BundleRegistry(paths, {
			afterTransitionStep(step, action) {
				if (!failed && action === "keep-trial" && step === "prepared") {
					failed = true;
					throw new Error("simulated keep interruption");
				}
			},
		});
		await expect(interrupted.keepTrial("first reason")).rejects.toThrow("simulated keep interruption");

		await expect(new BundleRegistry(paths).keepTrial("different reason")).rejects.toThrow("No trial is active");
		const history = (await readFile(paths.history, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string; reason: string });
		expect(history.filter((entry) => entry.action === "trial-keep")).toEqual([
			expect.objectContaining({ reason: "first reason" }),
		]);
	});

	it("rejects rollback to the current stable digest without side effects", async () => {
		const { initial, candidate } = await compileRegistryPair(paths, temporaryRoot, "same-target");
		const registry = new BundleRegistry(paths);
		await registry.initialize(initial.digest);
		const trial = await registry.activateTrial({
			digest: candidate.digest,
			proposalId: "proposal-same-target",
			plan: "Preserve the active trial",
		});

		await expect(registry.rollback(candidate.digest, "same target")).rejects.toThrow(
			"Rollback target is already stable",
		);
		await expect(registry.rollbackProposal(candidate.digest, "same target")).rejects.toThrow(
			"Rollback target is already stable",
		);
		expect(await registry.readTrial()).toEqual(trial);
		const history = (await readFile(paths.history, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string });
		expect(history.filter((entry) => entry.action === "rollback")).toHaveLength(0);
	});

	it("rejects rollback to a compiled candidate that was never stable", async () => {
		const { initial, candidate } = await compileRegistryPair(paths, temporaryRoot, "pending-target");
		const registry = new BundleRegistry(paths);
		await registry.initialize(initial.digest);
		const historyBefore = await readFile(paths.history, "utf8");

		await expect(registry.rollback(candidate.digest, "bypass pending approval")).rejects.toThrow(
			"was never committed as stable",
		);
		await expect(registry.rollbackProposal(candidate.digest, "bypass pending approval")).rejects.toThrow(
			"was never committed as stable",
		);

		expect(await registry.readStableDigest()).toBe(initial.digest);
		expect(await registry.readTrial()).toBeUndefined();
		expect(await readFile(paths.history, "utf8")).toBe(historyBefore);
		await expect(readFile(paths.transition, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects malformed persisted trial fields", async () => {
		const { initial } = await compileRegistryPair(paths, temporaryRoot, "invalid-trial");
		const registry = new BundleRegistry(paths);
		await registry.initialize(initial.digest);
		await writeFile(
			paths.trial,
			JSON.stringify({
				digest: initial.digest,
				parent: initial.digest,
				proposalId: "../escape",
				startedAt: "not-a-date",
				plan: "invalid trial",
			}),
		);

		await expect(registry.readTrial()).rejects.toThrow("registry/trial.json is invalid");
	});

	it("pauses and resumes background evolution", async () => {
		const registry = new BundleRegistry(paths);

		expect(await registry.isPaused()).toBe(false);
		await registry.pause("Foreground work is active");
		expect(await registry.isPaused()).toBe(true);
		expect((await registry.getStatus()).paused).toBe(true);

		await registry.resume("Quiet hours started");
		expect(await registry.isPaused()).toBe(false);
		expect((await registry.getStatus()).paused).toBe(false);

		const historyActions = (await readFile(paths.history, "utf8"))
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { action: string }).action);
		expect(historyActions).toEqual(["pause", "resume"]);
	});

	it("renders stable prompts before the digest and dynamic prompts last", async () => {
		const source = join(temporaryRoot, "runtime-order-source");
		await writeBundleSource(source, {
			files: [
				["prompts/stable-a.md", "stable-a"],
				["prompts/stable-b.md", "stable-b"],
				["prompts/regular-a.md", "regular-a"],
				["prompts/regular-b.md", "regular-b"],
				["prompts/dynamic-a.md", "dynamic-a"],
				["prompts/dynamic-b.md", "dynamic-b"],
				["memory/user.md", "remembered-context"],
			],
			policy: {
				schemaVersion: 1,
				promptOrder: [
					"prompts/stable-b.md",
					"prompts/regular-b.md",
					"prompts/dynamic-b.md",
					"prompts/stable-a.md",
					"prompts/regular-a.md",
					"prompts/dynamic-a.md",
				],
				stablePromptPaths: ["prompts/stable-a.md", "prompts/stable-b.md"],
				dynamicPromptPaths: ["prompts/dynamic-a.md", "prompts/dynamic-b.md"],
			},
		});
		const bundle = await compileSource(paths, source);
		const prompt = (await renderRuntimeBundle(bundle)).systemPromptAppend;
		const stableB = prompt.indexOf("stable-b");
		const stableA = prompt.indexOf("stable-a");
		const digest = prompt.indexOf(`Bundle: ${bundle.digest}`);
		const regularB = prompt.indexOf("regular-b");
		const regularA = prompt.indexOf("regular-a");
		const memory = prompt.indexOf("remembered-context");
		const dynamicB = prompt.indexOf("dynamic-b");
		const dynamicA = prompt.indexOf("dynamic-a");

		expect(prompt.startsWith("<!-- evo-pi bundle begin -->")).toBe(true);
		expect(stableB).toBeLessThan(stableA);
		expect(stableA).toBeLessThan(digest);
		expect(digest).toBeLessThan(regularB);
		expect(regularB).toBeLessThan(regularA);
		expect(regularA).toBeLessThan(memory);
		expect(memory).toBeLessThan(dynamicB);
		expect(dynamicB).toBeLessThan(dynamicA);
		expect(prompt.endsWith("<!-- evo-pi bundle end -->")).toBe(true);
	});

	it("replaces an existing runtime bundle prompt without duplication", () => {
		const begin = "<!-- evo-pi bundle begin -->";
		const end = "<!-- evo-pi bundle end -->";
		const replacement = `${begin}\nBundle: new\n\nNew policy\n${end}`;
		const original = `Base prompt\n${begin}\nBundle: old\n\nOld policy\n${end}\nProject context`;

		expect(replaceRuntimeBundlePrompt("Base prompt", replacement)).toBe(`Base prompt\n\n${replacement}`);
		expect(replaceRuntimeBundlePrompt(original, replacement)).toBe(`Base prompt\n${replacement}\nProject context`);
		expect(replaceRuntimeBundlePrompt(original, replacement).match(/evo-pi bundle begin/g)).toHaveLength(1);
	});
});
