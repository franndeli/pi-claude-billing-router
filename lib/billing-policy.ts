// Shared billing policy for pi-claude-billing-router.
//
// Anthropic decides which bucket an OAuth request bills to by inspecting the
// request body: a payload shaped like a first-party Claude Code request bills
// to the subscription plan (5h / weekly windows); anything else bills to
// "extra usage" (pay-per-token credits).
//
// This module is the single source of truth for "which bucket do we want
// right now". subscription-guard.ts asks `useSubscription()` before applying
// the Claude Code spoof, usage-status.ts feeds it usage numbers and 429s,
// and billing-router.ts exposes the /billing command and config file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BillingMode = "auto" | "plan" | "credits";
export type BillingTarget = "plan" | "credits";

export interface BillingConfig {
	/** Starting mode for every session. */
	defaultMode: BillingMode;
	/** In auto mode, switch to credits once the 5h window reaches this used-%. */
	sessionThresholdPercent: number;
	/** Also switch when the weekly window reaches the threshold. */
	considerWeekly: boolean;
	/** Also switch when any model-scoped weekly window reaches the threshold. */
	considerModelWeekly: boolean;
	/** If a 429 arrives without a usable reset header, assume credits for this long. */
	rateLimitFallbackMs: number;
}

export const DEFAULT_CONFIG: BillingConfig = {
	defaultMode: "auto",
	sessionThresholdPercent: 100,
	considerWeekly: false,
	considerModelWeekly: false,
	rateLimitFallbackMs: 5 * 60 * 60 * 1000,
};

export const CONFIG_FILE_NAME = "pi-claude-billing-router.json";

export interface UsageSample {
	label: string;
	percent: number;
}

export interface PolicyState {
	mode: BillingMode;
	config: BillingConfig;
	/** Last usage windows seen from the Anthropic usage endpoint. */
	usage: UsageSample[];
	usageAtMs: number | undefined;
	/** Set by a 429; epoch ms until which we treat the plan as exhausted. */
	rateLimitedUntilMs: number | undefined;
	/** Set when a credits request was refused (no extra-usage balance). */
	creditsUnavailableUntilMs: number | undefined;
	/** Last target that was actually applied to a request. */
	lastApplied: BillingTarget | undefined;
}

const state: PolicyState = {
	mode: DEFAULT_CONFIG.defaultMode,
	config: { ...DEFAULT_CONFIG },
	usage: [],
	usageAtMs: undefined,
	rateLimitedUntilMs: undefined,
	creditsUnavailableUntilMs: undefined,
	lastApplied: undefined,
};

/** How long to stop trying credits after Anthropic says the bucket is empty. */
export const CREDITS_UNAVAILABLE_MS = 30 * 60 * 1000;

type Listener = (target: BillingTarget, reason: string) => void;
const listeners = new Set<Listener>();
let lastAnnounced: { target: BillingTarget; reason: string } | undefined;

/** Subscribe to effective-target changes (plan ⇄ credits). */
export function onTargetChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function announceIfChanged(): void {
	const { target, reason } = resolve();
	if (lastAnnounced && lastAnnounced.target === target) return;
	lastAnnounced = { target, reason };
	for (const l of listeners) {
		try {
			l(target, reason);
		} catch {
			// Listeners must never break policy evaluation.
		}
	}
}

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseConfig(raw: unknown): BillingConfig {
	const cfg = { ...DEFAULT_CONFIG };
	if (!isRecord(raw)) return cfg;
	if (raw.defaultMode === "auto" || raw.defaultMode === "plan" || raw.defaultMode === "credits") {
		cfg.defaultMode = raw.defaultMode;
	}
	if (typeof raw.sessionThresholdPercent === "number" && Number.isFinite(raw.sessionThresholdPercent)) {
		cfg.sessionThresholdPercent = Math.min(100, Math.max(1, Math.round(raw.sessionThresholdPercent)));
	}
	if (typeof raw.considerWeekly === "boolean") cfg.considerWeekly = raw.considerWeekly;
	if (typeof raw.considerModelWeekly === "boolean") cfg.considerModelWeekly = raw.considerModelWeekly;
	if (typeof raw.rateLimitFallbackMs === "number" && raw.rateLimitFallbackMs > 0) {
		cfg.rateLimitFallbackMs = raw.rateLimitFallbackMs;
	}
	return cfg;
}

/** Load `<agentDir>/pi-claude-billing-router.json`, falling back to defaults. */
export function loadConfig(agentDir: string): BillingConfig {
	const path = join(agentDir, CONFIG_FILE_NAME);
	try {
		if (existsSync(path)) {
			state.config = parseConfig(JSON.parse(readFileSync(path, "utf-8")));
		} else {
			state.config = { ...DEFAULT_CONFIG };
		}
	} catch {
		state.config = { ...DEFAULT_CONFIG };
	}
	state.mode = state.config.defaultMode;
	announceIfChanged();
	return state.config;
}

export function getConfig(): BillingConfig {
	return state.config;
}

// ----------------------------------------------------------------------------
// Inputs
// ----------------------------------------------------------------------------

export function setMode(mode: BillingMode): void {
	state.mode = mode;
	announceIfChanged();
}

export function getMode(): BillingMode {
	return state.mode;
}

export function recordUsage(windows: UsageSample[]): void {
	state.usage = windows;
	state.usageAtMs = Date.now();
	// Fresh usage data is more trustworthy than a stale 429 guess: if the
	// session window is clearly below the threshold again, the limit reset.
	const session = windows.find((w) => w.label === "5h");
	if (session && session.percent < state.config.sessionThresholdPercent) {
		state.rateLimitedUntilMs = undefined;
	}
	announceIfChanged();
}

/**
 * Record a 429. Anthropic's unified rate-limit headers carry a reset time;
 * fall back to a fixed window when none is present.
 */
export function recordRateLimit(headers: Record<string, string> = {}, nowMs = Date.now()): void {
	let until: number | undefined;
	const candidates = [
		headers["anthropic-ratelimit-unified-5h-reset"],
		headers["anthropic-ratelimit-unified-reset"],
	];
	for (const raw of candidates) {
		if (!raw) continue;
		const n = Number(raw);
		if (Number.isFinite(n)) {
			// Header may be epoch seconds or epoch ms.
			until = n > 1e12 ? n : n * 1000;
			break;
		}
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) {
			until = parsed;
			break;
		}
	}
	if (until === undefined && headers["retry-after"]) {
		const secs = Number(headers["retry-after"]);
		if (Number.isFinite(secs) && secs > 0) until = nowMs + secs * 1000;
	}
	if (until === undefined || until <= nowMs) until = nowMs + state.config.rateLimitFallbackMs;
	state.rateLimitedUntilMs = until;
	announceIfChanged();
}

export function clearRateLimit(): void {
	state.rateLimitedUntilMs = undefined;
	announceIfChanged();
}

/** Anthropic refused a credits request ("draw from your extra usage… add more"). */
export function recordCreditsUnavailable(nowMs = Date.now()): void {
	state.creditsUnavailableUntilMs = nowMs + CREDITS_UNAVAILABLE_MS;
	announceIfChanged();
}

export function clearCreditsUnavailable(): void {
	state.creditsUnavailableUntilMs = undefined;
	announceIfChanged();
}

export function creditsUnavailable(nowMs = Date.now()): boolean {
	return state.creditsUnavailableUntilMs !== undefined && nowMs < state.creditsUnavailableUntilMs;
}

export function markApplied(target: BillingTarget): void {
	state.lastApplied = target;
}

// ----------------------------------------------------------------------------
// Decision
// ----------------------------------------------------------------------------

export interface Resolution {
	target: BillingTarget;
	reason: string;
}

function thresholdHit(cfg: BillingConfig, usage: UsageSample[]): string | undefined {
	for (const w of usage) {
		const isSession = w.label === "5h";
		const isWeekly = w.label === "wk";
		const isModelWeekly = !isSession && !isWeekly;
		const considered =
			isSession || (isWeekly && cfg.considerWeekly) || (isModelWeekly && cfg.considerModelWeekly);
		if (considered && w.percent >= cfg.sessionThresholdPercent) {
			return `${w.label} window at ${w.percent}%`;
		}
	}
	return undefined;
}

export function resolve(nowMs = Date.now()): Resolution {
	if (state.mode === "plan") return { target: "plan", reason: "forced by /billing plan" };
	if (state.mode === "credits") return { target: "credits", reason: "forced by /billing credits" };

	// In auto mode a dead credits bucket is worse than a 429: the plan at least
	// resets on its own, so keep requests on the plan until credits recover.
	if (creditsUnavailable(nowMs)) {
		return { target: "plan", reason: "extra-usage credits unavailable (empty or disabled)" };
	}

	if (state.rateLimitedUntilMs !== undefined && nowMs < state.rateLimitedUntilMs) {
		const mins = Math.max(1, Math.round((state.rateLimitedUntilMs - nowMs) / 60_000));
		return { target: "credits", reason: `plan rate-limited (429), ~${mins}m until reset` };
	}

	const hit = thresholdHit(state.config, state.usage);
	if (hit) return { target: "credits", reason: hit };

	return { target: "plan", reason: "plan has capacity" };
}

/** True when the Claude Code spoof should be applied (bill to the plan). */
export function useSubscription(nowMs = Date.now()): boolean {
	return resolve(nowMs).target === "plan";
}

export function snapshot(): Readonly<PolicyState> & Resolution {
	return { ...state, ...resolve() };
}

/** Short footer suffix, e.g. "plan" / "💳 credits". */
export function statusSuffix(): string {
	const { target } = resolve();
	const forced = state.mode !== "auto" ? "!" : "";
	return target === "plan" ? `plan${forced}` : `💳 credits${forced}`;
}

/** Test hook: reset module state. */
export function _reset(): void {
	state.mode = DEFAULT_CONFIG.defaultMode;
	state.config = { ...DEFAULT_CONFIG };
	state.usage = [];
	state.usageAtMs = undefined;
	state.rateLimitedUntilMs = undefined;
	state.creditsUnavailableUntilMs = undefined;
	state.lastApplied = undefined;
	lastAnnounced = undefined;
	listeners.clear();
}
