// What this extension adds to a request pi sends to Strata (OpenAI Chat Completions body), as pure functions.
import type { PiLevel, StrataConfig } from "./config.ts";

/**
 * pi's summarization system prompt (packages/coding-agent/src/core/compaction/utils.ts, pi 1.3.0). Compaction,
 * branch summaries and split-turn prefix summaries all send it as their only system message, with no tools.
 * pi does not export it, so it is matched by its first sentence.
 */
export const PI_SUMMARY_SYSTEM_PROMPT = "You are a context summarization assistant.";

type Json = Record<string | symbol, unknown>;

/**
 * Marks a payload as a turn of the main conversation: set by the before_provider_request handler (index.ts), which
 * pi fires for agent-loop requests only - not for compaction, branch summaries or an extension's own complete()
 * calls. A symbol, so JSON leaves it out: a payload that goes to another provider carries nothing.
 */
export const MAIN_TURN = Symbol("pi-strata main turn");

/** What this extension knows about the request beyond its payload. */
export interface Call {
  /** pi's session id, sent as "strata_session" (absent: no session sent). */
  session?: string;
  /**
   * The session was compacted since its last main turn: the next one sends "strata_drop", so Strata evicts the
   * conversation cached from before the compaction first. Set only once a compaction succeeded, never on the summary.
   */
  compacted?: boolean;
}

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
  /** turn: the main conversation; summary: pi's own summaries; side: anything else (an extension's own calls). */
  kind: "summary" | "turn" | "side";
  /** The Strata fields this request got (for /strata status). */
  added: string[];
}

/**
 * The payload with Strata's fields added, or undefined when it is not an object (left as it is).
 * `level`: the session's pi thinking level (the payload carries only the mapped Strata effort).
 */
export function applyStrataFields(payload: unknown, config: StrataConfig, level: PiLevel | undefined,
                                  call: Call = {}): Applied | undefined {
  if (!object(payload)) return undefined;
  const out: Json = { ...payload };
  const main = out[MAIN_TURN] === true;
  delete out[MAIN_TURN];
  const added: string[] = [];
  const session = config.session ? call.session : undefined;
  const put = (key: string, value: unknown) => {
    out[key] = value;
    added.push(key);
  };
  if (config.priority !== undefined) put("strata_priority", config.priority);   // summaries and side calls too: the session's work
  if (isPiSummary(payload)) {
    if (config.summaries.oneShot) {
      put("strata_checkpoint", false);     // no checkpoint kept or parked for it: nothing continues a summary
      if (session) {
        // the session's work, but it gives the turn up: its next prompt is read again after the summary anyway
        put("strata_session", session);
        put("strata_yield", true);
      }
    }
    if (config.summaries.reasoning !== "inherit") {
      out.reasoning_effort = config.summaries.reasoning;
      delete out.reasoning_budget_tokens;
      added.push("reasoning_effort");
    }
    return { payload: out, kind: "summary", added };
  }
  if (!main) {
    // an extension's own call (a memory review, a title): the session's side work, which nothing continues
    if (config.sideCalls.oneShot) {
      put("strata_checkpoint", false);
      if (session) put("strata_session", session);
    }
    return { payload: out, kind: "side", added };
  }
  if (session) put("strata_session", session);
  // the first turn after a compaction: the conversation cached from before it is never continued
  if (session && call.compacted) put("strata_drop", true);
  if (config.yieldTools.length) put("strata_yield_tools", [...config.yieldTools]);
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
