import type { ExtensionAPI, ExtensionContext, Theme } from "@ch1nyzzz/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import turnTimerExtension, { formatTurnDuration, type TurnTimingEntry } from "../examples/extensions/turn-timer.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type EntryRenderer = (
	entry: { data?: TurnTimingEntry },
	options: { expanded: boolean },
	theme: Theme,
) => { render(width: number): string[] } | undefined;

describe("turn timer extension", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats short, minute, and hour durations", () => {
		expect(formatTurnDuration(1_250)).toBe("1.3s");
		expect(formatTurnDuration(42_400)).toBe("42s");
		expect(formatTurnDuration(62_000)).toBe("1m 2s");
		expect(formatTurnDuration(3_723_000)).toBe("1h 2m 3s");
	});

	it("updates the live working row and appends one durable timing row when the agent settles", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
		const handlers = new Map<string, EventHandler>();
		const workingMessages: Array<string | undefined> = [];
		const entries: Array<{ customType: string; data: TurnTimingEntry }> = [];
		let renderer: EntryRenderer | undefined;
		const api = {
			on: (name: string, handler: EventHandler) => handlers.set(name, handler),
			registerEntryRenderer: (_customType: string, value: EntryRenderer) => {
				renderer = value;
			},
			appendEntry: (customType: string, data: TurnTimingEntry) => entries.push({ customType, data }),
		} as unknown as ExtensionAPI;
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setWorkingMessage: (message?: string) => workingMessages.push(message),
			},
			sessionManager: { getBranch: () => [] },
		} as unknown as ExtensionContext;
		turnTimerExtension(api);

		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, context);
		vi.advanceTimersByTime(1_250);
		expect(workingMessages.at(-1)).toBe("Working... 1.3s");

		await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			customType: "turn-timing",
			data: { schemaVersion: 1, durationMs: 1_250, completedAt: "2026-07-14T00:00:01.250Z" },
		});
		expect(workingMessages.at(-1)).toBeUndefined();
		expect(renderer?.({ data: entries[0]?.data }, { expanded: false }, context.ui.theme)?.render(80)).toEqual([
			"Worked for 1.3s",
		]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
