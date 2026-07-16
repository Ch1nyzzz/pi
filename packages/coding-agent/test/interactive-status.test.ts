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

	it("preserves editor and autocomplete down-key handling before the draft end", () => {
		const editing = createContext({ text: "draft", cursor: { line: 0, col: 2 } });
		expect(handleInteractiveStatusInput.call(editing.context, "\x1b[B")).toBeUndefined();

		const completing = createContext({ text: "draft", autocomplete: true });
		expect(handleInteractiveStatusInput.call(completing.context, "\x1b[B")).toBeUndefined();

		editing.setFocused(false);
		expect(handleInteractiveStatusInput.call(editing.context, "\x1b[B")).toBeUndefined();
		expect(editing.selected).toEqual([]);
	});
});
