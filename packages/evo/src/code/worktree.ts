import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import type { EvoPaths } from "../paths.ts";
import { atomicWriteFile, atomicWriteJson, canonicalJson, readJson, sha256, withFileLock } from "../storage.ts";
import { type CommandResult, type CommandRunner, SpawnCommandRunner } from "./command-runner.ts";

const CODE_WORKSPACE_SCHEMA_VERSION = 1;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const VALIDATION_OUTPUT_LIMIT = 1024 * 1024;
const VALIDATION_TIMEOUT_MS = 15 * 60 * 1000;
const CODE_LOCK_STALE_MS = 4 * 60 * 60 * 1000;
const SANDBOX_ROOT = "/evo-validation";
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DEPENDENCY_FILE_NAMES = new Set([
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"cargo.toml",
	"cargo.lock",
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"requirements.txt",
	"pipfile",
	"pipfile.lock",
	"go.mod",
	"go.sum",
	"gemfile",
	"gemfile.lock",
]);

export interface CodeValidationCheck {
	name: string;
	result: CommandResult;
}

export interface CodeL1Result {
	passed: boolean;
	errors: string[];
	checks: CodeValidationCheck[];
}

export interface CodeValidationContext {
	repositoryRoot: string;
	worktreePath: string;
	baseCommit: string;
	changedPaths: string[];
	commandRunner: CommandRunner;
	signal?: AbortSignal;
}

export interface CodeValidationExecutor {
	validate(context: CodeValidationContext): Promise<CodeL1Result>;
}

export interface CodeWorktreeRevision {
	schemaVersion: 1;
	proposalId: string;
	revision: number;
	parentBundleDigest: string;
	repositoryRoot: string;
	repositoryIdentity: string;
	baseCommit: string;
	branch: string;
	worktreePath: string;
	revisionDirectory: string;
	patchFile: string;
	diffFile: string;
	changedPaths: string[];
	diff: string;
	approvalDigest: string;
	diffDigest: string;
	l1: CodeL1Result;
}

type PersistedCodeWorktreeRevision = Omit<CodeWorktreeRevision, "diff">;

export interface CodeBuilderWorkspace {
	runId: string;
	repositoryRoot: string;
	repositoryIdentity: string;
	baseCommit: string;
	worktreePath: string;
}

export interface CodeBuilderSnapshot {
	patch: string;
	changedPaths: string[];
	repositoryRoot: string;
	repositoryIdentity: string;
	baseCommit: string;
}

export interface StageCodeWorktreeOptions {
	paths: EvoPaths;
	repositoryCwd: string;
	proposalId: string;
	revision: number;
	parentBundleDigest: string;
	patch: string;
	expectedRepositoryRoot?: string;
	expectedRepositoryIdentity?: string;
	expectedBaseCommit?: string;
	commandRunner?: CommandRunner;
	validationExecutor?: CodeValidationExecutor;
	signal?: AbortSignal;
}

export interface RevalidateCodeWorktreeOptions {
	paths: EvoPaths;
	proposalId: string;
	revision: number;
	expectedApprovalDigest: string;
	expectedRepositoryRoot: string;
	expectedRepositoryIdentity: string;
	expectedBaseCommit: string;
	expectedParentBundleDigest: string;
	commandRunner?: CommandRunner;
	validationExecutor?: CodeValidationExecutor;
	signal?: AbortSignal;
}

interface RepositoryInfo {
	root: string;
	identity: string;
	baseCommit: string;
}

interface CandidateSnapshot {
	changedPaths: string[];
	diff: string;
	approvalDigest: string;
	diffDigest: string;
}

interface ValidationCommand {
	name: string;
	command: string;
	args: string[];
	cwd: string;
}

export class CodeWorktreeIntegrityError extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertProposalRevision(proposalId: string, revision: number): void {
	if (!PROPOSAL_ID_PATTERN.test(proposalId)) throw new Error(`Invalid proposal id: ${proposalId}`);
	if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error("revision must be a positive safe integer");
}

function assertBundleDigest(digest: string): void {
	if (!DIGEST_PATTERN.test(digest)) throw new Error("parentBundleDigest must be a sha256 digest");
}

function revisionPaths(paths: EvoPaths, proposalId: string, revision: number) {
	const revisionName = `r${revision}`;
	const revisionDirectory = join(paths.proposals, proposalId, "revisions", String(revision));
	return {
		branch: `evo/${proposalId}/${revisionName}`,
		worktreePath: join(paths.worktrees, proposalId, revisionName),
		revisionDirectory,
		patchFile: join(revisionDirectory, "candidate.patch"),
		diffFile: join(revisionDirectory, "code.diff"),
		l1File: join(revisionDirectory, "l1.json"),
		workspaceFile: join(revisionDirectory, "workspace.json"),
	};
}

async function runCommand(
	runner: CommandRunner,
	command: string,
	args: readonly string[],
	cwd: string,
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
	return runner.run(command, args, {
		cwd,
		maxOutputBytes: options.maxOutputBytes ?? GIT_OUTPUT_LIMIT,
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		...(options.env ? { env: options.env } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

function assertSucceeded(result: CommandResult, label: string): void {
	if (result.code === 0 && !result.killed && !result.outputLimitExceeded) return;
	const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
	throw new Error(`${label} failed: ${detail}`);
}

async function runGit(
	runner: CommandRunner,
	cwd: string,
	args: readonly string[],
	label: string,
): Promise<CommandResult> {
	const result = await runCommand(runner, "git", ["-C", cwd, ...args], cwd);
	assertSucceeded(result, label);
	return result;
}

async function repositoryIdentity(runner: CommandRunner, cwd: string): Promise<string> {
	const commonDirectory = (
		await runGit(
			runner,
			cwd,
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			"Resolve Git common directory",
		)
	).stdout.trim();
	return sha256(await realpath(commonDirectory));
}

async function inspectRepository(runner: CommandRunner, cwd: string): Promise<RepositoryInfo> {
	const root = await realpath(
		(await runGit(runner, cwd, ["rev-parse", "--show-toplevel"], "Resolve repository root")).stdout.trim(),
	);
	const baseCommit = (
		await runGit(runner, root, ["rev-parse", "--verify", "HEAD^{commit}"], "Resolve repository HEAD")
	).stdout.trim();
	return { root, identity: await repositoryIdentity(runner, root), baseCommit };
}

function assertSafeChangedPath(path: string): void {
	if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/")) {
		throw new Error(`Code proposal contains an unsafe path: ${JSON.stringify(path)}`);
	}
	const segments = path.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`Code proposal contains an unsafe path: ${path}`);
	}
	const normalized = path.toLowerCase();
	const fileName = basename(normalized);
	if (normalized === ".git" || normalized.startsWith(".git/") || normalized === ".gitmodules") {
		throw new Error(`Code proposal cannot change Git control paths: ${path}`);
	}
	if (
		normalized.startsWith("packages/evo/src/prompts/") ||
		normalized.startsWith("packages/evo/src/registry/") ||
		normalized === "packages/evo/src/storage.ts"
	) {
		throw new Error(`Code proposal cannot change Evo-Pi judge or apply/rollback paths: ${path}`);
	}
	if (
		DEPENDENCY_FILE_NAMES.has(fileName) ||
		normalized.includes("/node_modules/") ||
		normalized.startsWith("node_modules/") ||
		normalized.includes("/install-lock/") ||
		normalized.startsWith("packages/coding-agent/install-lock/") ||
		fileName.includes("lockfile")
	) {
		throw new Error(`Code proposal cannot change dependencies, lockfiles, or install metadata: ${path}`);
	}
}

async function assertNoUnstagedChanges(runner: CommandRunner, worktreePath: string): Promise<void> {
	const unstaged = await runCommand(runner, "git", ["-C", worktreePath, "diff", "--quiet", "--"], worktreePath);
	if (unstaged.code !== 0 || unstaged.killed || unstaged.outputLimitExceeded) {
		throw new CodeWorktreeIntegrityError("Code worktree has unstaged changes after validation");
	}
	const untracked = await runGit(
		runner,
		worktreePath,
		["ls-files", "--others", "--exclude-standard", "-z"],
		"Inspect untracked candidate files",
	);
	if (untracked.stdout.length > 0) {
		throw new CodeWorktreeIntegrityError("Code worktree has untracked files after validation");
	}
}

export function codeApprovalDigest(options: {
	repositoryRoot: string;
	repositoryIdentity: string;
	baseCommit: string;
	parentBundleDigest: string;
	diff: string;
}): string {
	return sha256(
		canonicalJson({
			schemaVersion: CODE_WORKSPACE_SCHEMA_VERSION,
			repositoryRoot: options.repositoryRoot,
			repositoryIdentity: options.repositoryIdentity,
			baseCommit: options.baseCommit,
			parentBundleDigest: options.parentBundleDigest,
			diff: options.diff,
		}),
	);
}

async function inspectCandidate(
	runner: CommandRunner,
	worktreePath: string,
	repositoryRoot: string,
	repositoryIdentityValue: string,
	baseCommit: string,
	parentBundleDigest: string,
): Promise<CandidateSnapshot> {
	const [names, raw, summary, numstat, whitespace, diff] = await Promise.all([
		runGit(runner, worktreePath, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"], "List candidate paths"),
		runGit(runner, worktreePath, ["diff", "--cached", "--raw", "-z", "HEAD", "--"], "Inspect candidate modes"),
		runGit(runner, worktreePath, ["diff", "--cached", "--summary", "HEAD", "--"], "Inspect candidate modes"),
		runGit(
			runner,
			worktreePath,
			["diff", "--cached", "--numstat", "-z", "HEAD", "--"],
			"Inspect candidate binary files",
		),
		runCommand(runner, "git", ["-C", worktreePath, "diff", "--cached", "--check", "HEAD", "--"], worktreePath),
		runGit(
			runner,
			worktreePath,
			["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"],
			"Render complete candidate diff",
		),
	]);
	if (whitespace.code !== 0 || whitespace.killed || whitespace.outputLimitExceeded) {
		throw new Error(`Candidate diff failed whitespace validation: ${whitespace.stderr || whitespace.stdout}`);
	}
	if (
		/\b(?:120000|160000)\b/.test(summary.stdout) ||
		/(?:^|\0):(?:120000|160000) [0-7]{6} |(?:^|\0):[0-7]{6} (?:120000|160000) /.test(raw.stdout)
	) {
		throw new Error("Code proposal cannot add or modify symlinks or submodules");
	}
	if (numstat.stdout.split("\0").some((entry) => entry.startsWith("-\t-\t"))) {
		throw new Error("Code proposal cannot contain binary changes");
	}
	const changedPaths = names.stdout.split("\0").filter(Boolean).sort();
	if (changedPaths.length === 0 || !diff.stdout) throw new Error("Code proposal patch is empty");
	for (const path of changedPaths) assertSafeChangedPath(path);
	const approvalDigest = codeApprovalDigest({
		repositoryRoot,
		repositoryIdentity: repositoryIdentityValue,
		baseCommit,
		parentBundleDigest,
		diff: diff.stdout,
	});
	return {
		changedPaths,
		diff: diff.stdout,
		approvalDigest,
		diffDigest: sha256(diff.stdout),
	};
}

async function listEvoTests(worktreePath: string): Promise<string[]> {
	const directory = join(worktreePath, "packages", "evo", "test");
	try {
		return (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
			.map((entry) => `test/${entry.name}`)
			.sort();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function fixedValidationCommands(context: CodeValidationContext): Promise<ValidationCommand[]> {
	const commands: ValidationCommand[] = [
		{ name: "repository-check", command: "npm", args: ["run", "check"], cwd: context.worktreePath },
	];
	const tests = new Map<string, Set<string>>();
	if (context.changedPaths.some((path) => path.startsWith("packages/evo/"))) {
		tests.set("evo", new Set(await listEvoTests(context.worktreePath)));
	}
	for (const path of context.changedPaths) {
		const match = /^packages\/([^/]+)\/(test\/.*\.test\.ts)$/.exec(path);
		if (!match) continue;
		const packageName = match[1];
		const testPath = match[2];
		const packageTests = tests.get(packageName) ?? new Set<string>();
		packageTests.add(testPath);
		tests.set(packageName, packageTests);
	}
	for (const [packageName, testPaths] of [...tests].sort(([left], [right]) => left.localeCompare(right))) {
		if (testPaths.size === 0) continue;
		commands.push({
			name: `${packageName}-related-tests`,
			command: "node",
			args: [
				join(context.worktreePath, "node_modules", "vitest", "dist", "cli.js"),
				"--run",
				...[...testPaths].sort(),
			],
			cwd: join(context.worktreePath, "packages", packageName),
		});
	}
	if (commands.length === 1) {
		throw new Error("The fixed validation profile has no related-test mapping for this candidate");
	}
	return commands;
}

function minimalValidationEnv(options: {
	worktreePath: string;
	home: string;
	temporaryDirectory: string;
	runtimeBin: string;
}): NodeJS.ProcessEnv {
	return {
		PATH: [join(options.worktreePath, "node_modules", ".bin"), options.runtimeBin, "/usr/bin", "/bin"].join(
			delimiter,
		),
		HOME: options.home,
		TMPDIR: options.temporaryDirectory,
		CI: "1",
		NO_COLOR: "1",
		npm_config_cache: join(options.home, ".npm"),
		...(process.env.LANG ? { LANG: process.env.LANG } : {}),
		...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
	};
}

function macSandboxProfile(options: {
	validationRoot: string;
	repositoryNodeModules: string;
	runtimeDirectory: string;
	runtimeExecutable: string;
}): string {
	const escapeProfilePath = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	return [
		"(version 1)",
		"(deny default)",
		"(deny network*)",
		"(allow process*)",
		"(allow sysctl-read)",
		`(allow file-read-metadata (literal "${escapeProfilePath(options.runtimeDirectory)}"))`,
		`(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library") (literal "${escapeProfilePath(options.runtimeExecutable)}") (subpath "${escapeProfilePath(options.repositoryNodeModules)}") (subpath "${escapeProfilePath(options.validationRoot)}"))`,
		`(allow file-write* (subpath "${escapeProfilePath(join(options.validationRoot, "home"))}") (subpath "${escapeProfilePath(join(options.validationRoot, "tmp"))}") (literal "/dev/null"))`,
	].join(" ");
}

function sandboxPath(hostPath: string, validationRoot: string): string {
	const child = relative(validationRoot, hostPath);
	if (!child || child === ".." || child.startsWith(`..${sep}`)) {
		throw new Error("Validation command escaped its private workspace");
	}
	return join(SANDBOX_ROOT, child);
}

async function readOnlyBindArguments(paths: readonly string[]): Promise<string[]> {
	const arguments_: string[] = [];
	for (const path of paths) {
		try {
			await lstat(path);
			arguments_.push("--ro-bind", path, path);
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
	return arguments_;
}

function sanitizedCommandResult(result: CommandResult): CommandResult {
	return { ...result, stdout: "", stderr: "" };
}

function validationFailure(name: string, result: CommandResult): string {
	if (result.aborted) return `${name} aborted`;
	if (result.timedOut) return `${name} timed out`;
	if (result.outputLimitExceeded) return `${name} exceeded the output limit`;
	if (result.killed) return `${name} was terminated`;
	return `${name} failed with exit ${result.code}`;
}

async function validationWorkspaceDigest(root: string): Promise<string> {
	const records: Array<Record<string, string | number>> = [];
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			const childPath = join(directory, entry.name);
			const child = prefix ? `${prefix}/${entry.name}` : entry.name;
			const metadata = await lstat(childPath);
			const mode = metadata.mode & 0o777;
			if (metadata.isDirectory()) {
				records.push({ path: child, kind: "directory", mode });
				await visit(childPath, child);
				continue;
			}
			if (metadata.isFile()) {
				records.push({ path: child, kind: "file", mode, digest: sha256(await readFile(childPath)) });
				continue;
			}
			if (metadata.isSymbolicLink()) {
				records.push({ path: child, kind: "symlink", mode, target: await readlink(childPath) });
				continue;
			}
			throw new Error(`Validation workspace contains unsupported entry: ${child}`);
		}
	};
	await visit(root, "");
	return sha256(canonicalJson(records));
}

function containsPath(parent: string, candidate: string): boolean {
	const child = relative(parent, candidate);
	return !child || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function resolveValidationDirectory(path: string, expectedName: string, label: string): Promise<string> {
	const resolved = await realpath(path);
	if (basename(resolved).toLowerCase() !== expectedName || !(await lstat(resolved)).isDirectory()) {
		throw new Error(`${label} is not a dedicated ${expectedName} directory`);
	}
	return resolved;
}

async function createMacDependencyLink(options: {
	source: string;
	target: string;
	repositoryRoot: string;
	repositoryNodeModules: string;
	validationWorktree: string;
}): Promise<void> {
	const resolved = await realpath(options.source);
	const metadata = await lstat(resolved);
	let target = resolved;
	if (!containsPath(options.repositoryNodeModules, resolved)) {
		if (!containsPath(options.repositoryRoot, resolved)) {
			throw new Error(`Dependency link escapes the repository dependency root: ${options.source}`);
		}
		const child = relative(options.repositoryRoot, resolved);
		if (child === "packages" || !child.startsWith(`packages${sep}`)) {
			throw new Error(`Workspace dependency link escaped repository packages: ${options.source}`);
		}
		target = join(options.validationWorktree, child);
		const candidateMetadata = await lstat(target);
		if (
			candidateMetadata.isDirectory() !== metadata.isDirectory() ||
			candidateMetadata.isFile() !== metadata.isFile()
		) {
			throw new Error(`Workspace dependency type changed in the validation copy: ${options.source}`);
		}
	}
	await symlink(target, options.target, metadata.isDirectory() ? "dir" : "file");
}

async function createMacDependencyView(
	repositoryRoot: string,
	repositoryNodeModules: string,
	validationRoot: string,
	validationWorktree: string,
): Promise<void> {
	const view = join(validationRoot, "dependencies", "node_modules");
	await mkdir(view, { recursive: true, mode: 0o700 });
	for (const entry of await readdir(repositoryNodeModules, { withFileTypes: true })) {
		const source = join(repositoryNodeModules, entry.name);
		const target = join(view, entry.name);
		if (entry.isDirectory() && entry.name.startsWith("@")) {
			await mkdir(target, { mode: 0o700 });
			for (const child of await readdir(source)) {
				await createMacDependencyLink({
					source: join(source, child),
					target: join(target, child),
					repositoryRoot,
					repositoryNodeModules,
					validationWorktree,
				});
			}
			continue;
		}
		await createMacDependencyLink({ source, target, repositoryRoot, repositoryNodeModules, validationWorktree });
	}
	await symlink("../dependencies/node_modules", join(validationWorktree, "node_modules"), "dir");
}

async function runSandboxed(
	context: CodeValidationContext,
	validationCommand: ValidationCommand,
	validationRoot: string,
): Promise<CommandResult> {
	const repositoryRoot = await realpath(context.repositoryRoot);
	const repositoryNodeModules = await resolveValidationDirectory(
		join(repositoryRoot, "node_modules"),
		"node_modules",
		"Repository dependency root",
	);
	if (containsPath(repositoryNodeModules, repositoryRoot)) {
		throw new Error("Repository dependency root is too broad for sandbox mounting");
	}
	const runtimeExecutable = await realpath(process.execPath);
	if (!(await lstat(runtimeExecutable)).isFile()) {
		throw new Error("Runtime executable is not a regular file");
	}
	if (process.platform === "linux") {
		const runtimeCoveredBySystem = ["/usr", "/bin", "/lib", "/lib64"].some((root) => {
			const child = relative(root, runtimeExecutable);
			return child !== ".." && !child.startsWith(`..${sep}`);
		});
		const runtimeBin = runtimeCoveredBySystem ? dirname(runtimeExecutable) : `${SANDBOX_ROOT}/runtime`;
		const env = minimalValidationEnv({
			worktreePath: `${SANDBOX_ROOT}/workspace`,
			home: `${SANDBOX_ROOT}/home`,
			temporaryDirectory: `${SANDBOX_ROOT}/tmp`,
			runtimeBin,
		});
		const systemBinds = await readOnlyBindArguments(["/usr", "/bin", "/lib", "/lib64"]);
		const systemFiles = await readOnlyBindArguments(["/etc/passwd", "/etc/group", "/etc/ld.so.cache"]);
		return runCommand(
			context.commandRunner,
			"bwrap",
			[
				"--die-with-parent",
				"--new-session",
				"--unshare-net",
				"--unshare-pid",
				"--unshare-ipc",
				"--unshare-uts",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--tmpfs",
				"/tmp",
				...systemBinds,
				"--dir",
				"/etc",
				...systemFiles,
				"--dir",
				SANDBOX_ROOT,
				"--ro-bind",
				join(validationRoot, "workspace"),
				`${SANDBOX_ROOT}/workspace`,
				"--bind",
				join(validationRoot, "home"),
				`${SANDBOX_ROOT}/home`,
				"--bind",
				join(validationRoot, "tmp"),
				`${SANDBOX_ROOT}/tmp`,
				"--dir",
				`${SANDBOX_ROOT}/runtime`,
				"--ro-bind",
				repositoryNodeModules,
				`${SANDBOX_ROOT}/workspace/node_modules`,
				...(runtimeCoveredBySystem ? [] : ["--ro-bind", runtimeExecutable, `${SANDBOX_ROOT}/runtime/node`]),
				"--chdir",
				sandboxPath(validationCommand.cwd, validationRoot),
				"--",
				validationCommand.command,
				...validationCommand.args.map((argument) =>
					argument.startsWith(validationRoot) ? sandboxPath(argument, validationRoot) : argument,
				),
			],
			validationRoot,
			{
				timeoutMs: VALIDATION_TIMEOUT_MS,
				env,
				maxOutputBytes: VALIDATION_OUTPUT_LIMIT,
				...(context.signal ? { signal: context.signal } : {}),
			},
		);
	}
	if (process.platform === "darwin") {
		const env = minimalValidationEnv({
			worktreePath: join(validationRoot, "workspace"),
			home: join(validationRoot, "home"),
			temporaryDirectory: join(validationRoot, "tmp"),
			runtimeBin: dirname(runtimeExecutable),
		});
		return runCommand(
			context.commandRunner,
			"/usr/bin/sandbox-exec",
			[
				"-p",
				macSandboxProfile({
					validationRoot,
					repositoryNodeModules,
					runtimeDirectory: dirname(runtimeExecutable),
					runtimeExecutable,
				}),
				validationCommand.command,
				...validationCommand.args,
			],
			validationCommand.cwd,
			{
				timeoutMs: VALIDATION_TIMEOUT_MS,
				env,
				maxOutputBytes: VALIDATION_OUTPUT_LIMIT,
				...(context.signal ? { signal: context.signal } : {}),
			},
		);
	}
	throw new Error(`OS sandbox validation is unavailable on ${process.platform}`);
}

export class DefaultSandboxCodeValidationExecutor implements CodeValidationExecutor {
	async validate(context: CodeValidationContext): Promise<CodeL1Result> {
		const checks: CodeValidationCheck[] = [];
		const errors: string[] = [];
		const validationRoot = await mkdtemp(join(tmpdir(), "evo-pi-validation-"));
		try {
			context.signal?.throwIfAborted();
			const validationWorktree = join(validationRoot, "workspace");
			await mkdir(join(validationRoot, "home"), { mode: 0o700 });
			await mkdir(join(validationRoot, "tmp"), { mode: 0o700 });
			await mkdir(join(validationRoot, "runtime"), { mode: 0o700 });
			await cp(context.worktreePath, validationWorktree, {
				recursive: true,
				dereference: false,
				verbatimSymlinks: true,
				filter: (source) => {
					const child = relative(context.worktreePath, source);
					const segments = child.split(sep);
					return !segments.includes(".git") && !segments.includes("node_modules");
				},
			});
			const validationNodeModules = join(validationWorktree, "node_modules");
			if (process.platform === "darwin") {
				const repositoryRoot = await realpath(context.repositoryRoot);
				const repositoryNodeModules = await resolveValidationDirectory(
					join(repositoryRoot, "node_modules"),
					"node_modules",
					"Repository dependency root",
				);
				if (containsPath(repositoryNodeModules, repositoryRoot)) {
					throw new Error("Repository dependency root is too broad for sandbox mounting");
				}
				await createMacDependencyView(repositoryRoot, repositoryNodeModules, validationRoot, validationWorktree);
			} else {
				await mkdir(validationNodeModules, { mode: 0o700 });
			}
			const beforeValidationDigest = await validationWorkspaceDigest(validationWorktree);
			const validationContext: CodeValidationContext = {
				...context,
				worktreePath: validationWorktree,
			};
			for (const command of await fixedValidationCommands(validationContext)) {
				const result = await runSandboxed(validationContext, command, validationRoot);
				checks.push({ name: command.name, result: sanitizedCommandResult(result) });
				const failed = result.code !== 0 || result.killed || result.outputLimitExceeded;
				if (failed) errors.push(validationFailure(command.name, result));
				const modified = (await validationWorkspaceDigest(validationWorktree)) !== beforeValidationDigest;
				if (modified) errors.push("Sandboxed validation modified the candidate instead of checking it read-only");
				if (failed || modified) break;
			}
		} catch (error) {
			const detail = errorMessage(error)
				.replace(/[\r\n\t]+/g, " ")
				.slice(0, 500);
			errors.push(`Sandboxed validation failed closed: ${detail}`);
		} finally {
			await rm(validationRoot, { recursive: true, force: true }).catch(() => {});
		}
		return { passed: errors.length === 0 && checks.length > 0, errors, checks };
	}
}

async function persistRevision(paths: ReturnType<typeof revisionPaths>, revision: CodeWorktreeRevision): Promise<void> {
	await atomicWriteFile(paths.diffFile, revision.diff);
	await atomicWriteJson(paths.l1File, revision.l1);
	const { diff: _diff, ...persisted } = revision;
	await atomicWriteJson(paths.workspaceFile, persisted);
}

function buildRevision(options: {
	proposalId: string;
	revision: number;
	parentBundleDigest: string;
	repository: RepositoryInfo;
	paths: ReturnType<typeof revisionPaths>;
	snapshot: CandidateSnapshot;
	l1: CodeL1Result;
}): CodeWorktreeRevision {
	return {
		schemaVersion: 1,
		proposalId: options.proposalId,
		revision: options.revision,
		parentBundleDigest: options.parentBundleDigest,
		repositoryRoot: options.repository.root,
		repositoryIdentity: options.repository.identity,
		baseCommit: options.repository.baseCommit,
		branch: options.paths.branch,
		worktreePath: options.paths.worktreePath,
		revisionDirectory: options.paths.revisionDirectory,
		patchFile: options.paths.patchFile,
		diffFile: options.paths.diffFile,
		changedPaths: options.snapshot.changedPaths,
		diff: options.snapshot.diff,
		approvalDigest: options.snapshot.approvalDigest,
		diffDigest: options.snapshot.diffDigest,
		l1: options.l1,
	};
}

async function removeEmptyRevisionParents(paths: ReturnType<typeof revisionPaths>): Promise<void> {
	for (const directory of [
		dirname(paths.revisionDirectory),
		dirname(dirname(paths.revisionDirectory)),
		dirname(paths.worktreePath),
	]) {
		await rmdir(directory).catch(() => undefined);
	}
}

function builderWorktreePath(paths: EvoPaths, runId: string): string {
	if (!PROPOSAL_ID_PATTERN.test(runId)) throw new Error(`Invalid evolution run id: ${runId}`);
	return join(paths.worktrees, "builders", runId);
}

export async function createCodeBuilderWorkspace(options: {
	paths: EvoPaths;
	repositoryCwd: string;
	runId: string;
	commandRunner?: CommandRunner;
	signal?: AbortSignal;
}): Promise<CodeBuilderWorkspace> {
	const runner = options.commandRunner ?? new SpawnCommandRunner();
	const repository = await inspectRepository(runner, options.repositoryCwd);
	const worktreePath = builderWorktreePath(options.paths, options.runId);
	options.signal?.throwIfAborted();
	await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
	await runGit(
		runner,
		repository.root,
		["worktree", "add", "--detach", worktreePath, repository.baseCommit],
		"Create isolated Builder worktree",
	);
	return {
		runId: options.runId,
		repositoryRoot: repository.root,
		repositoryIdentity: repository.identity,
		baseCommit: repository.baseCommit,
		worktreePath,
	};
}

export async function snapshotCodeBuilderWorkspace(options: {
	workspace: CodeBuilderWorkspace;
	parentBundleDigest: string;
	commandRunner?: CommandRunner;
}): Promise<CodeBuilderSnapshot> {
	assertBundleDigest(options.parentBundleDigest);
	const runner = options.commandRunner ?? new SpawnCommandRunner();
	const identity = await repositoryIdentity(runner, options.workspace.worktreePath);
	if (identity !== options.workspace.repositoryIdentity) {
		throw new CodeWorktreeIntegrityError("Builder worktree repository identity changed");
	}
	const head = (
		await runGit(
			runner,
			options.workspace.worktreePath,
			["rev-parse", "--verify", "HEAD^{commit}"],
			"Verify Builder base",
		)
	).stdout.trim();
	if (head !== options.workspace.baseCommit) {
		throw new CodeWorktreeIntegrityError("Builder worktree base commit changed");
	}
	const [tracked, untracked] = await Promise.all([
		runGit(
			runner,
			options.workspace.worktreePath,
			["diff", "--name-only", "-z", "HEAD", "--"],
			"List Builder tracked changes",
		),
		runGit(
			runner,
			options.workspace.worktreePath,
			["ls-files", "--others", "--exclude-standard", "-z"],
			"List Builder untracked changes",
		),
	]);
	const changedPaths = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))];
	if (changedPaths.length === 0) throw new Error("Builder did not modify its isolated worktree");
	for (const path of changedPaths) assertSafeChangedPath(path);
	await runGit(runner, options.workspace.worktreePath, ["add", "--all", "--"], "Stage Builder candidate");
	const snapshot = await inspectCandidate(
		runner,
		options.workspace.worktreePath,
		options.workspace.repositoryRoot,
		options.workspace.repositoryIdentity,
		options.workspace.baseCommit,
		options.parentBundleDigest,
	);
	await assertNoUnstagedChanges(runner, options.workspace.worktreePath);
	return {
		patch: snapshot.diff,
		changedPaths: snapshot.changedPaths,
		repositoryRoot: options.workspace.repositoryRoot,
		repositoryIdentity: options.workspace.repositoryIdentity,
		baseCommit: options.workspace.baseCommit,
	};
}

export async function removeCodeBuilderWorkspace(
	workspace: CodeBuilderWorkspace,
	commandRunner: CommandRunner = new SpawnCommandRunner(),
): Promise<void> {
	await runGit(
		commandRunner,
		workspace.repositoryRoot,
		["worktree", "remove", "--force", "--", workspace.worktreePath],
		"Remove isolated Builder worktree",
	);
	await rmdir(dirname(workspace.worktreePath)).catch(() => undefined);
}

async function cleanupFailedRevision(
	runner: CommandRunner,
	repositoryRoot: string,
	paths: ReturnType<typeof revisionPaths>,
	options: { removeWorktree: boolean; deleteBranch: boolean },
): Promise<void> {
	if (options.removeWorktree) {
		await runCommand(
			runner,
			"git",
			["-C", repositoryRoot, "worktree", "remove", "--force", "--", paths.worktreePath],
			repositoryRoot,
		).catch(() => undefined);
	}
	if (options.deleteBranch) {
		await runCommand(runner, "git", ["-C", repositoryRoot, "branch", "-D", "--", paths.branch], repositoryRoot).catch(
			() => undefined,
		);
	}
	await rm(paths.revisionDirectory, { recursive: true, force: true }).catch(() => undefined);
	await removeEmptyRevisionParents(paths);
}

export async function stageCodeWorktree(options: StageCodeWorktreeOptions): Promise<CodeWorktreeRevision> {
	assertProposalRevision(options.proposalId, options.revision);
	assertBundleDigest(options.parentBundleDigest);
	if (!options.patch.trim()) throw new Error("Code proposal patch is empty");
	const runner = options.commandRunner ?? new SpawnCommandRunner();
	const validationExecutor = options.validationExecutor ?? new DefaultSandboxCodeValidationExecutor();
	const paths = revisionPaths(options.paths, options.proposalId, options.revision);
	return withFileLock(
		options.paths,
		`code-${options.proposalId}-r${options.revision}`,
		async () => {
			const repository = await inspectRepository(runner, options.repositoryCwd);
			if (options.expectedRepositoryRoot && repository.root !== options.expectedRepositoryRoot) {
				throw new CodeWorktreeIntegrityError("Repository root changed after Builder snapshot");
			}
			if (options.expectedRepositoryIdentity && repository.identity !== options.expectedRepositoryIdentity) {
				throw new CodeWorktreeIntegrityError("Repository identity changed after Builder snapshot");
			}
			if (options.expectedBaseCommit && repository.baseCommit !== options.expectedBaseCommit) {
				throw new CodeWorktreeIntegrityError("Repository HEAD changed after Builder snapshot");
			}
			let revisionDirectoryCreated = false;
			let branchCreated = false;
			let worktreeAddAttempted = false;
			try {
				options.signal?.throwIfAborted();
				await mkdir(dirname(paths.revisionDirectory), { recursive: true });
				await mkdir(paths.revisionDirectory);
				revisionDirectoryCreated = true;
				await mkdir(dirname(paths.worktreePath), { recursive: true });
				await writeFile(paths.patchFile, options.patch, { encoding: "utf8", flag: "wx", mode: 0o600 });
				await runGit(
					runner,
					repository.root,
					["branch", "--", paths.branch, repository.baseCommit],
					"Create code proposal branch",
				);
				branchCreated = true;
				worktreeAddAttempted = true;
				await runGit(
					runner,
					repository.root,
					["worktree", "add", paths.worktreePath, paths.branch],
					"Create isolated code worktree",
				);
				await runGit(
					runner,
					paths.worktreePath,
					["apply", "--check", "--index", "--", paths.patchFile],
					"Check code proposal patch",
				);
				await runGit(
					runner,
					paths.worktreePath,
					["apply", "--index", "--", paths.patchFile],
					"Apply code proposal patch",
				);
				const beforeValidation = await inspectCandidate(
					runner,
					paths.worktreePath,
					repository.root,
					repository.identity,
					repository.baseCommit,
					options.parentBundleDigest,
				);
				const l1 = await validationExecutor.validate({
					repositoryRoot: repository.root,
					worktreePath: paths.worktreePath,
					baseCommit: repository.baseCommit,
					changedPaths: beforeValidation.changedPaths,
					commandRunner: runner,
					...(options.signal ? { signal: options.signal } : {}),
				});
				if (!l1.passed) throw new Error("Code proposal failed sandboxed L1 validation");
				await assertNoUnstagedChanges(runner, paths.worktreePath);
				const snapshot = await inspectCandidate(
					runner,
					paths.worktreePath,
					repository.root,
					repository.identity,
					repository.baseCommit,
					options.parentBundleDigest,
				);
				if (
					snapshot.approvalDigest !== beforeValidation.approvalDigest ||
					snapshot.diff !== beforeValidation.diff
				) {
					throw new CodeWorktreeIntegrityError("L1 validation mutated the code candidate");
				}
				const revision = buildRevision({
					proposalId: options.proposalId,
					revision: options.revision,
					parentBundleDigest: options.parentBundleDigest,
					repository,
					paths,
					snapshot,
					l1,
				});
				await persistRevision(paths, revision);
				return revision;
			} catch (error) {
				if (branchCreated || worktreeAddAttempted) {
					await cleanupFailedRevision(runner, repository.root, paths, {
						removeWorktree: worktreeAddAttempted,
						deleteBranch: branchCreated,
					});
				} else if (revisionDirectoryCreated) {
					await rm(paths.revisionDirectory, { recursive: true, force: true }).catch(() => undefined);
					await removeEmptyRevisionParents(paths);
				}
				throw error;
			}
		},
		{ staleAfterMs: CODE_LOCK_STALE_MS },
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parsePersistedRevision(value: unknown): PersistedCodeWorktreeRevision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodeWorktreeIntegrityError("workspace.json must contain an object");
	}
	const record = value as Record<string, unknown>;
	if (
		record.schemaVersion !== 1 ||
		typeof record.proposalId !== "string" ||
		!Number.isSafeInteger(record.revision) ||
		typeof record.parentBundleDigest !== "string" ||
		typeof record.repositoryRoot !== "string" ||
		typeof record.repositoryIdentity !== "string" ||
		typeof record.baseCommit !== "string" ||
		typeof record.branch !== "string" ||
		typeof record.worktreePath !== "string" ||
		typeof record.revisionDirectory !== "string" ||
		typeof record.patchFile !== "string" ||
		typeof record.diffFile !== "string" ||
		!isStringArray(record.changedPaths) ||
		typeof record.approvalDigest !== "string" ||
		typeof record.diffDigest !== "string" ||
		typeof record.l1 !== "object" ||
		record.l1 === null
	) {
		throw new CodeWorktreeIntegrityError("workspace.json is invalid");
	}
	return value as PersistedCodeWorktreeRevision;
}

export async function loadCodeWorktreeRevision(
	paths: EvoPaths,
	proposalId: string,
	revision: number,
): Promise<CodeWorktreeRevision> {
	assertProposalRevision(proposalId, revision);
	const expectedPaths = revisionPaths(paths, proposalId, revision);
	const persisted = parsePersistedRevision(await readJson<unknown>(expectedPaths.workspaceFile));
	const diff = await readFile(expectedPaths.diffFile, "utf8");
	return { ...persisted, diff };
}

function assertExpectedPath(actual: string, expected: string, label: string): void {
	if (resolve(actual) !== resolve(expected))
		throw new CodeWorktreeIntegrityError(`${label} does not match its revision path`);
}

async function assertWorktreeLocation(paths: EvoPaths, worktreePath: string): Promise<void> {
	const [root, candidate] = await Promise.all([realpath(paths.worktrees), realpath(worktreePath)]);
	const child = relative(root, candidate);
	if (!child || child === ".." || child.startsWith(`..${sep}`)) {
		throw new CodeWorktreeIntegrityError("Code worktree is outside the Evo-Pi worktree directory");
	}
	if (!(await lstat(candidate)).isDirectory())
		throw new CodeWorktreeIntegrityError("Code worktree is not a directory");
}

export async function revalidateCodeWorktree(options: RevalidateCodeWorktreeOptions): Promise<CodeWorktreeRevision> {
	assertProposalRevision(options.proposalId, options.revision);
	assertBundleDigest(options.expectedParentBundleDigest);
	const runner = options.commandRunner ?? new SpawnCommandRunner();
	const validationExecutor = options.validationExecutor ?? new DefaultSandboxCodeValidationExecutor();
	const paths = revisionPaths(options.paths, options.proposalId, options.revision);
	return withFileLock(
		options.paths,
		`code-${options.proposalId}-r${options.revision}`,
		async () => {
			const stored = await loadCodeWorktreeRevision(options.paths, options.proposalId, options.revision);
			if (stored.parentBundleDigest !== options.expectedParentBundleDigest) {
				throw new CodeWorktreeIntegrityError("Stored parent bundle does not match the approved context");
			}
			if (stored.proposalId !== options.proposalId || stored.revision !== options.revision) {
				throw new CodeWorktreeIntegrityError("Stored code revision identity does not match the requested revision");
			}
			assertExpectedPath(stored.repositoryRoot, options.expectedRepositoryRoot, "repositoryRoot");
			if (stored.repositoryIdentity !== options.expectedRepositoryIdentity) {
				throw new CodeWorktreeIntegrityError("Stored repository identity does not match the approved workspace");
			}
			if (stored.baseCommit !== options.expectedBaseCommit) {
				throw new CodeWorktreeIntegrityError("Stored base commit does not match the approved workspace");
			}
			assertExpectedPath(stored.worktreePath, paths.worktreePath, "worktreePath");
			assertExpectedPath(stored.revisionDirectory, paths.revisionDirectory, "revisionDirectory");
			assertExpectedPath(stored.patchFile, paths.patchFile, "patchFile");
			assertExpectedPath(stored.diffFile, paths.diffFile, "diffFile");
			if (stored.branch !== paths.branch)
				throw new CodeWorktreeIntegrityError("Stored branch does not match the revision");
			await assertWorktreeLocation(options.paths, paths.worktreePath);

			const actualIdentity = await repositoryIdentity(runner, paths.worktreePath);
			if (actualIdentity !== options.expectedRepositoryIdentity) {
				throw new CodeWorktreeIntegrityError("Code worktree repository identity changed");
			}
			const head = (
				await runGit(runner, paths.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"], "Verify code base")
			).stdout.trim();
			if (head !== options.expectedBaseCommit)
				throw new CodeWorktreeIntegrityError("Code worktree base commit changed");
			const branch = (
				await runGit(runner, paths.worktreePath, ["branch", "--show-current"], "Verify code branch")
			).stdout.trim();
			if (branch !== paths.branch) throw new CodeWorktreeIntegrityError("Code worktree branch changed");
			await assertNoUnstagedChanges(runner, paths.worktreePath);

			const beforeValidation = await inspectCandidate(
				runner,
				paths.worktreePath,
				options.expectedRepositoryRoot,
				actualIdentity,
				options.expectedBaseCommit,
				options.expectedParentBundleDigest,
			);
			if (
				beforeValidation.approvalDigest !== options.expectedApprovalDigest ||
				beforeValidation.approvalDigest !== stored.approvalDigest ||
				beforeValidation.diffDigest !== stored.diffDigest ||
				beforeValidation.diff !== stored.diff ||
				canonicalJson(beforeValidation.changedPaths) !== canonicalJson(stored.changedPaths)
			) {
				throw new CodeWorktreeIntegrityError("Code proposal no longer matches the approved digest and stored diff");
			}

			const l1 = await validationExecutor.validate({
				repositoryRoot: options.expectedRepositoryRoot,
				worktreePath: paths.worktreePath,
				baseCommit: options.expectedBaseCommit,
				changedPaths: beforeValidation.changedPaths,
				commandRunner: runner,
				...(options.signal ? { signal: options.signal } : {}),
			});
			await assertNoUnstagedChanges(runner, paths.worktreePath);
			const afterValidation = await inspectCandidate(
				runner,
				paths.worktreePath,
				options.expectedRepositoryRoot,
				actualIdentity,
				options.expectedBaseCommit,
				options.expectedParentBundleDigest,
			);
			if (
				afterValidation.approvalDigest !== beforeValidation.approvalDigest ||
				afterValidation.diff !== beforeValidation.diff
			) {
				throw new CodeWorktreeIntegrityError("L1 validation mutated the approved code candidate");
			}
			const repository: RepositoryInfo = {
				root: options.expectedRepositoryRoot,
				identity: actualIdentity,
				baseCommit: options.expectedBaseCommit,
			};
			const revision = buildRevision({
				proposalId: options.proposalId,
				revision: options.revision,
				parentBundleDigest: options.expectedParentBundleDigest,
				repository,
				paths,
				snapshot: afterValidation,
				l1,
			});
			return revision;
		},
		{ staleAfterMs: CODE_LOCK_STALE_MS },
	);
}
