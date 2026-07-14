import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { type EvoPaths, ensureEvoLayout } from "./paths.ts";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
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

export async function atomicWriteFile(path: string, content: string): Promise<void> {
	const directory = dirname(path);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const handle = await open(temporaryPath, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporaryPath, path);
		await syncDirectory(directory);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWriteFile(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
	const handle = await open(path, "a", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
	try {
		const lockStat = await stat(lockPath);
		if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return false;
		await unlink(lockPath);
		return true;
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return true;
		throw error;
	}
}

export async function withFileLock<T>(
	paths: EvoPaths,
	name: string,
	operation: () => Promise<T>,
	options: { timeoutMs?: number; staleAfterMs?: number } = {},
): Promise<T> {
	await ensureEvoLayout(paths);
	const lockPath = `${paths.locks}/${name}.lock`;
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
	let handle: FileHandle | undefined;

	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
			await handle.sync();
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") throw error;
			if (await removeStaleLock(lockPath, staleAfterMs)) continue;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${name}`);
			await wait(25);
		}
	}

	try {
		return await operation();
	} finally {
		await handle.close();
		await unlink(lockPath).catch((error: unknown) => {
			if (getErrorCode(error) !== "ENOENT") throw error;
		});
	}
}
