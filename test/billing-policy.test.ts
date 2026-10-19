import { test } from "node:test";
import assert from "node:assert/strict";
import * as p from "../lib/billing-policy.ts";

test("auto: plan while 5h below threshold", () => {
	p._reset();
	p.recordUsage([{ label: "5h", percent: 87 }, { label: "wk", percent: 100 }]);
	assert.equal(p.resolve().target, "plan"); // weekly ignored by default
});

test("auto: credits once 5h hits 100%", () => {
	p._reset();
	p.recordUsage([{ label: "5h", percent: 100 }]);
	assert.equal(p.resolve().target, "credits");
	assert.equal(p.useSubscription(), false);
});

test("auto: 429 flips to credits using reset header, usage reset flips back", () => {
	p._reset();
	const now = 1_000_000_000_000;
	p.recordRateLimit({ "anthropic-ratelimit-unified-reset": String(Math.floor(now / 1000) + 600) }, now);
	assert.equal(p.resolve(now).target, "credits");
	assert.equal(p.resolve(now + 601_000).target, "plan");
	p.recordRateLimit({}, now); // fallback window
	assert.equal(p.resolve(now + 60_000).target, "credits");
	p.recordUsage([{ label: "5h", percent: 3 }]); // fresh data says reset
	assert.equal(p.resolve(now + 60_000).target, "plan");
});

test("manual override wins over auto signals", () => {
	p._reset();
	p.recordUsage([{ label: "5h", percent: 100 }]);
	p.setMode("plan");
	assert.equal(p.resolve().target, "plan");
	p.setMode("credits");
	p.recordUsage([{ label: "5h", percent: 0 }]);
	assert.equal(p.resolve().target, "credits");
	assert.equal(p.statusSuffix(), "💳 credits!");
});

test("config parsing + weekly consideration", () => {
	p._reset();
	const cfg = p.parseConfig({ sessionThresholdPercent: 95, considerWeekly: true, defaultMode: "bogus" });
	assert.equal(cfg.sessionThresholdPercent, 95);
	assert.equal(cfg.defaultMode, "auto");
	assert.equal(cfg.considerWeekly, true);
});

test("listeners fire only on target change", () => {
	p._reset();
	const seen: string[] = [];
	p.onTargetChange((t) => seen.push(t));
	p.recordUsage([{ label: "5h", percent: 10 }]);
	p.recordUsage([{ label: "5h", percent: 50 }]);
	p.recordUsage([{ label: "5h", percent: 100 }]);
	p.recordUsage([{ label: "5h", percent: 100 }]);
	p.recordUsage([{ label: "5h", percent: 1 }]);
	assert.deepEqual(seen, ["plan", "credits", "plan"]);
});

test("auto: empty credits bucket falls back to plan even when rate-limited", () => {
	p._reset();
	const now = 2_000_000_000_000;
	p.recordRateLimit({}, now);
	assert.equal(p.resolve(now).target, "credits");
	p.recordCreditsUnavailable(now);
	assert.equal(p.resolve(now).target, "plan");
	assert.match(p.resolve(now).reason, /credits unavailable/);
	assert.equal(p.resolve(now + p.CREDITS_UNAVAILABLE_MS + 1).target, "credits");
	p.setMode("credits"); // manual override still forces credits
	assert.equal(p.resolve(now).target, "credits");
});
