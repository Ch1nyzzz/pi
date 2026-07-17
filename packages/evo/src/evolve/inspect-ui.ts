import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Theme } from "@ch1nyzzz/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, wrapTextWithAnsi } from "@ch1nyzzz/pi-tui";
import { buildTrialComparison, type TrialComparison } from "../comparison.ts";
import type { EvoPaths } from "../paths.ts";
import { loadProposal, proposalApproval } from "../proposal.ts";
import { readEvaluationArtifact } from "../proposal-artifacts.ts";
import { recordPermitDefer, recordPermitReopen } from "../reflect/permit.ts";
import type { EvoService } from "../service.ts";
import type { ComponentApprovalDecision, EvolutionRun, EvolutionRunStatus, Proposal, TrialState } from "../types.ts";
import {
	activityGroup,
	type EvoActivityGroup,
	type EvoActivityItem,
	groupActivityItems,
	listEvoActivityItems,
} from "./activity.ts";
import { evolutionRunDirectory, readEvolutionRun } from "./run.ts";
import { type PendingVerification, readPendingVerification } from "./verification-decision.ts";

export type VerificationDecision = "execute" | "skip" | "reject";

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

const GROUP_LABELS: Record<EvoActivityGroup, string> = {
	action: "需要你的决定",
	running: "进行中",
	history: "历史",
};

const PROPOSAL_ACTION_HOTKEYS: Record<ProposalActionId, string> = {
	approve: "a",
	reject: "r",
	defer: "d",
	reopen: "o",
};

interface InspectorSection {
	id: string;
	title: string;
	summary?: string;
	tone?: "warning";
	content: string[];
}

/** Collapse a paragraph to a single scannable line. */
function summarize(value: string, maxLength = 96): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

type ProposalActionId = "approve" | "reject" | "defer" | "reopen";

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
	private displayItems: EvoActivityItem[] = [];
	private sectionFocus = 0;
	private expandedSections = new Set<string>();
	private activeSectionIds: string[] = [];
	private focusedSectionLine = -1;
	private followFocus = false;
	private scrollFromBottom = 0;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly paths: EvoPaths;
	private readonly service: EvoService;
	private readonly close: () => void;
	private readonly approveCanary: (runId: string, decision: ComponentApprovalDecision) => Promise<void>;
	private readonly directKeepCanary: (runId: string) => Promise<void>;
	private readonly decideVerification: (runId: string, decision: VerificationDecision) => Promise<void>;
	private pendingVerification?: PendingVerification;
	private verificationChoice = 0;
	private verificationActing = false;
	private verificationError?: string;
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
	private proposalView: "info" | "confirm" | "digest" | "reason" = "info";
	private proposalAction: ProposalActionId = "approve";
	private proposalChoice = 0;
	private proposalInput = "";
	private proposalError?: string;
	private proposalActing = false;
	private proposalReview?: string;
	private proposalValidation?: string;
	private proposalArtifactsFor?: string;

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
		decideVerification: (runId: string, decision: VerificationDecision) => Promise<void> = async () => {
			throw new Error("Verification decisions are unavailable");
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
		this.decideVerification = decideVerification;
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
			this.displayItems = groupActivityItems(this.items);
			this.taskIndex = Math.min(this.taskIndex, Math.max(0, this.displayItems.length - 1));
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
					const artifactsKey = `${this.proposal.id}:r${this.proposal.revision}`;
					if (this.proposalArtifactsFor !== artifactsKey) {
						this.proposalArtifactsFor = artifactsKey;
						this.proposalReview = await this.readProposalArtifact(this.proposal, "review");
						this.proposalValidation = await this.readProposalArtifact(this.proposal, "validation");
					}
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
					this.pendingVerification =
						this.run.status === "awaiting-evidence"
							? await readPendingVerification(this.paths, this.run.id)
							: undefined;
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

	private itemGlyph(item: EvoActivityItem): {
		icon: string;
		color: "warning" | "muted" | "accent" | "success" | "error";
	} {
		if (item.kind === "proposal") {
			if (item.proposal.status === "pending") return { icon: "●", color: "warning" };
			if (item.proposal.status === "deferred") return { icon: "○", color: "muted" };
			return { icon: "◆", color: "accent" };
		}
		const status = item.run.status;
		if (status === "trialing") return { icon: "◆", color: "accent" };
		if (status === "awaiting-canary-approval" || status === "awaiting-decision")
			return { icon: "●", color: "warning" };
		if (status === "completed") return { icon: "✓", color: "success" };
		if (status === "failed" || status === "cancelled") return { icon: "✗", color: "error" };
		if (status === "paused") return { icon: "○", color: "warning" };
		return { icon: "▶", color: "success" };
	}

	private taskLines(): string[] {
		const actionCount = this.displayItems.filter((item) => activityGroup(item) === "action").length;
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo 工作流")) +
				(actionCount > 0
					? this.theme.fg("warning", this.theme.bold(` · ${actionCount} 项等待你处理`))
					: this.theme.fg("dim", ` · ${this.displayItems.length} 项`)),
			...(this.taskNotice ? ["", this.theme.fg("warning", this.taskNotice)] : []),
			"",
		];
		if (this.displayItems.length === 0) {
			lines.push(
				this.theme.fg("muted", "暂无事项"),
				this.theme.fg("dim", "/evo go <目标> 启动一次演化 · /evo help 查看全部命令"),
			);
		}
		this.selectedTaskLine = 0;
		let lastGroup: EvoActivityGroup | undefined;
		for (const [index, item] of this.displayItems.entries()) {
			const group = activityGroup(item);
			if (group !== lastGroup) {
				if (lastGroup !== undefined) lines.push("");
				const headerColor = group === "action" ? "warning" : group === "running" ? "text" : "dim";
				lines.push(this.theme.fg(headerColor, this.theme.bold(GROUP_LABELS[group])));
				lastGroup = group;
			}
			const selected = index === this.taskIndex;
			if (selected) this.selectedTaskLine = lines.length;
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const glyph = this.itemGlyph(item);
			const text = item.text.replace(/^Evo: /, "");
			const textColor = group === "history" ? "muted" : "text";
			const suffix = item.kind === "run" ? this.theme.fg("dim", `  ${elapsed(item.run.startedAt)}`) : "";
			lines.push(`${marker} ${this.theme.fg(glyph.color, glyph.icon)} ${this.theme.fg(textColor, text)}${suffix}`);
		}
		return lines;
	}

	private pushSections(lines: string[], sections: InspectorSection[]): void {
		this.activeSectionIds = sections.map((section) => section.id);
		this.sectionFocus = Math.min(this.sectionFocus, Math.max(0, sections.length - 1));
		for (const [index, section] of sections.entries()) {
			if (index === this.sectionFocus) this.focusedSectionLine = lines.length;
			const focused = index === this.sectionFocus;
			const expanded = this.expandedSections.has(section.id);
			const marker = focused ? this.theme.fg("accent", "›") : " ";
			const triangle = expanded ? "▾" : "▸";
			const title =
				section.tone === "warning"
					? this.theme.fg("warning", this.theme.bold(section.title))
					: this.theme.bold(section.title);
			lines.push(
				`${marker} ${triangle} ${title}${section.summary ? `  ${this.theme.fg("muted", section.summary)}` : ""}`,
			);
			if (expanded) lines.push(...section.content.map((line) => `  ${line}`), "");
		}
	}

	private focusNextSection(): void {
		if (this.activeSectionIds.length === 0) return;
		this.sectionFocus = (this.sectionFocus + 1) % this.activeSectionIds.length;
		this.followFocus = true;
	}

	private moveSectionFocus(delta: number): void {
		if (this.activeSectionIds.length === 0) return;
		this.sectionFocus = Math.min(Math.max(0, this.sectionFocus + delta), this.activeSectionIds.length - 1);
		this.followFocus = true;
	}

	private toggleFocusedSection(): void {
		const id = this.activeSectionIds[this.sectionFocus];
		if (!id) return;
		if (this.expandedSections.has(id)) this.expandedSections.delete(id);
		else this.expandedSections.add(id);
		this.followFocus = true;
	}

	private tierBadge(proposal: Proposal): string {
		const color = proposal.tier === "T0" ? "success" : proposal.tier === "T1" ? "warning" : "error";
		return this.theme.fg(color, this.theme.bold(`[${proposal.tier}/${proposal.kind}]`));
	}

	private proposalStatusMeta(proposal: Proposal): {
		label: string;
		color: "warning" | "muted" | "accent" | "success" | "error";
	} {
		switch (proposal.status) {
			case "pending":
				return { label: "等待处理", color: "warning" };
			case "deferred":
				return { label: "已推迟", color: "muted" };
			case "approved":
				return { label: "已批准", color: "success" };
			case "trialing":
				return { label: "Trial 运行中", color: "accent" };
			case "kept":
				return { label: "已保留", color: "success" };
			case "rejected":
				return { label: "已拒绝", color: "error" };
			case "rolled-back":
				return { label: "已回滚", color: "muted" };
			default:
				return { label: proposal.status, color: "muted" };
		}
	}

	private progressBar(current: number, minimum: number): string {
		const width = 10;
		const filled = Math.min(width, Math.round((width * current) / Math.max(1, minimum)));
		const color = current >= minimum ? "success" : "accent";
		return `${this.theme.fg(color, "●".repeat(filled))}${this.theme.fg("dim", "○".repeat(width - filled))}`;
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
				this.theme.fg("accent", "再次按 Enter 确认直接上线 · Esc 返回选择"),
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
				this.theme.fg("dim", "↑↓ 选择 · ←→ 调整 · Enter 启动 · Esc 返回"),
			];
		}
		const choices = [
			{ key: "c", label: "默认 Canary", note: "按冻结计划与本地默认值" },
			{ key: "u", label: "自定义 Canary", note: "样本数与最长时间" },
			directAvailable
				? { key: "x", label: "直接上线", note: "跳过 Canary 效果证据" }
				: { key: "x", label: "直接上线不可用", note: "缺少可执行 validation artifact" },
		];
		return [
			this.theme.bold("发布决策"),
			...choices.map((choice, index) => {
				const marker = index === this.approvalChoice ? this.theme.fg("accent", "›") : " ";
				return `${marker} ${this.theme.fg("accent", `[${choice.key}]`)} ${choice.label}  ${this.theme.fg("muted", choice.note)}`;
			}),
			this.theme.fg(
				"dim",
				"推荐默认 Canary：先收集效果证据，可随时回滚 · 快捷键或 ←→+Enter · Tab 章节 · ↑↓ 滚动 · Esc 返回",
			),
		];
	}

	private canaryLines(run: EvolutionRun): string[] {
		const proposal = this.proposal;
		const validation = this.artifacts.validation?.trim();
		const evaluation = this.artifacts.evaluation?.trim();
		const diff = proposal?.diff.trim() ?? "";
		const sections: InspectorSection[] = [
			{
				id: "risk",
				title: "风险",
				tone: "warning",
				summary: summarize(proposal?.risk ?? "unknown", 48),
				content: [proposal?.risk ?? "unknown"],
			},
			{
				id: "rollback",
				title: "Canary 与回滚计划",
				summary: summarize(proposal?.trialPlan ?? "unknown", 48),
				content: [proposal?.trialPlan ?? "unknown", "", "回滚将恢复 Canary 启动前的 stable bundle。"],
			},
			{
				id: "validation",
				title: "可执行验证",
				summary: validation ? "✓ 已完成" : "缺失",
				content: validation ? validation.split("\n") : ["没有可执行验证报告"],
			},
			{
				id: "evaluation",
				title: "独立评估",
				summary: evaluation ? "✓ 已完成" : "缺失",
				content: evaluation ? evaluation.split("\n") : ["没有评估报告"],
			},
			{
				id: "diff",
				title: `Exact diff${diff ? ` · ${diff.split("\n").length} 行` : ""}`,
				content: diff ? diff.split("\n") : ["没有可审阅 diff"],
			},
		];
		const facts = [
			`验证 ${validation ? "✓" : "–"}`,
			`评估 ${evaluation ? "✓" : "–"}`,
			...(proposal ? [`diff ${proposal.diffDigest.slice(0, 12)}…`] : []),
		].join(" · ");
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo Component Canary 审批")),
			"",
			`${this.theme.bold("Component")}  ${this.item?.component ?? "unknown"}${this.theme.fg(
				"dim",
				` · ${run.canaryTargetAbi ?? "unknown ABI"} · r${proposal?.revision ?? "?"}`,
			)}`,
			`${this.theme.bold("目标")}  ${run.request ?? "定时演化"}`,
			`${this.theme.fg("dim", "Changed paths")}  ${proposal?.changedPaths.join(", ") || "unknown"}`,
			"",
			`${this.theme.fg("warning", "风险")}  ${this.theme.fg("warning", summarize(proposal?.risk ?? "unknown"))}`,
			this.theme.fg("dim", facts),
			"",
		];
		this.pushSections(lines, sections);
		return lines;
	}

	private canaryDecisionLines(): string[] {
		const run = this.run;
		if (!run) return [];
		this.initializeCustomCanaryDefaults();
		const proposal = this.proposal;
		const metadataMatches =
			proposal !== undefined &&
			proposal.status === "pending" &&
			proposal.parentBundleDigest === run.canaryParentDigest &&
			proposal.candidateDigest === run.canaryCandidateDigest &&
			proposal.targetAbi === run.canaryTargetAbi;
		return [
			this.theme.fg("dim", "─".repeat(40)),
			...(this.approvalError ? [this.theme.fg("error", this.approvalError)] : []),
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
			minimumSamples !== undefined && currentSamples !== undefined
				? `${this.progressBar(currentSamples, minimumSamples)}  ${currentSamples}/${minimumSamples} sessions`
				: "等待 session evidence";
		const validation = this.artifacts.validation?.trim();
		const evaluation = this.artifacts.evaluation?.trim();
		const sections: InspectorSection[] = [
			{
				id: "risk",
				title: "风险",
				tone: "warning",
				summary: summarize(proposal?.risk ?? "unknown", 48),
				content: [proposal?.risk ?? "unknown"],
			},
			{
				id: "rollback",
				title: "Canary 与回滚计划",
				summary: summarize(trial?.plan ?? proposal?.trialPlan ?? "unknown", 48),
				content: [trial?.plan ?? proposal?.trialPlan ?? "unknown"],
			},
			{
				id: "validation",
				title: "可执行验证",
				summary: validation ? "✓ 已完成" : "缺失",
				content: validation ? validation.split("\n") : ["没有可执行 validation artifact"],
			},
			{
				id: "evaluation",
				title: "独立评估",
				summary: evaluation ? "✓ 已完成" : "缺失",
				content: evaluation ? evaluation.split("\n") : ["没有评估报告"],
			},
		];
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo Component Canary")),
			"",
			`${this.theme.bold("Component")}  ${surface}/${shortComponent}${this.theme.fg(
				"dim",
				` · ${trial?.canary?.customization === "custom" ? "自定义 Canary" : "默认 Canary"}`,
			)}`,
			`${this.theme.bold("进度")}  ${progress}${duration === undefined ? "" : ` · ≤${duration} 天`}`,
			"",
			`${this.theme.fg("warning", "风险")}  ${this.theme.fg("warning", summarize(proposal?.risk ?? "unknown"))}`,
			"",
		];
		this.pushSections(lines, sections);
		return lines;
	}

	private verificationDecisionLines(): string[] {
		const pending = this.pendingVerification;
		if (!pending) return [];
		const verdictLabel =
			pending.verdict === "verified"
				? "verified"
				: pending.verdict === "needs-evidence"
					? "needs-evidence"
					: pending.verdict;
		const choices = [
			{ key: "e", label: "执行验证", note: `补跑 ${pending.profiles.join(", ")} 后重新评估` },
			{ key: "s", label: "跳过并发布", note: `按当前评估结果（${verdictLabel}）走标准发布策略` },
			{ key: "r", label: "拒绝候选", note: "不再投入验证，直接拒绝" },
		];
		const header = [
			this.theme.fg("dim", "─".repeat(40)),
			this.theme.bold("研究者建议执行验证（非发布阻塞）"),
			`${this.theme.fg("warning", "建议理由")}  ${summarize(pending.reason, 120)}`,
			this.theme.fg(
				"dim",
				`profiles: ${pending.profiles.join(", ")} · datasets: ${pending.datasets.length} 个 · 最少样本 ${pending.minimumSamples} · 当前评估 ${verdictLabel}`,
			),
		];
		if (this.verificationActing) return [...header, this.theme.fg("accent", "正在应用验证决策……")];
		return [
			...header,
			...(this.verificationError ? [this.theme.fg("error", this.verificationError)] : []),
			...choices.map((choice, index) => {
				const marker = index === this.verificationChoice ? this.theme.fg("accent", "›") : " ";
				return `${marker} ${this.theme.fg("accent", `[${choice.key}]`)} ${choice.label}  ${this.theme.fg("muted", choice.note)}`;
			}),
			this.theme.fg("dim", "快捷键或 ←→+Enter · Tab 章节 · ↑↓ 滚动 · Esc 返回"),
		];
	}

	private startVerificationDecision(decision: VerificationDecision): void {
		if (!this.run || this.verificationActing) return;
		this.verificationActing = true;
		this.verificationError = undefined;
		void this.decideVerification(this.run.id, decision)
			.then(() => this.refresh())
			.catch((error) => {
				this.verificationError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.verificationActing = false;
				this.tui.requestRender();
			});
	}

	private trialingDecisionLines(): string[] {
		const decision = this.keepConfirming
			? [
					this.theme.fg("warning", this.theme.bold("立即正式上线将结束 Canary，不再等待剩余效果证据。")),
					"当前 candidate 保持为 stable；parent 仍可通过 /evo rollback 恢复。",
					this.theme.fg("accent", "再次按 Enter 确认正式上线 · Esc 取消"),
				]
			: [
					"按 Enter 立即正式上线（随后需要二次确认）",
					this.theme.fg("dim", "Esc 返回事项列表 · /evo rollback 可立即回滚 · Tab 章节 · ↑↓ 滚动"),
				];
		return [
			this.theme.fg("dim", "─".repeat(40)),
			...(this.keepError ? [this.theme.fg("error", this.keepError)] : []),
			...(this.keeping ? [this.theme.fg("accent", "正在正式上线……")] : decision),
		];
	}

	private pinnedLines(): string[] {
		if (this.mode === "tasks") {
			return [this.theme.fg("dim", "─".repeat(40)), this.theme.fg("dim", "↑↓ 选择 · Enter 打开 · Esc 关闭")];
		}
		if (this.item?.kind === "proposal") return this.proposalActionLines(this.item.proposal);
		if (this.run?.status === "awaiting-canary-approval") return this.canaryDecisionLines();
		if (this.run?.status === "awaiting-evidence" && this.pendingVerification) return this.verificationDecisionLines();
		if (this.run?.status === "trialing" && this.item?.component) return this.trialingDecisionLines();
		if (this.run) {
			return [
				this.theme.fg("dim", "─".repeat(40)),
				this.theme.fg("dim", "↑↓ 滚动 · Tab 选择章节 · Enter/Space 展开收起 · Esc 返回 · 实时更新"),
			];
		}
		return [];
	}

	private async readProposalArtifact(proposal: Proposal, kind: "review" | "validation"): Promise<string | undefined> {
		const reference = proposal.artifacts[kind];
		if (!reference) return undefined;
		try {
			return (
				await readEvaluationArtifact({
					paths: this.paths,
					proposalId: proposal.id,
					revision: proposal.revision,
					diffDigest: proposal.diffDigest,
					kind,
					reference,
				})
			).trim();
		} catch {
			return undefined;
		}
	}

	private proposalLines(proposal: Proposal): string[] {
		const status = this.proposalStatusMeta(proposal);
		const diffLines = proposal.diff.split("\n");
		const maxDiffLines = 400;
		const sections: InspectorSection[] = [
			{
				id: "detail",
				title: "目标与预期效果",
				summary: summarize(proposal.motivation, 48),
				content: [
					this.theme.bold("目标"),
					proposal.motivation,
					"",
					this.theme.bold("预期效果"),
					proposal.expectedEffect,
				],
			},
			{
				id: "risk",
				title: "风险",
				tone: "warning",
				summary: summarize(proposal.risk, 48),
				content: [proposal.risk],
			},
			{
				id: "verify",
				title: "验证计划",
				summary: summarize(proposal.verifyPlan, 48),
				content: [proposal.verifyPlan],
			},
		];
		if (this.proposalValidation) {
			sections.push({
				id: "validation",
				title: "可执行验证",
				summary: "✓ 已完成",
				content: this.proposalValidation.split("\n"),
			});
		}
		if (this.proposalReview) {
			sections.push({
				id: "review",
				title: "独立评审",
				summary: "✓ 已完成",
				content: this.proposalReview.split("\n"),
			});
		}
		sections.push({
			id: "diff",
			title: `变更 · ${diffLines.length} 行`,
			content: [
				...diffLines.slice(0, maxDiffLines),
				...(diffLines.length > maxDiffLines
					? [this.theme.fg("dim", `… 其余 ${diffLines.length - maxDiffLines} 行见 /evo show ${proposal.id}`)]
					: []),
			],
		});
		const facts = [
			`验证 ${this.proposalValidation ? "✓" : "–"}`,
			`评审 ${this.proposalReview ? "✓" : "–"}`,
			`diff ${proposal.diffDigest.slice(0, 12)}…`,
		].join(" · ");
		const lines = [
			this.theme.fg("accent", this.theme.bold("Evo Proposal")) +
				(this.item?.component ? this.theme.fg("dim", ` · ${this.item.component}`) : ""),
			"",
			`${this.tierBadge(proposal)} ${this.theme.fg(status.color, status.label)}${this.theme.fg("dim", ` · r${proposal.revision}`)}`,
			"",
			`${this.theme.fg("dim", "目标")}  ${summarize(proposal.motivation)}`,
			`${this.theme.fg("dim", "预期")}  ${summarize(proposal.expectedEffect)}`,
			`${this.theme.fg("warning", "风险")}  ${this.theme.fg("warning", summarize(proposal.risk))}`,
			this.theme.fg("dim", facts),
			"",
		];
		this.pushSections(lines, sections);
		return lines;
	}

	private availableProposalActions(proposal: Proposal): Array<{ id: ProposalActionId; label: string }> {
		if (proposal.status === "pending") {
			return [
				{ id: "approve", label: "批准" },
				{ id: "reject", label: "拒绝" },
				{ id: "defer", label: "推迟" },
			];
		}
		if (proposal.status === "deferred") {
			return [
				{ id: "reopen", label: "重新打开" },
				{ id: "reject", label: "拒绝" },
			];
		}
		return [];
	}

	private strictProposalDigest(proposal: Proposal): string | undefined {
		if (proposal.kind !== "code" && proposal.tier !== "T2") return undefined;
		return proposal.kind === "code" ? proposal.approvalDigest : proposal.diffDigest;
	}

	private proposalActionLines(proposal: Proposal): string[] {
		const divider = this.theme.fg("dim", "─".repeat(40));
		const error = this.proposalError ? [this.theme.fg("error", this.proposalError)] : [];
		if (this.proposalActing) return [divider, ...error, this.theme.fg("accent", "正在执行……")];
		if (this.proposalView === "reason") {
			const label = this.proposalAction === "reject" ? "拒绝理由" : "推迟理由";
			return [
				divider,
				...error,
				`${this.theme.bold(label)}：${this.proposalInput}${this.theme.fg("accent", "▌")}`,
				this.theme.fg("dim", "输入理由后 Enter 提交 • Esc 取消"),
			];
		}
		if (this.proposalView === "digest") {
			const expected = this.strictProposalDigest(proposal) ?? "";
			return [
				divider,
				...error,
				this.theme.fg("warning", "严格审批：输入（可粘贴）完整 digest 以确认批准"),
				this.theme.fg("dim", `需要输入：${expected}`),
				`输入：${this.proposalInput}${this.theme.fg("accent", "▌")}`,
				this.theme.fg("dim", "Enter 提交 • Esc 取消"),
			];
		}
		if (this.proposalView === "confirm") {
			return [
				divider,
				...error,
				this.theme.fg(
					"warning",
					`确认批准 ${proposal.tier}/${proposal.kind} 提案并应用 diff ${proposal.diffDigest.slice(0, 12)}…？`,
				),
				this.theme.fg("accent", "再次按 Enter 确认 · Esc 取消"),
			];
		}
		const actions = this.availableProposalActions(proposal);
		if (actions.length === 0) {
			return [
				divider,
				...error,
				this.theme.fg("dim", "此提案已处理完毕 · ↑↓ 章节 · Enter/Space 展开收起 · Esc 返回事项列表"),
			];
		}
		const row = actions
			.map((action, index) => {
				const label = `[${PROPOSAL_ACTION_HOTKEYS[action.id]}] ${action.label}`;
				return index === this.proposalChoice ? this.theme.fg("accent", label) : this.theme.fg("muted", label);
			})
			.join("  ");
		const consequence = this.strictProposalDigest(proposal)
			? "严格审批：批准需输入完整 digest"
			: "批准后按冻结策略生效或进入 Trial · 可随时 /evo rollback";
		return [
			divider,
			...error,
			`${this.theme.bold("处理此提案")}  ${row}`,
			this.theme.fg("dim", `${consequence} · 快捷键或 ←→+Enter · ↑↓ 章节 · Space 展开收起 · Esc 返回`),
		];
	}

	private startProposalAction(proposal: Proposal): void {
		const actions = this.availableProposalActions(proposal);
		const action = actions[Math.min(this.proposalChoice, actions.length - 1)];
		if (!action) return;
		this.proposalAction = action.id;
		this.proposalInput = "";
		this.proposalError = undefined;
		if (action.id === "approve") {
			this.proposalView = this.strictProposalDigest(proposal) ? "digest" : "confirm";
		} else if (action.id === "reopen") {
			void this.executeProposalAction(proposal, "User reopened deferred proposal");
		} else {
			this.proposalView = "reason";
		}
	}

	private async executeProposalAction(proposal: Proposal, reason: string): Promise<void> {
		this.proposalActing = true;
		this.proposalError = undefined;
		this.tui.requestRender();
		try {
			let notice: string;
			if (this.proposalAction === "approve") {
				const approved = await this.service.approve(proposal.id, proposalApproval(proposal));
				notice = `提案已批准（${approved.status === "kept" ? "已直接生效" : "已进入 Trial"}）：${proposal.id}`;
			} else if (this.proposalAction === "reject") {
				await this.service.reject(proposal.id, reason);
				notice = `提案已拒绝：${proposal.id}`;
			} else if (this.proposalAction === "defer") {
				const deferred = await this.service.defer(proposal.id, reason);
				await recordPermitDefer({
					paths: this.paths,
					proposalId: deferred.id,
					revision: deferred.revision,
					diffDigest: deferred.diffDigest,
					reason,
				});
				notice = `提案已推迟：${proposal.id}`;
			} else {
				const reopened = await this.service.reopen(proposal.id, reason);
				await recordPermitReopen({
					paths: this.paths,
					proposalId: reopened.id,
					revision: reopened.revision,
					diffDigest: reopened.diffDigest,
					reason,
				});
				notice = `提案已重新打开：${proposal.id}`;
			}
			this.mode = "tasks";
			this.itemKey = undefined;
			this.item = undefined;
			this.proposalView = "info";
			this.taskNotice = notice;
			void this.refresh();
		} catch (error) {
			this.proposalError = error instanceof Error ? error.message : String(error);
		} finally {
			this.proposalActing = false;
			this.tui.requestRender();
		}
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
		const toolContent: string[] = [];
		for (const [index, entry] of tools.entries()) {
			toolContent.push(`${index + 1}. ${toolDescription(entry.call)}`);
			if (entry.result) {
				toolContent.push(
					this.theme.fg(
						entry.result.isError ? "error" : "success",
						`   ${entry.result.isError ? "失败" : "完成"}`,
					),
				);
				if (entry.result.text)
					toolContent.push(
						...entry.result.text
							.split("\n")
							.slice(0, 12)
							.map((line) => this.theme.fg("dim", `   ${line}`)),
					);
			} else toolContent.push(this.theme.fg("warning", "   运行中"));
		}
		if (tools.length === 0) toolContent.push("尚无工具调用");
		const outcomeContent: string[] = [];
		if (this.artifacts.plan)
			outcomeContent.push(
				this.theme.fg("success", "✓ 研究计划"),
				...this.artifacts.plan.split("\n").map((line) => `  ${line}`),
			);
		if (this.artifacts.experiment)
			outcomeContent.push(
				this.theme.fg("success", "✓ 冻结实验"),
				...this.artifacts.experiment.split("\n").map((line) => `  ${line}`),
			);
		if (run.proposalId) outcomeContent.push(this.theme.fg("success", "✓ 候选提案"));
		if (this.artifacts.evaluation)
			outcomeContent.push(
				this.theme.fg("success", "✓ 评估报告"),
				...this.artifacts.evaluation.split("\n").map((line) => `  ${line}`),
			);
		if (outcomes.length === 0) outcomeContent.push("当前阶段尚未生成可审阅成果");
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
		this.pushSections(lines, [
			{
				id: "thinking",
				title: "当前思考",
				summary: thinking ? `${thinking.length} 字符` : "尚无输出",
				content: thinking ? thinking.split("\n").map((line) => this.theme.fg("dim", line)) : ["尚无 thinking 输出"],
			},
			{
				id: "tools",
				title: "工具调用",
				summary: tools.length > 0 ? `${tools.length} 次调用` : "尚未调用",
				content: toolContent,
			},
			{
				id: "outcomes",
				title: "阶段成果",
				summary: outcomes.length > 0 ? outcomes.join("、") : "尚无阶段成果",
				content: outcomeContent,
			},
		]);
		if (run.error) lines.push("", this.theme.fg("error", `错误：${run.error}`));
		return lines;
	}

	render(width: number): string[] {
		this.focusedSectionLine = -1;
		const logical = this.mode === "tasks" ? this.taskLines() : this.runLines();
		// Decision controls and key hints stay pinned below the scrollable
		// content so the next action is always visible to the user.
		const pinned = this.pinnedLines().flatMap((line) =>
			wrapTextWithAnsi(line, Math.max(1, width - 2)).map((part) => ` ${part}`),
		);
		const wrapped: string[] = [];
		let selectedStart = 0;
		let selectedEnd = 0;
		let focusedStart = -1;
		for (const [index, line] of logical.entries()) {
			if (this.mode === "tasks" && index === this.selectedTaskLine) selectedStart = wrapped.length;
			if (index === this.focusedSectionLine) focusedStart = wrapped.length;
			for (const part of wrapTextWithAnsi(line, Math.max(1, width - 2))) wrapped.push(` ${part}`);
			if (this.mode === "tasks" && index === this.selectedTaskLine) selectedEnd = wrapped.length;
		}
		const viewport = Math.max(5, this.tui.terminal.rows - 4 - pinned.length);
		const maxStart = Math.max(0, wrapped.length - viewport);
		if (this.mode === "tasks") {
			// The task list is top-anchored and scrolls only as far as needed to
			// keep the selected item visible; the highest-priority items are at
			// the top, so a small terminal must never hide them by default.
			if (selectedEnd > this.taskScrollTop + viewport) this.taskScrollTop = selectedEnd - viewport;
			if (selectedStart < this.taskScrollTop) this.taskScrollTop = selectedStart;
			this.taskScrollTop = Math.min(Math.max(0, this.taskScrollTop), maxStart);
			return [...wrapped.slice(this.taskScrollTop, this.taskScrollTop + viewport), ...pinned];
		}
		let start = Math.max(0, maxStart - this.scrollFromBottom);
		if (this.followFocus && focusedStart >= 0) {
			if (focusedStart < start) start = focusedStart;
			else if (focusedStart >= start + viewport) start = focusedStart - viewport + 1;
			start = Math.min(Math.max(0, start), maxStart);
			this.scrollFromBottom = maxStart - start;
		}
		this.followFocus = false;
		return [...wrapped.slice(start, start + viewport), ...pinned];
	}

	private activateApprovalChoice(choice: number): void {
		if (this.approving) return;
		this.approvalChoice = choice;
		if (choice === 0) this.startComponentApproval({ mode: "canary", customization: "default" });
		else if (choice === 1) this.approvalView = "custom";
		else if (this.proposal?.artifacts.validation) this.approvalView = "direct-confirm";
		else this.approvalError = "直接上线要求通过并绑定可执行 validation artifact";
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
		const proposalTextEntry =
			this.mode === "run" &&
			this.item?.kind === "proposal" &&
			(this.proposalView === "reason" || this.proposalView === "digest");
		if (this.mode === "run" && this.item?.kind === "proposal" && this.proposalView !== "info") {
			if (matchesKey(data, Key.escape)) {
				this.proposalView = "info";
				this.proposalInput = "";
				this.proposalError = undefined;
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.escape) || (data === "q" && !proposalTextEntry)) {
			if (this.mode === "run") {
				this.mode = "tasks";
				this.itemKey = undefined;
				this.item = undefined;
				this.scrollFromBottom = 0;
				this.proposalView = "info";
				this.proposalInput = "";
				this.proposalError = undefined;
			} else this.close();
			this.tui.requestRender();
			return;
		}
		if (this.mode === "tasks") {
			if (matchesKey(data, Key.up)) this.taskIndex = Math.max(0, this.taskIndex - 1);
			else if (matchesKey(data, Key.down))
				this.taskIndex = Math.min(Math.max(0, this.displayItems.length - 1), this.taskIndex + 1);
			else if (matchesKey(data, Key.enter)) {
				const selected = this.displayItems[this.taskIndex];
				if (selected) {
					this.itemKey = selected.key;
					this.item = selected;
					this.run = selected.kind === "run" ? selected.run : undefined;
					this.mode = "run";
					this.taskNotice = undefined;
					this.sectionFocus = 0;
					this.expandedSections = new Set();
					this.followFocus = false;
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
				const proposal = this.item.proposal;
				if (this.proposalView === "reason" || this.proposalView === "digest") {
					if (matchesKey(data, Key.enter)) {
						if (this.proposalActing) return;
						const input = this.proposalInput.trim();
						if (this.proposalView === "digest") {
							if (input !== this.strictProposalDigest(proposal)) {
								this.proposalError = "digest 不匹配；请对照上方需要输入的值";
								this.tui.requestRender();
								return;
							}
							void this.executeProposalAction(proposal, `Approved exact digest ${input}`);
							return;
						}
						if (!input) {
							this.proposalError = "理由不能为空";
							this.tui.requestRender();
							return;
						}
						void this.executeProposalAction(proposal, input);
						return;
					}
					if (matchesKey(data, Key.backspace)) this.proposalInput = this.proposalInput.slice(0, -1);
					else if (!data.startsWith("\u001b")) {
						// Printable characters and pasted chunks; control bytes dropped.
						const clean = data.replace(/[\u0000-\u001f\u007f]/g, "");
						this.proposalInput = `${this.proposalInput}${clean}`.slice(0, 256);
					}
					this.tui.requestRender();
					return;
				}
				if (this.proposalView === "confirm") {
					if (matchesKey(data, Key.enter) && !this.proposalActing) {
						void this.executeProposalAction(proposal, `Approved exact diff ${proposal.diffDigest}`);
					}
					this.tui.requestRender();
					return;
				}
				const actions = this.availableProposalActions(proposal);
				if (matchesKey(data, Key.left)) this.proposalChoice = Math.max(0, this.proposalChoice - 1);
				else if (matchesKey(data, Key.right)) {
					this.proposalChoice = Math.min(Math.max(0, actions.length - 1), this.proposalChoice + 1);
				} else if (matchesKey(data, Key.up)) this.moveSectionFocus(-1);
				else if (matchesKey(data, Key.down)) this.moveSectionFocus(1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				else if (matchesKey(data, Key.tab)) this.focusNextSection();
				else if (matchesKey(data, Key.space)) this.toggleFocusedSection();
				else if (matchesKey(data, Key.enter) && !this.proposalActing) {
					if (actions.length > 0) this.startProposalAction(proposal);
					else this.toggleFocusedSection();
				} else if (data.length === 1 && !data.startsWith("\u001b") && !this.proposalActing) {
					const hotkeyIndex = actions.findIndex((action) => PROPOSAL_ACTION_HOTKEYS[action.id] === data);
					if (hotkeyIndex >= 0) {
						this.proposalChoice = hotkeyIndex;
						this.startProposalAction(proposal);
					}
				}
				this.tui.requestRender();
				return;
			}
			if (this.run?.status === "trialing" && this.item?.component) {
				if (matchesKey(data, Key.up)) this.scrollFromBottom++;
				else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				else if (matchesKey(data, Key.tab)) this.focusNextSection();
				else if (matchesKey(data, Key.space)) this.toggleFocusedSection();
				else if (matchesKey(data, Key.enter) && !this.keeping) {
					if (this.keepConfirming) this.startDirectKeep();
					else this.keepConfirming = true;
				}
				this.tui.requestRender();
				return;
			}
			if (this.run?.status === "awaiting-evidence" && this.pendingVerification) {
				if (matchesKey(data, Key.left)) this.verificationChoice = Math.max(0, this.verificationChoice - 1);
				else if (matchesKey(data, Key.right)) this.verificationChoice = Math.min(2, this.verificationChoice + 1);
				else if (matchesKey(data, Key.up)) this.scrollFromBottom++;
				else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
				else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
				else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
				else if (matchesKey(data, Key.tab)) this.focusNextSection();
				else if (matchesKey(data, Key.space)) this.toggleFocusedSection();
				else if (matchesKey(data, Key.enter)) {
					this.startVerificationDecision(
						this.verificationChoice === 0 ? "execute" : this.verificationChoice === 1 ? "skip" : "reject",
					);
				} else if (data === "e" || data === "s" || data === "r") {
					this.verificationChoice = data === "e" ? 0 : data === "s" ? 1 : 2;
					this.startVerificationDecision(data === "e" ? "execute" : data === "s" ? "skip" : "reject");
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
				else if (matchesKey(data, Key.tab)) this.focusNextSection();
				else if (matchesKey(data, Key.space)) this.toggleFocusedSection();
				else if (matchesKey(data, Key.enter)) this.activateApprovalChoice(this.approvalChoice);
				else if (data === "c" || data === "u" || data === "x") {
					this.activateApprovalChoice(data === "c" ? 0 : data === "u" ? 1 : 2);
				}
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) this.scrollFromBottom++;
			else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
			else if (matchesKey(data, Key.tab)) this.focusNextSection();
			else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) this.toggleFocusedSection();
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
