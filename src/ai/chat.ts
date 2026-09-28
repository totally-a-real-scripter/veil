/**
 * AI chat assistant backend with multi-provider failover.
 *
 * Providers (Groq, Cerebras, Gemini, Mistral, OpenRouter, Ollama, or any
 * OpenAI-compatible API; see providers.ts) are tried in order. If one is
 * rate-limited, out of free quota, misconfigured, erroring, or slow to start
 * answering, the request moves on to the next one immediately, and the failed
 * provider "rests" for a cooldown (honouring Retry-After / rate-limit reset
 * headers where given) so later requests skip it until it has recovered.
 *
 *   GET  /__px/ai/status  -> { enabled, name, model, providers: [{ name, model, available }] }
 *   POST /__px/ai/chat    -> body { messages: [{ role, content }] }
 *                            response: NDJSON stream: {"p":"Groq"} (who is answering),
 *                            {"t":"text"} chunks, then {"done":true} or {"error":"..."}
 *
 * SECURITY
 *  - Upstream URLs and API keys come only from server configuration; the
 *    browser can't choose where requests go (so this is not an SSRF vector) and
 *    never sees a key.
 *  - Same-origin + custom-header CSRF guard, per-client hourly quota, global
 *    and per-client concurrency caps, input/history size limits, timeouts and a
 *    cap on the size of the streamed answer.
 *  - Only "user"/"assistant" messages are accepted; the system prompt is fixed
 *    server-side. Upstream error bodies are never relayed (they can contain
 *    account details); users get a generic message and operators get a log line.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AiConfig } from '../config.js';
import type { AiProvider } from './providers.js';
import { ConnectionCounter, RateLimiter } from '../security/limits.js';
import { log } from '../util/log.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_BODY = 256 * 1024;
const MAX_MESSAGES = 60;
/** Hard ceiling on streamed output, independent of the model's token limit. */
const MAX_OUTPUT_CHARS = 200_000;
const MIN = 60_000;

type Attempt =
  | { kind: 'ok' }
  | { kind: 'fail'; cooldownMs: number; reason: string }
  | { kind: 'partial' } // failed after text was already sent
  | { kind: 'aborted' };

/** Per-provider health: cooldown deadline and consecutive rate-limit strikes. */
class Health {
  private readonly until = new Map<string, number>();
  private readonly strikes = new Map<string, number>();

  available(id: string, now = Date.now()): boolean {
    return (this.until.get(id) ?? 0) <= now;
  }
  remainingMs(id: string, now = Date.now()): number {
    return Math.max(0, (this.until.get(id) ?? 0) - now);
  }
  penalize(id: string, ms: number): void {
    if (ms <= 0) return;
    this.until.set(id, Math.max(this.until.get(id) ?? 0, Date.now() + ms));
  }
  /** Rate-limit strike: back off 1, 2, 4 ... up to 60 minutes when no reset time is given. */
  strike(id: string): number {
    const n = (this.strikes.get(id) ?? 0) + 1;
    this.strikes.set(id, n);
    return Math.min(60 * MIN, MIN * 2 ** (n - 1));
  }
  success(id: string): void {
    this.strikes.delete(id);
    this.until.delete(id);
  }
}

export class AiService {
  private readonly quota: RateLimiter;
  private readonly slots: ConnectionCounter;
  private readonly health = new Health();
  private rr = 0;

  constructor(private readonly cfg: AiConfig) {
    // Bucket refills continuously to AI_REQUESTS_PER_HOUR per client.
    this.quota = new RateLimiter(cfg.requestsPerHour / 60, cfg.requestsPerHour);
    this.slots = new ConnectionCounter(cfg.maxConcurrent, 1);
  }

  status(): { enabled: boolean; name: string; model: string; providers: { name: string; model: string; available: boolean }[] } {
    const ps = this.cfg.enabled ? this.cfg.providers : [];
    const model =
      ps.length === 0 ? '' : ps.length === 1 ? `${ps[0]!.name} · ${ps[0]!.model}` : `Auto · ${ps.length} providers`;
    return {
      enabled: this.cfg.enabled,
      name: this.cfg.name,
      model,
      providers: ps.map((p) => ({ name: p.name, model: p.model, available: this.health.available(p.id) })),
    };
  }

  stop(): void {
    this.quota.stop();
  }

  /** Providers to try for this request, healthy ones first in strategy order. */
  private plan(): AiProvider[] {
    let list = this.cfg.providers.slice();
    if (this.cfg.strategy === 'round-robin' && list.length > 1) {
      const k = this.rr++ % list.length;
      list = [...list.slice(k), ...list.slice(0, k)];
    }
    const now = Date.now();
    const healthy = list.filter((p) => this.health.available(p.id, now));
    if (healthy.length > 0) return healthy;
    // Everyone is resting: try the one that recovers soonest if that's imminent.
    const soonest = list.sort((a, b) => this.health.remainingMs(a.id, now) - this.health.remainingMs(b.id, now))[0];
    return soonest && this.health.remainingMs(soonest.id, now) < 15_000 ? [soonest] : [];
  }

  async handleChat(req: IncomingMessage, res: ServerResponse, clientKey: string): Promise<void> {
    if (!this.cfg.enabled) return sendJson(res, 404, { error: 'The AI assistant is not configured on this server.' });

    const wait = this.quota.take(clientKey);
    if (wait > 0) {
      res.setHeader('retry-after', String(wait));
      return sendJson(res, 429, { error: `You've reached the AI message limit. Try again in about ${formatWait(wait)}.` });
    }

    let messages: ChatMessage[];
    try {
      messages = validateMessages(await readJson(req), this.cfg);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request.' });
    }

    const release = this.slots.tryAcquire(clientKey);
    if (!release) return sendJson(res, 429, { error: 'Please wait for the current answer to finish.' });

    const overall = new AbortController();
    const timer = setTimeout(() => overall.abort(new Error('timeout')), this.cfg.timeoutMs);
    res.on('close', () => {
      if (!res.writableFinished) overall.abort(new Error('client closed'));
    });

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no', // don't let Nginx buffer the stream
    });
    const emit = (obj: unknown) => {
      if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
    };

    try {
      const plan = this.plan();
      if (plan.length === 0) {
        const soonest = Math.min(...this.cfg.providers.map((p) => this.health.remainingMs(p.id)));
        emit({ error: `All AI providers are at their free limits right now. Try again in about ${formatWait(Math.ceil(soonest / 1000))}.` });
        return;
      }
      let lastReason = '';
      for (const provider of plan) {
        if (overall.signal.aborted) break;
        const r = await this.attempt(provider, messages, overall.signal, emit);
        if (r.kind === 'ok') {
          this.health.success(provider.id);
          emit({ done: true });
          return;
        }
        if (r.kind === 'aborted' || r.kind === 'partial') {
          if (r.kind === 'partial') this.health.penalize(provider.id, 30_000);
          break;
        }
        this.health.penalize(provider.id, r.cooldownMs);
        lastReason = r.reason;
        log.warn('ai provider failed, trying next', {
          provider: provider.id,
          reason: r.reason,
          restSeconds: Math.round(r.cooldownMs / 1000),
        });
      }
      if (overall.signal.aborted) {
        if (!res.destroyed && String(overall.signal.reason ?? '').includes('timeout')) {
          emit({ error: 'The AI took too long to answer. Please try again.' });
        }
        return;
      }
      if (lastReason) emit({ error: userMessage(lastReason) });
    } finally {
      clearTimeout(timer);
      release();
      res.end();
    }
  }

  /** One provider attempt. Text is streamed to the client as soon as it arrives. */
  private async attempt(
    p: AiProvider,
    messages: ChatMessage[],
    overall: AbortSignal,
    emit: (o: unknown) => void,
  ): Promise<Attempt> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(overall.reason);
    overall.addEventListener('abort', onAbort, { once: true });
    // Fail over if the provider doesn't start answering in time.
    let started = false;
    const firstToken = setTimeout(() => {
      if (!started) ctrl.abort(new Error('slow'));
    }, this.cfg.attemptTimeoutMs);

    try {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...p.extraHeaders,
          ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: p.model,
          stream: true,
          max_tokens: this.cfg.maxTokens,
          temperature: this.cfg.temperature,
          messages: [{ role: 'system', content: this.cfg.systemPrompt }, ...messages],
          ...p.extraBody,
        }),
        signal: ctrl.signal,
        redirect: 'error',
      });

      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        return { kind: 'fail', ...classify(res.status, res.headers, detail, this.health, p.id) };
      }

      let produced = 0;
      for await (const delta of streamDeltas(res.body)) {
        if (!started) {
          started = true;
          clearTimeout(firstToken);
          emit({ p: p.name, m: p.model });
        }
        produced += delta.length;
        if (produced > MAX_OUTPUT_CHARS) {
          emit({ error: 'The answer was too long and was cut off.' });
          ctrl.abort();
          return { kind: 'partial' };
        }
        emit({ t: delta });
      }
      if (!started) return { kind: 'fail', cooldownMs: 0, reason: 'empty answer' };
      return { kind: 'ok' };
    } catch (err) {
      if (overall.aborted) return { kind: 'aborted' };
      if (started) {
        log.warn('ai stream interrupted', { provider: p.id, err: err instanceof Error ? err.message : String(err) });
        emit({ error: 'The answer was interrupted. Ask again to continue.' });
        return { kind: 'partial' };
      }
      const slow = String(ctrl.signal.reason ?? '').includes('slow');
      return {
        kind: 'fail',
        cooldownMs: slow ? 2 * MIN : 30_000,
        reason: slow ? 'no response in time' : `network: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(firstToken);
      overall.removeEventListener('abort', onAbort);
    }
  }
}

/** Decide how long a failed provider should rest, from its HTTP status and headers. */
export function classify(
  status: number,
  headers: Headers,
  detail: string,
  health: { strike(id: string): number },
  id: string,
): { cooldownMs: number; reason: string } {
  const body = detail.toLowerCase();
  if (status === 429) {
    const reset = resetMs(headers);
    // "per day" / quota exhaustion messages: rest much longer.
    const daily = /per day|daily|quota|exhausted|rpd|tpd/.test(body);
    const fallback = health.strike(id);
    return { cooldownMs: reset ?? (daily ? Math.max(fallback, 60 * MIN) : fallback), reason: `rate limited (${status})` };
  }
  if (status === 402) return { cooldownMs: 60 * MIN, reason: 'out of credits (402)' };
  if (status === 401 || status === 403) return { cooldownMs: 30 * MIN, reason: `key rejected (${status})` };
  if (status === 404) return { cooldownMs: 30 * MIN, reason: 'model not found (404)' };
  if (status === 413) return { cooldownMs: 0, reason: 'request too large (413)' };
  if (status === 400 || status === 422) return { cooldownMs: 2 * MIN, reason: `rejected request (${status})` };
  if (status === 408 || status >= 500) return { cooldownMs: 30_000, reason: `server error (${status})` };
  return { cooldownMs: MIN, reason: `unexpected status (${status})` };
}

/**
 * Parse a reset time from Retry-After or common rate-limit headers
 * (x-ratelimit-reset-requests / -tokens: "2m59.56s", "7.66s", "120").
 */
export function resetMs(headers: Headers): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return clampReset(secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return clampReset(date - Date.now());
  }
  let best: number | undefined;
  for (const h of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset']) {
    const v = headers.get(h);
    if (!v) continue;
    const ms = parseDuration(v);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best === undefined ? undefined : clampReset(best);
}

function parseDuration(v: string): number | undefined {
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    // Unix timestamps (seconds or ms) vs. plain seconds.
    if (n > 1e12) return n - Date.now();
    if (n > 1e9) return n * 1000 - Date.now();
    return n * 1000;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(t);
  if (!m || !t) return undefined;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000 + Number(m[4] ?? 0);
}

function clampReset(ms: number): number {
  return Math.min(Math.max(ms, 1_000), 24 * 60 * MIN);
}

function userMessage(reason: string): string {
  if (reason.startsWith('rate limited') || reason.startsWith('out of credits')) {
    return 'The free AI limits have been reached for now. Please try again in a few minutes.';
  }
  if (reason.startsWith('key rejected') || reason.startsWith('model not found')) {
    return 'The AI service is misconfigured. The site owner needs to check the AI settings.';
  }
  if (reason.startsWith('request too large')) return 'This conversation is too long for the AI. Start a new chat.';
  if (reason === 'no response in time') return 'The AI took too long to respond. Please try again.';
  return 'Could not get an answer from the AI service. Please try again shortly.';
}

/** Parse an OpenAI-style SSE stream and yield the text deltas. */
export async function* streamDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const obj = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[]; error?: unknown };
        if (obj.error) throw new Error('upstream stream error');
        const text = obj.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text) yield text;
      } catch (e) {
        if (e instanceof Error && e.message === 'upstream stream error') throw e;
        /* ignore keep-alive / malformed lines */
      }
    }
    if (buf.length > 1_000_000) throw new Error('upstream line too long');
  }
}

export function validateMessages(body: unknown, cfg: Pick<AiConfig, 'maxInputChars' | 'maxHistoryChars'>): ChatMessage[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { messages?: unknown }).messages)) {
    throw new Error('Expected a list of messages.');
  }
  const raw = (body as { messages: unknown[] }).messages;
  if (raw.length === 0) throw new Error('Type a message first.');
  if (raw.length > MAX_MESSAGES * 4) throw new Error('This conversation is too long. Start a new chat.');
  const msgs: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') throw new Error('Invalid message.');
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') throw new Error('Invalid message role.');
    if (typeof content !== 'string') throw new Error('Invalid message content.');
    // Strip control characters other than tab/newline.
    const clean = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!clean) continue;
    msgs.push({ role, content: clean });
  }
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') throw new Error('The last message must be from you.');
  if (last.content.length > cfg.maxInputChars) {
    throw new Error(`Messages are limited to ${cfg.maxInputChars.toLocaleString('en-US')} characters.`);
  }
  // Keep the most recent history that fits the budget (always keep the last message).
  const kept: ChatMessage[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    const m = msgs[i]!;
    const len = Math.min(m.content.length, cfg.maxInputChars * 4);
    if (kept.length > 0 && total + len > cfg.maxHistoryChars) break;
    kept.unshift({ role: m.role, content: m.content.slice(0, cfg.maxInputChars * 4) });
    total += len;
  }
  // Chat APIs expect the conversation to start with a user turn.
  while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift();
  return kept;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('Message is too large.');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid request.');
  }
}


function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
