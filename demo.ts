/**
 * Live routing demo: the real catalog and the real 30-minute health window,
 * with only the classifier label stubbed (it needs an API key).
 *
 *   node demo.ts
 */
import { chooseModel } from "./agent.ts";

const PROMPTS = [
	{ label: "FAST", media: 0, request: "Translate 'good morning' into French." },
	{
		label: "BALANCED",
		media: 0,
		request: "Write a Python function that merges two sorted linked lists, plus pytest tests.",
	},
	{
		label: "DEEP",
		media: 0,
		request:
			"Design a multi-region failover architecture for a card payment system and analyse the consistency, latency and cost trade-offs.",
	},
	{
		label: "FAST",
		media: 1,
		request: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/receipt.png" }, { type: "input_text", text: "What does this receipt say?" }] }],
	},
];

const [catalog, status] = await Promise.all([
	fetch("https://gen.pollinations.ai/v1/models").then((r) => r.json()),
	fetch("https://gen.pollinations.ai/models/status?minutes=30").then((r) => r.json()),
]);

for (const prompt of PROMPTS) {
	const media = prompt.media;
	const tier = media > 0 && prompt.label === "FAST" ? "BALANCED" : prompt.label;
	const text = typeof prompt.request === "string" ? prompt.request : JSON.stringify(prompt.request);
	const decision = chooseModel({
		tier: tier as "FAST" | "BALANCED" | "DEEP",
		media,
		tools: false,
		tokens: Math.ceil(text.length / 4) + media * 1024,
		catalog: catalog.data,
		statuses: status.data,
	});
	console.log(`\nrequest : ${text.slice(0, 90)}`);
	console.log(`tier    : ${tier}${tier === prompt.label ? "" : ` (bumped from ${prompt.label}: images)`}`);
	console.log(`model   : ${decision.id}`);
	console.log(`why     : ${decision.reason}`);
	console.log(`chain   : ${decision.candidates.join(" -> ")}`);
}
