import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import subscriptionGuard, { _test as router } from "../lib/subscription-guard.ts";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
// Exercise the actual installed runtime, not its unexecuted TypeScript source.
const { streamAnthropicViaBetaMessages } = await import(new URL(
	"../../../npm/node_modules/pi-background-tasks/dist/src/core/anthropic-attribution.js", import.meta.url).href);

const alias = "mcp__fixture__lookup";
const tool = (name: string, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
const fixture = () => [
	{ role: "system", content: "Use pi itself carefully.", toolsAdded: [tool("read"), tool("lookup"), tool(alias)], timestamp: 1 },
	{ role: "user", content: "Synthetic test only", timestamp: 2 },
];
function setup() {
	router.refreshAliasMap([["lookup", alias]]);
	router.registeredMcpAliases.add(alias);
}

async function request(messages: unknown[], middleware = (p: any) => router.transformPayload(p, false), retention = "long") {
	const originalFetch = globalThis.fetch;
	const originalAudit = process.env.PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH;
	delete process.env.PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH;
	let sent: any;
	globalThis.fetch = async (_url, init) => {
		sent = JSON.parse(String(init?.body));
		// Deliberately stop after the protected boundary; no live HTTP or credentials.
		return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "fixture transport reached" } }), { status: 400 });
	};
	try {
		const stream = streamAnthropicViaBetaMessages(
			{ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com", maxTokens: 8192 },
			{ messages },
			{ apiKey: "sk-ant-oat-fixture-not-a-secret", sessionId: randomUUID(), cacheRetention: retention, maxRetries: 0, onPayload: middleware },
			{ loadAccount: () => ({ deviceId: "fixture-device", accountUuid: "fixture-account" }), hostTranscriptHelpers: { getCurrentSystemPrompt, getCurrentTools } },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		return { sent, events, error: JSON.stringify(events) };
	} finally {
		globalThis.fetch = originalFetch;
		if (originalAudit === undefined) delete process.env.PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH;
		else process.env.PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH = originalAudit;
	}
}

test("legacy late projection reproduces the exact installed topology error", async () => {
	setup();
	const result = await request(fixture());
	assert.equal(result.sent, undefined);
	assert.match(result.error, /Anthropic protected cache-control topology changed during payload middleware/);
});

for (const retention of ["none", "short", "long"]) {
	test(`early projection passes installed topology AND lineage guards (${retention})`, async () => {
		setup();
		const input = fixture();
		const snapshot = structuredClone(input);
		const result = await request(router.transformTranscript(input, true, false), undefined, retention);
		assert.deepEqual(input, snapshot, "never mutate the persisted transcript");
		assert.ok(result.sent, result.error);
		assert.deepEqual(result.sent.tools.map((t: any) => t.name), ["read", alias]);
		assert.match(result.error, /fixture transport reached/);
	});
}

test("projection preserves source schemas, net alias activation, sections and historical calls", () => {
	setup();
	const messages = [
		...fixture(),
		{ role: "system", content: "", toolsRemoved: [{ name: "lookup" }], timestamp: 3 },
		{ role: "system", content: "", toolsAdded: [tool("lookup", "new schema")], sections: { help: "pi itself", removed: null }, timestamp: 4 },
		{ role: "assistant", content: [{ type: "toolCall", name: "lookup", id: "call1", arguments: {} }], timestamp: 5 },
	];
	const result: any = router.transformTranscript(messages, true, false);
	assert.deepEqual(result[2].toolsRemoved, [], "active alias must survive flat removal");
	assert.equal(result[3].toolsAdded[0].description, "new schema");
	assert.equal(result[3].sections.removed, null);
	assert.equal(result[4].content[0].name, alias);
	assert.equal(result[4].content[0].id, "call1");
});

test("credits projection keeps flat tools and original prose", async () => {
	setup();
	const projected: any = router.transformTranscript(fixture(), false, false);
	assert.equal(projected[0].content, fixture()[0].content);
	assert.deepEqual(projected[0].toolsAdded.map((t: any) => t.name), ["read", "lookup"]);
	const result = await request(projected, (p) => router.stripAliasStubs(p));
	assert.ok(result.sent, result.error);
	assert.deepEqual(result.sent.tools.map((t: any) => t.name), ["read", "lookup"]);
});

test("context handler is registered and leaves non-OAuth routes untouched", async () => {
	const handlers = new Map<string, Function>();
	await subscriptionGuard({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
	const handler = handlers.get("context_with_system");
	assert.ok(handler);
	for (const [provider, oauth] of [["anthropic", false], ["openai", true]]) {
		assert.equal(handler({ messages: fixture() }, {
			model: { provider }, modelRegistry: { isUsingOAuth: () => oauth },
		}), undefined);
	}
});

test("dynamic transcript passes installed guards after tool replacement and removal", async () => {
	setup();
	const messages = [...fixture(),
		{ role: "system", content: "", toolsAdded: [tool("lookup", "updated")], timestamp: 3 },
		{ role: "system", content: "", toolsRemoved: [{ name: alias }], timestamp: 4 },
	];
	const result = await request(router.transformTranscript(messages, true, false));
	assert.ok(result.sent, result.error);
	assert.equal(result.sent.tools.find((t: any) => t.name === alias).description, "updated");
});

for (const [name, mutate, expected] of [
	["cache TTL", (p: any) => { p.tools.at(-1).cache_control.ttl = "5m"; }, /protected cache-control topology/],
	["cache position", (p: any) => { p.tools[0].cache_control = p.tools.at(-1).cache_control; delete p.tools.at(-1).cache_control; }, /protected cache-control topology/],
	["route", (p: any) => { p.model = "other-model"; }, /protected attribution model\/stream/],
	["metadata", (p: any) => { p.metadata.user_id = "tampered"; }, /protected attribution metadata/],
	["identity", (p: any) => { p.system.shift(); }, /protected attribution system identity/],
	["schema", (p: any) => { p.tools[0].description = "tampered"; }, /lineage changed/],
] as const) {
	test(`security guard still rejects modified ${name}`, async () => {
		setup();
		const result = await request(router.transformTranscript(fixture(), true, false), (p) => { mutate(p); return p; });
		assert.equal(result.sent, undefined);
		assert.match(result.error, expected);
	});
}
