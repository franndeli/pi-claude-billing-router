// Single entry point. Pi loads every extension file in an isolated module
// graph (jiti with moduleCache: false), so the three parts must be wired from
// ONE file to share lib/billing-policy.ts state.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import billingRouter from "../lib/billing-router.ts";
import subscriptionGuard from "../lib/subscription-guard.ts";
import usageStatus from "../lib/usage-status.ts";

export default async function piClaudeBillingRouter(pi: ExtensionAPI): Promise<void> {
	billingRouter(pi); // loads config first so the guard's first decision is right
	await subscriptionGuard(pi);
	usageStatus(pi);
}
