import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Theme } from "@ch1nyzzz/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, wrapTextWithAnsi } from "@ch1nyzzz/pi-tui";
import { buildTrialComparison, type TrialComparison } from "../comparison.ts";
import type { EvoPaths } from "../paths.ts";
import { loadProposal } from "../proposal.ts";
import type { EvoService } from "../service.ts";
import type { ComponentApprovalDecision, EvolutionRun, EvolutionRunStatus, Proposal, TrialState } from "../types.ts";
import { type EvoActivityItem, listEvoActivityItems } from "./activity.ts";
import { evolutionRunDirectory, readEvolutionRun } from "./run.ts";

interface TranscriptEvent {
	timestamp: string;
	phase: string;
	type: "text" | "thinking" | "tool-arguments" | "tool-call" | "tool-result" | "complete";
	delta?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	text?: string;
	isError?: boolean;
	stopReason?: string;
}

interface RunArtifacts {
	plan?: string;
	experiment?: string;
	validation?: string;
	evaluation?: string;
}

const TERMINAL_STATUSES = new Set<EvolutionRunStatus>(["completed", "failed", "cancelled"]);
const PHASE_ORDER: EvolutionRunStatus[] = [
	"queued",
	"researching",
	"planned",
	"building",
	"validating",
	"replaying",
	"evaluating",
	"awaiting-canary-approval",
	"trialing",
	"awaiting-decision",
	"completed",
];
const SECTION_NAMES = ["当前思考", "工具调用", "阶段成果"] as const;

async function readOptional(path: string, maxCharacters = 40_000): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		return text.length > maxCharacters ? `${text.slice(0, maxCharacters)}\n[内容已截断]` : text;
	} catch {
		return undefined;
	}
}

async function readTranscript(paths: EvoPaths, runId: string): Promise<TranscriptEvent[]> {
	const text = await readOptional(join(evolutionRunDirectory(paths, runId), "transcript.jsonl"), 500_000);
	if (!text) return [];
	return text.split("\n").flatMap((line) => {
		try {
			return [JSON.parse(line) as TranscriptEvent];
		} catch {
			return [];
		}
	});
}

function cleanThinking(value: string): string {
	return value.replaceAll("**", "").replace(/\s+/g, " ").trim();
}

function elapsed(startedAt: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function phaseLabel(status: EvolutionRunStatus): string {
	return {
		queued: "等待执行",
		researching: "研究问题并制定实验计划",
		planned: "研究计划已冻结",
		building: "构建候选改进",
		validating: "执行确定性验证",
		replaying: "回放历史任务",
		evaluating: "评估候选效果",
		"awaiting-evidence": "等待更多实验数据",
		"awaiting-canary-approval": "等待用户确认 Canary",
		trialing: "Canary 试运行中",
		"awaiting-decision": "等待最终决定",
		paused: "已暂停",
		completed: "已完成",
		failed: "执行失败",
		cancelled: "已取消",
	}[status];
}

function toolDescription(event: TranscriptEvent): string {
	const args = event.arguments ?? {};
	if (event.name === "evo_research_search") {
		return `检索 ${String(args.source ?? "资料源")}：${String(args.query ?? "")}`;
	}
	if (event.name === "evo_research_fetch") return `读取研究资料：${String(args.url ?? args.id ?? "")}`;
	return `${event.name ?? "工具"} ${Object.keys(args).length > 0 ? JSON.stringify(args) : ""}`.trim();
}

function currentActivity(events: TranscriptEvent[], status: EvolutionRunStatus): string {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (!event) continue;
		if (event.type === "text" && cleanThinking(event.delta ?? "")) {
			return `正在整理输出：${cleanThinking(event.delta ?? "")}`;
		}
		if (event.type === "thinking" && cleanThinking(event.delta ?? "")) return cleanThinking(event.delta ?? "");
		if (event.type === "tool-call") return toolDescription(event);
		if (event.type === "tool-result")
			return event.isError ? `${event.name} 执行失败` : `${event.name} 已返回，正在分析`;
	}
	return phaseLabel(status);
}

function stageProgress(theme: Theme, status: EvolutionRunStatus): string {
	const current = status === "awaiting-evidence" ? 7 : PHASE_ORDER.indexOf(status);
	const stages = [
		{ threshold: 1, label: "研究" },
		{ threshold: 3, label: "构建" },
		{ threshold: 4, label: "验证" },
		{ threshold: 5, label: "回放" },
		{ threshold: 6, label: "评估" },
		{ threshold: 8, label: "Canary" },
		{ threshold: 10, label: "完成" },
	];
	return stages
		.map((stage) => {
			if (status === "failed" || status === "cancelled") return theme.fg("muted", `○ ${stage.label}`);
			if (status === "completed" || current > stage.threshold) return theme.fg("success", `● ${stage.label}`);
			if (current === stage.threshold || (stage.threshold === 1 && status === "planned")) {
				return theme.fg("accent", `◆ ${stage.label}`);
			}
			return theme.fg("dim", `○ ${stage.label}`);
		})
		.join("  ");
}

function thinkingText(events: TranscriptEvent[]): string {
	return events
		.filter((event) => event.type === "thinking")
		.map((event) => event.delta ?? "")
		.join("")
		.trim();
}

function toolEvents(events: TranscriptEvent[]): Array<{ call: TranscriptEvent; result?: TranscriptEvent }> {
	const calls: Array<{ call: TranscriptEvent; result?: TranscriptEvent }> = [];
	for (const event of events) {
		if (event.type === "tool-call") calls.push({ call: event });
		else if (event.type === "tool-result") {
			const pending = [...calls].reverse().find((entry) => !entry.result && entry.call.name === event.name);
			if (pending) pending.result = event;
		} else if (event.type === "thinking" || event.type === "text") {
			for (const pending of calls.filter((entry) => !entry.result)) {
				pending.result = {
					timestamp: event.timestamp,
					phase: event.phase,
					type: "tool-result",
					name: pending.call.name,
					isError: false,
				};
			}
		}
	}
	return calls;
}

export class EvolutionProcessInspector implements Component {
	private timer: NodeJS.Timeout;
	private items: EvoActivityItem[] = [];
	private item?: EvoActivityItem;
	private run?: EvolutionRun;
	private events: TranscriptEvent[] = [];
	private artifacts: RunArtifacts = {};
	private proposal?: Proposal;
	private mode: "tasks" | "run";
	private taskIndex = 0;
	private sectionIndex = 0;
	private expandedSection?: number;
	private scrollFromBottom = 0;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly paths: EvoPaths;
	private readonly service: EvoService;
	private readonly close: () => void;
	private readonly approveCanary: (runId: string, decision: ComponentApprovalDecision) => Promise<void>;
	private readonly directKeepCanary: (runId: string) => Promise<void>;
	private approving = false;
	private approvalError?: string;
	private approvalView: "choice" | "custom" | "direct-confirm" = "choice";
	private approvalChoice = 0;
	private customField = 0;
	private customMinimumSamples = 10;
	private customMaximumDurationDays = 7;
	private customDefaultsInitialized = false;
	private trial?: TrialState;
	private trialComparison?: TrialComparison;
	private nextTrialComparisonRefresh = 0;
	private keepConfirming = false;
	private keeping = false;
	private keepError?: string;
	private itemKey?: string;
	private loadError?: string;
	private taskNotice?: string;
	private taskScrollTop = 0;
	private selectedTaskLine = 0;
	private pendingInitialScroll: boolean;

	constructor(
		tui: TUI,
		theme: Theme,
		paths: EvoPaths,
		service: EvoService,
		itemKey: string | undefined,
		close: () => void,
		approveCanary: (runId: string, decision: ComponentApprovalDecision) => Promise<void>,
		directKeepCanary: (runId: string) => Promise<void> = async () => {
			throw new Error("Direct keep is unavailable");
		},
	) {
		this.tui = tui;
		this.theme = theme;
		this.paths = paths;
		this.service = service;
		this.itemKey = itemKey;
		this.close = close;
		this.approveCanary = approveCanary;
		this.directKeepCanary = directKeepCanary;
		this.mode = itemKey ? "run" : "tasks";
		this.pendingInitialScroll = Boolean(itemKey);
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 250);
		this.timer.unref?.();
	}

	private async refresh(): Promise<void> {
		try {
			this.items = await listEvoActivityItems(
				{ paths: this.paths, service: this.service },
				{ includeHistory: true, includeTrialComparison: false },
			);
			this.taskIndex = Math.min(this.taskIndex, Math.max(0, this.items.length - 1));
			if (this.mode === "run" && this.itemKey) {
				this.item = this.items.find((item) => item.key === this.itemKey);
				if (!this.item) {
					// The referenced item no longer exists (processed elsewhere or a
					// stale status entry): fall back to the live task list instead of
					// polling a permanent "connecting" screen.
					this.mode = "tasks";
					this.itemKey = undefined;
					this.run = undefined;
					this.proposal = undefined;
					this.taskNotice = "所选事项已不存在（可能已被处理）；请从下面的列表重新选择";
					this.tui.requestRender();
					return;
				}
				if (this.item.kind === "proposal") {
					this.run = undefined;
					this.proposal = this.item.proposal;
					this.events = [];
					this.artifacts = {};
					this.trial = undefined;
					this.trialComparison = undefined;
					if (this.pendingInitialScroll) {
						// A proposal card is a static document: open it at the top.
						this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
					}
				} else {
					this.run = await readEvolutionRun(this.paths, this.item.run.id);
					const directory = evolutionRunDirectory(this.paths, this.run.id);
					[
						this.events,
						this.artifacts.plan,
						this.artifacts.experiment,
						this.artifacts.validation,
						this.artifacts.evaluation,
						this.proposal,
					] = await Promise.all([
						readTranscript(this.paths, this.run.id),
						readOptional(join(directory, "plan.md")),
						readOptional(join(directory, "experiment.json")),
						readOptional(join(directory, "validation.md")),
						readOptional(join(directory, "evaluation.md")),
						this.run.proposalId ? loadProposal(this.paths, this.run.proposalId) : Promise.resolve(undefined),
					]);
					if (!this.artifacts.evaluation && this.proposal?.artifacts.review) {
						this.artifacts.evaluation = await readOptional(
							join(this.paths.proposals, this.proposal.id, this.proposal.artifacts.review.file),
						);
					}
					const status = await this.service.status();
					this.trial = status.trial?.proposalId === this.proposal?.id ? status.trial : undefined;
					if (this.trial && this.proposal && Date.now() >= this.nextTrialComparisonRefresh) {
						this.trialComparison = await buildTrialComparison(this.paths, this.proposal, this.trial);
						this.nextTrialComparisonRefresh = Date.now() + 5_000;
					} else if (!this.trial) this.trialComparison = undefined;
				}
			}
			this.pendingInitialScroll = false;
			this.loadError = undefined;
			this.tui.requestRender();
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}

	private taskLines(): string[] {
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo 工作流")),
			"",
			...(this.taskNotice ? [this.theme.fg("warning", this.taskNotice), ""] : []),
			"选择任务并按 Enter 查看实时进度：",
			"",
		];
		if (this.items.length === 0) lines.push(this.theme.fg("muted", "暂无事项"));
		this.selectedTaskLine = 0;
		for (const [index, item] of this.items.entries()) {
			const selected = index === this.taskIndex;
			if (selected) this.selectedTaskLine = lines.length;
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const terminal = item.kind === "run" && TERMINAL_STATUSES.has(item.run.status);
			const paused = item.kind === "run" && item.run.status === "paused";
			const stateColor = terminal ? "muted" : paused ? "warning" : "success";
			lines.push(`${marker} ${this.theme.fg(stateColor, item.text)}`);
			if (item.kind === "run") lines.push(`    ${this.theme.fg("dim", elapsed(item.run.startedAt))}`);
		}
		lines.push("", this.theme.fg("dim", "↑↓ 选择 • Enter 查看 • Esc 关闭"));
		return lines;
	}

	private sectionHeader(index: number, summary: string): string {
		const marker = this.sectionIndex === index ? this.theme.fg("accent", "›") : " ";
		const expanded = this.expandedSection === index ? "▾" : "▸";
		return `${marker} ${expanded} ${this.theme.bold(SECTION_NAMES[index] ?? "详情")}  ${this.theme.fg("muted", summary)}`;
	}

	private initializeCustomCanaryDefaults(): void {
		if (this.customDefaultsInitialized) return;
		try {
			const experiment = JSON.parse(this.artifacts.experiment ?? "null") as {
				evidenceStrategy?: { online?: { mode?: string; minimumSamples?: number; maximumDuration?: string } };
			};
			const online = experiment.evidenceStrategy?.online;
			if (online?.mode === "canary") {
				if (Number.isSafeInteger(online.minimumSamples) && (online.minimumSamples ?? 0) > 0) {
					this.customMinimumSamples = online.minimumSamples ?? this.customMinimumSamples;
				}
				const days = /^([1-9]\d*)d$/.exec(online.maximumDuration ?? "");
				if (days) this.customMaximumDurationDays = Number(days[1]);
			}
		} catch {
			// The exact experiment remains visible; malformed display defaults do not enable approval.
		}
		this.customDefaultsInitialized = true;
	}

	private approvalControlLines(metadataMatches: boolean, directAvailable: boolean): string[] {
		if (!metadataMatches) return [this.theme.fg("error", "审批已禁用：运行记录与当前提案不一致")];
		if (this.approving) return [this.theme.fg("accent", "正在应用人工发布决策……")];
		if (this.approvalView === "direct-confirm") {
			return [
				this.theme.fg("warning", this.theme.bold("直接上线将跳过所有 Canary 效果证据。")),
				"候选会立即成为 stable；其 parent 仍可通过 /evo rollback 恢复。",
				this.theme.fg("accent", "再次按 Enter 确认直接上线；Esc 返回选择"),
			];
		}
		if (this.approvalView === "custom") {
			const rows = [
				`最少 candidate sessions：${this.customMinimumSamples}`,
				`最长持续时间：${this.customMaximumDurationDays} 天`,
				"以以上参数启动 Canary",
			];
			return [
				this.theme.bold("自定义 Canary"),
				...rows.map((row, index) => `${index === this.customField ? this.theme.fg("accent", "›") : " "} ${row}`),
				this.theme.fg("dim", "↑↓ 选择 • ←→ 调整 • Enter 启动 • Esc 返回"),
			];
		}
		const choices = [
			"按冻结计划和本地默认值启动 Canary",
			"自定义 Canary 样本数与最长时间",
			directAvailable ? "直接上线，跳过 Canary" : "直接上线不可用：缺少可执行 validation artifact",
		];
		return [
			this.theme.bold("人工发布决策"),
			...choices.map(
				(choice, index) => `${index === this.approvalChoice ? this.theme.fg("accent", "›") : " "} ${choice}`,
			),
			this.theme.fg("dim", "←→ 选择 • Enter 确认 • ↑↓ 滚动 • Home/End 跳转 • Esc 返回任务列表"),
		];
	}

	private canaryLines(run: EvolutionRun): string[] {
		const proposal = this.proposal;
		const metadataMatches =
			proposal !== undefined &&
			proposal.status === "pending" &&
			proposal.parentBundleDigest === run.canaryParentDigest &&
			proposal.candidateDigest === run.canaryCandidateDigest &&
			proposal.targetAbi === run.canaryTargetAbi;
		this.initializeCustomCanaryDefaults();
		const evaluation = this.artifacts.evaluation?.trim() ?? "没有评估报告";
		const validation = this.artifacts.validation?.trim() ?? "没有可执行验证报告";
		const diff = proposal?.diff.trim() ?? "没有可审阅 diff";
		return [
			this.theme.fg("accent", this.theme.bold("Evo Component Canary 审批")),
			"",
			`${this.theme.bold("Component")}  ${this.item?.component ?? "unknown"}`,
			`${this.theme.bold("目标")}  ${run.request ?? "定时演化"}`,
			`${this.theme.bold("Revision")}  ${proposal?.revision ?? "?"}`,
			`${this.theme.bold("ABI")}  ${run.canaryTargetAbi ?? "unknown"}`,
			`${this.theme.bold("Changed paths")}  ${proposal?.changedPaths.join(", ") || "unknown"}`,
			"",
			this.theme.fg("warning", this.theme.bold("风险")),
			proposal?.risk ?? "unknown",
			"",
			this.theme.bold("Canary 与回滚计划"),
			proposal?.trialPlan ?? "unknown",
			"回滚将恢复 Canary 启动前的 stable bundle。",
			"",
			this.theme.bold("可执行验证"),
			...validation.split("\n"),
			"",
			this.theme.bold("独立评估"),
			...evaluation.split("\n"),
			"",
			this.theme.bold("Exact diff"),
			...diff.split("\n"),
			"",
			...(this.approvalError ? [this.theme.fg("error", this.approvalError), ""] : []),
			...this.approvalControlLines(metadataMatches, proposal?.artifacts.validation !== undefined),
		];
	}

	private activeCanaryLines(): string[] {
		const proposal = this.proposal;
		const trial = this.trial;
		const comparison = this.trialComparison;
		const component = this.item?.component ?? "unknown";
		const surface = proposal?.targetAbi?.split("/", 1)[0] ?? "component";
		const shortComponent = component.endsWith(`-${surface}`) ? component.slice(0, -surface.length - 1) : component;
		const minimumSamples = trial?.canary?.minimumSamples;
		const currentSamples = comparison?.after.totals.sessions;
		const duration = trial?.canary?.maximumDurationDays;
		const progress =
			minimumSamples === undefined || currentSamples === undefined
				? "等待 session evidence"
				: `${currentSamples}/${minimumSamples} candidate sessions`;
		const decision = this.keepConfirming
			? [
					this.theme.fg("warning", this.theme.bold("立即正式上线将结束 Canary，不再等待剩余效果证据。")),
					"当前 candidate 保持为 stable；parent 仍可通过 /evo rollback 恢复。",
					this.theme.fg("accent", "再次按 Enter 确认正式上线；Esc 取消"),
				]
			: [
					this.theme.fg("accent", "按 Enter 选择立即正式上线（随后需要二次确认）"),
					this.theme.fg("dim", "Esc 返回事项列表 • /evo rollback 可立即回滚"),
				];
		return [
			this.theme.fg("accent", this.theme.bold("Evo Component Canary")),
			"",
			`${this.theme.bold("Component")}  ${surface}/${shortComponent}`,
			`${this.theme.bold("进度")}  ${progress}${duration === undefined ? "" : ` · 最长 ${duration} 天`}`,
			`${this.theme.bold("模式")}  ${trial?.canary?.customization === "custom" ? "自定义 Canary" : "默认 Canary"}`,
			"",
			this.theme.fg("warning", this.theme.bold("风险")),
			proposal?.risk ?? "unknown",
			"",
			this.theme.bold("Canary 与回滚计划"),
			trial?.plan ?? proposal?.trialPlan ?? "unknown",
			"",
			this.theme.bold("可执行验证"),
			...(this.artifacts.validation?.trim().split("\n") ?? ["没有可执行 validation artifact"]),
			"",
			this.theme.bold("独立评估"),
			...(this.artifacts.evaluation?.trim().split("\n") ?? ["没有评估报告"]),
			"",
			...(this.keepError ? [this.theme.fg("error", this.keepError), ""] : []),
			...(this.keeping ? [this.theme.fg("accent", "正在正式上线……")] : decision),
		];
	}

	private proposalLines(proposal: Proposal): string[] {
		return [
			this.theme.fg("accent", this.theme.bold("Evo Proposal")),
			"",
			...(this.item?.component ? [`${this.theme.bold("Component")}  ${this.item.component}`] : []),
			`${this.theme.bold("状态")}  ${proposal.status}`,
			`${this.theme.bold("风险等级")}  ${proposal.tier}/${proposal.kind}`,
			"",
			this.theme.bold("目标"),
			proposal.motivation,
			"",
			this.theme.bold("预期效果"),
			proposal.expectedEffect,
			"",
			this.theme.bold("风险"),
			proposal.risk,
			"",
			this.theme.bold("验证计划"),
			proposal.verifyPlan,
			"",
			this.theme.bold("变更"),
			...proposal.diff.split("\n"),
			"",
			this.theme.fg("accent", `运行 /evo permit ${proposal.id} 处理此提案`),
			this.theme.fg("dim", "↑↓ 滚动 • Home/End 跳转 • Esc 返回事项列表"),
		];
	}

	private runLines(): string[] {
		if (this.item?.kind === "proposal") return this.proposalLines(this.item.proposal);
		const run = this.run;
		if (!run) {
			return [
				this.theme.fg("warning", "正在连接后台任务……"),
				...(this.loadError
					? ["", this.theme.fg("error", this.loadError), this.theme.fg("dim", "Esc 返回事项列表")]
					: []),
			];
		}
		if (run.status === "awaiting-canary-approval") return this.canaryLines(run);
		if (run.status === "trialing" && this.item?.component) return this.activeCanaryLines();
		const thinking = thinkingText(this.events);
		const tools = toolEvents(this.events);
		const outcomes = [
			this.artifacts.plan && "研究计划",
			this.artifacts.experiment && "冻结实验",
			run.proposalId && "候选提案",
			this.artifacts.evaluation && "评估报告",
		].filter(Boolean) as string[];
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo 工作流进度")),
			"",
			...(this.item?.component ? [`${this.theme.bold("Component")}  ${this.item.component}`] : []),
			`${this.theme.bold("目标")}  ${run.request ?? "定时演化"}`,
			`${this.theme.bold("状态")}  ${phaseLabel(run.status)} · ${elapsed(run.startedAt)}`,
			"",
			stageProgress(this.theme, run.status),
			"",
			`${this.theme.bold("当前活动")}  ${currentActivity(this.events, run.status)}`,
			"",
		];
		lines.push(this.sectionHeader(0, thinking ? `${thinking.length} 字符` : "尚无输出"));
		if (this.expandedSection === 0) {
			lines.push(
				"",
				...(thinking
					? thinking.split("\n").map((line) => this.theme.fg("dim", `  ${line}`))
					: ["  尚无 thinking 输出"]),
				"",
			);
		}
		lines.push(this.sectionHeader(1, tools.length > 0 ? `${tools.length} 次调用` : "尚未调用"));
		if (this.expandedSection === 1) {
			lines.push("");
			for (const [index, entry] of tools.entries()) {
				lines.push(`  ${index + 1}. ${toolDescription(entry.call)}`);
				if (entry.result) {
					lines.push(
						this.theme.fg(
							entry.result.isError ? "error" : "success",
							`     ${entry.result.isError ? "失败" : "完成"}`,
						),
					);
					if (entry.result.text)
						lines.push(
							...entry.result.text
								.split("\n")
								.slice(0, 12)
								.map((line) => this.theme.fg("dim", `     ${line}`)),
						);
				} else lines.push(this.theme.fg("warning", "     运行中"));
			}
			if (tools.length === 0) lines.push("  尚无工具调用");
			lines.push("");
		}
		lines.push(this.sectionHeader(2, outcomes.length > 0 ? outcomes.join("、") : "尚无阶段成果"));
		if (this.expandedSection === 2) {
			lines.push("");
			if (this.artifacts.plan)
				lines.push(
					this.theme.fg("success", "  ✓ 研究计划"),
					...this.artifacts.plan.split("\n").map((line) => `    ${line}`),
				);
			if (this.artifacts.experiment)
				lines.push(
					this.theme.fg("success", "  ✓ 冻结实验"),
					...this.artifacts.experiment.split("\n").map((line) => `    ${line}`),
				);
			if (run.proposalId) lines.push(this.theme.fg("success", "  ✓ 候选提案"));
			if (this.artifacts.evaluation)
				lines.push(
					this.theme.fg("success", "  ✓ 评估报告"),
					...this.artifacts.evaluation.split("\n").map((line) => `    ${line}`),
				);
			if (outcomes.length === 0) lines.push("  当前阶段尚未生成可审阅成果");
			lines.push("");
		}
		if (run.error) lines.push(this.theme.fg("error", `错误：${run.error}`), "");
		lines.push(this.theme.fg("dim", "↑↓ 选择 • Enter 展开/收起 • Esc 返回任务列表 • 实时更新"));
		return lines;
	}

	render(width: number): string[] {
		const logical = this.mode === "tasks" ? this.taskLines() : this.runLines();
		const wrapped: string[] = [];
		let selectedStart = 0;
		let selectedEnd = 0;
		for (const [index, line] of logical.entries()) {
			if (this.mode === "tasks" && index === this.selectedTaskLine) selectedStart = wrapped.length;
			for (const part of wrapTextWithAnsi(line, Math.max(1, width - 2))) wrapped.push(` ${part}`);
			if (this.mode === "tasks" && index === this.selectedTaskLine) selectedEnd = wrapped.length;
		}
		const viewport = Math.max(5, this.tui.terminal.rows - 4);
		const maxStart = Math.max(0, wrapped.length - viewport);
		if (this.mode === "tasks") {
			// The task list is top-anchored and scrolls only as far as needed to
			// keep the selected item visible; the highest-priority items are at
			// the top, so a small terminal must never hide them by default.
			if (selectedEnd > this.taskScrollTop + viewport) this.taskScrollTop = selectedEnd - viewport;
			if (selectedStart < this.taskScrollTop) this.taskScrollTop = selectedStart;
			this.taskScrollTop = Math.min(Math.max(0, this.taskScrollTop), maxStart);
			return wrapped.slice(this.taskScrollTop, this.taskScrollTop + viewport);
		}
		const start = Math.max(0, maxStart - this.scrollFromBottom);
		return wrapped.slice(start, start + viewport);
	}

	private startComponentApproval(decision: ComponentApprovalDecision): void {
		if (!this.run || this.approving) return;
		const proposal = this.proposal;
		if (
			!proposal ||
			proposal.status !== "pending" ||
			proposal.parentBundleDigest !== this.run.canaryParentDigest ||
			proposal.candidateDigest !== this.run.canaryCandidateDigest ||
			proposal.targetAbi !== this.run.canaryTargetAbi
		) {
			this.approvalError = "运行记录与当前提案不一致";
			this.tui.requestRender();
			return;
		}
		this.approving = true;
		this.approvalError = undefined;
		void this.approveCanary(this.run.id, decision)
			.then(() => this.refresh())
			.catch((error) => {
				this.approvalError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.approving = false;
				this.tui.requestRender();
			});
	}

	private startDirectKeep(): void {
		if (!this.run || this.keeping) return;
		if (!this.proposal?.artifacts.validation) {
			this.keepError = "正式上线要求绑定可执行 validation artifact";
			this.tui.requestRender();
			return;
		}
		this.keeping = true;
		this.keepError = undefined;
		void this.directKeepCanary(this.run.id)
			.then(() => this.refresh())
			.catch((error) => {
				this.keepError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.keeping = false;
				this.tui.requestRender();
			});
	}

	handleInput(data: string): void {
		if (
			this.mode === "run" &&
			this.run?.status === "trialing" &&
			this.keepConfirming &&
			matchesKey(data, Key.escape)
		) {
			this.keepConfirming = false;
			this.tui.requestRender();
			return;
		}
		if (
			this.mode === "run" &&
			this.run?.status === "awaiting-canary-approval" &&
			this.approvalView !== "choice" &&
			matchesKey(data, Key.escape)
		) {
			this.approvalView = "choice";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.mode === "run") {
				this.mode = "tasks";
				this.itemKey = undefined;
				this.item = undefined;
				this.scrollFromBottom = 0;
			} else this.close();
			this.tui.requestRender();
			return;
		}
		if (this.mode === "tasks") {
			if (matchesKey(data, Key.up)) this.taskIndex = Math.max(0, this.taskIndex - 1);
			else if (matchesKey(data, Key.down)) this.taskIndex = Math.min(this.items.length - 1, this.taskIndex + 1);
			else if (matchesKey(data, Key.enter)) {
				const selected = this.items[this.taskIndex];
				if (selected) {
					this.itemKey = selected.key;
					this.item = selected;
					this.run = selected.kind === "run" ? selected.run : undefined;
					this.mode = "run";
					this.taskNotice = undefined;
					this.sectionIndex = 0;
					this.expandedSection = undefined;
					// Proposal cards are static documents and open at the top; run
					// views stay bottom-anchored to follow live progress.
					this.scrollFromBottom = selected.kind === "proposal" ? Number.MAX_SAFE_INTEGER : 0;
					this.approvalView = "choice";
					this.approvalChoice = 0;
					this.customField = 0;
					this.customDefaultsInitialized = false;
					this.keepConfirming = false;
					this.keepError = undefined;
					void this.refresh();
				}
			}
		} else {
			if (this.item?.kind === "proposal") {
				if (matchesKey(data, Key.up)) this.scrollFromBottom++;
				else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				this.tui.requestRender();
				return;
			}
			if (this.run?.status === "trialing" && this.item?.component) {
				if (matchesKey(data, Key.up)) this.scrollFromBottom++;
				else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				else if (matchesKey(data, Key.enter) && !this.keeping) {
					if (this.keepConfirming) this.startDirectKeep();
					else this.keepConfirming = true;
				}
				this.tui.requestRender();
				return;
			}
			if (this.run?.status === "awaiting-canary-approval") {
				if (this.approvalView === "custom") {
					if (matchesKey(data, Key.up)) this.customField = Math.max(0, this.customField - 1);
					else if (matchesKey(data, Key.down)) this.customField = Math.min(2, this.customField + 1);
					else if (matchesKey(data, Key.left) && this.customField === 0)
						this.customMinimumSamples = Math.max(1, this.customMinimumSamples - 1);
					else if (matchesKey(data, Key.right) && this.customField === 0)
						this.customMinimumSamples = Math.min(10_000, this.customMinimumSamples + 1);
					else if (matchesKey(data, Key.left) && this.customField === 1)
						this.customMaximumDurationDays = Math.max(1, this.customMaximumDurationDays - 1);
					else if (matchesKey(data, Key.right) && this.customField === 1)
						this.customMaximumDurationDays = Math.min(365, this.customMaximumDurationDays + 1);
					else if (matchesKey(data, Key.enter) && this.customField === 2) {
						this.startComponentApproval({
							mode: "canary",
							customization: "custom",
							minimumSamples: this.customMinimumSamples,
							maximumDurationDays: this.customMaximumDurationDays,
						});
					}
				} else if (this.approvalView === "direct-confirm") {
					if (matchesKey(data, Key.enter)) this.startComponentApproval({ mode: "direct" });
				} else if (matchesKey(data, Key.left)) {
					this.approvalChoice = Math.max(0, this.approvalChoice - 1);
				} else if (matchesKey(data, Key.right)) {
					this.approvalChoice = Math.min(2, this.approvalChoice + 1);
				} else if (matchesKey(data, Key.up)) this.scrollFromBottom++;
				else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				else if (matchesKey(data, Key.enter) && !this.approving) {
					if (this.approvalChoice === 0) {
						this.startComponentApproval({ mode: "canary", customization: "default" });
					} else if (this.approvalChoice === 1) this.approvalView = "custom";
					else if (this.proposal?.artifacts.validation) this.approvalView = "direct-confirm";
					else this.approvalError = "直接上线要求通过并绑定可执行 validation artifact";
				}
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) this.sectionIndex = Math.max(0, this.sectionIndex - 1);
			else if (matchesKey(data, Key.down))
				this.sectionIndex = Math.min(SECTION_NAMES.length - 1, this.sectionIndex + 1);
			else if (matchesKey(data, Key.enter)) {
				this.expandedSection = this.expandedSection === this.sectionIndex ? undefined : this.sectionIndex;
				this.scrollFromBottom = 0;
			}
			if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
			else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}
