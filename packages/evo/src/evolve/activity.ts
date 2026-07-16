import { loadCompiledBundle } from "../bundle/compile.ts";
import { buildTrialComparison } from "../comparison.ts";
import type { EvoPaths } from "../paths.ts";
import { readScheduleConfig } from "../scheduler.ts";
import type { EvoService } from "../service.ts";
import type { EvolutionRun, Proposal } from "../types.ts";
import { listEvolutionRuns } from "./run.ts";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type EvoActivityItem =
	| { key: string; kind: "run"; text: string; run: EvolutionRun; proposal?: Proposal; component?: string }
	| { key: string; kind: "proposal"; text: string; proposal: Proposal; component?: string };

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

function runText(
	run: EvolutionRun,
	component: string | undefined,
	proposal: Proposal | undefined,
	trialDue: boolean,
): string {
	if (component && run.status === "trialing") {
		const state = proposal?.artifacts.retrospective
			? "Canary comparison ready"
			: trialDue
				? "Canary comparison pending"
				: "Canary 运行中";
		return `Evo: ${component} · ${state}`;
	}
	if (component && run.status === "awaiting-canary-approval") return `Evo: ${component} · 等待 Canary 确认`;
	return `Evo: ${runStatusLabel(run)} · ${compact(run.request ?? "定时演化")}`;
}

function proposalText(proposal: Proposal, component: string | undefined, trialDue: boolean): string {
	if (component && proposal.status === "trialing") {
		const status = proposal.artifacts.retrospective
			? "Canary comparison ready"
			: trialDue
				? "Canary comparison pending"
				: "Canary 运行中";
		return `Evo: ${component} · ${status}`;
	}
	if (proposal.status === "trialing") {
		const status = proposal.artifacts.retrospective
			? "Trial comparison ready"
			: trialDue
				? "Trial comparison pending"
				: "Trial 运行中";
		return `Evo: ${status} · ${compact(proposal.motivation)}`;
	}
	const status = proposal.status === "deferred" ? "已推迟" : "等待处理";
	return `Evo: ${status} · ${compact(proposal.motivation)}`;
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
	let trialDue = false;
	if (status.trial && options.includeTrialComparison !== false) {
		const trialProposal = proposalById.get(status.trial.proposalId);
		if (trialProposal && !trialProposal.artifacts.retrospective) {
			const [schedule, comparison] = await Promise.all([
				readScheduleConfig(dependencies.paths),
				buildTrialComparison(dependencies.paths, trialProposal, status.trial),
			]);
			const dueAt = Date.parse(status.trial.startedAt) + schedule.trialDueAfterDays * 24 * 60 * 60 * 1_000;
			trialDue =
				(Number.isFinite(dueAt) && (options.now ?? (() => new Date()))().getTime() >= dueAt) ||
				comparison.after.totals.sessions >= schedule.trialDueAfterSessions;
		}
	}
	const items: EvoActivityItem[] = [];
	const linkedProposalIds = new Set<string>();
	for (const run of visibleRuns) {
		const proposal = run.proposalId ? proposalById.get(run.proposalId) : undefined;
		if (proposal) linkedProposalIds.add(proposal.id);
		const component = await componentName(proposal);
		items.push({
			key: `run:${run.id}`,
			kind: "run",
			text: runText(run, component, proposal, trialDue && proposal?.id === status.trial?.proposalId),
			run,
			...(proposal ? { proposal } : {}),
			...(component ? { component } : {}),
		});
	}
	for (const proposal of proposals) {
		if (linkedProposalIds.has(proposal.id)) continue;
		if (proposal.status !== "pending" && proposal.status !== "deferred" && proposal.status !== "trialing") continue;
		const component = await componentName(proposal);
		items.push({
			key: `proposal:${proposal.id}`,
			kind: "proposal",
			text: proposalText(proposal, component, trialDue && proposal.id === status.trial?.proposalId),
			proposal,
			...(component ? { component } : {}),
		});
	}
	return items.sort((left, right) => {
		const priority = (item: EvoActivityItem): number => {
			const status = item.kind === "run" ? item.run.status : item.proposal.status;
			if (status === "trialing") return 0;
			if (status === "awaiting-canary-approval") return 1;
			if (item.kind === "run" && !TERMINAL_RUN_STATUSES.has(item.run.status)) return 2;
			if (status === "pending" || status === "deferred") return 3;
			return 4;
		};
		return priority(left) - priority(right);
	});
}
