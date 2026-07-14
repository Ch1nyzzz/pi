import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { refreshEvoStatusIndicator } from "./cli.ts";
import { type EvoPaths, getEvoPaths } from "./paths.ts";
import { createPiModelRunner, type ModelRunner } from "./reflect/model-runner.ts";
import { runReflector } from "./reflect/reflector.ts";
import { runConfiguredImprove } from "./scheduler.ts";
import { EvoService } from "./service.ts";

const DEFAULT_INITIAL_DELAY_MS = 45_000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60_000;

export interface AutoImproveOutcome {
	proposals: ReadonlyArray<{ id: string }>;
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
			runReflector({
				paths,
				runner,
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				...(options.model ? { model: options.model } : {}),
				signal,
			}));

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
					if (!(await service.status()).initialized) return;
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
							? `Evo-Pi reflected in the background and staged ${staged} proposal${staged === 1 ? "" : "s"}; review with /evo list`
							: "Evo-Pi reflected in the background; no grounded proposal was produced",
						"info",
					);
					await refreshEvoStatusIndicator({ service, paths }, ctx);
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
