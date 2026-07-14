import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvoPaths, ensureEvoLayout, getEvoPaths } from "../src/paths.ts";
import { appendJsonLine, durableUnlink, truncateIncompleteFinalLine, withFileLock } from "../src/storage.ts";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = (): void => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = () => resolvePromise();
	});
	return { promise, resolve };
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function exitedProcessId(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("Child process has no pid");
	await new Promise<void>((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("close", () => resolvePromise());
	});
	return pid;
}

describe("file lock storage", () => {
	let temporaryRoot: string;
	let paths: EvoPaths;

	beforeEach(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "pi-evo-storage-test-"));
		paths = getEvoPaths(join(temporaryRoot, "evo"));
	});

	afterEach(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")("keeps all Evo data directories private", async () => {
		await ensureEvoLayout(paths);
		const directories = [
			paths.root,
			dirname(paths.artifacts),
			paths.artifacts,
			paths.log,
			paths.inbox,
			paths.bundles,
			paths.registry,
			paths.intents,
			paths.proposals,
			paths.reports,
			paths.worktrees,
			paths.locks,
		];
		for (const directory of directories) {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
		}
	});

	it("syncs the parent directory after every append and durable unlink", async () => {
		await ensureEvoLayout(paths);
		const path = join(paths.registry, "durable.jsonl");
		const snapshots: Array<{ directory: string; content: string }> = [];
		const syncDirectory = async (directory: string): Promise<void> => {
			snapshots.push({ directory, content: await readFile(path, "utf8") });
		};

		await appendJsonLine(path, { sequence: 1 }, { syncDirectory });
		await appendJsonLine(path, { sequence: 2 }, { syncDirectory });
		expect(snapshots).toEqual([
			{ directory: paths.registry, content: '{"sequence":1}\n' },
			{ directory: paths.registry, content: '{"sequence":1}\n{"sequence":2}\n' },
		]);

		let unlinkDirectory: string | undefined;
		expect(
			await durableUnlink(path, {
				syncDirectory: async (directory) => {
					unlinkDirectory = directory;
					await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
				},
			}),
		).toBe(true);
		expect(unlinkDirectory).toBe(paths.registry);
	});

	it("durably truncates only an incomplete final line", async () => {
		await ensureEvoLayout(paths);
		const path = join(paths.registry, "torn.jsonl");
		await writeFile(path, '{"complete":true}\n{"torn":');

		expect(await truncateIncompleteFinalLine(path)).toBe(true);
		expect(await readFile(path, "utf8")).toBe('{"complete":true}\n');
		expect(await truncateIncompleteFinalLine(path)).toBe(false);
	});

	it("serializes contenders and removes the released lock", async () => {
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const order: string[] = [];
		const first = withFileLock(
			paths,
			"serialized",
			async () => {
				order.push("first-start");
				firstEntered.resolve();
				await releaseFirst.promise;
				order.push("first-end");
			},
			{ staleAfterMs: 1_000, heartbeatMs: 50 },
		);
		await firstEntered.promise;
		const second = withFileLock(
			paths,
			"serialized",
			async () => {
				order.push("second");
			},
			{ staleAfterMs: 1_000, heartbeatMs: 50 },
		);

		await wait(60);
		expect(order).toEqual(["first-start"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(order).toEqual(["first-start", "first-end", "second"]);
		expect(await readdir(paths.locks)).toEqual([]);
	});

	it("publishes a complete owner before exposing the lock to contenders", async () => {
		const firstPrepared = deferred();
		const allowFirstPublish = deferred();
		const secondEntered = deferred();
		const releaseSecond = deferred();
		const order: string[] = [];
		const first = withFileLock(
			paths,
			"atomic-publish",
			async () => {
				order.push("first");
			},
			{
				timeoutMs: 1_000,
				staleAfterMs: 1_000,
				heartbeatMs: 50,
				afterLockPrepared: async () => {
					firstPrepared.resolve();
					await allowFirstPublish.promise;
				},
			},
		);
		await firstPrepared.promise;

		const second = withFileLock(
			paths,
			"atomic-publish",
			async () => {
				order.push("second");
				secondEntered.resolve();
				await releaseSecond.promise;
			},
			{ staleAfterMs: 1_000, heartbeatMs: 50 },
		);
		await secondEntered.promise;
		allowFirstPublish.resolve();
		await wait(60);
		expect(order).toEqual(["second"]);

		releaseSecond.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["second", "first"]);
		expect(await readdir(paths.locks)).toEqual([]);
	});

	it("heartbeats a long-running owner so it cannot be reclaimed", async () => {
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const first = withFileLock(
			paths,
			"heartbeat",
			async () => {
				firstEntered.resolve();
				await releaseFirst.promise;
			},
			{ staleAfterMs: 60, heartbeatMs: 10 },
		);
		await firstEntered.promise;

		await expect(
			withFileLock(paths, "heartbeat", async () => {}, {
				timeoutMs: 90,
				staleAfterMs: 60,
				heartbeatMs: 10,
			}),
		).rejects.toThrow("Timed out waiting for lock: heartbeat");

		releaseFirst.resolve();
		await first;
	});

	it("never reclaims a live owner even when its heartbeat is disabled", async () => {
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const first = withFileLock(
			paths,
			"live-owner",
			async () => {
				firstEntered.resolve();
				await releaseFirst.promise;
			},
			{ staleAfterMs: 40, heartbeatMs: false },
		);
		await firstEntered.promise;
		await wait(75);

		await expect(
			withFileLock(paths, "live-owner", async () => {}, {
				timeoutMs: 90,
				staleAfterMs: 40,
				heartbeatMs: 10,
			}),
		).rejects.toThrow("Timed out waiting for lock: live-owner");

		releaseFirst.resolve();
		await first;
		expect(await readdir(paths.locks)).toEqual([]);
	});

	it("reclaims a stale lock after its owner process has exited", async () => {
		await ensureEvoLayout(paths);
		const lockPath = join(paths.locks, "dead-owner.lock");
		const ownerToken = "dead-owner-token";
		const ownerPath = join(lockPath, `${ownerToken}.owner.json`);
		await mkdir(lockPath, { mode: 0o700 });
		await writeFile(
			ownerPath,
			`${JSON.stringify({
				schemaVersion: 1,
				ownerToken,
				pid: await exitedProcessId(),
				createdAt: new Date(0).toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const staleAt = new Date(Date.now() - 1_000);
		await utimes(ownerPath, staleAt, staleAt);
		let entered = false;

		await withFileLock(
			paths,
			"dead-owner",
			async () => {
				entered = true;
			},
			{ timeoutMs: 500, staleAfterMs: 40, heartbeatMs: 10 },
		);

		expect(entered).toBe(true);
		expect(await readdir(paths.locks)).toEqual([]);
	});

	it("validates heartbeat lease options before acquiring", async () => {
		await expect(
			withFileLock(paths, "invalid-heartbeat", async () => {}, {
				staleAfterMs: 100,
				heartbeatMs: 100,
			}),
		).rejects.toThrow("heartbeatMs must be less than staleAfterMs");
	});
});
