import type { Component } from "@ch1nyzzz/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface InteractiveStatusContext {
	ui: { isFocused(component: Component): boolean; requestRender(): void };
	editor: Component & {
		getText(): string;
		getLines(): string[];
		getCursor(): { line: number; col: number };
		isShowingAutocomplete(): boolean;
	};
	footerDataProvider: FooterDataProvider;
	keybindings: KeybindingsManager;
	showError(message: string): void;
}

const handleInteractiveStatusInput = (
	InteractiveMode.prototype as unknown as {
		handleInteractiveStatusInput(this: InteractiveStatusContext, data: string): { consume?: boolean } | undefined;
	}
).handleInteractiveStatusInput;

const providers: FooterDataProvider[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.dispose();
});

function createContext(
	options: { focused?: boolean; text?: string; cursor?: { line: number; col: number }; autocomplete?: boolean } = {},
) {
	let focused = options.focused ?? true;
	let text = options.text ?? "";
	const selected: string[] = [];
	const editor = {
		render: () => [],
		invalidate: () => {},
		getText: () => text,
		getLines: () => text.split("\n"),
		getCursor: () => options.cursor ?? { line: 0, col: text.length },
		isShowingAutocomplete: () => options.autocomplete ?? false,
	};
	const provider = new FooterDataProvider(process.cwd());
	providers.push(provider);
	provider.setInteractiveExtensionStatus("evo", [
		{ id: "canary", text: "Canary", onSelect: () => void selected.push("canary") },
		{ id: "pending", text: "Pending", onSelect: () => void selected.push("pending") },
	]);
	const context: InteractiveStatusContext = {
		ui: {
			isFocused: (component) => focused && component === editor,
			requestRender: () => {},
		},
		editor,
		footerDataProvider: provider,
		keybindings: new KeybindingsManager(),
		showError: () => {},
	};
	return {
		context,
		selected,
		setFocused: (value: boolean) => {
			focused = value;
		},
		setText: (value: string) => {
			text = value;
		},
	};
}

describe("interactive footer statuses", () => {
	it("uses selection keys and Enter when the empty editor is focused", () => {
		const harness = createContext();
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[B")).toEqual({ consume: true });
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[B")).toEqual({ consume: true });
		expect(handleInteractiveStatusInput.call(harness.context, "\r")).toEqual({ consume: true });
		expect(harness.selected).toEqual(["pending"]);
	});

	it("enters status navigation from a draft at the end of the editor", () => {
		const harness = createContext({ text: "draft" });
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[B")).toEqual({ consume: true });
		expect(handleInteractiveStatusInput.call(harness.context, "\r")).toEqual({ consume: true });
		expect(harness.selected).toEqual(["canary"]);
	});

	it("enters status navigation from anywhere on the last draft line", () => {
		const midLine = createContext({ text: "draft", cursor: { line: 0, col: 2 } });
		expect(handleInteractiveStatusInput.call(midLine.context, "\x1b[B")).toEqual({ consume: true });
		expect(midLine.context.footerDataProvider.getInteractiveExtensionStatus()?.navigating).toBe(true);

		const multiLine = createContext({ text: "first\nsecond", cursor: { line: 1, col: 0 } });
		expect(handleInteractiveStatusInput.call(multiLine.context, "\x1b[B")).toEqual({ consume: true });
	});

	it("preserves editor and autocomplete down-key handling above the last line", () => {
		const editing = createContext({ text: "first\nsecond", cursor: { line: 0, col: 2 } });
		expect(handleInteractiveStatusInput.call(editing.context, "\x1b[B")).toBeUndefined();

		const completing = createContext({ text: "draft", autocomplete: true });
		expect(handleInteractiveStatusInput.call(completing.context, "\x1b[B")).toBeUndefined();

		editing.setFocused(false);
		expect(handleInteractiveStatusInput.call(editing.context, "\x1b[B")).toBeUndefined();
		expect(editing.selected).toEqual([]);
	});

	it("leaves the up key to the editor when not navigating the status bar", () => {
		const harness = createContext();
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[A")).toBeUndefined();
		expect(harness.context.footerDataProvider.getInteractiveExtensionStatus()?.navigating).toBe(false);
	});

	it("returns to the editor when pressing up past the first status item", () => {
		const harness = createContext();
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[B")).toEqual({ consume: true });
		expect(harness.context.footerDataProvider.getInteractiveExtensionStatus()).toMatchObject({
			index: 0,
			navigating: true,
		});
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[A")).toEqual({ consume: true });
		expect(harness.context.footerDataProvider.getInteractiveExtensionStatus()?.navigating).toBe(false);
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[A")).toBeUndefined();
	});

	it("stays on the last status item when pressing down at the bottom", () => {
		const harness = createContext();
		handleInteractiveStatusInput.call(harness.context, "\x1b[B");
		handleInteractiveStatusInput.call(harness.context, "\x1b[B");
		expect(harness.context.footerDataProvider.getInteractiveExtensionStatus()?.index).toBe(1);
		expect(handleInteractiveStatusInput.call(harness.context, "\x1b[B")).toEqual({ consume: true });
		expect(harness.context.footerDataProvider.getInteractiveExtensionStatus()).toMatchObject({
			index: 1,
			navigating: true,
		});
	});
});

interface RestoreContext {
	activePromptText?: string;
	editor: { getText(): string; setText(text: string): void };
	clearAllQueues(): { steering: string[]; followUp: string[] };
	updatePendingMessagesDisplay(): void;
	agent: { abort(): void };
}

const restoreQueuedMessagesToEditor = (
	InteractiveMode.prototype as unknown as {
		restoreQueuedMessagesToEditor(this: RestoreContext, options?: { abort?: boolean; currentText?: string }): number;
	}
).restoreQueuedMessagesToEditor;

function createRestoreContext(options: {
	activePrompt?: string;
	draft?: string;
	steering?: string[];
	followUp?: string[];
}) {
	let text = options.draft ?? "";
	let aborted = false;
	const context: RestoreContext = {
		activePromptText: options.activePrompt,
		editor: {
			getText: () => text,
			setText: (value: string) => {
				text = value;
			},
		},
		clearAllQueues: () => ({ steering: options.steering ?? [], followUp: options.followUp ?? [] }),
		updatePendingMessagesDisplay: () => {},
		agent: {
			abort: () => {
				aborted = true;
			},
		},
	};
	return { context, getText: () => text, wasAborted: () => aborted };
}

describe("abort prompt restore", () => {
	it("restores the in-flight prompt into an empty editor on abort", () => {
		const harness = createRestoreContext({ activePrompt: "fix the flaky test" });
		restoreQueuedMessagesToEditor.call(harness.context, { abort: true });
		expect(harness.getText()).toBe("fix the flaky test");
		expect(harness.context.activePromptText).toBeUndefined();
		expect(harness.wasAborted()).toBe(true);
	});

	it("prepends the aborted prompt to queued messages and the current draft", () => {
		const harness = createRestoreContext({
			activePrompt: "original prompt",
			draft: "current draft",
			followUp: ["queued note"],
		});
		restoreQueuedMessagesToEditor.call(harness.context, { abort: true });
		expect(harness.getText()).toBe("original prompt\n\nqueued note\n\ncurrent draft");
	});

	it("keeps the in-flight prompt when dequeuing without abort", () => {
		const harness = createRestoreContext({ activePrompt: "still running", followUp: ["queued note"] });
		restoreQueuedMessagesToEditor.call(harness.context, {});
		expect(harness.getText()).toBe("queued note");
		expect(harness.context.activePromptText).toBe("still running");
		expect(harness.wasAborted()).toBe(false);
	});

	it("leaves the editor untouched on abort when nothing is in flight", () => {
		const harness = createRestoreContext({ draft: "keep me" });
		restoreQueuedMessagesToEditor.call(harness.context, { abort: true });
		expect(harness.getText()).toBe("keep me");
		expect(harness.wasAborted()).toBe(true);
	});
});
