# BUILD_LOG — free-model-aggregator-02

Built 2026-11-15 (WIB) in a fresh session, from the kit spec only
(`RULES.txt`, `competition.yaml`, `practice/*/input/prompt.txt`,
`program/env/server.mjs`, `program/scorer/score.mjs`). No file under
`~/workspace/makefun/entries/` was opened, read or copied; the starter was
used as a shape reference only, and every line of `main.ts` was written fresh
in this session (v1, then a genuine revision v2).

## v1 — first full server

Single self-contained `main.ts` (Node 22, stdlib only):

- Brief parser: finds the models/prompts JSON documents by schema prefix,
  tolerates the sibling contest's key spellings.
- Catalog: exactly the brief's 14 free models, one provider (`openrouter`,
  public base URL, `OPENROUTER_API_KEY`, wire `openai`); `--list` prints the
  same document the register body carries.
- Routing: candidates ranked by `rating_milli` desc, id asc; requirements are
  the manifest row (by arrival order) unioned with the body's own signals.
  JSON-mode prompts route to `nvidia/nemotron-3.5-super-vl:free` (1303, best
  JSON-capable); everything else to `thinkingmachines/inkling-2-small:free`
  (1475, best overall).
- Both wires in JSON and SSE; Anthropic requests translated to Chat
  Completions and back (system prompt, images, tools, tool results, tool
  choice, stop reasons, usage); the dialled id is put back on every answer
  and every streamed chunk.
- Failover: 429/5xx/network retried once on the same model, then the next
  candidate; at most 10 gateway calls per prompt; refusals reported in
  `x-makefun-upstream-failures` (max 8 rows).
- Register + `GET /work` poll every 100 ms, exit 0 on done.

## v2 — revision

- A model that refused on two *different* prompts is demoted below the
  models that have not (two refusals inside one prompt do not demote it);
  a success clears the demotion. Derived only from gateway answers, so
  replay-identical. This saves calls when a model is persistently
  rate-limited without costing quality when it recovers.
- Dial outcomes logged to stderr (model, attempts, refusals).
- The refusal trail is also carried on a give-up 502 answer.

## Validation — local harness (kit env + sealed scorer, stub gateway)

The harness (`/tmp/harness/`: stub gateway mimicking the real gateway's
validation/answers/cassette, plus a runner driving `program/env/server.mjs`
and `program/scorer/score.mjs`) is not part of the entry. The stub answers
with canned completions carrying each prompt's token; no real OpenRouter key
exists in this environment, so live-model behaviour is validated against the
stub, not the real provider.

| Run | Score | quality | served | wire | failover | catalog | calls | valid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trial-0 clean (v1) | 100 | 100 | 100 | 100 | 100 | 100 | 6 | 6/6 |
| trial-0 clean (v2) | 100 | 100 | 100 | 100 | 100 | 100 | 6 | 6/6 |
| trial-1 clean (v2) | 100 | 100 | 100 | 100 | 100 | 100 | 6 | 6/6 |
| trial-2 clean (v2) | 100 | 100 | 100 | 100 | 100 | 100 | 6 | 6/6 |
| trial-0, inkling 429 once | 100 | 100 | 100 | 100 | 100 | 100 | 6 ok / 7 total | 6/6 |
| trial-0, inkling 429 x2 + super-vl 500 x1 | 98 | 96 | 100 | 100 | 100 | 100 | 6 ok / 9 total | 6/6 |
| trial-0, inkling 429 always | 94 | 90 | 100 | 100 | 100 | 100 | 6 ok / 10 total | 6/6 |
| trial-0, top 5 models 500 always | 69 | 61 | 83 | 80 | 66 | 100 | 5 ok / 25 total | 5/6 |

`real_model` check passed on every run. The entry exits 0 in all runs,
including the catastrophic-failure run.

## Determinism

- trial-0 clean, two runs: state export sha256 identical
  (`0a1a9218987fff6f62879e6e78ee06b83ed7b3bef6fc47ac34e8180f854c81cb`),
  same for v1 and v2.
- trial-0 with transient failures, v1 vs v2: identical state export sha256
  (`504659c90c72cded6420cda7ae0ca0b5dafc8ae04ea2d61084c2cd36c5185c42`).
- trial-0 with persistent inkling 429, two runs: identical state export
  sha256 (`45833bd381234584f383214ba2bd832f5f3581c3958e721d8a3ab046c4d0b9a5`).
- `--list` output is byte-for-byte the catalog in the register body
  (verified against the state export), and both `GET /v1/models` answers
  list exactly the 14 ids.

## Known limits

- Practice validation runs against the stub gateway, not live OpenRouter
  models: the real trial's model behaviour (latency, token echo, JSON-mode
  compliance) is untested here, by design of this environment (no pushed
  OpenRouter key).
- The entry was exercised on Node v24.22.1 (this machine); the trial runs
  Node 22. The code uses only stable APIs present in Node 22 (fetch,
  `AbortSignal.timeout`, async generators, `node:http`) and only erasable
  TypeScript syntax (interfaces, inline `type` imports, `as` casts).
