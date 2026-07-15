import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, setKeybindings, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContext = {
	pendingTools: Map<string, ToolExecutionComponent>;
	toolCallsInCurrentUserTurn: number;
	collapsedToolSummary: { count: number } | undefined;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: SettingsManager;
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: { retryAttempt: number; modelRegistry: { find(provider: string, modelId: string): undefined } };
	toolOutputExpanded: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	createToolExecutionComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

type RenderSessionItems = (
	this: RenderSessionContext,
	items: readonly AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

function createAssistantMessage(turn: string): AssistantMessage {
	return {
		role: "assistant",
		content: [1, 2, 3].map((index) => ({
			type: "toolCall" as const,
			id: `${turn}-id-${index}`,
			name: `${turn}-tool-${index}`,
			arguments: {},
		})),
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createContext(maxCollapsedToolsPerTurn?: number): RenderSessionContext {
	const chatContainer = new Container();
	return {
		pendingTools: new Map(),
		toolCallsInCurrentUserTurn: 0,
		collapsedToolSummary: undefined,
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: SettingsManager.inMemory(
			maxCollapsedToolsPerTurn === undefined ? {} : { maxCollapsedToolsPerTurn },
		),
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		toolOutputExpanded: false,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: () => undefined,
		createToolExecutionComponent: (
			InteractiveMode.prototype as unknown as {
				createToolExecutionComponent: RenderSessionContext["createToolExecutionComponent"];
			}
		).createToolExecutionComponent,
		addMessageToChat(message) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function renderContext(context: RenderSessionContext): string {
	return stripAnsi(context.chatContainer.render(120).join("\n"));
}

describe("collapsed tool visibility", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create());
	});

	test("shows only the configured number of tools per user turn until expanded", () => {
		const context = createContext(2);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(context, [
			{ role: "user", content: "first", timestamp: Date.now() },
			createAssistantMessage("first"),
			{ role: "user", content: "second", timestamp: Date.now() },
			createAssistantMessage("second"),
		]);

		const collapsed = renderContext(context);
		expect(collapsed).toContain("first-tool-1");
		expect(collapsed).toContain("first-tool-2");
		expect(collapsed).not.toContain("first-tool-3");
		expect(collapsed).toContain("… 1 tool hidden");
		expect(collapsed).toContain("ctrl+o to expand");
		expect(collapsed).toContain("second-tool-1");
		expect(collapsed).toContain("second-tool-2");
		expect(collapsed).not.toContain("second-tool-3");

		for (const child of context.chatContainer.children) {
			if (child instanceof ToolExecutionComponent) {
				child.setExpanded(true);
			}
		}
		const expanded = renderContext(context);
		expect(expanded).toContain("first-tool-3");
		expect(expanded).toContain("second-tool-3");
	});

	test("shows every collapsed tool when no limit is configured", () => {
		const context = createContext();
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(context, [
			{ role: "user", content: "first", timestamp: Date.now() },
			createAssistantMessage("unlimited"),
		]);

		expect(renderContext(context)).toContain("unlimited-tool-3");
	});
});
