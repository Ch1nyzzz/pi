import { proposalApproval } from "../proposal.ts";
import type { EvoService } from "../service.ts";
import type { EvoControlConfig, Proposal } from "../types.ts";
import type { EvolutionEvaluationVerdict } from "./evaluator.ts";

export type EvolutionReleaseAction = "applied" | "trial" | "rejected" | "review";

export interface EvolutionReleaseResult {
	action: EvolutionReleaseAction;
	proposal: Proposal;
	reason: string;
}

function changesComponentSelection(proposal: Proposal): boolean {
	return proposal.kind === "data" && proposal.changedPaths.includes("policy.json") && proposal.targetAbi !== undefined;
}

/**
 * Deterministic standing policy. Models supply evidence and a bounded verdict,
 * but cannot write registry pointers themselves.
 */
export async function applyEvolutionReleasePolicy(options: {
	service: EvoService;
	config: EvoControlConfig;
	proposal: Proposal;
	verdict: EvolutionEvaluationVerdict;
}): Promise<EvolutionReleaseResult> {
	const { proposal, verdict, config, service } = options;
	if (verdict === "unsupported") {
		const rejected = await service.reject(
			proposal.id,
			"Autonomous evaluator found the frozen experiment unsupported",
		);
		return { action: "rejected", proposal: rejected, reason: "Evaluator verdict was unsupported" };
	}
	if (proposal.requiresNewAbi) {
		return {
			action: "review",
			proposal,
			reason: "New ABI and host-seam proposals always require explicit human review",
		};
	}
	if (proposal.kind === "code") {
		return {
			action: "review",
			proposal,
			reason: "Arbitrary code proposals remain isolated for human integration",
		};
	}
	if (proposal.tier === "T0") {
		if (verdict === "supported" && config.release.autoApplyT0) {
			const approved = await service.approve(proposal.id, proposalApproval(proposal));
			return { action: "applied", proposal: approved, reason: "Standing policy allowed supported T0" };
		}
		return { action: "review", proposal, reason: "T0 automatic application is disabled or evidence is uncertain" };
	}
	const component = changesComponentSelection(proposal);
	const allowed = component ? config.release.autoStartComponentTrial : config.release.autoStartDataTrial;
	if (allowed) {
		const approved = await service.approve(proposal.id, proposalApproval(proposal));
		return {
			action: "trial",
			proposal: approved,
			reason: component ? "Standing policy started a component trial" : "Standing policy started a data trial",
		};
	}
	return {
		action: "review",
		proposal,
		reason: component ? "Automatic component trials are disabled" : "Automatic data trials are disabled",
	};
}
