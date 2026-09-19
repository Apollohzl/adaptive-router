import assert from "node:assert/strict";
import test from "node:test";
import agent, { chooseModel } from "./agent.ts";

const ROUTER_MODEL = "openai/gpt-oss-20b";

function entry(
	id: string,
	cost: number,
	options: { image?: boolean; tools?: boolean; context?: number } = {},
) {
	return {
		id,
		category: "text",
		community: false,
		supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
		input_modalities: options.image ? ["text", "image"] : ["text"],
		tools: options.tools ?? true,
		context_length: options.context ?? 128000,
		pricing: {
			promptTextTokens: String(cost / 1000),
			completionTextTokens: String(cost / 1000),
		},
	};
}

const catalog = [
	entry("cheap-fast", 0.0001),
	entry("cheap-fast-b", 0.0002),
	entry("cheap-fast-broken", 0.00015),
	entry("vision-cheap", 0.0005, { image: true }),
	entry("mid-balanced", 0.001),
	entry("mid-balanced-slow", 0.001),
	entry("deep-strong", 0.004),
	entry("deep-stronger", 0.009),
	entry("community/free-router", 0),
];

function statusRow(model: string, total: number, ok: number, p95: number | null = 1000) {
	return {
		model,
		event_type: "generate.text",
		is_rollup: 1,
		total_requests: total,
		status_2xx: ok,
		latency_p95_ms: p95,
	};
}

const statuses = [
	statusRow("cheap-fast", 500, 495, 800),
	statusRow("cheap-fast-b", 500, 490, 400),
	statusRow("cheap-fast-broken", 500, 20, 900), // 4% success -> degraded
	statusRow("mid-balanced", 200, 198, 2000),
	statusRow("mid-balanced-slow", 200, 199, 9000),
	statusRow("deep-strong", 100, 99, 5000),
	statusRow("deep-stronger", 100, 100, 7000),
	{ ...statusRow("ignored", 10, 10), is_rollup: 0 }, // per-route row, not a model rollup
];

type Call = { path: string; body: Record<string, unknown> };

function harness(options: { label?: string | null; fail?: number[] } = {}) {
	const calls: Call[] = [];
	let responses = 0;
	const pollinations = async (path: string, init?: RequestInit) => {
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ path, body });
		if (path === "/v1/models") return Response.json({ data: catalog });
		if (path.startsWith("/models/status")) return Response.json({ data: statuses });
		if (body.model === ROUTER_MODEL) {
			if (options.label === null) return new Response("boom", { status: 500 });
			return Response.json({
				output: [{ content: [{ type: "output_text", text: options.label ?? "BALANCED" }] }],
			});
		}
		responses++;
		if (options.fail?.includes(responses)) {
			return new Response('{"error":"upstream"}', {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("answer", { status: 200 });
	};
	return { calls, pollinations, get responses() { return responses; } };
}

function request(input: unknown, extra: Record<string, unknown> = {}) {
	return new Request("https://example.com/v1/responses", {
		method: "POST",
		body: JSON.stringify({ model: "Apollohzl/adaptive-router", input, ...extra }),
	});
}

test("three requests of different difficulty route to three different models", async () => {
	const picked: string[] = [];
	for (const label of ["FAST", "BALANCED", "DEEP"]) {
		const h = harness({ label });
		const result = await agent({ request: request("hello"), pollinations: h.pollinations });
		const forwarded = h.calls.filter((c) => c.body.model !== ROUTER_MODEL).pop();
		picked.push(String(forwarded?.body.model));
		assert.equal(result.status, 200);
		assert.equal(result.headers.get("x-router-tier"), label);
		assert.match(result.headers.get("x-router-reason") ?? "", /tier=/);
	}
	assert.deepEqual(picked, ["cheap-fast", "mid-balanced", "deep-strong"]);
	assert.equal(new Set(picked).size, 3);
});

test("the forwarded body keeps the conversation and only swaps the model", async () => {
	const h = harness({ label: "FAST" });
	const input = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello" },
		{ role: "user", content: "again" },
	];
	await agent({
		request: request(input, { instructions: "Be terse.", stream: true, max_output_tokens: 64 }),
		pollinations: h.pollinations,
	});
	const forwarded = h.calls.filter((c) => c.body.model !== ROUTER_MODEL).pop() as Call;
	assert.deepEqual(forwarded.body.input, input);
	assert.equal(forwarded.body.instructions, "Be terse.");
	assert.equal(forwarded.body.stream, true);
	assert.equal(forwarded.body.max_output_tokens, 64);
	assert.equal(forwarded.body.model, "cheap-fast");
});

test("chat-completions style input is normalised to a Responses body", async () => {
	const h = harness({ label: "FAST" });
	const messages = [{ role: "user", content: "hi" }];
	await agent({
		request: new Request("https://example.com/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "Apollohzl/adaptive-router", messages }),
		}),
		pollinations: h.pollinations,
	});
	const forwarded = h.calls.filter((c) => c.body.model !== ROUTER_MODEL).pop() as Call;
	assert.deepEqual(forwarded.body.input, messages);
	assert.equal("messages" in forwarded.body, false);
});

test("degraded models are skipped, ties break on latency", () => {
	const decision = chooseModel({
		tier: "FAST",
		media: 0,
		tools: false,
		tokens: 10,
		catalog,
		statuses,
	});
	assert.equal(decision.id, "cheap-fast"); // cheapest healthy: cheap-fast-broken is 4% success
	assert.ok(decision.candidates.includes("cheap-fast-b"));

	const balanced = chooseModel({
		tier: "BALANCED",
		media: 0,
		tools: false,
		tokens: 10,
		catalog,
		statuses,
	});
	assert.equal(balanced.id, "mid-balanced"); // same price as mid-balanced-slow, lower p95
});

test("image input is bumped out of FAST and only picks vision models", async () => {
	const h = harness({ label: "FAST" });
	const result = await agent({
		request: request([{ role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }]),
		pollinations: h.pollinations,
	});
	assert.equal(result.headers.get("x-router-tier"), "BALANCED");
	const forwarded = h.calls.filter((c) => c.body.model !== ROUTER_MODEL).pop() as Call;
	assert.equal(forwarded.body.model, "vision-cheap");
	assert.match(result.headers.get("x-router-reason") ?? "", /images/);
});

test("a failing router model falls back to the heuristic tier", async () => {
	const h = harness({ label: null });
	const result = await agent({
		request: request("Design a multi-region failover architecture and analyse the trade-offs."),
		pollinations: h.pollinations,
	});
	assert.equal(result.headers.get("x-router-tier"), "DEEP");
	assert.match(result.headers.get("x-router-reason") ?? "", /^heuristic ->/);
});

test("a 503 escalates to the next candidate and reports every attempt", async () => {
	const h = harness({ label: "BALANCED", fail: [1] });
	const result = await agent({ request: request("hi"), pollinations: h.pollinations });
	assert.equal(h.responses, 2);
	assert.equal(result.headers.get("x-router-model"), "mid-balanced-slow");
	assert.equal(result.headers.get("x-router-candidates"), "mid-balanced,mid-balanced-slow");
	assert.equal(result.status, 200);
});

test("an unreachable catalog still answers from the static fallback", async () => {
	const calls: string[] = [];
	const result = await agent({
		request: request("hi"),
		pollinations: async (path, init) => {
			calls.push(path);
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			if (path === "/v1/models" || path.startsWith("/models/status")) {
				return new Response("nope", { status: 500 });
			}
			if (body.model === ROUTER_MODEL) {
				return Response.json({
					output: [{ content: [{ type: "output_text", text: "DEEP" }] }],
				});
			}
			return new Response("answer", { status: 200 });
		},
	});
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("x-router-model"), "x-ai/grok-4.6");
	assert.equal(result.headers.get("x-router-tier"), "DEEP");
});
