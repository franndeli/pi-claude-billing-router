# pi-claude-billing-router

Use your Claude Pro/Max subscription with [pi](https://pi.dev) — and when the
plan runs out, **keep working on extra-usage credits instead of hitting a wall**.

```
🧠 5h 100% · wk 41% · 💳 credits     ← plan exhausted, requests now bill extra usage
🧠 5h 12% · wk 43% · plan            ← window reset, back on the plan
```

Anthropic decides which bucket a request bills to by inspecting the request
body. A payload that looks like a first-party Claude Code request bills to your
**plan** (5h / weekly windows); anything else bills to **extra usage**
(pay-per-token credits from claude.ai/settings/usage). Existing packages always
force the plan. This one decides **per request**:

| Mode | Behaviour |
|---|---|
| `auto` (default) | Plan while it has capacity. Switch to credits when the 5h window reaches 100% or Anthropic returns a 429. Back to plan when the window resets. If credits are empty, stay on the plan instead of failing. |
| `plan` | Always bill the subscription (what `pi-claude-subscription-connector` does). |
| `credits` | Always bill extra usage. |

## Install

```
pi install npm:pi-claude-billing-router
# or straight from GitHub:
pi install git:github.com/franndeli/pi-claude-billing-router
```

Then, if you haven't already: `/login` → Anthropic → OAuth.

**Requirements**
- Claude Pro or Max subscription, pi ≥ 1.1.0
- For the credits fallback: **extra usage enabled with a balance** at
  [claude.ai/settings/usage](https://claude.ai/settings/usage). Without it,
  `auto` simply behaves like `plan`.
- Note: *"cloud session credits"* are a different bucket that only applies to
  Claude Code cloud sessions — they cannot be used from pi or any other client.

> **Do not run alongside `pi-claude-subscription-connector` or
> `@benvargas/pi-claude-code-use`.** This package vendors and replaces them; all
> three rewrite the same payload. It warns on startup if it finds them in your
> settings.

## Commands

```
/billing            current mode, effective target and why, usage, threshold
/billing auto       plan first, credits when exhausted (default)
/billing plan       force the subscription
/billing credits    force extra usage
/billing reload     re-read the config file
```

Mode changes apply from the next request and last for the session. Switching
mid-conversation is safe: tool names are stored un-aliased in the transcript
and re-shaped on every request.

## Footer status line

```
🧠 5h 35% · wk 27% · plan
🧠 5h 100% · wk 60% · 💳 credits
🧠 5h 100% · wk 60% · 💳 credits!      ← "!" = manual override active
```

Percentages are **used** capacity. Colors: green < 70%, yellow 70–89%, red 90%+.
Error states (`login needed`, `⚠ HTTP 400`, `(stale)`, `usage n/a`) are
inherited from the upstream connector. A failed usage read (Anthropic's usage
endpoint intermittently answers 429) is retried automatically with backoff
(10s → 20s → 40s → 60s, or `Retry-After` when sent) instead of waiting for the
next model response. `⚠ extra usage` only appears when a
request billed extra usage **while the router intended the plan** — i.e. the
Claude Code shaping is broken, not when credits were chosen on purpose.

When the target flips you get a notification: `Billing → extra-usage CREDITS
(5h window at 100%)` / `Billing → Claude plan (plan has capacity)`.

## Configuration

`~/.pi/agent/pi-claude-billing-router.json` — optional, every key optional:

```json
{
  "defaultMode": "auto",
  "sessionThresholdPercent": 100,
  "considerWeekly": false,
  "considerModelWeekly": false,
  "rateLimitFallbackMs": 18000000
}
```

| Key | Default | Meaning |
|---|---|---|
| `defaultMode` | `auto` | Mode at session start |
| `sessionThresholdPercent` | `100` | In `auto`, switch to credits when the 5h window reaches this used-% (e.g. `95` to avoid 429s entirely) |
| `considerWeekly` | `false` | Also switch when the weekly (all models) window reaches the threshold |
| `considerModelWeekly` | `false` | Also switch when a per-model weekly window (e.g. Opus) reaches the threshold |
| `rateLimitFallbackMs` | 5h | How long to assume the plan is exhausted after a 429 that carries no reset header. Fresh usage data overrides this. |

Upstream env vars still work: `PI_CLAUDE_CODE_USE_DEBUG_LOG=<path>` logs every
payload with a `stage` of `before`/`after` (plan) or `credits-passthrough`
(credits) — handy to verify which path a request took.
`PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER`, `..._DISABLE_AUTO_ALIAS`,
`..._DISABLE_PROSE_UNALIAS` and the `pi-claude-code-use.json` alias overrides
behave as in the upstream packages.

## How the switch works

- **plan** → the vendored guard normalizes the payload (MCP-style tool aliases,
  neutralized system-prompt wording) so Anthropic classifies it as Claude Code.
- **credits** → the payload is sent as a plain pi request: flat tool names,
  original system prompt, alias stubs stripped. Anthropic bills extra usage.
  Verified: a credits-mode request returns `200` with
  `anthropic-ratelimit-unified-overage-status: allowed` and leaves the 5h
  utilization untouched.
- Signals feeding `auto`: the OAuth usage endpoint (polled at session start,
  on model change, after responses — throttled to 30s — and every 5 min idle),
  429 responses (with `anthropic-ratelimit-unified-*-reset` / `retry-after`
  headers), and the "no extra usage" 400 signature on credits requests.

## Caveats

- This works because the payload is shaped like Claude Code. Anthropic can
  change its classifier at any time; if that happens the plan path breaks for
  this and every similar package.
- Credits cost real money per token. Watch the footer and the `Billing →`
  notifications; use `/billing plan` if you'd rather wait for the window reset.

## Development

```
npm test          # links your installed pi into node_modules, runs node --test (Node ≥ 23)
npm run typecheck # tsc against the linked pi types
```

Layout — pi loads each extension file in an isolated module graph, so the
pieces are wired from a single entry point to share state:

```
extensions/index.ts        entry point
lib/billing-policy.ts      decision logic + shared state
lib/billing-router.ts      /billing command + config
lib/subscription-guard.ts  vendored payload shaping, gated on the policy
lib/usage-status.ts        vendored footer; feeds usage/429s to the policy
test/                      unit tests for the policy
```

Every local change to the vendored files is tagged `PCBR:` inline.

## Credits

Built on [pi-claude-subscription-connector](https://github.com/Akshay-patel7/pi-claude-subscription-connector)
by Akshay Patel, which vendors [@benvargas/pi-claude-code-use](https://github.com/ben-vargas/pi-packages)
by Ben Vargas. Both MIT — see `LICENSE`.
