import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type EvoPaths, ensureEvoLayout } from "./paths.ts";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MAX_DEFAULT_HEARTBEAT_MS = 10_000;
const OWNER_FILE_SUFFIX = ".owner.json";

export interface FileLockOptions {
	timeoutMs?: number;
	staleAfterMs?: number;
	heartbeatMs?: number | false;
	ownerToken?: string;
	afterLockPrepared?: () => void | Promise<void>;
	onHeartbeatError?: (error: unknown) => void;
}

export type FileLockAttempt<T> = { acquired: true; value: T } | { acquired: false };

export interface DurabilityOptions {
	syncDirectory?: (path: string) => Promise<void>;
}

interface AcquiredFileLock {
	ownerPath: string;
	stopHeartbeat: () => Promise<void>;
}

interface NamedAcquiredFileLock {
	lockPath: string;
	acquired: AcquiredFileLock;
}

interface ResolvedFileLockOptions extends FileLockOptions {
	timeoutMs: number;
	staleAfterMs: number;
	heartbeatMs: number | false;
}

interface FileLockOwnerRecord {
	schemaVersion: 1;
	ownerToken: string;
	pid: number;
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function parseFileLockOwner(value: unknown): FileLockOwnerRecord | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("ownerToken" in value) ||
		typeof value.ownerToken !== "string" ||
		!value.ownerToken ||
		!("pid" in value) ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0
	) {
		return undefined;
	}
	return value as FileLockOwnerRecord;
}

async function hasLiveOwnerProcess(ownerPath: string): Promise<boolean> {
	let owner: FileLockOwnerRecord | undefined;
	try {
		owner = parseFileLockOwner(JSON.parse(await readFile(ownerPath, "utf8")) as unknown);
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return false;
		if (error instanceof SyntaxError) return false;
		throw error;
	}
	if (!owner) return false;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return getErrorCode(error) !== "ESRCH";
	}
}

function normalizeJson(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(object).sort()) {
			const child = object[key];
			if (child !== undefined) normalized[key] = normalizeJson(child);
		}
		return normalized;
	}
	throw new Error(`Cannot canonicalize ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeJson(value));
}

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		return await readJson<T>(path);
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		await handle?.close();
	}
}

async function syncParentDirectory(path: string, options: DurabilityOptions): Promise<void> {
	await (options.syncDirectory ?? syncDirectory)(dirname(path));
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
	const directory = dirname(path);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
		await syncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWriteFile(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

export async function appendJsonLine(path: string, value: unknown, options: DurabilityOptions = {}): Promise<void> {
	const handle = await open(path, "a", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncParentDirectory(path, options);
}

export async function durableUnlink(path: string, options: DurabilityOptions = {}): Promise<boolean> {
	let removed = true;
	try {
		await unlink(path);
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") throw error;
		removed = false;
	}
	await syncParentDirectory(path, options);
	return removed;
}

export async function truncateIncompleteFinalLine(path: string): Promise<boolean> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r+");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return false;
		throw error;
	}
	try {
		const content = await handle.readFile();
		if (content.length === 0 || content[content.length - 1] === 0x0a) return false;
		const finalNewline = content.lastIndexOf(0x0a);
		await handle.truncate(finalNewline + 1);
		await handle.sync();
		return true;
	} finally {
		await handle.close();
	}
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assertDuration(value: number, label: string, allowZero = false): void {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
	}
}

function defaultHeartbeatMs(staleAfterMs: number): number | false {
	if (staleAfterMs === 1) return false;
	return Math.min(MAX_DEFAULT_HEARTBEAT_MS, Math.max(1, Math.floor(staleAfterMs / 3)), staleAfterMs - 1);
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
	let ownerNames: string[];
	try {
		ownerNames = (await readdir(lockPath)).filter((entry) => entry.endsWith(OWNER_FILE_SUFFIX));
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return true;
		throw error;
	}
	if (ownerNames.length === 0) {
		const lockStat = await stat(lockPath).catch((error: unknown) => {
			if (getErrorCode(error) === "ENOENT") return undefined;
			throw error;
		});
		if (!lockStat) return true;
		if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return false;
		try {
			await rmdir(lockPath);
			return true;
		} catch (error) {
			if (getErrorCode(error) === "ENOENT") return true;
			if (getErrorCode(error) === "ENOTEMPTY") return false;
			throw error;
		}
	}

	const existingOwners: Array<{ ownerPath: string; mtimeMs: number }> = [];
	for (const ownerName of ownerNames) {
		const ownerPath = join(lockPath, ownerName);
		const ownerStat = await stat(ownerPath).catch((error: unknown) => {
			if (getErrorCode(error) === "ENOENT") return undefined;
			throw error;
		});
		if (ownerStat) existingOwners.push({ ownerPath, mtimeMs: ownerStat.mtimeMs });
	}
	// An owner whose process is verifiably dead makes the lock reclaimable after a
	// short heartbeat grace window. The full staleAfterMs window applies only to
	// owners that still have a live process (e.g. paused with SIGSTOP), so a
	// kill -9 never wedges the lock for the whole stale window.
	const deadOwnerGraceMs = Math.min(staleAfterMs, 60_000);
	for (const { ownerPath, mtimeMs } of existingOwners) {
		// A live owner process is never reclaimed, regardless of mtime age.
		if (await hasLiveOwnerProcess(ownerPath)) return false;
		const current = await stat(ownerPath).catch((error: unknown) => {
			if (getErrorCode(error) === "ENOENT") return undefined;
			throw error;
		});
		// A refreshed mtime means the heartbeat still runs despite the PID probe.
		if (current && (current.mtimeMs !== mtimeMs || Date.now() - current.mtimeMs <= deadOwnerGraceMs)) return false;
	}
	for (const { ownerPath } of existingOwners) {
		await unlink(ownerPath).catch((error: unknown) => {
			if (getErrorCode(error) !== "ENOENT") throw error;
		});
	}
	try {
		await rmdir(lockPath);
		return true;
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return true;
		if (getErrorCode(error) === "ENOTEMPTY") return false;
		throw error;
	}
}

async function acquireLock(lockPath: string, options: ResolvedFileLockOptions): Promise<AcquiredFileLock> {
	const ownerToken = options.ownerToken ?? randomUUID();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ownerToken)) {
		throw new Error("ownerToken must be a safe non-empty lock identifier");
	}
	const pendingPath = `${lockPath}.pending-${process.pid}-${randomUUID()}`;
	const pendingOwnerPath = join(pendingPath, `${ownerToken}${OWNER_FILE_SUFFIX}`);
	const ownerPath = join(lockPath, `${ownerToken}${OWNER_FILE_SUFFIX}`);
	await mkdir(pendingPath, { mode: 0o700 });
	try {
		const handle = await open(pendingOwnerPath, "wx", 0o600);
		try {
			await handle.writeFile(
				`${JSON.stringify({
					schemaVersion: 1,
					ownerToken,
					pid: process.pid,
					createdAt: new Date().toISOString(),
				})}\n`,
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await options.afterLockPrepared?.();
		await rename(pendingPath, lockPath);
	} catch (error) {
		await unlink(pendingOwnerPath).catch(() => {});
		await rmdir(pendingPath).catch(() => {});
		throw error;
	}

	let stopped = false;
	let timeout: NodeJS.Timeout | undefined;
	let heartbeat = Promise.resolve();
	let heartbeatError: unknown;
	const scheduleHeartbeat = (): void => {
		if (options.heartbeatMs === false || stopped) return;
		timeout = setTimeout(() => {
			const now = new Date();
			heartbeat = utimes(ownerPath, now, now)
				.catch((error: unknown) => {
					heartbeatError = error;
					stopped = true;
					try {
						options.onHeartbeatError?.(error);
					} catch (callbackError) {
						heartbeatError = callbackError;
					}
				})
				.finally(scheduleHeartbeat);
		}, options.heartbeatMs);
		timeout.unref();
	};
	scheduleHeartbeat();

	return {
		ownerPath,
		stopHeartbeat: async () => {
			stopped = true;
			if (timeout) clearTimeout(timeout);
			await heartbeat;
			if (heartbeatError) throw heartbeatError;
		},
	};
}

async function releaseLock(lockPath: string, acquired: AcquiredFileLock): Promise<void> {
	let heartbeatError: unknown;
	try {
		await acquired.stopHeartbeat();
	} catch (error) {
		heartbeatError = error;
	}
	await unlink(acquired.ownerPath).catch((error: unknown) => {
		if (getErrorCode(error) !== "ENOENT") throw error;
	});
	await rmdir(lockPath).catch((error: unknown) => {
		if (getErrorCode(error) !== "ENOENT" && getErrorCode(error) !== "ENOTEMPTY") throw error;
	});
	if (heartbeatError) throw heartbeatError;
}

function resolveFileLockOptions(options: FileLockOptions): ResolvedFileLockOptions {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
	const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs(staleAfterMs);
	assertDuration(timeoutMs, "timeoutMs", true);
	assertDuration(staleAfterMs, "staleAfterMs");
	if (heartbeatMs !== false) {
		assertDuration(heartbeatMs, "heartbeatMs");
		if (heartbeatMs >= staleAfterMs) throw new Error("heartbeatMs must be less than staleAfterMs");
	}
	return { ...options, timeoutMs, staleAfterMs, heartbeatMs };
}

async function isLockContentionError(error: unknown, lockPath: string): Promise<boolean> {
	const code = getErrorCode(error);
	if (code === "EEXIST" || code === "ENOTEMPTY") return true;
	if (code !== "EPERM") return false;
	try {
		await stat(lockPath);
		return true;
	} catch (statError) {
		if (getErrorCode(statError) === "ENOENT") return false;
		throw statError;
	}
}

async function acquireNamedLock(
	paths: EvoPaths,
	name: string,
	options: FileLockOptions,
	waitForAvailability: boolean,
): Promise<NamedAcquiredFileLock | undefined> {
	await ensureEvoLayout(paths);
	const lockPath = `${paths.locks}/${name}.lock`;
	const resolved = resolveFileLockOptions(options);
	const deadline = Date.now() + resolved.timeoutMs;
	let acquired: AcquiredFileLock | undefined;

	while (!acquired) {
		try {
			acquired = await acquireLock(lockPath, resolved);
		} catch (error) {
			if (!(await isLockContentionError(error, lockPath))) throw error;
			if (await removeStaleLock(lockPath, resolved.staleAfterMs)) continue;
			if (!waitForAvailability || Date.now() >= deadline) return undefined;
			await wait(25);
		}
	}
	return { lockPath, acquired };
}

export async function withFileLock<T>(
	paths: EvoPaths,
	name: string,
	operation: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireNamedLock(paths, name, options, true);
	if (!lock) throw new Error(`Timed out waiting for lock: ${name}`);
	try {
		return await operation();
	} finally {
		await releaseLock(lock.lockPath, lock.acquired);
	}
}

export async function tryWithFileLock<T>(
	paths: EvoPaths,
	name: string,
	operation: () => Promise<T>,
	options: Omit<FileLockOptions, "timeoutMs"> = {},
): Promise<FileLockAttempt<T>> {
	const lock = await acquireNamedLock(paths, name, { ...options, timeoutMs: 0 }, false);
	if (!lock) return { acquired: false };
	try {
		return { acquired: true, value: await operation() };
	} finally {
		await releaseLock(lock.lockPath, lock.acquired);
	}
}
