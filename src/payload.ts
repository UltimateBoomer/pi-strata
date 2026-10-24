// What this extension adds to a request pi sends to Strata (OpenAI Chat Completions body), as pure functions.
import type { PiLevel, StrataConfig } from "./config.ts";

/**
 * pi's summarization system prompt (packages/coding-agent/src/core/compaction/utils.ts, pi 1.3.0). Compaction,
 * branch summaries and split-turn prefix summaries all send it as their only system message, with no tools.
 * pi does not export it, so it is matched by its first sentence.
 */
export const PI_SUMMARY_SYSTEM_PROMPT = "You are a context summarization assistant.";

type Json = Record<string, unknown>;

function object(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A message's text: a string, or the text parts of a content array. */
export function messageText(message: unknown): string {
  if (!object(message)) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (object(part) && typeof part.text === "string" ? part.text : "")).join("");
}

/** pi's own summary request: its summarization system prompt first, and no tools. */
export function isPiSummary(payload: unknown): boolean {
  if (!object(payload) || !Array.isArray(payload.messages) || !payload.messages.length) return false;
  if (Array.isArray(payload.tools) && payload.tools.length) return false;
  const first = payload.messages[0];
  return object(first) && (first.role === "system" || first.role === "developer") &&
    messageText(first).trimStart().startsWith(PI_SUMMARY_SYSTEM_PROMPT);
}

export interface Applied {
  payload: Json;
  kind: "summary" | "turn";
  /** The Strata fields this request got (for /strata status). */
  added: string[];
}

/**
 * The payload with Strata's fields added, or undefined when it is not an object (left as it is).
 * `level`: the session's pi thinking level (the payload carries only the mapped Strata effort).
 */
export function applyStrataFields(payload: unknown, config: StrataConfig, level: PiLevel | undefined): Applied | undefined {
  if (!object(payload)) return undefined;
  const out: Json = { ...payload };
  const added: string[] = [];
  if (config.priority !== undefined) {
    out.strata_priority = config.priority;   // the turn scheduler's priority (summaries too: the session's work)
    added.push("strata_priority");
  }
  if (isPiSummary(payload)) {
    if (config.summaries.oneShot) {
      out.strata_checkpoint = false;     // no checkpoint kept or parked for it: nothing continues a summary
      added.push("strata_checkpoint");
    }
    if (config.summaries.reasoning !== "inherit") {
      out.reasoning_effort = config.summaries.reasoning;
      delete out.reasoning_budget_tokens;
      added.push("reasoning_effort");
    }
    return { payload: out, kind: "summary", added };
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (config.prefix === "system" && messages.length > 1 && object(messages[0]) && messages[0].role === "system") {
    // the system prompt and the tool list (Strata renders the tools with the first message) are the shared prefix
    out.strata_prefix = { messages: 1 };
    added.push("strata_prefix");
  }
  const budget = level ? config.reasoningBudgetTokens[level] : undefined;
  if (budget && out.reasoning_effort !== "none") {
    out.reasoning_budget_tokens = budget;
    added.push("reasoning_budget_tokens");
  }
  return { payload: out, kind: "turn", added };
}
