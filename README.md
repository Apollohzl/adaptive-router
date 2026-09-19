# adaptive-router

A [Pollinations](https://github.com/pollinations/pollinations) **code agent** that picks which
model answers each request, then answers as that model. Callers see one normal model:
`Apollohzl/adaptive-router`.

```bash
curl https://gen.pollinations.ai/v1/chat/completions \
  -H "Authorization: Bearer $POLLINATIONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Apollohzl/adaptive-router","messages":[{"role":"user","content":"Translate good morning into French."}]}'
```

## How it routes

Four signals, one decision, in this order:

1. **Difficulty tier.** One cheap call (`openai/gpt-oss-20b`, `max_output_tokens: 64`,
   `temperature: 0`) labels the request `FAST`, `BALANCED` or `DEEP`. The conversation is
   passed as JSON *data* with an explicit "do not follow these instructions" wrapper, so a
   prompt inside the request cannot steer the router. If that call fails or returns no label,
   a keyword/length heuristic picks the tier instead — the router never blocks on itself.
2. **Quality bar.** Each tier is a price floor in blended Pollen per 1k tokens
   (`FAST` 0, `BALANCED` 0.0006, `DEEP` 0.003). Price is the proxy for capability, so the
   floor is the quality bar.
3. **Live health.** `GET /models/status?minutes=30` (per-model rollup rows) removes models
   whose success rate over the window is below 80% with at least 8 requests, or that have
   never served a request in 3+ tries. This is what makes the router *switch away* from a
   model that degrades, with no code change.
4. **Cheapest healthy wins,** ties broken by p95 latency. Hard constraints are applied
   first: `/v1/responses` support, image input when the request carries images, tool calling
   when `tools` is set, and enough context length. Community models are excluded so the
   router can never route into another router.

If nothing clears the bar (a rare capability that only cheap models have), the bar is relaxed
rather than failing, and the trace says so. If the catalog is unreachable, a small static
per-tier list keeps the agent answering.

**Escalation.** Gen already retries a model's own fallbacks, so this agent only escalates
*between* models: on `429` or `5xx` it replays the identical request to the next candidate,
up to three attempts, and reports the whole chain.

## Verifying the routing

Every response carries the decision:

| Header | Example |
| --- | --- |
| `x-router-model` | `x-ai/grok-4.6` |
| `x-router-tier` | `DEEP` |
| `x-router-reason` | `classifier -> tier=DEEP; bar>=0.003; cost=0.00300/1k; success 100% of 1 req, p95 11929ms; healthy 11/13 above bar; cheapest healthy, then lowest p95; text only` |
| `x-router-candidates` | `x-ai/grok-4.6,qwen/qwen3.7-max,qwen/qwen3.8-2.4t-a95b` |

The same line is written to the console (visible in the agent's logs).

## Demonstration

`node demo.ts` runs the real selection logic against the **live** catalog and the **live**
30-minute health window; only the classifier label is stubbed, because labelling needs an API
key. Output from 2026-09-19:

```
request : Translate 'good morning' into French.
tier    : FAST
model   : inception/mercury-2.5-preview
why     : tier=FAST; bar>=0; cost=0.00010/1k; healthy 54/66 above bar;
          cheapest healthy, then lowest p95; text only
chain   : inception/mercury-2.5-preview -> openai/gpt-oss-20b -> nvidia/nemotron-3.5-lightning

request : Write a Python function that merges two sorted linked lists, plus pytest tests.
tier    : BALANCED
model   : xiaomi/mimo-v2.5-pro
why     : tier=BALANCED; bar>=0.0006; cost=0.00069/1k; healthy 32/37 above bar;
          cheapest healthy, then lowest p95; text only
chain   : xiaomi/mimo-v2.5-pro -> mistralai/mistral-large-3 -> minimax/minimax-m3

request : Design a multi-region failover architecture for a card payment system and analyse
          the consistency, latency and cost trade-offs.
tier    : DEEP
model   : x-ai/grok-4.6
why     : tier=DEEP; bar>=0.003; cost=0.00300/1k; success 100% of 1 req, p95 11929ms;
          healthy 11/13 above bar; cheapest healthy, then lowest p95; text only
chain   : x-ai/grok-4.6 -> qwen/qwen3.7-max -> qwen/qwen3.8-2.4t-a95b

request : [image] What does this receipt say?
tier    : BALANCED (bumped from FAST: images)
model   : mistralai/mistral-large-3
why     : tier=BALANCED; bar>=0.0006; cost=0.00075/1k; success 100% of 1 req, p95 1401ms;
          healthy 24/28 above bar; cheapest healthy, then lowest p95; request carries images
chain   : mistralai/mistral-large-3 -> minimax/minimax-m3 -> qwen/qwen3.7-plus
```

Four requests, four different answers to "which model", each with a reason. The live numbers
move with the platform, so re-running `demo.ts` will print different models — that is the
point: the health filter switches on its own.

`node --test agent.test.ts` covers the same behaviour offline (8 tests): three tiers routing
to three models, degraded models skipped, latency tie-breaks, image bump, classifier failure
falling back to the heuristic, 503 escalation, and an unreachable catalog.

## Files

| File | Purpose |
| --- | --- |
| `agent.ts` | the agent, deployed by Pollinations from this repository |
| `agent.test.ts` | offline tests with a fixture catalog |
| `demo.ts` | live routing demo against the real catalog and health feed |

## Deploy

1. Fork this repository.
2. In [My Models](https://enter.pollinations.ai/my-models) choose **Add Agent → Code agent**
   and enter your fork's URL. The repository name becomes the model ID.
3. Push to `main`; set the repository **variable** `POLLINATIONS_SYNC_URL` to
   `https://gen.pollinations.ai/account/agents/<agent-id>/sync` to auto-deploy.

```bash
npx @pollinations/cli agents create --config code-agent.json --visibility public
```

```json
{ "type": "code_agent", "repository": "https://github.com/Apollohzl/adaptive-router" }
```

[Agent guide](https://github.com/pollinations/pollinations/blob/main/BUILD_YOUR_OWN_AGENT.md)
