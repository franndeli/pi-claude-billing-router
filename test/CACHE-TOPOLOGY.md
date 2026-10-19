# Installed Anthropic cache-topology regression

Run from this package directory:

```sh
node --test test/*.test.ts
```

`cache-topology.test.ts` intentionally imports the installed
`../../../npm/node_modules/pi-background-tasks/dist/src/core/anthropic-attribution.js`
relative to the test file. The installed extension entry point imports that
runtime, not `src/core/anthropic-attribution.ts`. This installation-specific
integration test requires Pi's existing peer dependency links in `node_modules`.
It does not install packages, read credentials, or send HTTP requests: account
loading and fetch are replaced with synthetic fixtures. A simulated HTTP 400
marks successful passage through all pre-send guards, not a successful API call.

## Cause and fix

The subscription router used to deduplicate/filter tools and rewrite history in
`before_provider_request`, after the attribution provider had sealed cache
breakpoint paths and request lineage. A breakpoint on tool index 2 moves to index
1 when a flat tool and its MCP stub merge. Preserving its TTL is insufficient:
the protected path changes. Even with no cache, rewriting the prompt/tools late
can violate the separate lineage guard.

The router now projects the complete request-local transcript in
`context_with_system`, before provider serialization, attribution, cache markers,
and lineage. It replays tool additions/removals and emits the projected deltas,
keeps the source schema over alias stubs, and rewrites assistant tool-call names
and system sections in plan mode. Credits mode strips only registered alias
stubs and retains the original prose/flat tools. Persisted messages are not
mutated. The existing late hook remains for compatibility and tool_choice; for
an already projected transcript its structural transformations are idempotent.

No provider guard, billing policy, credentials, or installed npm files were
changed. The patch lives in the local package loaded through
`packages/pi-claude-billing-router` in the agent settings, so reinstalling
`pi-background-tasks` does not overwrite it. Replacing/updating this local router
checkout can overwrite local changes; preserve them in the router repository.
Re-run the tests after either package or Pi is upgraded.

Restart Pi to load the changed extension module graph. The test does not verify
live Anthropic acceptance, token usage, or billing classification. It verifies
that the original error is reproduced on the old late path, the new path reaches
the mocked transport, and malicious late mutations remain blocked.
