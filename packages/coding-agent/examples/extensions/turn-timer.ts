import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "turn-timing";
const UPDATE_INTERVAL_MS = 250;

export interface TurnTimingEntry {
	schemaVersion: 1;
	durationMs: number;
	completedAt: string;
}

export function formatTurnDuration(durationMs: number): string {
	const clampedMs = Math.max(0, durationMs);
	if (clampedMs < 10_000) return `${(clampedMs / 1000).toFixed(1)}s`;

	const totalSeconds = Math.round(clampedMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h ${minutes}m ${seconds}s`;
}

function isTurnTimingEntry(value: unknown): value is TurnTimingEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<TurnTimingEntry>;
	return entry.schemaVersion === 1 && typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs);
}

export default function turnTimerExtension(pi: ExtensionAPI) {
	const supportsTimingEntries = typeof pi.registerEntryRenderer === "function" && typeof pi.appendEntry === "function";
	let startedAtMs: number | undefined;
	let activeContext: ExtensionContext | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const stopInterval = () => {
		if (interval !== undefined) clearInterval(interval);
		interval = undefined;
	};

	const setWorkingMessage = (ctx: ExtensionContext, message?: string) => {
		if (ctx.hasUI && typeof ctx.ui.setWorkingMessage === "function") ctx.ui.setWorkingMessage(message);
	};

	const renderWorkingMessage = () => {
		if (startedAtMs === undefined || !activeContext) return;
		setWorkingMessage(activeContext, `Working... ${formatTurnDuration(performance.now() - startedAtMs)}`);
	};

	const beginTiming = (ctx: ExtensionContext) => {
		activeContext = ctx;
		if (startedAtMs !== undefined) return;
		startedAtMs = performance.now();
		renderWorkingMessage();
		if (ctx.mode !== "tui") return;
		interval = setInterval(renderWorkingMessage, UPDATE_INTERVAL_MS);
		(interval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
	};

	if (supportsTimingEntries) {
		pi.registerEntryRenderer<TurnTimingEntry>(ENTRY_TYPE, (entry, _options, theme) => {
			if (!isTurnTimingEntry(entry.data)) return undefined;
			const label = `Worked for ${formatTurnDuration(entry.data.durationMs)}`;
			return {
				render(width: number): string[] {
					const visible = width > 0 ? label.slice(0, width) : "";
					return visible ? [theme.fg("dim", visible)] : [];
				},
				invalidate() {},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		stopInterval();
		startedAtMs = undefined;
		activeContext = undefined;
		setWorkingMessage(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		beginTiming(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		beginTiming(ctx);
	});

	const finishTiming = (ctx: ExtensionContext) => {
		if (startedAtMs === undefined) return;
		const durationMs = Math.max(0, performance.now() - startedAtMs);
		stopInterval();
		startedAtMs = undefined;
		activeContext = undefined;
		if (supportsTimingEntries) {
			pi.appendEntry<TurnTimingEntry>(ENTRY_TYPE, {
				schemaVersion: 1,
				durationMs,
				completedAt: new Date().toISOString(),
			});
		}
		setWorkingMessage(ctx);
	};

	pi.on("agent_end", (_event, ctx) => {
		if (!supportsTimingEntries) finishTiming(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (supportsTimingEntries) finishTiming(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopInterval();
		startedAtMs = undefined;
		activeContext = undefined;
		setWorkingMessage(ctx);
	});
}
