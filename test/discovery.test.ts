import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import { discover, modelFromEntry } from "../src/discovery.ts";
import { createStrataProvider } from "../src/provider.ts";

const config = { ...DEFAULTS, baseUrl: "http://strata.test/v1" };
// what Strata's GET /v1/models returns (serve/server.py), with an alias and the image model
const MODELS = {
  object: "list",
  data: [
    { id: "qwen3.8-flash-next-q2_0", object: "model", status: { value: "loaded" }, meta: { n_ctx: 200000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, aliases: ["qwen"] },
    { id: "qwen", object: "model", meta: { n_ctx: 200000 }, alias_of: "qwen3.8-flash-next-q2_0",
      architecture: { input_modalities: ["text", "image"] } },
    { id: "qwen-image", object: "model", status: { value: "loaded" } },
  ],
};
const STATUS = { service: "strata", model: "qwen3.8-flash-next-q2_0", concurrency: { serving: 1, requested: 1 } };

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>, seen: { url: string; auth?: string }[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const r = routes[u];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("a /v1/models entry becomes a pi model matching the server", () => {
  const m = modelFromEntry(MODELS.data[0], config)!;
  assert.equal(m.id, "qwen3.8-flash-next-q2_0");
  assert.equal(m.provider, "strata");
  assert.equal(m.api, "openai-completions");
  assert.equal(m.baseUrl, "http://strata.test/v1");
  assert.equal(m.contextWindow, 200000);
  assert.equal(m.maxTokens, 32768);
  assert.deepEqual(m.input, ["text", "image"]);
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.thinkingLevelMap, { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" });
  assert.equal(m.compat?.supportsReasoningEffort, true);
  assert.equal(m.compat?.thinkingFormat, undefined, "reasoning_effort, not a chat-template switch");
  assert.equal(modelFromEntry(MODELS.data[1], config), undefined, "an alias is not listed twice");
  assert.equal(modelFromEntry(MODELS.data[2], config), undefined, "the image model is not a chat model");
  const small = modelFromEntry({ id: "s", meta: { n_ctx: 8192 } }, config)!;
  assert.equal(small.maxTokens, 8192, "the output cap never exceeds the context");
  assert.deepEqual(small.input, ["text"]);
});

test("discover: models, Strata identity and auth", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const f = fakeFetch({ "http://strata.test/v1/models": { body: MODELS }, "http://strata.test/v1/status": { body: STATUS } }, seen);
  const d = await discover(config, { apiKey: "k", fetcher: f });
  assert.deepEqual(d.models.map(m => m.id), ["qwen3.8-flash-next-q2_0"]);
  assert.equal(d.strata, true);
  assert.equal(d.concurrency, 1);
  assert.deepEqual(d.warnings, []);
  assert.ok(seen.every(s => s.auth === "Bearer k"));
  const other = await discover(config, { fetcher: fakeFetch({ "http://strata.test/v1/models": { body: MODELS } }) });
  assert.equal(other.strata, false, "no /v1/status: not known to be Strata");
  await assert.rejects(discover(config, { fetcher: fakeFetch({ "http://strata.test/v1/models": { status: 401, body: {} } }) }),
    /HTTP 401.*STRATA_API_KEY/);
  await assert.rejects(discover(config, { fetcher: fakeFetch({ "http://strata.test/v1/models": { body: { data: "x" } } }) }), /data array/);
});

test("provider: startup discovery, refresh, and the stored catalog offline", async () => {
  const f = fakeFetch({ "http://strata.test/v1/models": { body: MODELS }, "http://strata.test/v1/status": { body: STATUS } });
  const { provider, status, prime } = createStrataProvider(config, { fetcher: f });
  assert.deepEqual(provider.getModels(), []);
  await prime();
  assert.equal(provider.getModels().length, 1);
  assert.equal(status.source, "startup");

  // offline: only a stored catalog for this endpoint is restored
  const offline = createStrataProvider(config, { fetcher: f });
  const stored = { models: [modelFromEntry(MODELS.data[0], config)!, { ...modelFromEntry(MODELS.data[0], config)!, id: "x", baseUrl: "http://elsewhere/v1" }], checkedAt: 1 };
  const publish = async (p: { update?: () => void }) => { p.update?.(); return true; };
  await offline.provider.refreshModels!({ stored, publish, allowNetwork: false, signal: new AbortController().signal } as any);
  assert.deepEqual(offline.provider.getModels().map(m => m.id), ["qwen3.8-flash-next-q2_0"]);
  assert.equal(offline.status.source, "cache");

  // live refresh persists what it found
  let persisted: unknown;
  const live = createStrataProvider(config, { fetcher: f });
  await live.provider.refreshModels!({ publish: async (p: any) => { persisted = p.persist; p.update?.(); return true; },
    allowNetwork: true, signal: new AbortController().signal } as any);
  assert.equal(live.status.source, "live");
  assert.equal((persisted as { models: unknown[] }).models.length, 1);
});

test("provider auth: a stored key, the environment, or none", async () => {
  const { provider } = createStrataProvider(config);
  const resolve = provider.auth.apiKey!.resolve;
  const ctx = (env: Record<string, string>) => ({ env: async (k: string) => env[k] }) as any;
  assert.equal((await resolve({ ctx: ctx({}), credential: { type: "api_key", key: "stored" } } as any))?.auth.apiKey, "stored");
  assert.equal((await resolve({ ctx: ctx({ STRATA_API_KEY: "envkey" }) } as any))?.auth.apiKey, "envkey");
  assert.equal((await resolve({ ctx: ctx({}) } as any))?.auth.apiKey, "strata-local");
});

test("withStrataFields: pi's own payload hook first, then Strata's fields", async () => {
  const { withStrataFields } = await import("../src/provider.ts");
  const seen: string[] = [];
  const inner = async (p: unknown) => ({ ...(p as object), temperature: 0 });
  const hook = withStrataFields(DEFAULTS, "minimal", inner, a => seen.push(a.kind));
  const out = await hook({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], reasoning_effort: "low" },
    {} as any) as Record<string, unknown>;
  assert.equal(out.temperature, 0, "pi's change is kept");
  assert.equal(out.reasoning_budget_tokens, 1024, "and Strata's field added");
  assert.deepEqual(seen, ["turn"]);
  assert.equal(await withStrataFields(DEFAULTS, undefined, undefined)("text", {} as any), undefined, "a non-object payload is left alone");
});

test("/login strata: the endpoint, then the API key", async () => {
  const cfg = { ...DEFAULTS, baseUrl: "http://old.test/v1" };
  const f = fakeFetch({ "http://new.test:9931/v1/models": { body: MODELS }, "http://new.test:9931/v1/status": { body: STATUS } });
  const saved: string[] = [];
  const { provider, status } = createStrataProvider(cfg, { fetcher: f, saveBaseUrl: async u => { saved.push(u); return u; } });
  const answers = ["not a url", "http://new.test:9931", "secret-key"];
  const asked: { type: string; message: string; placeholder?: string }[] = [];
  const told: string[] = [];
  const interaction = {
    signal: new AbortController().signal,
    prompt: async (p: any) => { asked.push(p); return answers.shift()!; },
    notify: (e: any) => told.push(e.message),
  };
  const credential = await provider.auth.apiKey!.login!(interaction as any);
  assert.deepEqual(asked.map(a => a.type), ["text", "text", "secret"], "an invalid URL is asked again");
  assert.equal(asked[0].message, "Strata endpoint (blank keeps http://old.test/v1)");
  assert.equal(asked[0].placeholder, "http://192.168.0.66:9931");
  assert.equal(asked[1].message, '"not a url" is not an http(s) URL. Strata endpoint (blank keeps http://old.test/v1)',
    "asked again with the reason");
  assert.deepEqual(saved, ["http://new.test:9931/v1"]);
  assert.equal(cfg.baseUrl, "http://new.test:9931/v1");
  assert.equal(provider.baseUrl, "http://new.test:9931/v1", "the provider follows the new endpoint");
  assert.deepEqual(credential, { type: "api_key", key: "secret-key" });
  assert.equal(status.models, 1);
  assert.equal(provider.getModels()[0].baseUrl, "http://new.test:9931/v1");
  assert.ok(told.some(m => /1 model\(s\) at http:\/\/new\.test:9931\/v1/.test(m)));

  // blank keeps the endpoint; a server that does not answer is reported, the login still completes
  const kept: string[] = [];
  const two = createStrataProvider({ ...DEFAULTS, baseUrl: "http://gone.test/v1" },
    { fetcher: fakeFetch({}), saveBaseUrl: async u => { kept.push(u); return u; } });
  const msgs: string[] = [];
  const c2 = await two.provider.auth.apiKey!.login!({ signal: new AbortController().signal,
    prompt: async () => "", notify: (e: any) => msgs.push(e.message) } as any);
  assert.deepEqual(kept, [], "nothing saved for a blank answer");
  assert.deepEqual(c2, { type: "api_key", key: undefined }, "a blank key: a server without one");
  assert.ok(msgs.some(m => m.startsWith("Saved, but")));
});
