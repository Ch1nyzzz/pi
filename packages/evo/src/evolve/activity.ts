import { loadCompiledBundle } from "../bundle/compile.ts";
import { buildTrialComparison } from "../comparison.ts";
import type { EvoPaths } from "../paths.ts";
import { readScheduleConfig } from "../scheduler.ts";
import type { EvoService } from "../service.ts";
import type { EvolutionRun, Proposal } from "../types.ts";
import { listEvolutionRuns } from "./run.ts";
import { readPendingVerification } from "./verification-decision.ts";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type EvoActivityItem =
	| {
			key: string;
			kind: "run";
			text: string;
			run: EvolutionRun;
			proposal?: Proposal;
			component?: string;
			/** The run is parked on a recommended-verification execute/skip/reject decision. */
			pendingVerification?: boolean;
	  }
	| { key: string; kind: "proposal"; text: string; proposal: Proposal; component?: string };

/** What the user should do with an item next: decide, watch, or nothing. */
export type EvoActivityGroup = "action" | "running" | "history";

export function activityGroup(item: EvoActivityItem): EvoActivityGroup {
	if (item.kind === "proposal") {
		const status = item.proposal.status;
		return status === "pending" || status === "deferred" ? "action" : "running";
	}
	const status = item.run.status;
	if (status === "awaiting-canary-approval" || status === "awaiting-decision") return "action";
	if (status === "awaiting-evidence" && item.pendingVerification) return "action";
	return TERMINAL_RUN_STATUSES.has(status) ? "history" : "running";
}

/** Stable-reorder items: decisions first, then live work, then history. */
export function groupActivityItems(items: EvoActivityItem[]): EvoActivityItem[] {
	const rank: Record<EvoActivityGroup, number> = { action: 0, running: 1, history: 2 };
	return items
		.map((item, index) => ({ item, index }))
		.sort(
			(left, right) => rank[activityGroup(left.item)] - rank[activityGroup(right.item)] || left.index - right.index,
		)
		.map((entry) => entry.item);
}

function compact(value: string, maxLength = 54): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export async function componentNameForProposal(paths: EvoPaths, proposal: Proposal): Promise<string | undefined> {
	if (!proposal.candidateDigest || !proposal.targetAbi) return undefined;
	const [parent, candidate] = await Promise.all([
		loadCompiledBundle(paths, proposal.parentBundleDigest),
		loadCompiledBundle(paths, proposal.candidateDigest),
	]);
	for (const [surface, selection] of Object.entries(candidate.policy.components ?? {})) {
		if (
			selection.abi === proposal.targetAbi &&
			JSON.stringify(selection) !== JSON.stringify(parent.policy.components?.[surface])
		) {
			return selection.id;
		}
	}
	return undefined;
}

function runStatusLabel(run: EvolutionRun): string {
	return (
		{
			queued: "等待执行",
			researching: "研究中",
			planned: "计划已冻结",
			building: "构建候选",
			validating: "确定性验证",
			replaying: "历史回放",
			evaluating: "独立评估",
			"awaiting-evidence": "等待实验数据",
			"awaiting-canary-approval": "等待 Canary 确认",
			trialing: "Canary 运行中",
			"awaiting-decision": "等待最终决定",
			paused: "已暂停",
			completed: "已完成",
			failed: "执行失败",
			cancelled: "已取消",
		}[run.status] ?? run.status
	);
}

interface TrialDisplay {
	due: boolean;
	currentSessions: number;
	minimumSessions: number;
	maximumDurationDays: number;
}

function componentLabel(proposal: Proposal | undefined, component: string): string {
	const surface = proposal?.targetAbi?.split("/", 1)[0] ?? "component";
	const short = component.endsWith(`-${surface}`) ? component.slice(0, -surface.length - 1) : component;
	return `${surface}/${short}`;
}

function canaryStateText(proposal: Proposal | undefined, trial: TrialDisplay | undefined, noun: string): string {
	if (proposal?.artifacts.retrospective) return "comparison ready";
	if (trial?.due) return "comparison pending";
	return trial ? `${noun} ${trial.currentSessions}/${trial.minimumSessions}` : `${noun} 运行中`;
}

function runText(
	run: EvolutionRun,
	component: string | undefined,
	proposal: Proposal | undefined,
	trial: TrialDisplay | undefined,
	pendingVerification = false,
): string {
	if (component && run.status === "trialing") {
		const bound = trial ? ` · ≤${trial.maximumDurationDays}d` : "";
		return `Evo: ${canaryStateText(proposal, trial, "Canary")} · ${componentLabel(proposal, component)}${bound}`;
	}
	if (component && run.status === "awaiting-canary-approval") {
		return `Evo: 等待发布确认 · ${componentLabel(proposal, component)}`;
	}
	if (run.status === "awaiting-evidence" && pendingVerification) {
		return `Evo: 等待验证决策 · ${compact(run.request ?? "定时演化", 48)}`;
	}
	return `Evo: ${runStatusLabel(run)} · ${compact(run.request ?? "定时演化", 48)}`;
}

function proposalText(proposal: Proposal, component: string | undefined, trial: TrialDisplay | undefined): string {
	if (component && proposal.status === "trialing") {
		const bound = trial ? ` · ≤${trial.maximumDurationDays}d` : "";
		return `Evo: ${canaryStateText(proposal, trial, "Canary")} · ${componentLabel(proposal, component)}${bound}`;
	}
	if (proposal.status === "trialing") {
		return `Evo: ${canaryStateText(proposal, trial, "Trial")} · ${compact(proposal.motivation, 48)}`;
	}
	const status = proposal.status === "deferred" ? "已推迟" : "等待处理";
	return `Evo: ${status} · ${compact(proposal.motivation, 48)}`;
}

export async function listEvoActivityItems(
	dependencies: { paths: EvoPaths; service: EvoService },
	options: { includeHistory?: boolean; includeTrialComparison?: boolean; now?: () => Date } = {},
): Promise<EvoActivityItem[]> {
	const [runs, proposals, status] = await Promise.all([
		listEvolutionRuns(dependencies.paths),
		dependencies.service.listProposals(),
		dependencies.service.status(),
	]);
	const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
	const componentNames = new Map<string, string | undefined>();
	const componentName = async (proposal: Proposal | undefined): Promise<string | undefined> => {
		if (!proposal) return undefined;
		if (!componentNames.has(proposal.id)) {
			componentNames.set(proposal.id, await componentNameForProposal(dependencies.paths, proposal));
		}
		return componentNames.get(proposal.id);
	};
	const visibleRuns = options.includeHistory ? runs : runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
	let trialDisplay: TrialDisplay | undefined;
	if (status.trial) {
		const trialProposal = proposalById.get(status.trial.proposalId);
		if (trialProposal) {
			const [schedule, comparison] = await Promise.all([
				readScheduleConfig(dependencies.paths),
				buildTrialComparison(dependencies.paths, trialProposal, status.trial),
			]);
			const maximumDurationDays = status.trial.canary?.maximumDurationDays ?? schedule.trialDueAfterDays;
			const minimumSessions = status.trial.canary?.minimumSamples ?? schedule.trialDueAfterSessions;
			const dueAt = Date.parse(status.trial.startedAt) + maximumDurationDays * 24 * 60 * 60 * 1_000;
			trialDisplay = {
				due:
					trialProposal.artifacts.retrospective !== undefined ||
					(Number.isFinite(dueAt) && (options.now ?? (() => new Date()))().getTime() >= dueAt) ||
					comparison.after.totals.sessions >= minimumSessions,
				currentSessions: comparison.after.totals.sessions,
				minimumSessions,
				maximumDurationDays,
			};
		}
	}
	const items: EvoActivityItem[] = [];
	const linkedProposalIds = new Set<string>();
	for (const run of visibleRuns) {
		const proposal = run.proposalId ? proposalById.get(run.proposalId) : undefined;
		if (proposal && !TERMINAL_RUN_STATUSES.has(run.status)) linkedProposalIds.add(proposal.id);
		const component = await componentName(proposal);
		const pendingVerification =
			run.status === "awaiting-evidence" &&
			(await readPendingVerification(dependencies.paths, run.id)) !== undefined;
		items.push({
			key: `run:${run.id}`,
			kind: "run",
			text: runText(
				run,
				component,
				proposal,
				proposal?.id === status.trial?.proposalId ? trialDisplay : undefined,
				pendingVerification,
			),
			run,
			...(proposal ? { proposal } : {}),
			...(component ? { component } : {}),
			...(pendingVerification ? { pendingVerification: true } : {}),
		});
	}
	for (const proposal of proposals) {
		if (linkedProposalIds.has(proposal.id)) continue;
		if (proposal.status !== "pending" && proposal.status !== "deferred" && proposal.status !== "trialing") continue;
		const component = await componentName(proposal);
		items.push({
			key: `proposal:${proposal.id}`,
			kind: "proposal",
			text: proposalText(proposal, component, proposal.id === status.trial?.proposalId ? trialDisplay : undefined),
			proposal,
			...(component ? { component } : {}),
		});
	}
	return items.sort((left, right) => {
		const priority = (item: EvoActivityItem): number => {
			const status = item.kind === "run" ? item.run.status : item.proposal.status;
			if (status === "trialing") return 0;
			if (status === "awaiting-canary-approval") return 1;
			if (item.kind === "run" && item.pendingVerification) return 1;
			if (item.kind === "run" && !TERMINAL_RUN_STATUSES.has(item.run.status)) return 2;
			if (status === "pending" || status === "deferred") return 3;
			return 4;
		};
		return priority(left) - priority(right);
	});
}
