import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type EvoPaths, ensureEvoLayout } from "./paths.ts";
import { BundleRegistry } from "./registry/registry.ts";
import {
	appendJsonLine,
	atomicWriteJson,
	readJsonIfExists,
	truncateIncompleteFinalLine,
	tryWithFileLock,
	withFileLock,
} from "./storage.ts";

const SCHEDULE_SCHEMA_VERSION = 1;
const SCHEDULE_CONFIG_SCHEMA_VERSION = 1;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_SCHEDULE_DAYS = 365;
const PAUSE_POLL_MS = 50;

export interface QuietHours {
	start: string;
	end: string;
}

export interface ScheduledImproveConfig {
	quietHours: QuietHours | null;
	inactivityMinutes: number;
	dailyRunLimit: number;
	everyDays: number;
	lockStaleMs: number;
}

export interface ScheduledImproveConfigInput {
	quietHours?: Partial<QuietHours> | null;
	inactivityMinutes?: number;
	dailyRunLimit?: number;
	everyDays?: number;
	lockStaleMs?: number;
}

export const DEFAULT_SCHEDULED_IMPROVE_CONFIG: Readonly<ScheduledImproveConfig> = {
	quietHours: { start: "00:00", end: "06:00" },
	inactivityMinutes: 15,
	dailyRunLimit: 1,
	everyDays: 1,
	lockStaleMs: 12 * HOUR_MS,
};

export type EvoScheduleMode = "auto" | "manual";

export interface EvoScheduleConfig {
	schemaVersion: 1;
	mode: EvoScheduleMode;
	everyDays: number;
	quietHours: QuietHours | null;
	inactivityMinutes: number;
	dailyRunLimit: number;
	trialDueAfterDays: number;
	trialDueAfterSessions: number;
}

export interface EvoScheduleConfigInput {
	mode?: EvoScheduleMode;
	everyDays?: number;
	quietHours?: QuietHours | null;
	inactivityMinutes?: number;
	dailyRunLimit?: number;
	trialDueAfterDays?: number;
	trialDueAfterSessions?: number;
}

export const DEFAULT_EVO_SCHEDULE_CONFIG: Readonly<EvoScheduleConfig> = {
	schemaVersion: SCHEDULE_CONFIG_SCHEMA_VERSION,
	mode: "auto",
	everyDays: 3,
	quietHours: null,
	inactivityMinutes: 15,
	dailyRunLimit: 1,
	trialDueAfterDays: 7,
	trialDueAfterSessions: 10,
};

export interface ImproveRunStartedEvent {
	schemaVersion: 1;
	type: "started";
	runId: string;
	timestamp: string;
	localDay: string;
}

export interface ImproveRunCompletedEvent {
	schemaVersion: 1;
	type: "completed";
	runId: string;
	timestamp: string;
	localDay: string;
}

export interface ImproveRunFailedEvent {
	schemaVersion: 1;
	type: "failed";
	runId: string;
	timestamp: string;
	localDay: string;
	error: string;
}

export type ImproveRunEvent = ImproveRunStartedEvent | ImproveRunCompletedEvent | ImproveRunFailedEvent;

export type ScheduledImproveSkipReason =
	| "already-running"
	| "paused"
	| "manual-mode"
	| "outside-quiet-hours"
	| "interval-not-elapsed"
	| "recent-session-activity"
	| "daily-limit-reached";

export type ScheduledImproveResult<T> =
	| {
			status: "completed";
			runId: string;
			value: T;
	  }
	| {
			status: "skipped";
			reason: ScheduledImproveSkipReason;
			lastActivityAt?: string;
			nextEligibleDay?: string;
	  };

export interface RunScheduledImproveOptions<T> {
	paths: EvoPaths;
	improve: (signal: AbortSignal) => Promise<T>;
	config?: ScheduledImproveConfigInput;
	now?: () => Date;
	excludeSessionIds?: readonly string[];
	createOwnerToken?: () => string;
	afterLockPrepared?: () => void | Promise<void>;
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseClock(value: string, label: string): number {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) throw new Error(`${label} must use HH:MM format`);
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) throw new Error(`${label} is outside the valid clock range`);
	return hour * 60 + minute;
}

function requirePositiveSafeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
	return value;
}

function resolveQuietHours(input: Partial<QuietHours> | null | undefined): QuietHours | null {
	if (input === null) return null;
	const defaults = DEFAULT_SCHEDULED_IMPROVE_CONFIG.quietHours ?? { start: "00:00", end: "06:00" };
	const quietHours = {
		start: input?.start ?? defaults.start,
		end: input?.end ?? defaults.end,
	};
	const start = parseClock(quietHours.start, "quietHours.start");
	const end = parseClock(quietHours.end, "quietHours.end");
	if (start === end) throw new Error("quietHours start and end must differ");
	return quietHours;
}

function requireScheduleDays(value: number, label: string): number {
	requirePositiveSafeInteger(value, label);
	if (value > MAX_SCHEDULE_DAYS) throw new Error(`${label} must be at most ${MAX_SCHEDULE_DAYS} days`);
	return value;
}

export function resolveScheduledImproveConfig(input: ScheduledImproveConfigInput = {}): ScheduledImproveConfig {
	return {
		quietHours: resolveQuietHours(
			input.quietHours === undefined ? DEFAULT_SCHEDULED_IMPROVE_CONFIG.quietHours : input.quietHours,
		),
		inactivityMinutes: requirePositiveSafeInteger(
			input.inactivityMinutes ?? DEFAULT_SCHEDULED_IMPROVE_CONFIG.inactivityMinutes,
			"inactivityMinutes",
		),
		dailyRunLimit: requirePositiveSafeInteger(
			input.dailyRunLimit ?? DEFAULT_SCHEDULED_IMPROVE_CONFIG.dailyRunLimit,
			"dailyRunLimit",
		),
		everyDays: requireScheduleDays(input.everyDays ?? DEFAULT_SCHEDULED_IMPROVE_CONFIG.everyDays, "everyDays"),
		lockStaleMs: requirePositiveSafeInteger(
			input.lockStaleMs ?? DEFAULT_SCHEDULED_IMPROVE_CONFIG.lockStaleMs,
			"lockStaleMs",
		),
	};
}

export function isWithinQuietHours(date: Date, quietHours: QuietHours): boolean {
	const start = parseClock(quietHours.start, "quietHours.start");
	const end = parseClock(quietHours.end, "quietHours.end");
	if (start === end) throw new Error("quietHours start and end must differ");
	const minute = date.getHours() * 60 + date.getMinutes();
	return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function localDay(date: Date): string {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseLocalDayMs(day: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) throw new Error("localDay must use YYYY-MM-DD format");
	return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function addLocalDays(day: string, days: number): string {
	return new Date(parseLocalDayMs(day) + days * DAY_MS).toISOString().slice(0, 10);
}

export function latestCompletedImproveDay(events: readonly ImproveRunEvent[]): string | undefined {
	let latest: string | undefined;
	for (const event of events) {
		if (event.type === "completed" && (!latest || event.localDay > latest)) latest = event.localDay;
	}
	return latest;
}

export function getImproveRunsPath(paths: EvoPaths): string {
	return join(paths.registry, "improve-runs.jsonl");
}

export function getImproveLockPath(paths: EvoPaths): string {
	return join(paths.locks, "scheduled-improve.lock");
}

function parseImproveRunEvent(value: unknown, lineNumber: number): ImproveRunEvent {
	if (typeof value !== "object" || value === null) {
		throw new Error(`Invalid improve run event at line ${lineNumber}`);
	}
	const event = value as Record<string, unknown>;
	if (
		event.schemaVersion !== SCHEDULE_SCHEMA_VERSION ||
		!(event.type === "started" || event.type === "completed" || event.type === "failed") ||
		typeof event.runId !== "string" ||
		!event.runId ||
		typeof event.timestamp !== "string" ||
		!Number.isFinite(Date.parse(event.timestamp)) ||
		typeof event.localDay !== "string" ||
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(event.localDay) ||
		(event.type === "failed" && typeof event.error !== "string")
	) {
		throw new Error(`Invalid improve run event at line ${lineNumber}`);
	}
	return event as unknown as ImproveRunEvent;
}

export async function readImproveRunEvents(paths: EvoPaths): Promise<ImproveRunEvent[]> {
	let content: string;
	try {
		content = await readFile(getImproveRunsPath(paths), "utf8");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return [];
		throw error;
	}

	const events: ImproveRunEvent[] = [];
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(`Invalid improve run JSON at line ${index + 1}`, { cause: error });
		}
		events.push(parseImproveRunEvent(value, index + 1));
	}
	return events;
}

function countDailyRuns(events: ImproveRunEvent[], day: string): number {
	const runIds = new Set<string>();
	for (const event of events) {
		if (event.localDay === day && (event.type === "started" || event.type === "failed")) runIds.add(event.runId);
	}
	return runIds.size;
}

export async function findLatestSessionActivity(
	paths: EvoPaths,
	excludeSessionIds: readonly string[] = [],
): Promise<Date | undefined> {
	let entries: Dirent[];
	try {
		entries = await readdir(paths.log, { withFileTypes: true });
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	const excluded = new Set(excludeSessionIds.map((sessionId) => `${sessionId}.jsonl`));
	let latest = Number.NEGATIVE_INFINITY;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || excluded.has(entry.name)) continue;
		try {
			latest = Math.max(latest, (await stat(join(paths.log, entry.name))).mtimeMs);
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT") throw error;
		}
	}
	return Number.isFinite(latest) ? new Date(latest) : undefined;
}

async function isPauseMarkerPresent(paths: EvoPaths): Promise<boolean> {
	try {
		await readFile(paths.paused, "utf8");
		return true;
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function abortController(controller: AbortController, error: Error): void {
	if (!controller.signal.aborted) controller.abort(error);
}

function startPauseMonitor(paths: EvoPaths, controller: AbortController): () => Promise<void> {
	let stopped = false;
	let timeout: NodeJS.Timeout | undefined;
	let check = Promise.resolve();
	const schedule = (): void => {
		if (stopped || controller.signal.aborted) return;
		timeout = setTimeout(() => {
			check = isPauseMarkerPresent(paths)
				.then((paused) => {
					if (paused) {
						abortController(controller, new Error("Evo-Pi was paused during scheduled reflection"));
					}
				})
				.catch((error: unknown) => {
					abortController(controller, error instanceof Error ? error : new Error(String(error)));
				})
				.finally(schedule);
		}, PAUSE_POLL_MS);
		timeout.unref();
	};
	schedule();
	return async () => {
		stopped = true;
		if (timeout) clearTimeout(timeout);
		await check;
	};
}

async function appendImproveRunEvent(paths: EvoPaths, event: ImproveRunEvent): Promise<void> {
	await appendJsonLine(getImproveRunsPath(paths), event);
}

export async function runScheduledImprove<T>(
	options: RunScheduledImproveOptions<T>,
): Promise<ScheduledImproveResult<T>> {
	const config = resolveScheduledImproveConfig(options.config);
	const now = options.now ?? (() => new Date());
	const startedAt = now();
	if (!Number.isFinite(startedAt.getTime())) throw new Error("now returned an invalid date");
	await ensureEvoLayout(options.paths);

	const owner = options.createOwnerToken?.() ?? randomUUID();
	if (!owner) throw new Error("createOwnerToken returned an empty owner token");
	const controller = new AbortController();
	const attempt = await tryWithFileLock<ScheduledImproveResult<T>>(
		options.paths,
		"scheduled-improve",
		async () => {
			await truncateIncompleteFinalLine(getImproveRunsPath(options.paths));
			const registry = new BundleRegistry(options.paths);
			if (await registry.isPaused()) return { status: "skipped", reason: "paused" };
			if (config.quietHours && !isWithinQuietHours(startedAt, config.quietHours)) {
				return { status: "skipped", reason: "outside-quiet-hours" };
			}

			const day = localDay(startedAt);
			const events = await readImproveRunEvents(options.paths);
			const lastCompletedDay = latestCompletedImproveDay(events);
			if (lastCompletedDay !== undefined) {
				const nextEligibleDay = addLocalDays(lastCompletedDay, config.everyDays);
				if (parseLocalDayMs(day) < parseLocalDayMs(nextEligibleDay)) {
					return { status: "skipped", reason: "interval-not-elapsed", nextEligibleDay };
				}
			}

			const lastActivity = await findLatestSessionActivity(options.paths, options.excludeSessionIds);
			if (lastActivity && startedAt.getTime() - lastActivity.getTime() < config.inactivityMinutes * MINUTE_MS) {
				return {
					status: "skipped",
					reason: "recent-session-activity",
					lastActivityAt: lastActivity.toISOString(),
				};
			}

			if (countDailyRuns(events, day) >= config.dailyRunLimit) {
				return { status: "skipped", reason: "daily-limit-reached" };
			}

			const runId = randomUUID();
			await appendImproveRunEvent(options.paths, {
				schemaVersion: SCHEDULE_SCHEMA_VERSION,
				type: "started",
				runId,
				timestamp: startedAt.toISOString(),
				localDay: day,
			});

			try {
				const stopPauseMonitor = startPauseMonitor(options.paths, controller);
				let value: T;
				try {
					controller.signal.throwIfAborted();
					value = await options.improve(controller.signal);
					controller.signal.throwIfAborted();
				} finally {
					await stopPauseMonitor();
				}
				await withFileLock(options.paths, "registry", async () => {
					if (await isPauseMarkerPresent(options.paths)) {
						abortController(controller, new Error("Evo-Pi was paused during scheduled reflection"));
					}
					controller.signal.throwIfAborted();
					const completedAt = now();
					if (!Number.isFinite(completedAt.getTime())) throw new Error("now returned an invalid date");
					await appendImproveRunEvent(options.paths, {
						schemaVersion: SCHEDULE_SCHEMA_VERSION,
						type: "completed",
						runId,
						timestamp: completedAt.toISOString(),
						localDay: day,
					});
				});
				return { status: "completed", runId, value };
			} catch (error) {
				const failedAt = now();
				if (!Number.isFinite(failedAt.getTime())) throw new Error("now returned an invalid date");
				await appendImproveRunEvent(options.paths, {
					schemaVersion: SCHEDULE_SCHEMA_VERSION,
					type: "failed",
					runId,
					timestamp: failedAt.toISOString(),
					localDay: day,
					error: errorMessage(error),
				});
				throw error;
			}
		},
		{
			staleAfterMs: config.lockStaleMs,
			ownerToken: owner,
			afterLockPrepared: options.afterLockPrepared,
			onHeartbeatError: (error) => {
				abortController(controller, error instanceof Error ? error : new Error(String(error)));
			},
		},
	);
	if (!attempt.acquired) return { status: "skipped", reason: "already-running" };
	return attempt.value;
}

export function getScheduleConfigPath(paths: EvoPaths): string {
	return join(paths.registry, "schedule.json");
}

function parseScheduleMode(value: unknown): EvoScheduleMode {
	if (value !== "auto" && value !== "manual") throw new Error('Schedule mode must be "auto" or "manual"');
	return value;
}

function parseStoredQuietHours(value: unknown): QuietHours | null {
	if (value === null) return null;
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as Record<string, unknown>).start !== "string" ||
		typeof (value as Record<string, unknown>).end !== "string"
	) {
		throw new Error("Schedule quietHours must be null or an object with start and end clocks");
	}
	return resolveQuietHours(value as QuietHours);
}

function parseScheduleConfig(value: unknown): EvoScheduleConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Stored Evo-Pi schedule configuration is invalid");
	}
	const config = value as Record<string, unknown>;
	if (config.schemaVersion !== SCHEDULE_CONFIG_SCHEMA_VERSION) {
		throw new Error("Stored Evo-Pi schedule configuration has an unsupported schema version");
	}
	if (
		typeof config.everyDays !== "number" ||
		typeof config.inactivityMinutes !== "number" ||
		typeof config.dailyRunLimit !== "number" ||
		typeof config.trialDueAfterDays !== "number" ||
		(config.trialDueAfterSessions !== undefined && typeof config.trialDueAfterSessions !== "number")
	) {
		throw new Error("Stored Evo-Pi schedule configuration is invalid");
	}
	return {
		schemaVersion: SCHEDULE_CONFIG_SCHEMA_VERSION,
		mode: parseScheduleMode(config.mode),
		everyDays: requireScheduleDays(config.everyDays, "everyDays"),
		quietHours: parseStoredQuietHours(config.quietHours),
		inactivityMinutes: requirePositiveSafeInteger(config.inactivityMinutes, "inactivityMinutes"),
		dailyRunLimit: requirePositiveSafeInteger(config.dailyRunLimit, "dailyRunLimit"),
		trialDueAfterDays: requireScheduleDays(config.trialDueAfterDays, "trialDueAfterDays"),
		trialDueAfterSessions: requirePositiveSafeInteger(
			config.trialDueAfterSessions ?? DEFAULT_EVO_SCHEDULE_CONFIG.trialDueAfterSessions,
			"trialDueAfterSessions",
		),
	};
}

export async function readScheduleConfig(paths: EvoPaths): Promise<EvoScheduleConfig> {
	const stored = await readJsonIfExists<unknown>(getScheduleConfigPath(paths));
	if (stored === undefined) return { ...DEFAULT_EVO_SCHEDULE_CONFIG };
	return parseScheduleConfig(stored);
}

export async function writeScheduleConfig(paths: EvoPaths, input: EvoScheduleConfigInput): Promise<EvoScheduleConfig> {
	await ensureEvoLayout(paths);
	return withFileLock(paths, "schedule-config", async () => {
		const current = await readScheduleConfig(paths);
		const next = parseScheduleConfig({
			schemaVersion: SCHEDULE_CONFIG_SCHEMA_VERSION,
			mode: input.mode ?? current.mode,
			everyDays: input.everyDays ?? current.everyDays,
			quietHours: input.quietHours === undefined ? current.quietHours : input.quietHours,
			inactivityMinutes: input.inactivityMinutes ?? current.inactivityMinutes,
			dailyRunLimit: input.dailyRunLimit ?? current.dailyRunLimit,
			trialDueAfterDays: input.trialDueAfterDays ?? current.trialDueAfterDays,
			trialDueAfterSessions: input.trialDueAfterSessions ?? current.trialDueAfterSessions,
		});
		await atomicWriteJson(getScheduleConfigPath(paths), next);
		return next;
	});
}

export function parseScheduleCadence(value: string): EvoScheduleConfigInput | undefined {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^every\s+/, "");
	if (normalized === "manual" || normalized === "off") return { mode: "manual" };
	if (normalized === "daily") return { mode: "auto", everyDays: 1 };
	if (normalized === "weekly") return { mode: "auto", everyDays: 7 };
	const match = /^(\d{1,3})\s*(?:d|day|days)?$/.exec(normalized);
	if (!match) return undefined;
	const days = Number(match[1]);
	if (days < 1 || days > MAX_SCHEDULE_DAYS) return undefined;
	return { mode: "auto", everyDays: days };
}

export interface RunConfiguredImproveOptions<T> {
	paths: EvoPaths;
	improve: (signal: AbortSignal) => Promise<T>;
	now?: () => Date;
	excludeSessionIds?: readonly string[];
	createOwnerToken?: () => string;
}

export async function runConfiguredImprove<T>(
	options: RunConfiguredImproveOptions<T>,
): Promise<ScheduledImproveResult<T>> {
	const schedule = await readScheduleConfig(options.paths);
	if (schedule.mode === "manual") return { status: "skipped", reason: "manual-mode" };
	return runScheduledImprove({
		...options,
		config: {
			quietHours: schedule.quietHours,
			inactivityMinutes: schedule.inactivityMinutes,
			dailyRunLimit: schedule.dailyRunLimit,
			everyDays: schedule.everyDays,
		},
	});
}

export interface EvoScheduleStatus {
	config: EvoScheduleConfig;
	lastCompletedAt?: string;
	lastCompletedDay?: string;
	nextEligibleDay?: string;
	runsToday: number;
}

export async function getScheduleStatus(
	paths: EvoPaths,
	now: () => Date = () => new Date(),
): Promise<EvoScheduleStatus> {
	const config = await readScheduleConfig(paths);
	const events = await readImproveRunEvents(paths);
	const lastCompleted = events.filter((event) => event.type === "completed").at(-1);
	const lastCompletedDay = latestCompletedImproveDay(events);
	return {
		config,
		...(lastCompleted ? { lastCompletedAt: lastCompleted.timestamp } : {}),
		...(lastCompletedDay ? { lastCompletedDay } : {}),
		...(config.mode === "auto" && lastCompletedDay
			? { nextEligibleDay: addLocalDays(lastCompletedDay, config.everyDays) }
			: {}),
		runsToday: countDailyRuns(events, localDay(now())),
	};
}
