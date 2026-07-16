import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Theme } from "@ch1nyzzz/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, wrapTextWithAnsi } from "@ch1nyzzz/pi-tui";
import type { EvoPaths } from "../paths.ts";
import { loadProposal } from "../proposal.ts";
import type { EvoService } from "../service.ts";
import type { EvolutionRun, EvolutionRunStatus, Proposal } from "../types.ts";
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
	private readonly approveCanary: (runId: string) => Promise<void>;
	private approving = false;
	private approvalError?: string;
	private itemKey?: string;

	constructor(
		tui: TUI,
		theme: Theme,
		paths: EvoPaths,
		service: EvoService,
		itemKey: string | undefined,
		close: () => void,
		approveCanary: (runId: string) => Promise<void>,
	) {
		this.tui = tui;
		this.theme = theme;
		this.paths = paths;
		this.service = service;
		this.itemKey = itemKey;
		this.close = close;
		this.approveCanary = approveCanary;
		this.mode = itemKey ? "run" : "tasks";
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
				if (!this.item) throw new Error("Evo item is no longer available");
				if (this.item.kind === "proposal") {
					this.run = undefined;
					this.proposal = this.item.proposal;
					this.events = [];
					this.artifacts = {};
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
				}
			}
			this.tui.requestRender();
		} catch (error) {
			if (this.mode === "run") {
				this.run = undefined;
				this.events = [
					{
						timestamp: new Date().toISOString(),
						phase: "unknown",
						type: "text",
						delta: error instanceof Error ? error.message : String(error),
					},
				];
			}
			this.tui.requestRender();
		}
	}

	private taskLines(): string[] {
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo 工作流")),
			"",
			"选择任务并按 Enter 查看实时进度：",
			"",
		];
		if (this.items.length === 0) lines.push(this.theme.fg("muted", "暂无事项"));
		for (const [index, item] of this.items.entries()) {
			const selected = index === this.taskIndex;
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

	private canaryLines(run: EvolutionRun): string[] {
		const proposal = this.proposal;
		const metadataMatches =
			proposal !== undefined &&
			proposal.status === "pending" &&
			proposal.parentBundleDigest === run.canaryParentDigest &&
			proposal.candidateDigest === run.canaryCandidateDigest &&
			proposal.targetAbi === run.canaryTargetAbi;
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
			metadataMatches
				? this.theme.fg(
						"accent",
						this.approving ? "正在启动 Canary……" : "按 Enter 同意以上精确候选并启动可回滚 Canary",
					)
				: this.theme.fg("error", "审批已禁用：运行记录与当前提案不一致"),
			this.theme.fg("dim", "↑↓ 滚动 • Home/End 跳转 • Enter 审批 • Esc 返回任务列表"),
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
			this.theme.fg("dim", "↑↓ 滚动 • Home/End 跳转 • Esc 返回事项列表"),
		];
	}

	private runLines(): string[] {
		if (this.item?.kind === "proposal") return this.proposalLines(this.item.proposal);
		const run = this.run;
		if (!run) return [this.theme.fg("warning", "正在连接后台任务……")];
		if (run.status === "awaiting-canary-approval") return this.canaryLines(run);
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
		const wrapped = logical
			.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)))
			.map((line) => ` ${line}`);
		const viewport = Math.max(5, this.tui.terminal.rows - 4);
		const maxStart = Math.max(0, wrapped.length - viewport);
		const start = Math.max(0, maxStart - this.scrollFromBottom);
		return wrapped.slice(start, start + viewport);
	}

	handleInput(data: string): void {
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
					this.sectionIndex = 0;
					this.expandedSection = undefined;
					this.scrollFromBottom = 0;
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
			if (this.run?.status === "awaiting-canary-approval") {
				if (matchesKey(data, Key.up)) this.scrollFromBottom++;
				else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				else if (matchesKey(data, Key.enter) && !this.approving) {
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
					void this.approveCanary(this.run.id)
						.then(() => this.refresh())
						.catch((error) => {
							this.approvalError = error instanceof Error ? error.message : String(error);
						})
						.finally(() => {
							this.approving = false;
							this.tui.requestRender();
						});
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
