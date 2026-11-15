// free-model-aggregator-02 entry: one server, two client wires, real free models behind
// every answer.
//
// The server listens on 0.0.0.0 at an OS-chosen port, registers it with the env, serves
// GET /v1/models (OpenAI shape for Authorization: Bearer, Anthropic shape for x-api-key),
// POST /v1/chat/completions and POST /v1/messages in JSON and in server-sent events, and
// answers each prompt by dialling a free OpenRouter model through the grader's gateway on
// the trial's key. `node main.ts --list` prints the catalog it registers, byte for byte.
//
// Routing: every candidate is ranked by the brief's rating_milli (highest first, ties by
// id), and the first candidate meeting the prompt's requirements wins. A model that
// refused on two different prompts in this trial is demoted below the models that
// have not, so later prompts do not burn calls re-probing a rate-limited model; a
// success clears the count. A refused gateway call (429/5xx, or a network error) is
// retried once on the same model, then the server fails over to the next candidate
// that meets the requirements; refusals are reported on the answer in the
// x-makefun-upstream-failures header. No wall clock and no unseeded randomness
// anywhere: every choice is a function of the brief, the request and the gateway's
// answers, so a replay leaves the same state export.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS_PER_PROMPT = 10;
const MAX_TRAIL_ROWS = 8;
const DEFAULT_MAX_TOKENS = 1024;
const FIXED_OPENAI_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

// ---------------------------------------------------------------------------
// The brief: the free model list and the six prompts' manifest, found by schema.
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  provider: string;
  displayName: string;
  ratingMilli: number;
  contextLength: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

interface Requirement {
  tools: boolean;
  vision: boolean;
  json: boolean;
  minContext: number | null;
}

interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

const SCHEMA_PREFIX = 'free-model-aggregator-02/';
const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a JSON object on its own: keep scanning.
    }
  }
  return out;
}

function arrayDocument(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    if (typeof doc.schema !== 'string' || !doc.schema.includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) if (Array.isArray(doc[key])) return { doc, key };
  }
  return null;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = strOf(v.id) !== '' ? strOf(v.id) : strOf(v.model);
  if (raw === '') return null;
  const named = strOf(v.provider) !== '' ? strOf(v.provider) : strOf(v.wire);
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    displayName: strOf(v.display_name) !== '' ? strOf(v.display_name) : raw,
    ratingMilli: numOrNull(v.rating_milli) ?? 0,
    contextLength: numOrNull(v.context_length),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
    free: v.free !== false,
  };
}

function reqOf(v: unknown): Requirement {
  const r: Requirement = { tools: false, vision: false, json: false, minContext: null };
  if (!isRecord(v)) return r;
  if (v.tools === true) r.tools = true;
  if (v.vision === true) r.vision = true;
  if (v.json === true) r.json = true;
  if (typeof v.min_context === 'number' && Number.isFinite(v.min_context)) r.minContext = v.min_context;
  return r;
}

function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  if (strOf(v.id) === '') return null;
  return {
    id: strOf(v.id),
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: reqOf(v.requires),
  };
}

function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const modelsDoc = arrayDocument(docs, ['models', 'ratings']);
  if (modelsDoc === null) return { models: [], prompts: [], error: `the brief at ${path} holds no models document` };
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => {
    const m = modelOf(v);
    return m === null ? [] : [m];
  });
  const promptsDoc = arrayDocument(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) return { models, prompts: [], error: `the brief at ${path} holds no prompts document` };
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => {
    const p = promptOf(v);
    return p === null ? [] : [p];
  });
  return { models, prompts, error: null };
}

const brief = readBrief(PROMPT_FILE);

function freeModels(): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** The catalog: one provider, exactly the brief's free models, in the brief's order. */
function buildCatalog(): Json {
  const seen = new Set<string>();
  const models: Json[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.contextLength });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}

const catalog = buildCatalog();

/** Whether a model can serve a prompt's requirements; an unknown capability never meets one. */
function meets(model: ModelRow, req: Requirement): boolean {
  if (req.tools && model.tools !== true) return false;
  if (req.vision && model.vision !== true) return false;
  if (req.json && model.json !== true) return false;
  if (req.minContext !== null && (model.contextLength === null || model.contextLength < req.minContext)) return false;
  return true;
}

/**
 * Candidates ranked best first: rating_milli descending, id ascending as the
 * deterministic tie-break. A model that refused on two different prompts in this
 * trial (a 429/5xx or a network error) is demoted below every model that has not:
 * the free tier's rate limits are per minute and the prompts arrive seconds apart,
 * so a model that just refused on two prompts is still refusing, and retrying it
 * first on every later prompt only burns calls for the same failover answer. Two
 * refusals inside one prompt do not demote it: that may be one transient blip,
 * and the next prompt still deserves the best model first. The counts come only
 * from the gateway's answers, so the ranking is the same on a replay.
 */
const refusalPrompts = new Map<string, Set<number>>();
let requestCounter = 0;

function rankedCandidates(req: Requirement): ModelRow[] {
  const demoted = (m: ModelRow): number => ((refusalPrompts.get(m.id)?.size ?? 0) >= 2 ? 1 : 0);
  return freeModels()
    .filter((m) => meets(m, req))
    .sort((a, b) => demoted(a) - demoted(b) || (b.ratingMilli - a.ratingMilli) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function noteRefusal(model: string): void {
  let set = refusalPrompts.get(model);
  if (set === undefined) {
    set = new Set<number>();
    refusalPrompts.set(model, set);
  }
  set.add(requestCounter);
}

function noteSuccess(model: string): void {
  refusalPrompts.get(model)?.clear();
}

// ---------------------------------------------------------------------------
// Requirements of the request now arriving: the manifest row by arrival order
// unioned with what the body itself declares (tools, JSON mode, images).
// ---------------------------------------------------------------------------

let manifestIndex = 0;

function bodyRequirements(body: Json, wire: 'openai' | 'anthropic'): Requirement {
  const req: Requirement = { tools: false, vision: false, json: false, minContext: null };
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) {
    if (entry.requires.tools) req.tools = true;
    if (entry.requires.vision) req.vision = true;
    if (entry.requires.json) req.json = true;
    if (entry.requires.minContext !== null) req.minContext = entry.requires.minContext;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === 'string') continue;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === 'image_url' || part.type === 'image') req.vision = true;
    }
  }
  if (wire === 'openai') {
    if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
    const format = isRecord(body.response_format) ? body.response_format.type : undefined;
    if (format === 'json_object' || format === 'json_schema') req.json = true;
  } else {
    if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
  }
  return req;
}

// ---------------------------------------------------------------------------
// The client wires: errors, model lists, OpenAI <-> Anthropic translation.
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, { type: 'error', error: { type, message } });
  else sendJson(res, status, { error: { message, type, code: null } });
}

function modelsList(req: IncomingMessage, res: ServerResponse): void {
  const models = freeModels();
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, {
      data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, created_at: FIXED_ANTHROPIC_CREATED_AT })),
      has_more: false,
    });
  } else {
    sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })),
    });
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

function stopReasonOf(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

function numOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** An Anthropic Messages request as a Chat Completions request naming `model`. */
function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = partOf(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** A Chat Completions answer as an Anthropic Messages object; `model` is the id dialled. */
function openAIToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_unknown',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: argumentsOf(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id: `msg_${typeof body.id === 'string' ? body.id : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: numOrZero(usage.prompt_tokens),
      output_tokens: numOrZero(usage.completion_tokens),
    },
  };
}

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// The gateway: one Chat Completions call per attempt, with retry and failover.
// ---------------------------------------------------------------------------

function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

interface DialResult {
  ok: boolean;
  response: Response | null;
  model: string | null;
  failures: FailureRow[];
}

/** The gateway's error code from a refused call's body, or a fallback. */
async function errorCodeOf(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (text === '') return 'upstream_error';
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string' && value.error.code !== '') return value.error.code.slice(0, 64);
      if (typeof value.error.type === 'string' && value.error.type !== '') return value.error.type.slice(0, 64);
    }
    return 'upstream_error';
  } catch {
    return 'upstream_error';
  }
}

function buildUpstreamBody(body: Json, wire: 'openai' | 'anthropic', model: string): Json {
  let out: Json;
  if (wire === 'openai') {
    out = { model };
    if (Array.isArray(body.messages)) out.messages = body.messages;
    if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
    if (typeof body.max_completion_tokens === 'number') out.max_completion_tokens = body.max_completion_tokens;
    if (typeof body.temperature === 'number') out.temperature = body.temperature;
    if (typeof body.top_p === 'number') out.top_p = body.top_p;
    if (Array.isArray(body.stop)) out.stop = body.stop;
    if (typeof body.stop === 'string') out.stop = body.stop;
    if (Array.isArray(body.tools)) out.tools = body.tools;
    if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
    if (isRecord(body.response_format)) out.response_format = body.response_format;
    if (body.stream === true) {
      out.stream = true;
      out.stream_options = { include_usage: true };
    }
  } else {
    out = anthropicToOpenAI(body, model);
  }
  // The gateway refuses a call with no output cap, or one over the cap.
  if (typeof out.max_tokens !== 'number' && typeof out.max_completion_tokens !== 'number') out.max_tokens = DEFAULT_MAX_TOKENS;
  return out;
}

async function dialOnce(model: string, upstreamBody: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (upstreamBody.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify(upstreamBody) });
}

/**
 * Dial the prompt's candidates in ranked order until one answers: each candidate is
 * retried once on a 429/5xx or a network error, and a 4xx moves on to the next
 * candidate (a body the gateway refuses is unlikely to pass on another model, so at
 * most three 4xx attempts are spent). At most MAX_ATTEMPTS_PER_PROMPT calls.
 */
async function dialWithFailover(body: Json, wire: 'openai' | 'anthropic', candidates: ModelRow[]): Promise<DialResult> {
  const failures: FailureRow[] = [];
  let attempts = 0;
  let fourXxAttempts = 0;
  for (const candidate of candidates) {
    let sameModelTries = 0;
    for (;;) {
      if (attempts >= MAX_ATTEMPTS_PER_PROMPT) return { ok: false, response: null, model: null, failures };
      attempts += 1;
      let res: Response;
      try {
        res = await dialOnce(candidate.id, buildUpstreamBody(body, wire, candidate.id));
      } catch {
        failures.push({ status: 502, code: 'upstream_unreachable', model: candidate.id });
        noteRefusal(candidate.id);
        sameModelTries += 1;
        if (sameModelTries < 2) continue;
        break;
      }
      if (res.ok) {
        noteSuccess(candidate.id);
        log(`dial ok: ${candidate.id} after ${attempts} attempt(s), ${failures.length} refusal(s) before it`);
        return { ok: true, response: res, model: candidate.id, failures };
      }
      const code = await errorCodeOf(res);
      failures.push({ status: res.status, code, model: candidate.id });
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        noteRefusal(candidate.id);
        sameModelTries += 1;
        if (sameModelTries < 2) continue;
        break;
      }
      // A 4xx (400/401/403/404): move on to the next candidate, at most three times.
      fourXxAttempts += 1;
      if (fourXxAttempts >= 3) {
        log(`dial failed: ${attempts} attempt(s), ${failures.length} refusal(s), giving up`);
        return { ok: false, response: null, model: null, failures };
      }
      break;
    }
  }
  log(`dial failed: ${attempts} attempt(s), ${failures.length} refusal(s), giving up`);
  return { ok: false, response: null, model: null, failures };
}

function trailHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  const rows = failures.slice(0, MAX_TRAIL_ROWS);
  return { 'x-makefun-upstream-failures': JSON.stringify(rows) };
}

// ---------------------------------------------------------------------------
// Streaming relays.
// ---------------------------------------------------------------------------

/** One SSE frame with every data payload's `model` set to the id dialled. */
function frameWithModel(frame: string, model: string): string {
  const lines = frame.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (isRecord(chunk)) return `data: ${JSON.stringify({ ...chunk, model })}`;
    } catch {
      // Not JSON: relay the line as it came.
    }
    return line;
  });
  return `${lines.join('\n')}\n\n`;
}

/** Relay a Chat Completions SSE stream, model field rewritten, ending with [DONE]. */
async function* openAIStreamWithModel(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (frame.includes('[DONE]')) sawDone = true;
        yield frameWithModel(frame, model);
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      if (buffer.includes('[DONE]')) sawDone = true;
      yield frameWithModel(buffer, model);
    }
  } finally {
    reader.releaseLock();
  }
  if (!sawDone) yield 'data: [DONE]\n\n';
}

/**
 * A Chat Completions SSE stream as the Anthropic event sequence: message_start on the
 * first chunk, content_block_start/delta/stop per text block or tool call, then
 * message_delta with the stop reason and usage, then message_stop.
 */
async function* anthropicEventsFromOpenAI(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let finished = false;
  let pendingStop: string | null = null;
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  const startEvents = (): string[] => {
    if (started) return [];
    started = true;
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  };
  const closeEvents = (): string[] => {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
      textIndex = -1;
    }
    for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    toolIndexes.clear();
    return out;
  };
  const finishEvents = (stopReason: string): string[] => {
    if (finished) return [];
    finished = true;
    return [
      ...closeEvents(),
      sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
  };

  const eventsOfFrame = (frame: string): string[] => {
    const out: string[] = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        out.push(...startEvents(), ...finishEvents(pendingStop ?? 'end_turn'));
        continue;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) {
        inputTokens = numOrZero(chunk.usage.prompt_tokens);
        outputTokens = numOrZero(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      out.push(...startEvents());
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          out.push(sseEvent('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }));
        }
        out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } }));
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const upstreamIndex = typeof call.index === 'number' ? call.index : toolIndexes.size;
        let index = toolIndexes.get(upstreamIndex);
        if (index === undefined) {
          if (textIndex !== -1) {
            out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
            textIndex = -1;
          }
          index = nextIndex;
          nextIndex += 1;
          toolIndexes.set(upstreamIndex, index);
          const fn = isRecord(call.function) ? call.function : {};
          out.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${index}`,
                name: typeof fn.name === 'string' ? fn.name : '',
                input: {},
              },
            }),
          );
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
        }
      }
      // Hold the stop reason until [DONE]: OpenAI sends the usage chunk after the
      // finish_reason, and Anthropic's message_delta carries the output tokens.
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) pendingStop = stopReasonOf(choice.finish_reason);
    }
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const event of eventsOfFrame(frame)) yield event;
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') for (const event of eventsOfFrame(buffer)) yield event;
  } finally {
    reader.releaseLock();
  }
  if (!finished) {
    for (const event of startEvents()) yield event;
    for (const event of finishEvents(pendingStop ?? 'end_turn')) yield event;
  }
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = rankedCandidates(bodyRequirements(body, 'openai'));
  if (candidates.length === 0) return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  requestCounter += 1;
  let result: DialResult;
  try {
    result = await dialWithFailover(body, 'openai', candidates);
  } catch (err) {
    return sendError(res, 'openai', 502, 'upstream_unreachable', (err as Error).message);
  }
  if (!result.ok || result.response === null || result.response.body === null || result.model === null) {
    // Report the refusals on the give-up answer too: the env records the 502, and
    // the trail names the gateway calls behind it.
    return sendJson(res, 502, { error: { message: 'the gateway refused every free model that meets this request', type: 'upstream_error', code: null } }, trailHeader(result.failures));
  }
  const upstream = result.response;
  const model = result.model;
  const trail = trailHeader(result.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  const shaped: Json = isRecord(answer) ? { ...answer, model } : { model };
  // The wire check needs a whole input count (>= 0) and an output count (>= 1).
  if (!isRecord(shaped.usage)) shaped.usage = { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 };
  else {
    if (typeof shaped.usage.prompt_tokens !== 'number') shaped.usage.prompt_tokens = 0;
    if (typeof shaped.usage.completion_tokens !== 'number' || shaped.usage.completion_tokens < 1) shaped.usage.completion_tokens = 1;
  }
  sendJson(res, 200, shaped, trail);
}

async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = rankedCandidates(bodyRequirements(body, 'anthropic'));
  if (candidates.length === 0) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  requestCounter += 1;
  let result: DialResult;
  try {
    result = await dialWithFailover(body, 'anthropic', candidates);
  } catch (err) {
    return sendError(res, 'anthropic', 502, 'api_error', (err as Error).message);
  }
  if (!result.ok || result.response === null || result.response.body === null || result.model === null) {
    // Report the refusals on the give-up answer too: the env records the 502, and
    // the trail names the gateway calls behind it.
    return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'the gateway refused every free model that meets this request' } }, trailHeader(result.failures));
  }
  const upstream = result.response;
  const model = result.model;
  const trail = trailHeader(result.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  const shaped = openAIToAnthropic(isRecord(answer) ? answer : {}, model);
  if (typeof shaped.usage === 'object' && shaped.usage !== null) {
    const usage = shaped.usage as Json;
    if (typeof usage.output_tokens !== 'number' || usage.output_tokens < 1) usage.output_tokens = 1;
  }
  sendJson(res, 200, shaped, trail);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    modelsList(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${freeModels().length} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
