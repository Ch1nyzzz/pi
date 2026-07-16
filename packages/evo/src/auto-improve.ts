import type { ExtensionFactory } from "@ch1nyzzz/pi-coding-agent";
import { refreshEvoStatusIndicator } from "./cli.ts";
import {
	buildTrialComparison,
	contractMetricRegressions,
	evaluateTrialContractGate,
	parseTrialDurationDays,
} from "./comparison.ts";
import { readEvoControlConfig } from "./evolve/config.ts";
import { runEvolutionCycle } from "./evolve/cycle.ts";
import { readFrozenExperimentForProposal } from "./evolve/run.ts";
import { runSessionTriage } from "./evolve/triage.ts";
import { type EvoPaths, getEvoPaths } from "./paths.ts";
import { createPiModelRunner, type ModelRunner } from "./reflect/model-runner.ts";
import { runRetrospective, type TrialRecommendation } from "./reflect/retrospective.ts";
import { readScheduleConfig, runConfiguredImprove } from "./scheduler.ts";
import { EvoService } from "./service.ts";

const DEFAULT_INITIAL_DELAY_MS = 45_000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60_000;

export interface AutoImproveOutcome {
	proposals: ReadonlyArray<{ id: string }>;
}

export interface AutoRetrospectiveOutcome {
	proposal: { id: string };
	recommendation?: TrialRecommendation;
	reused?: boolean;
}

export interface EvoAutoImproveExtensionOptions {
	root?: string;
	paths?: EvoPaths;
	service?: EvoService;
	runner?: ModelRunner;
	cwd?: string;
	agentDir?: string;
	model?: string;
	initialDelayMs?: number;
	checkIntervalMs?: number;
	improve?: (signal: AbortSignal) => Promise<AutoImproveOutcome>;
	retrospect?: () => Promise<AutoRetrospectiveOutcome>;
	now?: () => Date;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the guarded scheduled-improve loop inside the live Pi session, so users
 * get background reflection at their configured cadence without any cron or
 * systemd setup. Every attempt still goes through runConfiguredImprove, which
 * enforces pause, cadence, quiet hours, activity, daily-limit, and lock gates.
 */
export function createEvoAutoImproveExtension(options: EvoAutoImproveExtensionOptions = {}): ExtensionFactory {
	const paths = options.service?.paths ?? options.paths ?? getEvoPaths(options.root);
	const service = options.service ?? new EvoService(paths);
	const runner = options.runner ?? createPiModelRunner();
	const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
	const improve =
		options.improve ??
		((signal: AbortSignal) =>
			runEvolutionCycle({
				paths,
				runner,
				service,
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				signal,
			}));
	const retrospect =
		options.retrospect ??
		(async () => {
			const config = await readEvoControlConfig(paths);
			return runRetrospective({
				paths,
				runner,
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				model: options.model ?? config.models.evaluator.model,
				...(config.models.evaluator.thinkingLevel ? { thinkingLevel: config.models.evaluator.thinkingLevel } : {}),
			});
		});
	const now = options.now ?? (() => new Date());

	return (pi) => {
		let timer: NodeJS.Timeout | undefined;
		let stopped = true;
		let activeTick: Promise<void> = Promise.resolve();
		let notifiedFailure = false;

		const clearTimer = (): void => {
			if (timer) clearTimeout(timer);
			timer = undefined;
		};

		pi.on("session_start", (_event, ctx) => {
			stopped = false;
			notifiedFailure = false;
			clearTimer();

			const tick = async (): Promise<void> => {
				try {
					if (stopped || !ctx.isIdle()) return;
					const status = await service.status();
					if (!status.initialized) return;
					// Streaming triage is cheap and cursor-gated: it no-ops until
					// enough new sessions accumulate, and never blocks the tick.
					try {
						const config = await readEvoControlConfig(paths);
						const triage = await runSessionTriage({
							paths,
							runner,
							model: options.model ?? config.models.triage.model,
							...(config.models.triage.thinkingLevel
								? { thinkingLevel: config.models.triage.thinkingLevel }
								: {}),
							everyNSessions: config.triage.everyNSessions,
							...(options.cwd ? { cwd: options.cwd } : {}),
							...(options.agentDir ? { agentDir: options.agentDir } : {}),
						});
						if (triage.ran && triage.hypotheses.length > 0) {
							ctx.ui.notify(
								`Evo-Pi triage filed ${triage.hypotheses.length} improvement hypothesis(es) from ${triage.newSessions} new session(s)`,
								"info",
							);
						}
					} catch {
						// Triage is best-effort; a missing triage model must not stall trials or improves.
					}
					if (status.trial) {
						const proposal = await service.getProposal(status.trial.proposalId);
						const schedule = await readScheduleConfig(paths);
						const comparison = await buildTrialComparison(paths, proposal, status.trial);
						// The frozen experiment contract bounds the trial: its maximumDuration
						// caps the schedule window and its minimumSamples raises the session bar.
						const experiment = await readFrozenExperimentForProposal(paths, status.trial.proposalId);
						const online = experiment?.evidenceStrategy.online;
						const contractDays =
							online && online.mode !== "none" ? parseTrialDurationDays(online.maximumDuration) : undefined;
						const contractSamples = online && online.mode !== "none" ? online.minimumSamples : 0;
						const dueAfterDays =
							contractDays === undefined
								? schedule.trialDueAfterDays
								: Math.min(schedule.trialDueAfterDays, contractDays);
						const dueAfterSessions = Math.max(schedule.trialDueAfterSessions, contractSamples);
						const dueAt = Date.parse(status.trial.startedAt) + dueAfterDays * 24 * 60 * 60 * 1_000;
						const due = now().getTime() >= dueAt || comparison.after.totals.sessions >= dueAfterSessions;
						if (due) {
							const result = await retrospect();
							notifiedFailure = false;
							const config = await readEvoControlConfig(paths);
							// Machine rollback trigger: a measured regression of the frozen
							// primary metric or any pre-registered guardrail metric outranks
							// any model recommendation.
							const regressions = contractMetricRegressions(experiment, comparison);
							if (regressions.length > 0) {
								const regression = regressions.map((entry) => entry.reason).join("; ");
								await service.rollback(undefined, `Automatic rollback: ${regression}`);
								ctx.ui.notify(
									`Evo-Pi automatically rolled back trial ${result.proposal.id}: ${regression}`,
									"warning",
								);
								await refreshEvoStatusIndicator({ service, paths }, ctx, now);
								return;
							}
							if (config.release.autoKeepSuccessfulTrial && result.recommendation === "keep") {
								// The model's keep is a veto-capable opinion; the deterministic
								// contract gate decides whether an automatic keep is allowed.
								const gate = evaluateTrialContractGate(experiment, comparison);
								if (gate.allowed) {
									await service.keep(
										"Automatic keep: retrospective recommendation and frozen contract gate both passed",
									);
									ctx.ui.notify(`Evo-Pi automatically kept trial ${result.proposal.id}`, "info");
									await refreshEvoStatusIndicator({ service, paths }, ctx, now);
									return;
								}
								ctx.ui.notify(
									`Evo-Pi left trial ${result.proposal.id} open for review: ${gate.reasons.join("; ")}`,
									"info",
								);
								await refreshEvoStatusIndicator({ service, paths }, ctx, now);
								return;
							}
							if (result.recommendation === "rollback") {
								await service.rollback(
									undefined,
									"Automatic rollback after evidence-bound retrospective recommendation",
								);
								ctx.ui.notify(`Evo-Pi automatically rolled back trial ${result.proposal.id}`, "warning");
								await refreshEvoStatusIndicator({ service, paths }, ctx, now);
								return;
							}
							if (!result.reused) {
								ctx.ui.notify(
									`Evo-Pi automatically compared the trial with its baseline; review ${result.proposal.id} with /evo show ${result.proposal.id}`,
									"info",
								);
								await refreshEvoStatusIndicator({ service, paths }, ctx, now);
							}
						}
						return;
					}
					const result = await runConfiguredImprove({
						paths,
						excludeSessionIds: [ctx.sessionManager.getSessionId()],
						improve,
					});
					if (result.status !== "completed") return;
					notifiedFailure = false;
					const staged = result.value.proposals.length;
					ctx.ui.notify(
						staged > 0
							? `Evo-Pi evolved in the background and produced ${staged} proposal${staged === 1 ? "" : "s"}; review with /evo list`
							: "Evo-Pi completed a background research cycle without a candidate",
						"info",
					);
					await refreshEvoStatusIndicator({ service, paths }, ctx, now);
				} catch (error) {
					if (!notifiedFailure) {
						notifiedFailure = true;
						ctx.ui.notify(`Evo-Pi background reflection failed: ${errorMessage(error)}`, "warning");
					}
				} finally {
					schedule(checkIntervalMs);
				}
			};

			const schedule = (delayMs: number): void => {
				if (stopped) return;
				timer = setTimeout(() => {
					activeTick = tick();
				}, delayMs);
				timer.unref?.();
			};

			schedule(initialDelayMs);
		});

		pi.on("session_shutdown", async () => {
			stopped = true;
			clearTimer();
			await activeTick;
		});
	};
}
