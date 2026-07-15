import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEvoPaths } from "../src/paths.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import {
	addLocalDays,
	DEFAULT_EVO_SCHEDULE_CONFIG,
	DEFAULT_SCHEDULED_IMPROVE_CONFIG,
	getImproveLockPath,
	getImproveRunsPath,
	getScheduleConfigPath,
	getScheduleStatus,
	isWithinQuietHours,
	latestCompletedImproveDay,
	localDay,
	parseScheduleCadence,
	readImproveRunEvents,
	readScheduleConfig,
	runConfiguredImprove,
	runScheduledImprove,
	type ScheduledImproveConfigInput,
	writeScheduleConfig,
} from "../src/scheduler.ts";

const ALL_DAY_TEST_CONFIG: ScheduledImproveConfigInput = {
	quietHours: { start: "00:00", end: "23:59" },
	inactivityMinutes: 15,
	dailyRunLimit: 1,
};

const temporaryRoots: string[] = [];

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = (): void => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-scheduler-"));
	temporaryRoots.push(root);
	return { root, paths: getEvoPaths(join(root, "evo")) };
}

function localDate(day: number, hour: number, minute = 0): Date {
	return new Date(2026, 6, day, hour, minute, 0, 0);
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

describe("scheduled improve", () => {
	it("evaluates local quiet hours including a window that crosses midnight", () => {
		expect(isWithinQuietHours(localDate(14, 1), { start: "00:00", end: "06:00" })).toBe(true);
		expect(isWithinQuietHours(localDate(14, 6), { start: "00:00", end: "06:00" })).toBe(false);
		expect(isWithinQuietHours(localDate(14, 23), { start: "22:00", end: "05:00" })).toBe(true);
		expect(isWithinQuietHours(localDate(14, 4, 59), { start: "22:00", end: "05:00" })).toBe(true);
		expect(isWithinQuietHours(localDate(14, 5), { start: "22:00", end: "05:00" })).toBe(false);
		expect(isWithinQuietHours(localDate(14, 12), { start: "22:00", end: "05:00" })).toBe(false);
	});

	it("runs once in quiet hours and appends started and completed events", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 2);
		let calls = 0;
		const result = await runScheduledImprove({
			paths: fixture.paths,
			now: () => current,
			improve: async () => {
				calls += 1;
				return { proposals: 2 };
			},
		});

		expect(result).toMatchObject({ status: "completed", value: { proposals: 2 } });
		expect(calls).toBe(1);
		const events = await readImproveRunEvents(fixture.paths);
		expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
		expect(new Set(events.map((event) => event.runId)).size).toBe(1);
		expect(events[0]?.localDay).toBe(localDay(current));
		await expect(readFile(getImproveLockPath(fixture.paths), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("skips outside quiet hours without recording a run", async () => {
		const fixture = await createFixture();
		let calls = 0;
		const result = await runScheduledImprove({
			paths: fixture.paths,
			now: () => localDate(14, 12),
			improve: async () => {
				calls += 1;
			},
		});

		expect(result).toEqual({ status: "skipped", reason: "outside-quiet-hours" });
		expect(calls).toBe(0);
		expect(await readImproveRunEvents(fixture.paths)).toEqual([]);
	});

	it("uses recorder log mtimes as the recent foreground activity gate", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		await mkdir(fixture.paths.log, { recursive: true });
		const logPath = join(fixture.paths.log, "active-session.jsonl");
		await writeFile(logPath, "{}\n");
		const recent = new Date(current.getTime() - 5 * 60_000);
		await utimes(logPath, recent, recent);
		let calls = 0;

		const skipped = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				calls += 1;
			},
		});
		expect(skipped).toEqual({
			status: "skipped",
			reason: "recent-session-activity",
			lastActivityAt: recent.toISOString(),
		});

		const old = new Date(current.getTime() - 15 * 60_000);
		await utimes(logPath, old, old);
		const completed = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				calls += 1;
			},
		});
		expect(completed.status).toBe("completed");
		expect(calls).toBe(1);
	});

	it("persists pause across registry instances and resumes scheduled work", async () => {
		const fixture = await createFixture();
		await new BundleRegistry(fixture.paths).pause("Stop background work");
		expect(await new BundleRegistry(fixture.paths).isPaused()).toBe(true);
		let calls = 0;
		const options = {
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => localDate(14, 12),
			improve: async () => {
				calls += 1;
			},
		};

		expect(await runScheduledImprove(options)).toEqual({ status: "skipped", reason: "paused" });
		await new BundleRegistry(fixture.paths).resume("Resume background work");
		expect((await runScheduledImprove(options)).status).toBe("completed");
		expect(calls).toBe(1);
	});

	it("aborts an in-flight improve when pause is activated", async () => {
		const fixture = await createFixture();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const running = runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => localDate(14, 12),
			improve: async (signal) => {
				markStarted?.();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
						{ once: true },
					);
				});
			},
		});
		await started;
		await new BundleRegistry(fixture.paths).pause("Stop the running reflection");
		await expect(running).rejects.toThrow("paused during scheduled reflection");
		expect((await readImproveRunEvents(fixture.paths)).map((event) => event.type)).toEqual(["started", "failed"]);
		await expect(readFile(getImproveLockPath(fixture.paths), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails a fast improve when pause commits before the callback returns", async () => {
		const fixture = await createFixture();
		const started = deferred();
		const finish = deferred();
		const running = runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => localDate(14, 12),
			improve: async () => {
				started.resolve();
				await finish.promise;
				return "must not complete";
			},
		});
		await started.promise;

		await new BundleRegistry(fixture.paths).pause("Pause before the fast callback returns");
		finish.resolve();

		await expect(running).rejects.toThrow("paused during scheduled reflection");
		expect((await readImproveRunEvents(fixture.paths)).map((event) => event.type)).toEqual(["started", "failed"]);
		await expect(readFile(getImproveLockPath(fixture.paths), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("counts failed runs against the local-day limit and permits the next day", async () => {
		const fixture = await createFixture();
		let current = localDate(14, 12);
		let calls = 0;
		await expect(
			runScheduledImprove({
				paths: fixture.paths,
				config: ALL_DAY_TEST_CONFIG,
				now: () => current,
				improve: async () => {
					calls += 1;
					throw new Error("provider unavailable");
				},
			}),
		).rejects.toThrow("provider unavailable");

		const sameDay = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				calls += 1;
			},
		});
		expect(sameDay).toEqual({ status: "skipped", reason: "daily-limit-reached" });
		expect(calls).toBe(1);
		expect((await readImproveRunEvents(fixture.paths)).map((event) => event.type)).toEqual(["started", "failed"]);

		current = localDate(15, 12);
		expect(
			(
				await runScheduledImprove({
					paths: fixture.paths,
					config: ALL_DAY_TEST_CONFIG,
					now: () => current,
					improve: async () => {
						calls += 1;
					},
				})
			).status,
		).toBe("completed");
		expect(calls).toBe(2);
	});

	it("treats a standalone failed journal event as a consumed daily run", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		await mkdir(fixture.paths.registry, { recursive: true });
		await writeFile(
			getImproveRunsPath(fixture.paths),
			`${JSON.stringify({
				schemaVersion: 1,
				type: "failed",
				runId: "recovered-failure",
				timestamp: current.toISOString(),
				localDay: localDay(current),
				error: "crashed after the provider call",
			})}\n`,
		);
		let calls = 0;
		const result = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				calls += 1;
			},
		});
		expect(result).toEqual({ status: "skipped", reason: "daily-limit-reached" });
		expect(calls).toBe(0);
	});

	it("repairs a torn final journal line before a restarted run reads and appends", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		const previousAt = localDate(13, 12);
		await mkdir(fixture.paths.registry, { recursive: true });
		const previousEvent = {
			schemaVersion: 1,
			type: "completed",
			runId: "previous-run",
			timestamp: previousAt.toISOString(),
			localDay: localDay(previousAt),
		};
		const tornTail = '{"schemaVersion":1,"type":"started","runId":"torn-run-never-committed';
		await writeFile(getImproveRunsPath(fixture.paths), `${JSON.stringify(previousEvent)}\n${tornTail}`);

		let calls = 0;
		const result = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				calls += 1;
				return "recovered";
			},
		});

		expect(result).toMatchObject({ status: "completed", value: "recovered" });
		expect(calls).toBe(1);
		const raw = await readFile(getImproveRunsPath(fixture.paths), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw).not.toContain(tornTail);
		const events = await readImproveRunEvents(fixture.paths);
		expect(events.map((event) => event.type)).toEqual(["completed", "started", "completed"]);
		expect(events[0]?.runId).toBe("previous-run");
		expect(events[1]?.runId).toBe(result.status === "completed" ? result.runId : undefined);
		expect(events[2]?.runId).toBe(result.status === "completed" ? result.runId : undefined);
	});

	it("preserves a complete invalid journal record and fails closed", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		await mkdir(fixture.paths.registry, { recursive: true });
		const invalidLine = `${JSON.stringify({
			schemaVersion: 2,
			type: "started",
			runId: "invalid-run",
			timestamp: current.toISOString(),
			localDay: localDay(current),
		})}\n`;
		await writeFile(getImproveRunsPath(fixture.paths), invalidLine);
		let calls = 0;

		await expect(
			runScheduledImprove({
				paths: fixture.paths,
				config: ALL_DAY_TEST_CONFIG,
				now: () => current,
				improve: async () => {
					calls += 1;
				},
			}),
		).rejects.toThrow("Invalid improve run event at line 1");
		expect(calls).toBe(0);
		expect(await readFile(getImproveRunsPath(fixture.paths), "utf8")).toBe(invalidLine);
		await expect(readFile(getImproveLockPath(fixture.paths), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("publishes a complete scheduled lock before a contender can acquire it", async () => {
		const fixture = await createFixture();
		const firstPrepared = deferred();
		const allowFirstPublish = deferred();
		const secondEntered = deferred();
		const releaseSecond = deferred();
		const config: ScheduledImproveConfigInput = {
			...ALL_DAY_TEST_CONFIG,
			dailyRunLimit: 2,
		};
		const first = runScheduledImprove({
			paths: fixture.paths,
			config,
			now: () => localDate(14, 12),
			createOwnerToken: () => "delayed-owner",
			afterLockPrepared: async () => {
				firstPrepared.resolve();
				await allowFirstPublish.promise;
			},
			improve: async () => {
				throw new Error("delayed owner must not enter while the published owner is running");
			},
		});
		await firstPrepared.promise;

		const second = runScheduledImprove({
			paths: fixture.paths,
			config,
			now: () => localDate(14, 12),
			createOwnerToken: () => "published-owner",
			improve: async () => {
				secondEntered.resolve();
				await releaseSecond.promise;
				return "published";
			},
		});
		await secondEntered.promise;
		allowFirstPublish.resolve();
		expect(await first).toEqual({ status: "skipped", reason: "already-running" });

		releaseSecond.resolve();
		expect(await second).toMatchObject({ status: "completed", value: "published" });
		expect((await readImproveRunEvents(fixture.paths)).map((event) => event.type)).toEqual(["started", "completed"]);
	});

	it("keeps a long-running improve lock beyond the old 30-second stale window", async () => {
		const fixture = await createFixture();
		let current = localDate(14, 12);
		let releaseFirst: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				markStarted?.();
				await pending;
			},
		});
		await started;
		current = new Date(current.getTime() + 31_000);

		const second = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			improve: async () => {
				throw new Error("second callback must not run");
			},
		});
		expect(second).toEqual({ status: "skipped", reason: "already-running" });
		releaseFirst?.();
		expect((await first).status).toBe("completed");
	});

	it("heartbeats a scheduled lock beyond its configured stale window", async () => {
		const fixture = await createFixture();
		let releaseFirst: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const config: ScheduledImproveConfigInput = {
			quietHours: { start: "00:00", end: "23:59" },
			inactivityMinutes: 15,
			dailyRunLimit: 2,
			lockStaleMs: 60,
		};
		const first = runScheduledImprove({
			paths: fixture.paths,
			config,
			improve: async () => {
				markStarted?.();
				await pending;
			},
		});
		await started;
		await new Promise<void>((resolve) => setTimeout(resolve, 140));
		const second = await runScheduledImprove({
			paths: fixture.paths,
			config,
			improve: async () => {
				throw new Error("second callback must not run");
			},
		});
		expect(second).toEqual({ status: "skipped", reason: "already-running" });
		releaseFirst?.();
		expect((await first).status).toBe("completed");
	});

	it("does not let an old owner remove a replacement lock", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		const lockPath = getImproveLockPath(fixture.paths);
		const replacementOwnerPath = join(lockPath, "replacement-owner.owner.json");
		const result = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			createOwnerToken: () => "original-owner",
			improve: async () => {
				await rm(lockPath, { recursive: true, force: true });
				await mkdir(lockPath, { mode: 0o700 });
				await writeFile(
					replacementOwnerPath,
					`${JSON.stringify({
						schemaVersion: 1,
						ownerToken: "replacement-owner",
						pid: process.pid,
						createdAt: current.toISOString(),
					})}\n`,
					{ mode: 0o600 },
				);
			},
		});

		expect(result.status).toBe("completed");
		expect(JSON.parse(await readFile(replacementOwnerPath, "utf8"))).toMatchObject({
			ownerToken: "replacement-owner",
		});
	});

	it("recovers an owner-checked stale lock", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		await mkdir(fixture.paths.locks, { recursive: true });
		const lockPath = getImproveLockPath(fixture.paths);
		const staleOwnerPath = join(lockPath, "stale-owner.owner.json");
		await mkdir(lockPath, { mode: 0o700 });
		await writeFile(
			staleOwnerPath,
			`${JSON.stringify({
				schemaVersion: 1,
				ownerToken: "stale-owner",
				pid: await exitedProcessId(),
				createdAt: new Date(current.getTime() - 61_000).toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const staleAt = new Date(Date.now() - 1_000);
		await utimes(staleOwnerPath, staleAt, staleAt);
		let calls = 0;
		const result = await runScheduledImprove({
			paths: fixture.paths,
			config: { ...ALL_DAY_TEST_CONFIG, lockStaleMs: 40 },
			now: () => current,
			improve: async () => {
				calls += 1;
			},
		});
		expect(result.status).toBe("completed");
		expect(calls).toBe(1);
	});

	it("skips until the configured interval has elapsed since the last completed run", async () => {
		const fixture = await createFixture();
		const config: ScheduledImproveConfigInput = { ...ALL_DAY_TEST_CONFIG, everyDays: 3 };
		let calls = 0;
		const improve = async () => {
			calls += 1;
		};

		expect(
			(await runScheduledImprove({ paths: fixture.paths, config, now: () => localDate(14, 12), improve })).status,
		).toBe("completed");
		expect(calls).toBe(1);

		const sameInterval = await runScheduledImprove({
			paths: fixture.paths,
			config,
			now: () => localDate(16, 12),
			improve,
		});
		expect(sameInterval).toEqual({
			status: "skipped",
			reason: "interval-not-elapsed",
			nextEligibleDay: "2026-07-17",
		});
		expect(calls).toBe(1);

		expect(
			(await runScheduledImprove({ paths: fixture.paths, config, now: () => localDate(17, 12), improve })).status,
		).toBe("completed");
		expect(calls).toBe(2);
	});

	it("does not extend the interval after a failed run", async () => {
		const fixture = await createFixture();
		const config: ScheduledImproveConfigInput = { ...ALL_DAY_TEST_CONFIG, everyDays: 3 };
		await expect(
			runScheduledImprove({
				paths: fixture.paths,
				config,
				now: () => localDate(14, 12),
				improve: async () => {
					throw new Error("provider unavailable");
				},
			}),
		).rejects.toThrow("provider unavailable");

		const retry = await runScheduledImprove({
			paths: fixture.paths,
			config,
			now: () => localDate(15, 12),
			improve: async () => "retried",
		});
		expect(retry).toMatchObject({ status: "completed", value: "retried" });
	});

	it("allows any clock time when quiet hours are disabled", async () => {
		const fixture = await createFixture();
		const result = await runScheduledImprove({
			paths: fixture.paths,
			config: { quietHours: null },
			now: () => localDate(14, 12),
			improve: async () => "ran at noon",
		});
		expect(result).toMatchObject({ status: "completed", value: "ran at noon" });
	});

	it("ignores excluded session logs when gating on recent activity", async () => {
		const fixture = await createFixture();
		const current = localDate(14, 12);
		await mkdir(fixture.paths.log, { recursive: true });
		const ownLog = join(fixture.paths.log, "current-session.jsonl");
		await writeFile(ownLog, "{}\n");
		await utimes(ownLog, current, current);

		const excluded = await runScheduledImprove({
			paths: fixture.paths,
			config: ALL_DAY_TEST_CONFIG,
			now: () => current,
			excludeSessionIds: ["current-session"],
			improve: async () => "ran despite own activity",
		});
		expect(excluded).toMatchObject({ status: "completed", value: "ran despite own activity" });

		const later = localDate(15, 12);
		const otherLog = join(fixture.paths.log, "other-session.jsonl");
		await writeFile(otherLog, "{}\n");
		const recent = new Date(later.getTime() - 5 * 60_000);
		await utimes(otherLog, recent, recent);
		const blocked = await runScheduledImprove({
			paths: fixture.paths,
			config: { ...ALL_DAY_TEST_CONFIG, everyDays: 1, dailyRunLimit: 2 },
			now: () => later,
			excludeSessionIds: ["current-session"],
			improve: async () => {
				throw new Error("must not run while another session is active");
			},
		});
		expect(blocked).toMatchObject({ status: "skipped", reason: "recent-session-activity" });
	});

	it("computes local day arithmetic and completed-day lookups", () => {
		expect(addLocalDays("2026-07-30", 3)).toBe("2026-08-02");
		expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(latestCompletedImproveDay([])).toBeUndefined();
		expect(
			latestCompletedImproveDay([
				{ schemaVersion: 1, type: "completed", runId: "a", timestamp: "t", localDay: "2026-07-10" },
				{ schemaVersion: 1, type: "failed", runId: "b", timestamp: "t", localDay: "2026-07-12", error: "x" },
				{ schemaVersion: 1, type: "completed", runId: "c", timestamp: "t", localDay: "2026-07-08" },
			]),
		).toBe("2026-07-10");
	});

	it("uses conservative defaults and validates injected configuration", () => {
		expect(DEFAULT_SCHEDULED_IMPROVE_CONFIG).toMatchObject({
			quietHours: { start: "00:00", end: "06:00" },
			inactivityMinutes: 15,
			dailyRunLimit: 1,
			everyDays: 1,
		});
		expect(() => isWithinQuietHours(localDate(14, 1), { start: "24:00", end: "06:00" })).toThrow(
			"outside the valid clock range",
		);
	});
});

describe("schedule configuration", () => {
	it("returns defaults when no schedule file exists and persists updates", async () => {
		const fixture = await createFixture();
		expect(await readScheduleConfig(fixture.paths)).toEqual(DEFAULT_EVO_SCHEDULE_CONFIG);

		const updated = await writeScheduleConfig(fixture.paths, { everyDays: 7 });
		expect(updated).toMatchObject({ mode: "auto", everyDays: 7, quietHours: null });
		expect(await readScheduleConfig(fixture.paths)).toEqual(updated);

		const manual = await writeScheduleConfig(fixture.paths, { mode: "manual" });
		expect(manual).toMatchObject({ mode: "manual", everyDays: 7 });
	});

	it("adds the session threshold when reading an older schedule", async () => {
		const fixture = await createFixture();
		await mkdir(fixture.paths.registry, { recursive: true });
		const { trialDueAfterSessions: _omitted, ...olderSchedule } = DEFAULT_EVO_SCHEDULE_CONFIG;
		await writeFile(getScheduleConfigPath(fixture.paths), JSON.stringify(olderSchedule));
		expect(await readScheduleConfig(fixture.paths)).toMatchObject({
			trialDueAfterSessions: DEFAULT_EVO_SCHEDULE_CONFIG.trialDueAfterSessions,
		});
	});

	it("fails closed on invalid stored schedule configuration", async () => {
		const fixture = await createFixture();
		await mkdir(fixture.paths.registry, { recursive: true });
		await writeFile(getScheduleConfigPath(fixture.paths), JSON.stringify({ schemaVersion: 99 }));
		await expect(readScheduleConfig(fixture.paths)).rejects.toThrow("unsupported schema version");

		await writeFile(
			getScheduleConfigPath(fixture.paths),
			JSON.stringify({ ...DEFAULT_EVO_SCHEDULE_CONFIG, everyDays: 0 }),
		);
		await expect(readScheduleConfig(fixture.paths)).rejects.toThrow("everyDays");
		await expect(writeScheduleConfig(fixture.paths, { everyDays: 3 })).rejects.toThrow("everyDays");
	});

	it("parses cadence expressions", () => {
		expect(parseScheduleCadence("manual")).toEqual({ mode: "manual" });
		expect(parseScheduleCadence("off")).toEqual({ mode: "manual" });
		expect(parseScheduleCadence("daily")).toEqual({ mode: "auto", everyDays: 1 });
		expect(parseScheduleCadence("weekly")).toEqual({ mode: "auto", everyDays: 7 });
		expect(parseScheduleCadence("3d")).toEqual({ mode: "auto", everyDays: 3 });
		expect(parseScheduleCadence("every 14 days")).toEqual({ mode: "auto", everyDays: 14 });
		expect(parseScheduleCadence("EVERY 2D")).toEqual({ mode: "auto", everyDays: 2 });
		expect(parseScheduleCadence("0d")).toBeUndefined();
		expect(parseScheduleCadence("sometimes")).toBeUndefined();
		expect(parseScheduleCadence("999")).toBeUndefined();
	});

	it("runs configured improves at the stored cadence and skips manual mode", async () => {
		const fixture = await createFixture();
		await writeScheduleConfig(fixture.paths, { everyDays: 3 });
		let calls = 0;
		const improve = async () => {
			calls += 1;
		};

		expect((await runConfiguredImprove({ paths: fixture.paths, now: () => localDate(14, 12), improve })).status).toBe(
			"completed",
		);
		expect(await runConfiguredImprove({ paths: fixture.paths, now: () => localDate(15, 12), improve })).toEqual({
			status: "skipped",
			reason: "interval-not-elapsed",
			nextEligibleDay: "2026-07-17",
		});
		expect(calls).toBe(1);

		await writeScheduleConfig(fixture.paths, { mode: "manual" });
		expect(await runConfiguredImprove({ paths: fixture.paths, now: () => localDate(20, 12), improve })).toEqual({
			status: "skipped",
			reason: "manual-mode",
		});
		expect(calls).toBe(1);
	});

	it("summarizes the schedule status for display", async () => {
		const fixture = await createFixture();
		const initial = await getScheduleStatus(fixture.paths, () => localDate(14, 12));
		expect(initial).toMatchObject({ runsToday: 0, config: { mode: "auto", everyDays: 3 } });
		expect(initial.lastCompletedAt).toBeUndefined();
		expect(initial.nextEligibleDay).toBeUndefined();

		await runConfiguredImprove({ paths: fixture.paths, now: () => localDate(14, 12), improve: async () => "done" });
		const after = await getScheduleStatus(fixture.paths, () => localDate(14, 13));
		expect(after).toMatchObject({
			runsToday: 1,
			lastCompletedDay: "2026-07-14",
			nextEligibleDay: "2026-07-17",
		});
		expect(after.lastCompletedAt).toBe(localDate(14, 12).toISOString());
	});
});
