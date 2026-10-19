// /billing — inspect and override which bucket Anthropic OAuth requests bill to.
//
//   /billing            show current mode, effective target, and why
//   /billing auto       plan while it has capacity, credits once exhausted
//   /billing plan       always spoof → always bill the subscription
//   /billing credits    never spoof → always bill extra-usage credits
//   /billing reload     re-read ~/.pi/agent/pi-claude-billing-router.json
//
// Config file (all keys optional):
//   {
//     "defaultMode": "auto",
//     "sessionThresholdPercent": 100,
//     "considerWeekly": false,
//     "considerModelWeekly": false,
//     "rateLimitFallbackMs": 18000000
//   }

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type BillingMode,
	CONFIG_FILE_NAME,
	getConfig,
	loadConfig,
	setMode,
	snapshot,
} from "./billing-policy.ts";

const MODES: BillingMode[] = ["auto", "plan", "credits"];

function describe(): string {
	const s = snapshot();
	const cfg = getConfig();
	const usage = s.usage.length > 0 ? s.usage.map((w) => `${w.label} ${w.percent}%`).join(", ") : "no usage data yet";
	const rl =
		s.rateLimitedUntilMs !== undefined && s.rateLimitedUntilMs > Date.now()
			? ` · 429 hold until ${new Date(s.rateLimitedUntilMs).toLocaleTimeString()}`
			: "";
	const lines = [
		`Billing mode: ${s.mode}`,
		`Effective target: ${s.target === "plan" ? "Claude plan (subscription)" : "extra-usage credits"} — ${s.reason}`,
		`Usage: ${usage}${rl}`,
		`Auto threshold: ${cfg.sessionThresholdPercent}% (5h${cfg.considerWeekly ? " + weekly" : ""}${cfg.considerModelWeekly ? " + model weekly" : ""})`,
		`Last request billed as: ${s.lastApplied ?? "n/a"}`,
	];
	return lines.join("\n");
}

export default function billingRouter(pi: ExtensionAPI): void {
	// Load config as early as possible so the guard's first decision is right.
	loadConfig(getAgentDir());

	pi.on("session_start", async () => {
		loadConfig(getAgentDir());
	});

	pi.registerCommand("billing", {
		description: "Show or set Claude billing target: auto | plan | credits | reload",
		getArgumentCompletions: (prefix) => {
			const items = [...MODES, "reload", "status"].filter((m) => m.startsWith(prefix.toLowerCase()));
			return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "reload") {
				loadConfig(getAgentDir());
				ctx.ui.notify(`Reloaded ${CONFIG_FILE_NAME}\n${describe()}`, "info");
				return;
			}
			if (arg === "" || arg === "status") {
				ctx.ui.notify(describe(), "info");
				return;
			}
			if (!MODES.includes(arg as BillingMode)) {
				ctx.ui.notify(`Unknown mode "${args.trim()}". Use: ${MODES.join(" | ")} | reload`, "error");
				return;
			}
			setMode(arg as BillingMode);
			ctx.ui.notify(describe(), "info");
		},
	});
}
