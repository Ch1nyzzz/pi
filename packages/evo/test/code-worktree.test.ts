import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CommandResult,
	type CommandRunner,
	type CommandRunOptions,
	SpawnCommandRunner,
} from "../src/code/command-runner.ts";
import {
	type CodeL1Result,
	type CodeValidationContext,
	type CodeValidationExecutor,
	CodeWorktreeIntegrityError,
	codeApprovalDigest,
	DefaultSandboxCodeValidationExecutor,
	loadCodeWorktreeRevision,
	revalidateCodeWorktree,
	stageCodeWorktree,
} from "../src/code/worktree.ts";
import { getEvoPaths } from "../src/paths.ts";

const PARENT_BUNDLE_DIGEST = "a".repeat(64);

interface Fixture {
	root: string;
	repository: string;
	paths: ReturnType<typeof getEvoPaths>;
}

class FakeValidationExecutor implements CodeValidationExecutor {
	readonly calls: CodeValidationContext[] = [];
	private readonly result: CodeL1Result;

	constructor(result: CodeL1Result = { passed: true, errors: [], checks: [] }) {
		this.result = result;
	}

	async validate(context: CodeValidationContext): Promise<CodeL1Result> {
		this.calls.push({ ...context, changedPaths: [...context.changedPaths] });
		return {
			passed: this.result.passed,
			errors: [...this.result.errors],
			checks: [...this.result.checks],
		};
	}
}

function successfulCommandResult(command: string, args: readonly string[]): CommandResult {
	return {
		command,
		args: [...args],
		stdout: "sensitive validation output",
		stderr: "sensitive validation error",
		code: 0,
		killed: false,
		timedOut: false,
		aborted: false,
		outputLimitExceeded: false,
	};
}

class MutatingSandboxRunner implements CommandRunner {
	private calls = 0;

	async run(command: string, args: readonly string[], options: CommandRunOptions): Promise<CommandResult> {
		this.calls += 1;
		if (this.calls === 1) {
			const dependencyLink = join(options.cwd, "workspace", "node_modules");
			await rm(dependencyLink, { recursive: true });
			await symlink("../tmp", dependencyLink, "dir");
		}
		return successfulCommandResult(command, args);
	}
}

class FailingAfterWorktreeAddRunner implements CommandRunner {
	private readonly delegate = new SpawnCommandRunner();

	async run(command: string, args: readonly string[], options: CommandRunOptions): Promise<CommandResult> {
		const result = await this.delegate.run(command, args, options);
		if (command === "git" && args.includes("worktree") && args.includes("add")) {
			return { ...result, code: 1, stderr: "simulated worktree add failure" };
		}
		return result;
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function replacementPatch(path: string, before: string, after: string): string {
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -1 +1 @@",
		`-${before}`,
		`+${after}`,
		"",
	].join("\n");
}

function newFilePatch(path: string, content = "blocked"): string {
	return [
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${path}`,
		"@@ -0,0 +1 @@",
		`+${content}`,
		"",
	].join("\n");
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-code-worktree-"));
	const repository = join(root, "repository");
	await mkdir(join(repository, "src"), { recursive: true });
	git(repository, ["init", "--quiet"]);
	git(repository, ["config", "user.name", "Evo Test"]);
	git(repository, ["config", "user.email", "evo-test@example.invalid"]);
	await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
	git(repository, ["add", "src/value.ts"]);
	git(repository, ["commit", "--quiet", "-m", "initial"]);
	return { root, repository, paths: getEvoPaths(join(root, "evo")) };
}

describe("code proposal worktrees", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("binds code approval to the parent bundle", () => {
		const context = {
			repositoryRoot: "/repository",
			repositoryIdentity: "repository-id",
			baseCommit: "b".repeat(40),
			diff: "diff",
		};
		const first = codeApprovalDigest({ ...context, parentBundleDigest: "a".repeat(64) });
		const second = codeApprovalDigest({ ...context, parentBundleDigest: "c".repeat(64) });

		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(second).not.toBe(first);
	});

	it("stages and revalidates an exact diff without touching dirty main worktree state", async () => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		await writeFile(join(fixture.repository, "src", "value.ts"), "export const dirtyMainValue = 9;\n");
		const mainStatusBefore = git(fixture.repository, ["status", "--short"]);
		const mainIndexBefore = git(fixture.repository, ["diff", "--cached", "--binary", "--full-index"]);
		const validator = new FakeValidationExecutor();

		const staged = await stageCodeWorktree({
			paths: fixture.paths,
			parentBundleDigest: PARENT_BUNDLE_DIGEST,
			repositoryCwd: join(fixture.repository, "src"),
			proposalId: "p-isolated",
			revision: 1,
			patch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;"),
			validationExecutor: validator,
		});

		expect(staged.branch).toBe("evo/p-isolated/r1");
		expect(staged.revisionDirectory).toBe(join(fixture.paths.proposals, "p-isolated", "revisions", "1"));
		expect(staged.changedPaths).toEqual(["src/value.ts"]);
		expect(staged.diff).toContain("export const value = 2;");
		expect(staged.diffDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(staged.approvalDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(staged.approvalDigest).not.toBe(staged.diffDigest);
		expect(staged.l1.passed).toBe(true);
		expect(await readFile(join(staged.worktreePath, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
		expect(await readFile(join(fixture.repository, "src", "value.ts"), "utf8")).toBe(
			"export const dirtyMainValue = 9;\n",
		);
		expect(git(fixture.repository, ["status", "--short"])).toBe(mainStatusBefore);
		expect(git(fixture.repository, ["diff", "--cached", "--binary", "--full-index"])).toBe(mainIndexBefore);
		expect(validator.calls).toHaveLength(1);
		expect(validator.calls[0]?.worktreePath).toBe(staged.worktreePath);

		const loaded = await loadCodeWorktreeRevision(fixture.paths, "p-isolated", 1);
		expect(loaded.diff).toBe(staged.diff);
		expect(loaded.approvalDigest).toBe(staged.approvalDigest);
		const revalidated = await revalidateCodeWorktree({
			paths: fixture.paths,
			proposalId: "p-isolated",
			revision: 1,
			expectedApprovalDigest: staged.approvalDigest,
			expectedRepositoryRoot: staged.repositoryRoot,
			expectedRepositoryIdentity: staged.repositoryIdentity,
			expectedBaseCommit: staged.baseCommit,
			expectedParentBundleDigest: PARENT_BUNDLE_DIGEST,
			validationExecutor: validator,
		});
		expect(revalidated.approvalDigest).toBe(staged.approvalDigest);
		expect(revalidated.l1.passed).toBe(true);
		expect(validator.calls).toHaveLength(2);
	});

	it("rejects a persisted parent-bundle substitution before approval-time L1", async () => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		const validator = new FakeValidationExecutor();
		const staged = await stageCodeWorktree({
			paths: fixture.paths,
			parentBundleDigest: PARENT_BUNDLE_DIGEST,
			repositoryCwd: fixture.repository,
			proposalId: "p-parent-tamper",
			revision: 1,
			patch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;"),
			validationExecutor: validator,
		});
		const workspaceFile = join(staged.revisionDirectory, "workspace.json");
		const persisted = JSON.parse(await readFile(workspaceFile, "utf8")) as Record<string, unknown>;
		persisted.parentBundleDigest = "c".repeat(64);
		await writeFile(workspaceFile, `${JSON.stringify(persisted)}\n`);

		await expect(
			revalidateCodeWorktree({
				paths: fixture.paths,
				proposalId: staged.proposalId,
				revision: staged.revision,
				expectedApprovalDigest: staged.approvalDigest,
				expectedRepositoryRoot: staged.repositoryRoot,
				expectedRepositoryIdentity: staged.repositoryIdentity,
				expectedBaseCommit: staged.baseCommit,
				expectedParentBundleDigest: PARENT_BUNDLE_DIGEST,
				validationExecutor: validator,
			}),
		).rejects.toThrow("Stored parent bundle does not match the approved context");
		expect(validator.calls).toHaveLength(1);
	});

	it("keeps a failed injected L1 result non-approvable without running a default command", async () => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		const validator = new FakeValidationExecutor({ passed: false, errors: ["focused test failed"], checks: [] });
		await expect(
			stageCodeWorktree({
				paths: fixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: fixture.repository,
				proposalId: "p-l1-failure",
				revision: 2,
				patch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 3;"),
				validationExecutor: validator,
			}),
		).rejects.toThrow("failed sandboxed L1 validation");
		expect(validator.calls).toHaveLength(1);
		await expect(loadCodeWorktreeRevision(fixture.paths, "p-l1-failure", 2)).rejects.toThrow();
		expect(git(fixture.repository, ["branch", "--list", "evo/p-l1-failure/r2"])).toBe("");
		expect(await readdir(fixture.paths.proposals)).not.toContain("p-l1-failure");
		expect(await readdir(fixture.paths.worktrees)).not.toContain("p-l1-failure");
	});

	it.each([
		"packages/evo/src/prompts/critic.md",
		"packages/evo/src/registry/unsafe.ts",
		"packages/evo/src/storage.ts",
		"Packages/Evo/Src/Registry/unsafe.ts",
		"package-lock.json",
		"packages/example/package.json",
		"packages/coding-agent/install-lock/generated.json",
		".gitmodules",
	])("rejects forbidden candidate path %s", async (path) => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		await expect(
			stageCodeWorktree({
				paths: fixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: fixture.repository,
				proposalId: `p-forbidden-${roots.length}`,
				revision: 1,
				patch: newFilePatch(path),
				validationExecutor: new FakeValidationExecutor(),
			}),
		).rejects.toThrow(/cannot change/i);
	});

	it("rejects symlink and binary changes before L1", async () => {
		const symlinkFixture = await createFixture();
		roots.push(symlinkFixture.root);
		const symlinkPatch = [
			"diff --git a/link b/link",
			"new file mode 120000",
			"--- /dev/null",
			"+++ b/link",
			"@@ -0,0 +1 @@",
			"+src/value.ts",
			"",
		].join("\n");
		await expect(
			stageCodeWorktree({
				paths: symlinkFixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: symlinkFixture.repository,
				proposalId: "p-symlink",
				revision: 1,
				patch: symlinkPatch,
				validationExecutor: new FakeValidationExecutor(),
			}),
		).rejects.toThrow(/symlinks or submodules/);

		const existingSymlinkFixture = await createFixture();
		roots.push(existingSymlinkFixture.root);
		await symlink("src/value.ts", join(existingSymlinkFixture.repository, "link"));
		git(existingSymlinkFixture.repository, ["add", "link"]);
		git(existingSymlinkFixture.repository, ["commit", "--quiet", "-m", "add symlink"]);
		await rm(join(existingSymlinkFixture.repository, "link"));
		await symlink("src/other.ts", join(existingSymlinkFixture.repository, "link"));
		const existingSymlinkPatch = git(existingSymlinkFixture.repository, ["diff", "--binary", "--", "link"]);
		await rm(join(existingSymlinkFixture.repository, "link"));
		await symlink("src/value.ts", join(existingSymlinkFixture.repository, "link"));
		await expect(
			stageCodeWorktree({
				paths: existingSymlinkFixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: existingSymlinkFixture.repository,
				proposalId: "p-existing-symlink",
				revision: 1,
				patch: existingSymlinkPatch,
				validationExecutor: new FakeValidationExecutor(),
			}),
		).rejects.toThrow(/symlinks or submodules/);

		const binaryFixture = await createFixture();
		roots.push(binaryFixture.root);
		const original = Buffer.from([0, 1, 2, 3]);
		const changed = Buffer.from([0, 9, 8, 7]);
		await writeFile(join(binaryFixture.repository, "binary.dat"), original);
		git(binaryFixture.repository, ["add", "binary.dat"]);
		git(binaryFixture.repository, ["commit", "--quiet", "-m", "add binary"]);
		await writeFile(join(binaryFixture.repository, "binary.dat"), changed);
		const binaryPatch = git(binaryFixture.repository, ["diff", "--binary", "--", "binary.dat"]);
		await writeFile(join(binaryFixture.repository, "binary.dat"), original);
		await expect(
			stageCodeWorktree({
				paths: binaryFixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: binaryFixture.repository,
				proposalId: "p-binary",
				revision: 1,
				patch: binaryPatch,
			}),
		).rejects.toThrow(/binary changes/);
	});

	it("fails closed when sandboxed validation modifies its disposable candidate", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-evo-validation-mutation-"));
		roots.push(root);
		const candidate = join(root, "candidate");
		await mkdir(join(candidate, "packages", "evo", "src"), { recursive: true });
		await mkdir(join(candidate, "packages", "evo", "test"), { recursive: true });
		await mkdir(join(candidate, "node_modules"), { recursive: true });
		const originalPackage = '{"name":"candidate"}\n';
		await writeFile(join(candidate, "package.json"), originalPackage);
		await writeFile(join(candidate, "packages", "evo", "src", "value.ts"), "export const value = 1;\n");
		await writeFile(join(candidate, "packages", "evo", "test", "value.test.ts"), "export {};\n");

		const result = await new DefaultSandboxCodeValidationExecutor().validate({
			repositoryRoot: candidate,
			worktreePath: candidate,
			baseCommit: "b".repeat(40),
			changedPaths: ["packages/evo/src/value.ts"],
			commandRunner: new MutatingSandboxRunner(),
		});

		expect(result.passed).toBe(false);
		expect(result.errors).toContain("Sandboxed validation modified the candidate instead of checking it read-only");
		expect(result.checks).toHaveLength(1);
		for (const check of result.checks) {
			expect(check.result.stdout).toBe("");
			expect(check.result.stderr).toBe("");
		}
		expect(await readFile(join(candidate, "package.json"), "utf8")).toBe(originalPackage);
	});

	it("rejects a dependency mount that resolves to the repository root", async () => {
		if (process.platform !== "linux" && process.platform !== "darwin") return;
		const root = await mkdtemp(join(tmpdir(), "pi-evo-validation-dependency-root-"));
		roots.push(root);
		const candidate = join(root, "candidate");
		await mkdir(join(candidate, "packages", "evo", "src"), { recursive: true });
		await mkdir(join(candidate, "packages", "evo", "test"), { recursive: true });
		await symlink(".", join(candidate, "node_modules"), "dir");
		await writeFile(join(candidate, "package.json"), '{"name":"candidate"}\n');
		await writeFile(join(candidate, "packages", "evo", "src", "value.ts"), "export const value = 1;\n");
		await writeFile(join(candidate, "packages", "evo", "test", "value.test.ts"), "export {};\n");

		const result = await new DefaultSandboxCodeValidationExecutor().validate({
			repositoryRoot: candidate,
			worktreePath: candidate,
			baseCommit: "b".repeat(40),
			changedPaths: ["packages/evo/src/value.ts"],
			commandRunner: {
				async run(command, args) {
					return successfulCommandResult(command, args);
				},
			},
		});

		expect(result.passed).toBe(false);
		expect(result.errors.join("\n")).toMatch(/not a dedicated node_modules directory|too broad/);
		expect(result.checks).toHaveLength(0);
	});
	it("preserves a pre-existing branch when proposal branch creation fails", async () => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		const branch = "evo/p-existing-branch/r1";
		git(fixture.repository, ["branch", branch]);
		const expectedCommit = git(fixture.repository, ["rev-parse", branch]).trim();

		await expect(
			stageCodeWorktree({
				paths: fixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: fixture.repository,
				proposalId: "p-existing-branch",
				revision: 1,
				patch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;"),
				validationExecutor: new FakeValidationExecutor(),
			}),
		).rejects.toThrow("Create code proposal branch failed");

		expect(git(fixture.repository, ["rev-parse", branch]).trim()).toBe(expectedCommit);
		await expect(loadCodeWorktreeRevision(fixture.paths, "p-existing-branch", 1)).rejects.toThrow();
	});

	it("cleans resources when worktree creation reports failure after creating them", async () => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		await expect(
			stageCodeWorktree({
				paths: fixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: fixture.repository,
				proposalId: "p-worktree-side-effect",
				revision: 1,
				patch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 2;"),
				commandRunner: new FailingAfterWorktreeAddRunner(),
				validationExecutor: new FakeValidationExecutor(),
			}),
		).rejects.toThrow("Create isolated code worktree failed");
		expect(git(fixture.repository, ["branch", "--list", "evo/p-worktree-side-effect/r1"])).toBe("");
		await expect(loadCodeWorktreeRevision(fixture.paths, "p-worktree-side-effect", 1)).rejects.toThrow();
		await expect(
			readFile(join(fixture.paths.worktrees, "p-worktree-side-effect", "r1", "src", "value.ts")),
		).rejects.toThrow();
	});

	it("rejects an empty patch and staged tampering before rerunning L1", async () => {
		const fixture = await createFixture();
		roots.push(fixture.root);
		const validator = new FakeValidationExecutor();
		await expect(
			stageCodeWorktree({
				paths: fixture.paths,
				parentBundleDigest: PARENT_BUNDLE_DIGEST,
				repositoryCwd: fixture.repository,
				proposalId: "p-empty",
				revision: 1,
				patch: "  \n",
				validationExecutor: validator,
			}),
		).rejects.toThrow("patch is empty");

		const staged = await stageCodeWorktree({
			paths: fixture.paths,
			parentBundleDigest: PARENT_BUNDLE_DIGEST,
			repositoryCwd: fixture.repository,
			proposalId: "p-tamper",
			revision: 1,
			patch: replacementPatch("src/value.ts", "export const value = 1;", "export const value = 4;"),
			validationExecutor: validator,
		});
		await writeFile(join(staged.worktreePath, "src", "value.ts"), "export const tampered = true;\n");
		git(staged.worktreePath, ["add", "-A"]);

		await expect(
			revalidateCodeWorktree({
				paths: fixture.paths,
				proposalId: "p-tamper",
				revision: 1,
				expectedApprovalDigest: staged.approvalDigest,
				expectedRepositoryRoot: staged.repositoryRoot,
				expectedRepositoryIdentity: staged.repositoryIdentity,
				expectedBaseCommit: staged.baseCommit,
				expectedParentBundleDigest: PARENT_BUNDLE_DIGEST,
				validationExecutor: validator,
			}),
		).rejects.toBeInstanceOf(CodeWorktreeIntegrityError);
		expect(validator.calls).toHaveLength(1);
	});
});

describe("SpawnCommandRunner", () => {
	it("force kills a process group that ignores SIGTERM", async () => {
		const runner = new SpawnCommandRunner();
		const started = Date.now();
		const result = await runner.run(
			process.execPath,
			["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
			{ cwd: process.cwd(), timeoutMs: 50, maxOutputBytes: 1024 },
		);

		expect(result.timedOut).toBe(true);
		expect(result.killed).toBe(true);
		expect(Date.now() - started).toBeLessThan(3_000);
	});
});
