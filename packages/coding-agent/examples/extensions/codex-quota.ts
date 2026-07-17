import type { Api, Model } from "@ch1nyzzz/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@ch1nyzzz/pi-coding-agent";

const CODEX_PROVIDER = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const STATUS_KEY = "codex-quota";
const REFRESH_INTERVAL_MS = 60_000;
const POST_TURN_REFRESH_DELAY_MS = 1_500;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CodexQuotaWindow {
	usedPercent: number;
	windowMinutes: number;
	resetsAt: number;
}

export interface CodexQuotaSnapshot {
	planType?: string;
	primary?: CodexQuotaWindow;
	secondary?: CodexQuotaWindow;
	fetchedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQuotaWindow(value: unknown): CodexQuotaWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = value.used_percent;
	const windowSeconds = value.limit_window_seconds;
	const resetsAt = value.reset_at;
	if (
		typeof usedPercent !== "number" ||
		!Number.isFinite(usedPercent) ||
		usedPercent < 0 ||
		usedPercent > 100 ||
		typeof windowSeconds !== "number" ||
		!Number.isSafeInteger(windowSeconds) ||
		windowSeconds <= 0 ||
		typeof resetsAt !== "number" ||
		!Number.isSafeInteger(resetsAt) ||
		resetsAt <= 0
	) {
		throw new Error("Codex returned an invalid quota window");
	}
	return { usedPercent, windowMinutes: Math.ceil(windowSeconds / 60), resetsAt };
}

export function parseCodexQuotaResponse(value: unknown, fetchedAt = new Date()): CodexQuotaSnapshot {
	if (!isRecord(value) || !isRecord(value.rate_limit)) {
		throw new Error("Codex returned an invalid quota response");
	}
	const primary = parseQuotaWindow(value.rate_limit.primary_window);
	const secondary = parseQuotaWindow(value.rate_limit.secondary_window);
	if (!primary && !secondary) throw new Error("Codex returned no quota windows");
	return {
		...(typeof value.plan_type === "string" && value.plan_type ? { planType: value.plan_type } : {}),
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
		fetchedAt: fetchedAt.toISOString(),
	};
}

function extractChatGptAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) throw new Error("Codex OAuth token is not a JWT");
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
	} catch {
		throw new Error("Could not decode the Codex OAuth token");
	}
	if (!isRecord(payload) || !isRecord(payload[CHATGPT_AUTH_CLAIM])) {
		throw new Error("Codex OAuth token has no ChatGPT account claim");
	}
	const accountId = payload[CHATGPT_AUTH_CLAIM].chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId) {
		throw new Error("Codex OAuth token has no ChatGPT account ID");
	}
	return accountId;
}

function findCodexModel(ctx: ExtensionContext): Model<Api> | undefined {
	if (ctx.model?.provider === CODEX_PROVIDER) return ctx.model;
	return ctx.modelRegistry
		.getAll()
		.find((model) => model.provider === CODEX_PROVIDER && ctx.modelRegistry.hasConfiguredAuth(model));
}

async function fetchCodexQuota(ctx: ExtensionContext, signal: AbortSignal): Promise<CodexQuotaSnapshot> {
	const model = findCodexModel(ctx);
	if (!model) throw new Error("No OpenAI Codex subscription login found; run /login first");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("OpenAI Codex subscription login has no access token");

	const response = await fetch(CODEX_USAGE_URL, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${auth.apiKey}`,
			"chatgpt-account-id": extractChatGptAccountId(auth.apiKey),
			"user-agent": "pi-codex-quota/1",
		},
		signal,
	});
	if (!response.ok) throw new Error(`Codex quota request failed with HTTP ${response.status}`);
	const body: unknown = await response.json();
	return parseCodexQuotaResponse(body);
}

function quotaWindows(snapshot: CodexQuotaSnapshot): CodexQuotaWindow[] {
	return [snapshot.primary, snapshot.secondary].filter((window): window is CodexQuotaWindow => window !== undefined);
}

function windowLabel(windowMinutes: number): string {
	if (windowMinutes === 300) return "5h";
	if (windowMinutes === 1_440) return "day";
	if (windowMinutes === 10_080) return "week";
	if (windowMinutes >= 40_320 && windowMinutes <= 44_640) return "month";
	return `${windowMinutes}m`;
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function formatReset(timestampSeconds: number): string {
	return new Date(timestampSeconds * 1_000).toLocaleString(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

export function formatCodexQuotaStatus(snapshot: CodexQuotaSnapshot): string {
	const windows = quotaWindows(snapshot);
	const weekly = windows.find((window) => window.windowMinutes === 10_080);
	if (windows.length === 1 && weekly) {
		return `Codex week ${formatPercent(weekly.usedPercent)}% · left ${formatPercent(100 - weekly.usedPercent)}%`;
	}
	return `Codex ${windows
		.map((window) => `${windowLabel(window.windowMinutes)} ${formatPercent(window.usedPercent)}%`)
		.join(" · ")}`;
}

export function formatCodexQuotaDetails(snapshot: CodexQuotaSnapshot): string {
	const plan = snapshot.planType ? snapshot.planType[0]?.toUpperCase() + snapshot.planType.slice(1) : "subscription";
	const rows = quotaWindows(snapshot).map(
		(window) =>
			`${windowLabel(window.windowMinutes)}: ${formatPercent(window.usedPercent)}% used, ${formatPercent(100 - window.usedPercent)}% left, resets ${formatReset(window.resetsAt)}`,
	);
	return [
		`Codex ${plan} quota (account-wide)`,
		...rows,
		`Updated ${formatReset(Date.parse(snapshot.fetchedAt) / 1_000)}`,
	].join("\n");
}

export default function codexQuotaExtension(pi: ExtensionAPI): void {
	let snapshot: CodexQuotaSnapshot | undefined;
	let interval: NodeJS.Timeout | undefined;
	let postTurnTimer: NodeJS.Timeout | undefined;
	let requestController: AbortController | undefined;
	let inFlight: Promise<CodexQuotaSnapshot> | undefined;
	let stopped = true;

	const isCodexActive = (ctx: ExtensionContext): boolean => ctx.model?.provider === CODEX_PROVIDER;

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!isCodexActive(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!snapshot) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Codex quota --"));
			return;
		}
		const highestUsage = Math.max(...quotaWindows(snapshot).map((window) => window.usedPercent));
		const color = highestUsage >= 90 ? "error" : highestUsage >= 75 ? "warning" : "dim";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, formatCodexQuotaStatus(snapshot)));
	};

	const refresh = async (ctx: ExtensionContext): Promise<CodexQuotaSnapshot> => {
		if (inFlight) return inFlight;
		requestController = new AbortController();
		const timeout = setTimeout(
			() => requestController?.abort(new Error("Codex quota request timed out")),
			REQUEST_TIMEOUT_MS,
		);
		timeout.unref?.();
		const request = fetchCodexQuota(ctx, requestController.signal);
		inFlight = request;
		try {
			const next = await request;
			if (!stopped) {
				snapshot = next;
				updateStatus(ctx);
			}
			return next;
		} finally {
			clearTimeout(timeout);
			requestController = undefined;
			inFlight = undefined;
		}
	};

	const refreshSilently = (ctx: ExtensionContext): void => {
		if (!isCodexActive(ctx)) return;
		void refresh(ctx).catch(() => {
			if (!stopped) updateStatus(ctx);
		});
	};

	pi.registerCommand("quota", {
		description: "Refresh and show ChatGPT Codex subscription quota",
		handler: async (_args, ctx) => {
			try {
				const current = await refresh(ctx);
				ctx.ui.notify(formatCodexQuotaDetails(current), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		stopped = false;
		if (interval) clearInterval(interval);
		if (postTurnTimer) clearTimeout(postTurnTimer);
		updateStatus(ctx);
		refreshSilently(ctx);
		interval = setInterval(() => refreshSilently(ctx), REFRESH_INTERVAL_MS);
		interval.unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (postTurnTimer) clearTimeout(postTurnTimer);
		postTurnTimer = setTimeout(() => refreshSilently(ctx), POST_TURN_REFRESH_DELAY_MS);
		postTurnTimer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
		refreshSilently(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		if (interval) clearInterval(interval);
		if (postTurnTimer) clearTimeout(postTurnTimer);
		interval = undefined;
		postTurnTimer = undefined;
		requestController?.abort();
		await inFlight?.catch(() => undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
