import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, mergeConfig, applyEnv } from "../src/config.ts";
import { applyStrataFields, isPiSummary, PI_SUMMARY_SYSTEM_PROMPT } from "../src/payload.ts";

const SUMMARY_SYSTEM = `${PI_SUMMARY_SYSTEM_PROMPT} Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation.`;

const summary = (extra: Record<string, unknown> = {}) => ({
  model: "m", stream: true, reasoning_effort: "high",
  messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: "<conversation>\n[User]: hi\n</conversation>\n\nSummarize." }],
  ...extra,
});
const turn = (extra: Record<string, unknown> = {}) => ({
  model: "m", stream: true, reasoning_effort: "medium",
  messages: [{ role: "system", content: "You are pi, a coding agent." }, { role: "user", content: "fix the bug" }],
  tools: [{ type: "function", function: { name: "read", parameters: {} } }],
  ...extra,
});

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

test("the payload pi sent is not changed in place", () => {
  const p = turn();
  applyStrataFields(p, { ...DEFAULTS, prefix: "system" }, "minimal");
  assert.equal("strata_prefix" in p, false);
  assert.equal(applyStrataFields("not an object", DEFAULTS, undefined), undefined);
});

test("config validation and environment overrides", () => {
  assert.throws(() => mergeConfig(DEFAULTS, { reasoning: { high: "max" } }), /reasoning\.high/);
  assert.throws(() => mergeConfig(DEFAULTS, { reasoning: { ultra: "high" } }), /unknown pi level/);
  assert.throws(() => mergeConfig(DEFAULTS, { prefix: "all" }), /prefix/);
  assert.throws(() => mergeConfig(DEFAULTS, { maxTokens: -1 }), /maxTokens/);
  assert.throws(() => mergeConfig(DEFAULTS, []), /JSON object/);
  const c = mergeConfig(DEFAULTS, { baseUrl: "http://192.168.0.66:9931/v1/", reasoning: { xhigh: "medium" } });
  assert.equal(c.baseUrl, "http://192.168.0.66:9931/v1");
  assert.equal(c.reasoning.xhigh, "medium");
  assert.equal(c.reasoning.high, "high", "other levels keep their default");
  assert.equal(DEFAULTS.reasoning.xhigh, "high", "the defaults are not changed");
  const e = applyEnv(c, { STRATA_BASE_URL: "http://h:1/v1/", PI_STRATA_PREFIX: "system" });
  assert.equal(e.baseUrl, "http://h:1/v1");
  assert.equal(e.prefix, "system");
});
