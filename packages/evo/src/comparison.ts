import type { EvoPaths } from "./paths.ts";
import { loadProposal, saveProposal } from "./proposal.ts";
import { readEvaluationArtifact, saveProposalRevisionSnapshot, writeComparisonArtifact } from "./proposal-artifacts.ts";
import {
	listSessionDigests,
	type SessionDigest,
	type SessionDigestMetrics,
	type SessionTaskClass,
} from "./recorder/digest.ts";
import { canonicalJson, sha256 } from "./storage.ts";
import type { EvaluationArtifactRef, Proposal, TrialState } from "./types.ts";

export interface ComparisonRates {
	toolErrorRate: number | null;
	verificationPassRate: number | null;
	assistantTurnsPerTask: number | null;
	followUpsPerTask: number | null;
	tokensPerTask: number | null;
}

export interface ComparisonTotals extends SessionDigestMetrics {
	sessions: number;
}

export interface ComparisonCohort {
	bundleDigest: string;
	sessions: Array<{ sessionId: string; sourceDigest: string; taskClass: SessionTaskClass }>;
	totals: ComparisonTotals;
	rates: ComparisonRates;
}

export interface TrialComparison {
	schemaVersion: 1;
	proposalId: string;
	revision: number;
	diffDigest: string;
	generatedAt: string;
	trialStartedAt: string;
	change: {
		changedPaths: string[];
		expectedEffect: string;
	};
	matching: {
		taskClasses: SessionTaskClass[];
		excludedBeforeSessions: number;
	};
	sufficiency: {
		status: "sufficient" | "insufficient";
		minimumSessionsPerCohort: number;
		reasons: string[];
	};
	before: ComparisonCohort;
	after: ComparisonCohort;
	delta: ComparisonRates;
	evidenceDigest: string;
}

export interface StoredTrialComparison {
	comparison: TrialComparison;
	proposal: Proposal;
	reference: EvaluationArtifactRef;
	reused: boolean;
}

function emptyMetrics(): SessionDigestMetrics {
	return {
		tasks: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolResults: 0,
		followUpUserMessages: 0,
		toolCalls: 0,
		toolErrors: 0,
		toolDurationMs: 0,
		verificationRuns: 0,
		verificationPassed: 0,
		verificationFailed: 0,
		preferenceSignals: 0,
		compactions: 0,
		compactionRetries: 0,
		compactionDurationMs: 0,
		compactionTokensBefore: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	};
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator > 0 ? numerator / denominator : null;
}

function aggregateCohort(bundleDigest: string, sessions: SessionDigest[]): ComparisonCohort {
	const metrics = emptyMetrics();
	for (const session of sessions) {
		for (const key of [
			"tasks",
			"userMessages",
			"assistantMessages",
			"toolResults",
			"followUpUserMessages",
			"toolCalls",
			"toolErrors",
			"toolDurationMs",
			"verificationRuns",
			"verificationPassed",
			"verificationFailed",
			"preferenceSignals",
			"compactions",
			"compactionRetries",
			"compactionDurationMs",
			"compactionTokensBefore",
		] as const) {
			metrics[key] += session.metrics[key];
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			metrics.usage[key] += session.metrics.usage[key];
		}
	}
	return {
		bundleDigest,
		sessions: sessions.map(({ sessionId, sourceDigest, taskClass }) => ({ sessionId, sourceDigest, taskClass })),
		totals: { sessions: sessions.length, ...metrics },
		rates: {
			toolErrorRate: ratio(metrics.toolErrors, metrics.toolCalls),
			verificationPassRate: ratio(metrics.verificationPassed, metrics.verificationRuns),
			assistantTurnsPerTask: ratio(metrics.assistantMessages, metrics.tasks),
			followUpsPerTask: ratio(metrics.followUpUserMessages, metrics.tasks),
			tokensPerTask: ratio(metrics.usage.totalTokens, metrics.tasks),
		},
	};
}

function subtract(after: number | null, before: number | null): number | null {
	return after === null || before === null ? null : after - before;
}

export function trialEvidenceDigest(corpusDigest: string, comparisonDigest: string): string {
	return sha256(canonicalJson({ trialEvidenceSchemaVersion: 1, corpusDigest, comparisonDigest }));
}

function comparisonSufficiency(before: ComparisonCohort, after: ComparisonCohort) {
	const minimumSessionsPerCohort = 3;
	const reasons: string[] = [];
	if (before.totals.sessions < minimumSessionsPerCohort) {
		reasons.push(`baseline has ${before.totals.sessions}/${minimumSessionsPerCohort} required sessions`);
	}
	if (after.totals.sessions < minimumSessionsPerCohort) {
		reasons.push(`candidate has ${after.totals.sessions}/${minimumSessionsPerCohort} required sessions`);
	}
	return {
		status: reasons.length === 0 ? ("sufficient" as const) : ("insufficient" as const),
		minimumSessionsPerCohort,
		reasons,
	};
}

function formatRate(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(3);
}

export function renderTrialComparisonMarkdown(comparison: TrialComparison): string {
	const rows: Array<[string, number | null, number | null, number | null]> = [
		[
			"Tool error rate",
			comparison.before.rates.toolErrorRate,
			comparison.after.rates.toolErrorRate,
			comparison.delta.toolErrorRate,
		],
		[
			"Verification pass rate",
			comparison.before.rates.verificationPassRate,
			comparison.after.rates.verificationPassRate,
			comparison.delta.verificationPassRate,
		],
		[
			"Assistant turns / task",
			comparison.before.rates.assistantTurnsPerTask,
			comparison.after.rates.assistantTurnsPerTask,
			comparison.delta.assistantTurnsPerTask,
		],
		[
			"Follow-ups / task",
			comparison.before.rates.followUpsPerTask,
			comparison.after.rates.followUpsPerTask,
			comparison.delta.followUpsPerTask,
		],
		[
			"Tokens / task",
			comparison.before.rates.tokensPerTask,
			comparison.after.rates.tokensPerTask,
			comparison.delta.tokensPerTask,
		],
	];
	return [
		"# Automatic trial comparison",
		"",
		`- Proposal: ${comparison.proposalId} revision ${comparison.revision}`,
		`- Evidence: ${comparison.evidenceDigest}`,
		`- Trial started: ${comparison.trialStartedAt}`,
		`- Generated: ${comparison.generatedAt}`,
		`- Evidence status: **${comparison.sufficiency.status}**`,
		...comparison.sufficiency.reasons.map((reason) => `  - ${reason}`),
		"",
		"## Change",
		"",
		`Expected effect: ${comparison.change.expectedEffect}`,
		"",
		...comparison.change.changedPaths.map((path) => `- \`${path}\``),
		"",
		"## Automatic cohort matching",
		"",
		`Candidate task classes: ${comparison.matching.taskClasses.join(", ") || "none yet"}`,
		`Excluded non-matching baseline sessions: ${comparison.matching.excludedBeforeSessions}`,
		`Baseline sessions: ${comparison.before.totals.sessions}; candidate sessions: ${comparison.after.totals.sessions}`,
		"",
		"## Deterministic metrics",
		"",
		"| Metric | Before | After | Delta (after - before) |",
		"| --- | ---: | ---: | ---: |",
		...rows.map(
			([label, before, after, delta]) =>
				`| ${label} | ${formatRate(before)} | ${formatRate(after)} | ${formatRate(delta)} |`,
		),
		"",
	].join("\n");
}

export async function buildTrialComparison(
	paths: EvoPaths,
	proposal: Proposal,
	trial: TrialState,
): Promise<TrialComparison> {
	const digests = (await listSessionDigests(paths)).filter((digest) => digest.assessment.comparisonEligible);
	const eligibleBeforeSessions = digests.filter(
		(digest) => digest.bundleDigest === trial.parent && (digest.endedAt ?? "") < trial.startedAt,
	);
	const afterSessions = digests.filter(
		(digest) => digest.bundleDigest === trial.digest && (digest.startedAt ?? "") >= trial.startedAt,
	);
	const taskClasses = [...new Set(afterSessions.map((digest) => digest.taskClass))].sort();
	const beforeSessions =
		taskClasses.length === 0
			? eligibleBeforeSessions
			: eligibleBeforeSessions.filter((digest) => taskClasses.includes(digest.taskClass));
	const before = aggregateCohort(trial.parent, beforeSessions);
	const after = aggregateCohort(trial.digest, afterSessions);
	const generatedAt = [...beforeSessions, ...afterSessions].reduce(
		(cutoff, digest) => (digest.endedAt && digest.endedAt > cutoff ? digest.endedAt : cutoff),
		trial.startedAt,
	);
	const evidenceDigest = sha256(
		canonicalJson({
			comparisonSchemaVersion: 1,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			before: before.sessions,
			after: after.sessions,
		}),
	);
	return {
		schemaVersion: 1,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		generatedAt,
		trialStartedAt: trial.startedAt,
		change: {
			changedPaths: proposal.changedPaths,
			expectedEffect: proposal.expectedEffect,
		},
		matching: {
			taskClasses,
			excludedBeforeSessions: eligibleBeforeSessions.length - beforeSessions.length,
		},
		sufficiency: comparisonSufficiency(before, after),
		before,
		after,
		delta: {
			toolErrorRate: subtract(after.rates.toolErrorRate, before.rates.toolErrorRate),
			verificationPassRate: subtract(after.rates.verificationPassRate, before.rates.verificationPassRate),
			assistantTurnsPerTask: subtract(after.rates.assistantTurnsPerTask, before.rates.assistantTurnsPerTask),
			followUpsPerTask: subtract(after.rates.followUpsPerTask, before.rates.followUpsPerTask),
			tokensPerTask: subtract(after.rates.tokensPerTask, before.rates.tokensPerTask),
		},
		evidenceDigest,
	};
}

export async function storeTrialComparison(
	paths: EvoPaths,
	proposal: Proposal,
	trial: TrialState,
	now: () => Date = () => new Date(),
): Promise<StoredTrialComparison> {
	const comparison = await buildTrialComparison(paths, proposal, trial);
	const existing = proposal.artifacts.comparison;
	if (existing?.evidence?.digest === comparison.evidenceDigest) {
		const content = await readEvaluationArtifact({
			paths,
			proposalId: proposal.id,
			revision: proposal.revision,
			diffDigest: proposal.diffDigest,
			kind: "comparison",
			reference: existing,
		});
		return { comparison: JSON.parse(content) as TrialComparison, proposal, reference: existing, reused: true };
	}
	const content = `${canonicalJson(comparison)}\n`;
	const reference = await writeComparisonArtifact({
		paths,
		proposalId: proposal.id,
		revision: proposal.revision,
		diffDigest: proposal.diffDigest,
		content,
		markdownContent: renderTrialComparisonMarkdown(comparison),
		evidenceDigest: comparison.evidenceDigest,
		evidenceCutoff: comparison.generatedAt,
		now,
	});
	const current = await loadProposal(paths, proposal.id);
	current.artifacts.comparison = reference;
	await saveProposal(paths, current);
	await saveProposalRevisionSnapshot(paths, current);
	return { comparison, proposal: current, reference, reused: false };
}

// ============================================================================
// Trial contract: the measurable metric registry and its deterministic gates.
// A plan may only promise metrics this module actually measures, and keep /
// rollback decisions compare measured deltas against the frozen minimum effect.
// ============================================================================

export const TRIAL_METRIC_DIRECTIONS = {
	toolErrorRate: "lower",
	verificationPassRate: "higher",
	assistantTurnsPerTask: "lower",
	followUpsPerTask: "lower",
	tokensPerTask: "lower",
} as const satisfies Record<keyof ComparisonRates, "lower" | "higher">;

export type TrialMetricName = keyof typeof TRIAL_METRIC_DIRECTIONS;

export function isTrialMetricName(value: string): value is TrialMetricName {
	return value in TRIAL_METRIC_DIRECTIONS;
}

export function parseTrialDurationDays(value: string): number | undefined {
	const match = /^([1-9]\d*)d$/.exec(value.trim());
	return match ? Number(match[1]) : undefined;
}

interface TrialContract {
	primaryMetric?: string;
	minimumEffect: Record<string, number>;
}

/** Signed improvement of a delta under the metric's direction (positive = better). */
function improvement(metric: TrialMetricName, delta: number): number {
	return TRIAL_METRIC_DIRECTIONS[metric] === "lower" ? -delta : delta;
}

export interface TrialContractGate {
	allowed: boolean;
	reasons: string[];
}

export interface ContractMetricRegression {
	metric: TrialMetricName;
	primary: boolean;
	reason: string;
}

/**
 * Every frozen-contract metric regression: the primary metric plus each other
 * pre-registered metric in minimumEffect acts as a guardrail. A regression at
 * least as large as a metric's frozen minimum effect fires, so a proposal that
 * improves its primary metric while tanking a guardrail still gets caught.
 */
export function contractMetricRegressions(
	contract: TrialContract | undefined,
	comparison: TrialComparison,
): ContractMetricRegression[] {
	if (!contract) return [];
	const regressions: ContractMetricRegression[] = [];
	for (const [metric, threshold] of Object.entries(contract.minimumEffect)) {
		if (!isTrialMetricName(metric) || !threshold || threshold <= 0) continue;
		const delta = comparison.delta[metric];
		if (delta === null) continue;
		if (improvement(metric, delta) <= -threshold) {
			const primary = metric === contract.primaryMetric;
			regressions.push({
				metric,
				primary,
				reason: `${primary ? "primary" : "guardrail"} metric ${metric} regressed by ${(-improvement(metric, delta)).toFixed(4)} (frozen minimum effect ${threshold})`,
			});
		}
	}
	return regressions;
}

/**
 * Deterministic keep-gate: sufficiency must hold, the primary metric must have
 * improved by at least the frozen minimum effect, and no pre-registered
 * guardrail metric may have regressed beyond its own frozen effect size. Model
 * recommendations can veto a keep but can never substitute for this gate.
 */
export function evaluateTrialContractGate(
	contract: TrialContract | undefined,
	comparison: TrialComparison,
): TrialContractGate {
	const reasons: string[] = [];
	if (comparison.sufficiency.status !== "sufficient") {
		reasons.push(`comparison evidence is insufficient: ${comparison.sufficiency.reasons.join("; ") || "unknown"}`);
	}
	const primary = contract?.primaryMetric;
	if (primary && isTrialMetricName(primary)) {
		const delta = comparison.delta[primary];
		const threshold = contract.minimumEffect[primary] ?? 0;
		if (delta === null) {
			reasons.push(`primary metric ${primary} has no measurement in either cohort`);
		} else if (improvement(primary, delta) < threshold) {
			reasons.push(
				`primary metric ${primary} improved by ${improvement(primary, delta).toFixed(4)}, below the frozen minimum effect ${threshold}`,
			);
		}
	}
	for (const regression of contractMetricRegressions(contract, comparison)) {
		if (!regression.primary) reasons.push(regression.reason);
	}
	return { allowed: reasons.length === 0, reasons };
}

/**
 * Machine rollback trigger: the primary metric regressed by at least the frozen
 * minimum effect. Returns the reason, or undefined when no trigger fires.
 */
export function primaryMetricRegression(
	contract: TrialContract | undefined,
	comparison: TrialComparison,
): string | undefined {
	const primary = contract?.primaryMetric;
	if (!primary || !isTrialMetricName(primary)) return undefined;
	const threshold = contract?.minimumEffect[primary];
	if (!threshold || threshold <= 0) return undefined;
	const delta = comparison.delta[primary];
	if (delta === null) return undefined;
	if (improvement(primary, delta) <= -threshold) {
		return `primary metric ${primary} regressed by ${(-improvement(primary, delta)).toFixed(4)} (frozen minimum effect ${threshold})`;
	}
	return undefined;
}
