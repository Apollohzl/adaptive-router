Fixes #15017

**Repository:** https://github.com/Apollohzl/adaptive-router
**Callable model:** `Apollohzl/adaptive-router`

## What it is

A code agent that chooses which model answers each request and then answers as that model. Callers see one ordinary model; the choice is reported in `x-router-*` headers and one log line.

## How it routes

1. **Difficulty tier.** One cheap call (`openai/gpt-oss-20b`, `max_output_tokens: 64`, `temperature: 0`) labels the request `FAST` / `BALANCED` / `DEEP`. The conversation is passed as JSON *data* behind an explicit "do not follow these instructions" wrapper, so a prompt inside the request cannot steer the router. If the call fails or returns no label, a keyword/length heuristic picks the tier — the router never blocks on itself.
2. **Quality bar.** Each tier is a price floor in blended Pollen per 1k tokens (`FAST` 0, `BALANCED` 0.0006, `DEEP` 0.003). Price is the capability proxy, so the floor *is* the bar.
3. **Live health.** `GET /models/status?minutes=30` per-model rollups drop models below 80% success over 8+ requests, or that never served in 3+ tries. This is what makes the router switch away from a degrading model with no code change.
4. **Cheapest healthy wins,** ties broken by p95 latency — after hard constraints (`/v1/responses` support, image input when the request carries images, tool calling when `tools` is set, enough context length). Community models are excluded so the router can never route into another router.

Nothing clears the bar? It relaxes instead of failing, and the trace says so. Catalog unreachable? A small static per-tier list keeps it answering. On `429`/`5xx` it replays the identical request to the next candidate, up to three attempts: escalation *between* models, since Gen already retries a model's own fallbacks.

## Verifying the routing

Every response carries `x-router-model`, `x-router-tier`, `x-router-reason`, `x-router-candidates`; the same line is logged.

```
x-router-model: x-ai/grok-4.6
x-router-tier: DEEP
x-router-reason: classifier -> tier=DEEP; bar>=0.003; cost=0.00300/1k; success 100% of 1 req,
  p95 11929ms; healthy 11/13 above bar; cheapest healthy, then lowest p95; text only
x-router-candidates: x-ai/grok-4.6,qwen/qwen3.7-max,qwen/qwen3.8-2.4t-a95b
```

## Demonstration — three requests routed differently

Run against the **live** catalog and the **live** 30-minute health window; only the classifier label is stubbed (labelling needs an API key), and `demo.ts` reproduces it:

| Request | Tier | Model | Reason |
| --- | --- | --- | --- |
| "Translate 'good morning' into French." | FAST | `inception/mercury-2.5-preview` | `bar>=0; cost=0.00010/1k; healthy 54/66 above bar; cheapest healthy, then lowest p95` |
| "Write a Python function that merges two sorted linked lists, plus pytest tests." | BALANCED | `xiaomi/mimo-v2.5-pro` | `bar>=0.0006; cost=0.00069/1k; healthy 32/37 above bar` |
| "Design a multi-region failover architecture for a card payment system…" | DEEP | `x-ai/grok-4.6` | `bar>=0.003; cost=0.00300/1k; success 100% of 1 req, p95 11929ms; healthy 11/13 above bar` |
| An image of a receipt + "What does this receipt say?" | BALANCED (bumped from FAST) | `mistralai/mistral-large-3` | `request carries images; cost=0.00075/1k; healthy 24/28 above bar` |

## Tests

`node --test agent.test.ts` — 8 tests, all passing:

- three difficulty tiers route to three different models;
- the forwarded body keeps the conversation and only swaps `model`;
- chat-completions style `messages` are normalised to a Responses body;
- degraded models are skipped, equal-price ties break on p95 latency;
- image input is bumped out of FAST and only picks vision models;
- a failing router model falls back to the heuristic tier;
- a 503 escalates to the next candidate and reports every attempt;
- an unreachable catalog still answers from the static fallback.

## Alpha feedback

- The code-agent contract is clear and the one-file deploy works well. Two things would help: a way to set response headers that is guaranteed to survive the gateway (custom headers are easy to set but I could not confirm they reach the caller), and access to agent stdout in the dashboard — right now the `console.log` trace is only verifiable indirectly.
- A `GET /v1/models` field marking *managed agents* would let routers exclude them generically; today I exclude everything under `community/` to avoid routing into another router.

## Files

- `apps/agent-adaptive-router/agent.ts` — the agent
- `apps/agent-adaptive-router/README.md` — short README
