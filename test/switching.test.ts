import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, mergeConfig } from "../src/config.ts";
import { discover } from "../src/discovery.ts";
import { describeVariants, fetchVariants, loadVariant, parseVariants, variantOf } from "../src/switching.ts";

const config = { ...DEFAULTS, baseUrl: "http://strata.test/v1" };
// what the fork's GET /v1/models and /v1/status return with "models" (serve/server.py models_listing, Models.view)
const entry = (id: string, variant: string, loaded: boolean, extra: Record<string, unknown> = {}) => ({
  id, object: "model", status: { value: loaded ? "loaded" : "unloaded" },
  meta: { n_ctx: 200000, variant, default: false },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, ...extra,
});
const MODELS = {
  object: "list",
  data: [
    entry("qwen3.8-flash-next-q2_0", "q2", true, { aliases: ["q2", "qwen"] }),
    { ...entry("q2", "q2", true), alias_of: "qwen3.8-flash-next-q2_0" },
    entry("qwen3.8-flash-next-iq3_xxs", "q3", false, { aliases: ["q3"] }),
    { ...entry("q3", "q3", false), alias_of: "qwen3.8-flash-next-iq3_xxs" },
  ],
};
const VIEW = {
  active: "q2", default: null, committed: null,
  variants: { q2: "qwen3.8-flash-next-q2_0", q3: "qwen3.8-flash-next-iq3_xxs" },
  saved: ["q3"], switches: 2, switch_s: 52.5, last_switch_s: 25.7, default_idle_s: 0,
};
const STATUS = { service: "strata", model: "qwen3.8-flash-next-q2_0", models: VIEW };

type Seen = { url: string; method: string; body?: string; auth?: string };
function fakeFetch(routes: Record<string, { status?: number; body?: unknown } | ((init?: RequestInit) => { status?: number; body?: unknown })>,
                   seen: Seen[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, method: init?.method ?? "GET", body: init?.body as string | undefined,
                auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const route = routes[`${init?.method ?? "GET"} ${u}`];
    const r = typeof route === "function" ? route(init) : route;
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("parseVariants: the server's variants, or none", () => {
  const v = parseVariants(STATUS)!;
  assert.equal(v.active, "q2");
  assert.equal(v.default, null);
  assert.deepEqual(v.models, VIEW.variants);
  assert.equal(v.switches, 2);
  assert.equal(v.lastSwitchS, 25.7);
  assert.equal(parseVariants({ service: "strata", model: "m" }), undefined, "one model: no variants");
  assert.equal(parseVariants(undefined), undefined);
  assert.equal(parseVariants({ models: { active: 1, variants: {} } }), undefined);
});

test("variantOf: a variant's name or its model id", () => {
  const v = parseVariants(STATUS)!;
  assert.equal(variantOf(v, "q3"), "q3");
  assert.equal(variantOf(v, "qwen3.8-flash-next-iq3_xxs"), "q3");
  assert.equal(variantOf(v, "claude-sonnet"), undefined);
  const lines = describeVariants({ ...v, committed: "q3", default: "q2" });
  assert.deepEqual(lines, [
    "q2: qwen3.8-flash-next-q2_0 (loaded) (default)",
    "q3: qwen3.8-flash-next-iq3_xxs (switching to it)",
    "switches since the server started: 2, the last took 25.7 s",
  ]);
});

test("discover: every variant listed, named with its variant; the variants from /v1/status", async () => {
  const f = fakeFetch({ "GET http://strata.test/v1/models": { body: MODELS }, "GET http://strata.test/v1/status": { body: STATUS } });
  const d = await discover(config, { fetcher: f });
  assert.deepEqual(d.models.map(m => [m.id, m.name]), [
    ["qwen3.8-flash-next-q2_0", "qwen3.8-flash-next-q2_0 (Strata, q2)"],
    ["qwen3.8-flash-next-iq3_xxs", "qwen3.8-flash-next-iq3_xxs (Strata, q3)"],
  ], "the unloaded variant too; aliases are not listed twice");
  assert.equal(d.variants?.active, "q2");
  const one = await discover(config, { fetcher: fakeFetch({
    "GET http://strata.test/v1/models": { body: { data: [{ id: "m", meta: { n_ctx: 8192 } }] } },
    "GET http://strata.test/v1/status": { body: { service: "strata" } } }) });
  assert.equal(one.variants, undefined);
  assert.equal(one.models[0].name, "m (Strata)");
});

test("fetchVariants: GET /v1/status with the key; undefined when it does not answer", async () => {
  const seen: Seen[] = [];
  const v = await fetchVariants(config, { apiKey: "k", fetcher: fakeFetch({ "GET http://strata.test/v1/status": { body: STATUS } }, seen) });
  assert.equal(v?.active, "q2");
  assert.equal(seen[0].auth, "Bearer k");
  assert.equal(await fetchVariants(config, { fetcher: fakeFetch({}) }), undefined);
  assert.equal(await fetchVariants(config, { fetcher: (async () => { throw new Error("down"); }) as typeof fetch }), undefined);
});

test("loadVariant: POST /v1/load; busy (409) and errors told apart", async () => {
  const seen: Seen[] = [];
  const loaded = await loadVariant(config, "qwen3.8-flash-next-iq3_xxs", { apiKey: "k", fetcher: fakeFetch({
    "POST http://strata.test/v1/load": { body: { status: "loaded", ...STATUS, models: { ...VIEW, active: "q3" } } } }, seen) });
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.kind === "loaded" && loaded.variants?.active, "q3");
  assert.deepEqual(JSON.parse(seen[0].body!), { model: "qwen3.8-flash-next-iq3_xxs" });
  assert.equal(seen[0].auth, "Bearer k");
  const busy = await loadVariant(config, "q3", { fetcher: fakeFetch({ "POST http://strata.test/v1/load": { status: 409, body: {} } }) });
  assert.deepEqual(busy, { kind: "busy" });
  const missing = await loadVariant(config, "q9", { fetcher: fakeFetch({
    "POST http://strata.test/v1/load": { status: 404, body: { error: { message: "model not found" } } } }) });
  assert.deepEqual(missing, { kind: "error", message: "Strata returned HTTP 404 for POST /v1/load: model not found" });
  const down = await loadVariant(config, "q3", { fetcher: (async () => { throw new Error("refused"); }) as typeof fetch });
  assert.equal(down.kind, "error");
});

test("switchOnSelect: on by default, false in strata.json turns it off", () => {
  assert.equal(DEFAULTS.switchOnSelect, true);
  assert.equal(mergeConfig(DEFAULTS, { switchOnSelect: false }).switchOnSelect, false);
  assert.throws(() => mergeConfig(DEFAULTS, { switchOnSelect: "no" }), /switchOnSelect/);
});
