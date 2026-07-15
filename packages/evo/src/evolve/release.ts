import { proposalApproval } from "../proposal.ts";
import type { EvoService } from "../service.ts";
import type { EvoControlConfig, EvoEvidenceStrategy, Proposal } from "../types.ts";
import type { ProfileReceipt } from "./check-profiles.ts";
import type { EvolutionEvaluationVerdict } from "./evaluator.ts";

export type EvolutionReleaseAction =
	| "applied"
	| "trial"
	| "awaiting-canary-approval"
	| "needs-evidence"
	| "rejected"
	| "review";

export interface EvolutionReleaseResult {
	action: EvolutionReleaseAction;
	proposal: Proposal;
	reason: string;
}

/** Canonical run status for each release action; shared by the cycle and evidence resumption. */
export const RELEASE_ACTION_RUN_STATUS = {
	"awaiting-canary-approval": "awaiting-canary-approval",
	"needs-evidence": "awaiting-evidence",
	trial: "trialing",
	review: "awaiting-decision",
	applied: "completed",
	rejected: "completed",
} as const satisfies Record<EvolutionReleaseAction, string>;

export function changesComponentSelection(proposal: Proposal): boolean {
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
	evidenceStrategy: EvoEvidenceStrategy;
	/** Execution receipts written by the code that ran each check. */
	receipts: ReadonlyMap<ProfileReceipt["profile"], ProfileReceipt>;
}): Promise<EvolutionReleaseResult> {
	const { proposal, verdict, config, service } = options;
	if (verdict === "unsupported" || verdict === "invalid") {
		const rejected = await service.reject(
			proposal.id,
			verdict === "invalid"
				? "Autonomous validation found the candidate or frozen experiment invalid"
				: "Executed comparative evidence found the frozen experiment unsupported",
		);
		return { action: "rejected", proposal: rejected, reason: `Evaluator verdict was ${verdict}` };
	}
	const requiredProfiles = [
		...(options.evidenceStrategy.offline.mode === "required" ? options.evidenceStrategy.offline.profiles : []),
		...(options.evidenceStrategy.historicalReplay.mode === "required"
			? options.evidenceStrategy.historicalReplay.profiles
			: []),
	];
	const missingProfiles = requiredProfiles.filter((profile) => options.receipts.get(profile)?.passed !== true);
	if (missingProfiles.length > 0) {
		return {
			action: "needs-evidence",
			proposal,
			reason: `Required evidence profiles have no passing execution receipt: ${missingProfiles.join(", ")}`,
		};
	}
	if (options.evidenceStrategy.rollout === "shadow-first") {
		return {
			action: "needs-evidence",
			proposal,
			reason: "The frozen evidence strategy requires shadow execution before release",
		};
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
		if (verdict === "verified" && config.release.autoApplyT0) {
			const approved = await service.approve(proposal.id, proposalApproval(proposal));
			return { action: "applied", proposal: approved, reason: "Standing policy allowed verified T0" };
		}
		return { action: "review", proposal, reason: "T0 automatic application is disabled or evidence is uncertain" };
	}
	const component = changesComponentSelection(proposal);
	if (component) {
		if (options.evidenceStrategy.online.mode !== "canary") {
			return {
				action: "needs-evidence",
				proposal,
				reason: "Component activation requires a bounded Canary evidence strategy",
			};
		}
		return config.release.autoStartComponentTrial
			? {
					action: "awaiting-canary-approval",
					proposal,
					reason: "Component Canary is enabled and requires explicit Enter confirmation",
				}
			: {
					action: "review",
					proposal,
					reason: "Component Canary is disabled by local release policy",
				};
	}
	if (config.release.autoStartDataTrial) {
		const approved = await service.approve(proposal.id, proposalApproval(proposal));
		return {
			action: "trial",
			proposal: approved,
			reason: "Standing policy started a data trial",
		};
	}
	return {
		action: verdict === "needs-evidence" ? "needs-evidence" : "review",
		proposal,
		reason:
			verdict === "needs-evidence"
				? "The valid candidate is waiting for replay or trial evidence"
				: "Automatic data trials are disabled",
	};
}
