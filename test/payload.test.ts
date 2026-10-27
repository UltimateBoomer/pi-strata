import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, mergeConfig, parsePriority } from "../src/config.ts";
import { applyStrataFields, isPiSummary, MAIN_TURN, PI_SUMMARY_SYSTEM_PROMPT } from "../src/payload.ts";

const SUMMARY_SYSTEM = `${PI_SUMMARY_SYSTEM_PROMPT} Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation.`;

const summary = (extra: Record<string, unknown> = {}) => ({
  model: "m", stream: true, reasoning_effort: "high",
  messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: "<conversation>\n[User]: hi\n</conversation>\n\nSummarize." }],
  ...extra,
});
const side = (extra: Record<string, unknown> = {}) => ({
  model: "m", stream: true, reasoning_effort: "medium",
  messages: [{ role: "system", content: "You are pi, a coding agent." }, { role: "user", content: "fix the bug" }],
  tools: [{ type: "function", function: { name: "read", parameters: {} } }],
  ...extra,
});
/** An agent-loop request: marked by the before_provider_request handler. */
const turn = (extra: Record<string, unknown> = {}) => ({ ...side(extra), [MAIN_TURN]: true });

test("pi's summary requests are recognized; agent turns are not", () => {
  assert.equal(isPiSummary(summary()), true);
  assert.equal(isPiSummary(summary({ messages: [{ role: "system", content: [{ type: "text", text: SUMMARY_SYSTEM }] }, { role: "user", content: "x" }] })), true,
    "content as text parts");
  assert.equal(isPiSummary(turn()), false);
  assert.equal(isPiSummary(summary({ tools: [{ type: "function", function: { name: "read" } }] })), false, "a request with tools is not a summary");
  assert.equal(isPiSummary(turn({ messages: [{ role: "user", content: SUMMARY_SYSTEM }] })), false, "the prompt as a user message is not it");
  assert.equal(isPiSummary(null), false);
});

test("summaries: one-shot and low reasoning by default", () => {
  const a = applyStrataFields(summary({ reasoning_budget_tokens: 9 }), DEFAULTS, "high")!;
  assert.equal(a.kind, "summary");
  assert.equal(a.payload.strata_checkpoint, false);
  assert.equal(a.payload.reasoning_effort, "low");
  assert.equal(a.payload.reasoning_budget_tokens, undefined, "a session's cap does not apply to the summary");
  assert.equal(a.payload.strata_prefix, undefined, "a summary never pins a prefix");
  const kept = applyStrataFields(summary(), mergeConfig(DEFAULTS, { summaries: { oneShot: false, reasoning: "inherit" } }), "high")!;
  assert.equal(kept.payload.strata_checkpoint, undefined);
  assert.equal(kept.payload.reasoning_effort, "high");
});

test("turns: no prefix by default; the system prompt and tools with prefix=system", () => {
  const off = applyStrataFields(turn(), DEFAULTS, "medium")!;
  assert.equal(off.kind, "turn");
  assert.equal(off.payload.strata_prefix, undefined);
  assert.equal(off.payload.strata_checkpoint, undefined, "an agent turn keeps its checkpoints");
  const on = applyStrataFields(turn(), { ...DEFAULTS, prefix: "system" }, "medium")!;
  assert.deepEqual(on.payload.strata_prefix, { messages: 1 });
  const lone = applyStrataFields(turn({ messages: [{ role: "system", content: "x" }] }), { ...DEFAULTS, prefix: "system" }, "medium")!;
  assert.equal(lone.payload.strata_prefix, undefined, "Strata needs a message past the prefix");
});

test("reasoning budgets by pi level, never with reasoning off", () => {
  assert.equal(applyStrataFields(turn({ reasoning_effort: "low" }), DEFAULTS, "minimal")!.payload.reasoning_budget_tokens, 1024);
  assert.equal(applyStrataFields(turn({ reasoning_effort: "low" }), DEFAULTS, "low")!.payload.reasoning_budget_tokens, undefined);
  const capped = mergeConfig(DEFAULTS, { reasoningBudgetTokens: { high: 8192 } });
  assert.equal(applyStrataFields(turn({ reasoning_effort: "high" }), capped, "high")!.payload.reasoning_budget_tokens, 8192);
  assert.equal(applyStrataFields(turn({ reasoning_effort: "high" }), capped, "minimal")!.payload.reasoning_budget_tokens, undefined,
    "a reasoningBudgetTokens object replaces the default one");
  const off = mergeConfig(DEFAULTS, { reasoningBudgetTokens: { off: 100 } });
  assert.equal(applyStrataFields(turn({ reasoning_effort: "none" }), off, "off")!.payload.reasoning_budget_tokens, undefined);
});

test("sessions: main turns carry the session and the yield tools", () => {
  const a = applyStrataFields(turn(), DEFAULTS, "medium", { session: "S" })!;
  assert.equal(a.kind, "turn");
  assert.equal(a.payload.strata_session, "S");
  assert.deepEqual(a.payload.strata_yield_tools, ["subagent"]);
  assert.equal(a.payload.strata_yield, undefined, "a main turn does not give the turn up");
  assert.equal(MAIN_TURN in a.payload, false, "the mark is removed");
  assert.equal(JSON.stringify({ [MAIN_TURN]: true, x: 1 }), '{"x":1}', "and JSON never carries it");
  const none = applyStrataFields(turn(), { ...DEFAULTS, session: false, yieldTools: [] }, "medium", { session: "S" })!;
  assert.equal(none.payload.strata_session, undefined);
  assert.equal(none.payload.strata_yield_tools, undefined);
});

test("summaries yield only; the first turn after a compaction drops the session's cached conversation", () => {
  const c = applyStrataFields(summary(), DEFAULTS, "high", { session: "S", compacted: true })!;
  assert.equal(c.kind, "summary");
  assert.equal(c.payload.strata_session, "S");
  assert.equal(c.payload.strata_yield, true);
  assert.equal(c.payload.strata_drop, undefined, "the summary never drops: the compaction may still fail");
  const after = applyStrataFields(turn(), DEFAULTS, "high", { session: "S", compacted: true })!;
  assert.equal(after.kind, "turn");
  assert.equal(after.payload.strata_drop, true);
  assert.equal(after.payload.strata_yield, undefined);
  assert.equal(applyStrataFields(turn(), DEFAULTS, "high", { session: "S" })!.payload.strata_drop, undefined);
  assert.equal(applyStrataFields(side(), DEFAULTS, "high", { session: "S", compacted: true })!.payload.strata_drop, undefined,
    "a side call leaves the drop to the next main turn");
  assert.equal(applyStrataFields(turn(), { ...DEFAULTS, session: false }, "high", { session: "S", compacted: true })!
    .payload.strata_drop, undefined, "no session sent: nothing to drop");
  const kept = applyStrataFields(summary(), mergeConfig(DEFAULTS, { summaries: { oneShot: false } }), "high", { session: "S" })!;
  assert.equal(kept.payload.strata_session, undefined, "a summary that is not a one-shot would continue the session");
});

test("side calls: a one-shot of the session", () => {
  const a = applyStrataFields(side(), DEFAULTS, "medium", { session: "S" })!;
  assert.equal(a.kind, "side");
  assert.equal(a.payload.strata_checkpoint, false);
  assert.equal(a.payload.strata_session, "S");
  assert.equal(a.payload.strata_yield_tools, undefined);
  assert.equal(a.payload.reasoning_budget_tokens, undefined);
  const plain = applyStrataFields(side(), mergeConfig(DEFAULTS, { sideCalls: { oneShot: false } }), "medium", { session: "S" })!;
  assert.equal(plain.payload.strata_checkpoint, undefined);
  assert.equal(plain.payload.strata_session, undefined);
});

test("the payload pi sent is not changed in place", () => {
  const p = turn();
  applyStrataFields(p, { ...DEFAULTS, prefix: "system" }, "minimal");
  assert.equal("strata_prefix" in p, false);
  assert.equal(applyStrataFields("not an object", DEFAULTS, undefined), undefined);
});

test("config validation", () => {
  assert.throws(() => mergeConfig(DEFAULTS, { reasoning: { high: "max" } }), /reasoning\.high/);
  assert.throws(() => mergeConfig(DEFAULTS, { reasoning: { ultra: "high" } }), /unknown pi level/);
  assert.throws(() => mergeConfig(DEFAULTS, { prefix: "all" }), /prefix/);
  assert.throws(() => mergeConfig(DEFAULTS, { maxTokens: -1 }), /maxTokens/);
  assert.throws(() => mergeConfig(DEFAULTS, []), /JSON object/);
  assert.throws(() => mergeConfig(DEFAULTS, { yieldTools: "subagent" }), /yieldTools/);
  assert.throws(() => mergeConfig(DEFAULTS, { session: "yes" }), /session/);
  assert.throws(() => mergeConfig(DEFAULTS, { sideCalls: { oneShot: 1 } }), /sideCalls/);
  assert.deepEqual(mergeConfig(DEFAULTS, { yieldTools: ["subagent", "web_search"] }).yieldTools, ["subagent", "web_search"]);
  const c = mergeConfig(DEFAULTS, { baseUrl: "http://192.168.0.66:9931/v1/", reasoning: { xhigh: "medium" } });
  assert.equal(c.baseUrl, "http://192.168.0.66:9931/v1");
  assert.equal(c.reasoning.xhigh, "medium");
  assert.equal(c.reasoning.high, "high", "other levels keep their default");
  assert.equal(DEFAULTS.reasoning.xhigh, "high", "the defaults are not changed");
});

test("the endpoint URL: normalized, validated, and saved beside the other keys", async () => {
  const { normalizeBaseUrl, saveBaseUrl, loadConfig } = await import("../src/config.ts");
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.equal(normalizeBaseUrl("http://192.168.0.66:9931"), "http://192.168.0.66:9931/v1");
  assert.equal(normalizeBaseUrl(" http://h:1/v1/ "), "http://h:1/v1");
  assert.equal(normalizeBaseUrl("https://llama.local.caohc.me/"), "https://llama.local.caohc.me/v1");
  assert.equal(normalizeBaseUrl("http://h/proxy/strata"), "http://h/proxy/strata/v1", "a path prefix behind a proxy is kept");
  assert.throws(() => normalizeBaseUrl("192.168.0.66:9931"), /http\(s\)/);
  assert.throws(() => normalizeBaseUrl("ftp://h/v1"), /http\(s\)/);
  assert.throws(() => normalizeBaseUrl("http://h/v1?x=1"), /query/);
  assert.throws(() => mergeConfig(DEFAULTS, { baseUrl: "nope" }), /baseUrl/);

  const dir = await mkdtemp(join(tmpdir(), "pi-strata-"));
  const path = join(dir, "strata.json");
  assert.equal(await saveBaseUrl("http://a:1", path), "http://a:1/v1", "a new file");
  await writeFile(path, JSON.stringify({ baseUrl: "http://a:1/v1", prefix: "system", maxTokens: 4096 }));
  await saveBaseUrl("http://b:2/", path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { baseUrl: "http://b:2/v1", prefix: "system", maxTokens: 4096 });
  const loaded = await loadConfig(path);
  assert.equal(loaded.baseUrl, "http://b:2/v1");
  assert.equal(loaded.prefix, "system");
  await writeFile(path, "[1]");
  await assert.rejects(saveBaseUrl("http://c:3", path), /JSON object/, "a file that is not an object is not overwritten");
});

test("priority: sent on turns and summaries when set, from strata.json or --strata-priority", () => {
  assert.equal(applyStrataFields(turn(), DEFAULTS, "medium")!.payload.strata_priority, undefined, "none sent by default");
  const set = mergeConfig(DEFAULTS, { priority: -3 });
  assert.equal(applyStrataFields(turn(), set, "medium")!.payload.strata_priority, -3);
  assert.equal(applyStrataFields(summary(), set, "high")!.payload.strata_priority, -3);
  assert.equal(parsePriority(" 7 "), 7, "a flag value is a string");
  for (const bad of [2.5, 20, -21, "high", true]) {
    assert.throws(() => mergeConfig(DEFAULTS, { priority: bad }), /priority/);
  }
  for (const bad of ["x", "", "-21"]) assert.throws(() => parsePriority(bad), /priority/);
});
