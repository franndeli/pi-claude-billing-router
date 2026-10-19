// 🧠 Claude and OpenAI subscription usage in pi's footer status line.
//
// Shows live rate-limit utilization from the active provider's usage endpoint,
// colored green/yellow/red. Anthropic responses also raise an alarm when billed
// to "extra usage" (anthropic-ratelimit-unified-overage-in-use).
//
// Connector failures are never silent: rejected requests (HTTP 400) and
// auth loss turn the line red/yellow, and a failing usage fetch is marked
// "(stale)" — or "usage n/a" when nothing was ever read.
//
// The status key "0-claude-max" is chosen deliberately: pi's footer sorts
// extension statuses alphabetically by key (localeCompare), and "0" sorts
// before every letter, so this line renders first.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// PCBR: vendored from pi-claude-subscription-connector v1.2.0; feeds the
// billing policy and shows the active billing target in the footer.
import {
	clearCreditsUnavailable,
	clearRateLimit,
	getMode,
	onTargetChange,
	recordCreditsUnavailable,
	recordRateLimit,
	recordUsage,
	statusSuffix,
	useSubscription,
} from "./billing-policy.ts";

export const STATUS_KEY = "0-claude-max";
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const POLL_MIN_INTERVAL_MS = 30_000;
export const IDLE_REFRESH_MS = 5 * 60_000;
// Anthropic's usage endpoint intermittently answers 429; retry quickly with
// backoff instead of showing "usage n/a" until the idle timer fires.
export const RETRY_BASE_MS = 10_000;
export const RETRY_MAX_MS = 60_000;
export const OVERAGE_HEADER = "anthropic-ratelimit-unified-overage-in-use";
const CONFLICT_PACKAGE = "@benvargas/pi-claude-code-use";
// PCBR: the package this one was forked from must not run alongside it either.
const CONFLICT_PACKAGES = [CONFLICT_PACKAGE, "pi-claude-subscription-connector"];
const FETCH_TIMEOUT_MS = 10_000;

// ============================================================================
// Pure logic (exported for tests — no pi imports at runtime)
// ============================================================================

export interface UsageWindow {
	label: string;
	percent: number;
}

export type Severity = "ok" | "warn" | "critical";

function asPercent(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LIMIT_KIND_LABELS: Record<string, string> = {
	session: "5h",
	weekly_all: "wk",
};

/**
 * Parse the /api/oauth/usage response into display windows.
 *
 * Primary source is `limits[]` (kind: session | weekly_all | weekly_scoped,
 * percent, scope.model.display_name). Falls back to the top-level
 * `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`
 * utilization fields when `limits[]` is missing or empty.
 */
export function parseUsage(json: unknown): UsageWindow[] {
	if (!isRecord(json)) return [];

	const limits = json.limits;
	if (Array.isArray(limits)) {
		const windows: UsageWindow[] = [];
		for (const entry of limits) {
			if (!isRecord(entry)) continue;
			const percent = asPercent(entry.percent);
			if (percent === undefined) continue;
			const kind = typeof entry.kind === "string" ? entry.kind : "";
			let label = LIMIT_KIND_LABELS[kind];
			if (!label && kind === "weekly_scoped") {
				const scope = isRecord(entry.scope) ? entry.scope : undefined;
				const model = scope && isRecord(scope.model) ? scope.model : undefined;
				const displayName = model && typeof model.display_name === "string" ? model.display_name : "";
				label = displayName ? displayName.toLowerCase() : "model wk";
			}
			windows.push({ label: label || kind || "limit", percent });
		}
		if (windows.length > 0) return windows;
	}

	const windows: UsageWindow[] = [];
	const fallbacks: Array<[key: string, label: string]> = [
		["five_hour", "5h"],
		["seven_day", "wk"],
		["seven_day_opus", "opus"],
		["seven_day_sonnet", "sonnet"],
	];
	for (const [key, label] of fallbacks) {
		const block = json[key];
		if (!isRecord(block)) continue;
		const percent = asPercent(block.utilization);
		if (percent !== undefined) windows.push({ label, percent });
	}
	return windows;
}

/** Parse OpenAI's primary/secondary windows, whose durations vary by plan. */
export function parseOpenAIUsage(json: unknown): UsageWindow[] {
	if (!isRecord(json) || !isRecord(json.rate_limit)) return [];
	const windows: UsageWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const window = json.rate_limit[key];
		if (!isRecord(window)) continue;
		const percent = asPercent(window.used_percent);
		const seconds = window.limit_window_seconds;
		if (percent === undefined || percent < 0 || percent > 100) continue;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) continue;
		let label = `${seconds}s`;
		if (seconds === 604_800) label = "wk";
		else if (seconds % 86_400 === 0) label = `${seconds / 86_400}d`;
		else if (seconds % 3_600 === 0) label = `${seconds / 3_600}h`;
		else if (seconds % 60 === 0) label = `${seconds / 60}m`;
		windows.push({ label, percent });
	}
	return windows;
}

/** Read only the account-routing claim. Tokens never leave the request headers. */
export function openAIAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const auth = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
		const id = isRecord(auth) ? auth.chatgpt_account_id : undefined;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** "🧠 5h 19% · wk 24% · fable 46% · plan" (+ " ⚠ extra usage" when the alarm is on). */
export function formatStatusLine(windows: UsageWindow[], alarm = false, suffix?: string): string {
	const body =
		windows.length > 0 ? windows.map((w) => `${w.label} ${w.percent}%`).join(" · ") : "usage n/a";
	const tail = suffix ? ` · ${suffix}` : ""; // PCBR
	return `🧠 ${body}${tail}${alarm ? " ⚠ extra usage" : ""}`;
}

/** Green below 70%, yellow at 70–89%, red at 90%+ or whenever the alarm is on. */
export function severityOf(windows: UsageWindow[], alarm = false): Severity {
	if (alarm) return "critical";
	const max = windows.reduce((acc, w) => Math.max(acc, w.percent), 0);
	if (max >= 90) return "critical";
	if (max >= 70) return "warn";
	return "ok";
}

export const SEVERITY_COLOR: Record<Severity, string> = {
	ok: "success",
	warn: "warning",
	critical: "error",
};

/** Everything the status line needs to render one frame. */
export interface StatusSnapshot {
	windows: UsageWindow[];
	/** A response reported billing to extra usage (overage) instead of the plan. */
	alarm: boolean;
	/** OAuth token missing or rejected (usage endpoint or provider 401/403). */
	loginNeeded: boolean;
	/** The last usage-endpoint read failed (network, HTTP error, or bad shape). */
	fetchFailed: boolean;
	/** Last rejected request: Anthropic HTTP 400, or any OpenAI HTTP error. */
	providerErrorStatus: number | undefined;
	/** PCBR: billing target suffix for the footer (Anthropic only). */
	billingSuffix?: string;
}

/**
 * Compose the footer line for a snapshot. Priority: login problems, then
 * connector failures (overage billing / rejected requests, both red), then
 * usage-severity coloring. A failing usage fetch keeps the last known numbers
 * on screen with a "(stale)" marker instead of hiding the problem.
 */
export function composeStatus(s: StatusSnapshot): { text: string; color: string } {
	if (s.loginNeeded) return { text: "🧠 login needed", color: "warning" };

	const connectorFailure = s.alarm || s.providerErrorStatus !== undefined;
	if (s.windows.length === 0 && !connectorFailure && !s.fetchFailed) {
		return { text: "🧠 …", color: "dim" }; // first fetch still in flight
	}

	let text = formatStatusLine(s.windows, s.alarm, s.billingSuffix);
	if (!s.alarm && s.providerErrorStatus !== undefined) text += ` ⚠ HTTP ${s.providerErrorStatus}`;
	if (s.fetchFailed && s.windows.length > 0) text += " (stale)";

	const color = connectorFailure
		? "error"
		: s.fetchFailed && s.windows.length === 0
			? "warning"
			: SEVERITY_COLOR[severityOf(s.windows)];
	return { text, color };
}

export function shouldPoll(lastPollMs: number | undefined, nowMs: number, minIntervalMs = POLL_MIN_INTERVAL_MS): boolean {
	return lastPollMs === undefined || nowMs - lastPollMs >= minIntervalMs;
}

/** Delay before retrying a failed usage fetch: honors Retry-After, else exponential backoff. */
export function retryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
	const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
	if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, RETRY_MAX_MS);
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt), RETRY_MAX_MS);
}

/** True when a settings `packages` array references the conflicting upstream package. */
export function hasConflictingPackage(settings: unknown): boolean {
	if (!isRecord(settings) || !Array.isArray(settings.packages)) return false;
	return settings.packages.some((entry) => {
		const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : "";
		return CONFLICT_PACKAGES.some((pkg) => source.includes(pkg));
	});
}

// ============================================================================
// Extension wiring
// ============================================================================

interface StatusUi {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: string): void;
	theme?: { fg(color: string, text: string): string };
}

interface StatusCtx {
	ui: StatusUi;
	model?: { provider: string } | undefined;
	modelRegistry: {
		isUsingOAuth(model: { provider: string }): boolean;
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
	};
	hasUI?: boolean;
	cwd?: string;
}

type UsageProvider = "anthropic" | "openai-codex" | "openai";

interface ProviderState extends StatusSnapshot {
	lastPollMs: number | undefined;
	inFlight: boolean;
	retryAttempt: number;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
}

export default function usageStatus(pi: ExtensionAPI) {
	const states = new Map<UsageProvider, ProviderState>();
	let currentCtx: StatusCtx | undefined;
	let idleTimer: ReturnType<typeof setInterval> | undefined;

	function stateFor(provider: UsageProvider): ProviderState {
		let state = states.get(provider);
		if (!state) {
			state = {
				windows: [],
				alarm: false,
				loginNeeded: false,
				fetchFailed: false,
				providerErrorStatus: undefined,
				lastPollMs: undefined,
				inFlight: false,
				retryAttempt: 0,
				retryTimer: undefined,
			};
			states.set(provider, state);
		}
		return state;
	}

	const paint = (ui: StatusUi, color: string, text: string): string =>
		ui.theme ? ui.theme.fg(color, text) : text;

	function clearRetry(state: ProviderState): void {
		if (state.retryTimer) clearTimeout(state.retryTimer);
		state.retryTimer = undefined;
		state.retryAttempt = 0;
	}

	function scheduleRetry(state: ProviderState, retryAfter?: string | null): void {
		if (state.retryTimer) return;
		const delay = retryDelayMs(state.retryAttempt, retryAfter);
		state.retryAttempt += 1;
		state.retryTimer = setTimeout(() => {
			state.retryTimer = undefined;
			if (currentCtx) void refresh(currentCtx, true);
		}, delay);
		state.retryTimer.unref?.();
	}

	function usageProvider(ctx: StatusCtx): UsageProvider | undefined {
		const model = ctx.model;
		if (!model) return undefined;
		const provider = model.provider;
		if (provider !== "anthropic" && provider !== "openai-codex" && provider !== "openai") return undefined;
		return ctx.modelRegistry.isUsingOAuth(model) ? provider : undefined;
	}

	function render(ctx: StatusCtx): void {
		if (!ctx.hasUI) return;
		const provider = usageProvider(ctx);
		if (!provider) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const snapshot = stateFor(provider);
		const { text, color } = composeStatus(
			provider === "anthropic" ? { ...snapshot, billingSuffix: statusSuffix() } : snapshot, // PCBR
		);
		ctx.ui.setStatus(STATUS_KEY, paint(ctx.ui, color, text));
	}

	async function refresh(ctx: StatusCtx, force = false): Promise<void> {
		currentCtx = ctx;
		if (!ctx.hasUI) return;
		const provider = usageProvider(ctx);
		render(ctx);
		if (!provider) return;
		const state = stateFor(provider);
		if (state.inFlight || (!force && !shouldPoll(state.lastPollMs, Date.now()))) return;
		state.inFlight = true;
		state.lastPollMs = Date.now();
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (!token) {
				state.loginNeeded = true;
				return;
			}
			const headers: Record<string, string> = { authorization: `Bearer ${token}` };
			if (provider === "anthropic") {
				headers["anthropic-beta"] = "oauth-2025-04-20";
			} else {
				const accountId = openAIAccountId(token);
				if (accountId) headers["chatgpt-account-id"] = accountId;
			}
			const response = await fetch(provider === "anthropic" ? USAGE_URL : OPENAI_USAGE_URL, {
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (response.status === 401 || response.status === 403) {
				state.loginNeeded = true;
				state.fetchFailed = false;
				clearRetry(state);
				return;
			}
			if (!response.ok) {
				state.fetchFailed = true; // shown as "(stale)" / "usage n/a"
				scheduleRetry(state, response.headers.get("retry-after"));
				return;
			}
			const json: unknown = await response.json();
			const parsed = provider === "anthropic" ? parseUsage(json) : parseOpenAIUsage(json);
			if (parsed.length > 0 || state.windows.length === 0) state.windows = parsed;
			if (provider === "anthropic" && parsed.length > 0) recordUsage(parsed); // PCBR
			state.loginNeeded = false;
			// An unrecognized/empty payload counts as a failed read too.
			state.fetchFailed = parsed.length === 0;
			if (state.fetchFailed) scheduleRetry(state);
			else clearRetry(state);
		} catch {
			// Keep last known data, but surface the failure in the status line.
			state.fetchFailed = true;
			scheduleRetry(state);
		} finally {
			state.inFlight = false;
			// A different model may have been selected while the fetch was running.
			if (currentCtx) render(currentCtx);
		}
	}

	function warnOnConflict(ctx: StatusCtx): void {
		const settingsPaths: string[] = [];
		try {
			// Lazy import: only resolvable (and only needed) when running inside pi.
			// Keeping it out of module scope lets `node --test` import this file.
			void import("@earendil-works/pi-coding-agent").then(({ getAgentDir, CONFIG_DIR_NAME }) => {
				settingsPaths.push(join(getAgentDir(), "settings.json"));
				if (ctx.cwd) settingsPaths.push(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
				for (const path of settingsPaths) {
					try {
						if (!existsSync(path)) continue;
						if (hasConflictingPackage(JSON.parse(readFileSync(path, "utf-8")))) {
							ctx.ui.notify(
								`pi-claude-billing-router: remove ${CONFLICT_PACKAGES.join(" / ")} from ${path} — these packages sanitize the same Anthropic OAuth payloads and must not run together.`,
								"warning",
							);
							return;
						}
					} catch {
						// Unreadable settings file — nothing to warn about.
					}
				}
			});
		} catch {
			// Conflict detection is best-effort; never break startup.
		}
	}

	// PCBR: announce plan ⇄ credits switches and repaint the footer.
	onTargetChange((target, reason) => {
		if (!currentCtx) return;
		if (currentCtx.hasUI) {
			const label = target === "plan" ? "Claude plan" : "extra-usage CREDITS";
			currentCtx.ui.notify(`Billing → ${label} (${reason})`, target === "plan" ? "info" : "warning");
		}
		render(currentCtx);
	});

	pi.on("session_start", async (_event, ctx) => {
		warnOnConflict(ctx as unknown as StatusCtx);
		if (!ctx.hasUI) return;
		await refresh(ctx as unknown as StatusCtx, true);
		if (idleTimer) clearInterval(idleTimer);
		idleTimer = setInterval(() => {
			if (currentCtx) void refresh(currentCtx, true);
		}, IDLE_REFRESH_MS);
		idleTimer.unref?.();
	});

	pi.on("model_select", async (event, ctx) => {
		await refresh({ ...ctx, model: event.model } as unknown as StatusCtx, true);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		const statusCtx = ctx as unknown as StatusCtx;
		currentCtx = statusCtx;
		const provider = usageProvider(statusCtx);
		if (!provider || !ctx.hasUI) return;
		const state = stateFor(provider);
		if (event.status === 401 || event.status === 403) {
			state.loginNeeded = true;
			render(statusCtx);
			return;
		}
		if (provider === "anthropic") {
			const nowBilling = event.headers[OVERAGE_HEADER] === "true";
			// PCBR: overage is only an alarm when we intended to bill the plan.
			const intendedPlan = useSubscription();
			if (nowBilling && intendedPlan && !state.alarm) {
				ctx.ui.notify(
					"Claude request was billed to EXTRA USAGE, not your subscription — the Claude Code spoof may be broken.",
					"warning",
				);
			}
			state.alarm = nowBilling && intendedPlan;
			// PCBR: 429 on the plan → treat the plan as exhausted so the retry
			// (pi retries rate limits automatically) goes out as a plain request.
			if (event.status === 429 && intendedPlan) {
				recordRateLimit(event.headers);
			} else if (event.status < 400 && intendedPlan) {
				clearRateLimit();
			}
			// PCBR: a 400 on a credits request is Anthropic's "no extra usage"
			// signature. In auto mode, stop trying credits for a while.
			if (!intendedPlan && event.status === 400) {
				if (getMode() === "auto") {
					recordCreditsUnavailable();
				} else {
					ctx.ui.notify(
						"Credits request refused: your account has no spendable extra usage (claude.ai/settings/usage). Use /billing plan or /billing auto.",
						"error",
					);
				}
			} else if (!intendedPlan && event.status < 400) {
				clearCreditsUnavailable();
			}
			if (event.status === 400) {
				// Anthropic's "out of extra usage" failure signature.
				if (state.providerErrorStatus === undefined) {
					ctx.ui.notify(
						"Claude request failed (HTTP 400). If this repeats, subscription billing may be broken — see the 🧠 status.",
						"error",
					);
				}
				state.providerErrorStatus = 400;
			}
		} else if (event.status >= 400) {
			state.providerErrorStatus = event.status;
		}
		if (event.status < 400) {
			state.providerErrorStatus = undefined;
			state.loginNeeded = false;
		}
		// PCBR: a 429 is exactly when we need fresh numbers — bypass the throttle.
		await refresh(statusCtx, event.status === 429);
	});

	pi.on("session_shutdown", async () => {
		if (idleTimer) clearInterval(idleTimer);
		idleTimer = undefined;
		for (const state of states.values()) clearRetry(state);
		currentCtx = undefined;
	});
}
