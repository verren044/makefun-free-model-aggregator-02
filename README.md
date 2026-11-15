# free-model-aggregator-02

One server that puts OpenRouter's fourteen free models behind a single
OpenAI- and Anthropic-compatible endpoint, and answers every prompt with a real
completion from a live free model dialled through the grader's gateway.

## Run

```sh
node main.ts            # trial mode: reads MAKEFUN_PROMPT_FILE, registers with
                        # MAKEFUN_ENV_URL, serves, exits 0 when /work says done
node main.ts --list     # print the catalog document and exit 0
```

Node 22, standard library only. No install step, no API key in the repository:
the trial's dummy key comes from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and the
gateway swaps it for the entrant's pushed OpenRouter key.

## What it serves

- `POST /v1/chat/completions` — OpenAI Chat Completions, JSON and SSE streaming
- `POST /v1/messages` — Anthropic Messages, JSON and SSE streaming (translated
  to Chat Completions upstream and back)
- `GET /v1/models` — OpenAI shape for `Authorization: Bearer`, Anthropic shape
  for `x-api-key`; both list exactly the fourteen free ids

## Routing

Candidates are ranked by the brief's `rating_milli` (highest first, ties by
id) and the first one meeting the prompt's requirements wins — so JSON-mode
prompts go to the best JSON-capable free model and everything else to the
best-rated free model overall. Requirements come from the brief's manifest row
for the prompt (by arrival order) unioned with what the body itself declares
(tools, `response_format`, image parts).

## Failover

A 429/5xx or network error is retried once on the same model, then the server
fails over to the next candidate that meets the requirements (at most 10
gateway calls per prompt). A model that refused on two different prompts is
demoted below the models that have not, so later prompts stop burning calls
re-probing a rate-limited model; a success clears the demotion. Refusals are
reported on the answer in the `x-makefun-upstream-failures` header (at most 8
rows of `{"status","code","model"}`), including on a give-up 502.

## Determinism

Every choice is a function of the brief, the requests and the gateway's
answers: no wall clock, no unseeded randomness. The catalog is built once from
the brief, so `node main.ts --list` prints byte for byte what the register
body carries, and a replay leaves the same state export.

## Files

- `main.ts` — the whole server (brief parsing, catalog, routing, both wires,
  streaming relays, failover, register + `/work` polling)
- `LICENSE` — MIT
- `BUILD_LOG.md` — how it was built and validated
