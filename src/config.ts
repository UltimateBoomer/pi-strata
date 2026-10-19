// Settings: built-in defaults, then ~/.pi/agent/strata.json (or $PI_STRATA_CONFIG), then environment variables.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pi's thinking levels. */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiLevel = typeof PI_LEVELS[number];

/** Strata's reasoning levels (docs/DETAILS.md: none, low, medium, high; the model's default is high). */
export const STRATA_EFFORTS = ["none", "low", "medium", "high"] as const;
export type StrataEffort = typeof STRATA_EFFORTS[number];

export interface StrataConfig {
  /** pi provider id the models are listed under. */
  provider: string;
  /** Strata's OpenAI-compatible endpoint ("baseUrl" in strata.json, $STRATA_BASE_URL): kept ending in /v1. */
  baseUrl: string;
  /** Environment variable holding the API key (Strata's "api_key" / $STRATA_API_KEY on the server). */
  apiKeyEnv: string;
  apiKey?: string;
  /** Discovery request timeout. */
  timeoutMs: number;
  /**
   * The output cap pi sends (max_completion_tokens). Strata refuses a prompt plus this cap that exceeds its
   * context unless the server runs with "fit_max_tokens": true, so keep it well under the context.
   */
  maxTokens: number;
  /** pi level -> Strata reasoning_effort. */
  reasoning: Record<PiLevel, StrataEffort>;
  /** pi level -> reasoning_budget_tokens, Strata's hard thinking cap (absent: no cap). */
  reasoningBudgetTokens: Partial<Record<PiLevel, number>>;
  /** pi's own summaries (compaction, branch summaries, split-turn prefixes). */
  summaries: {
    /** Send "strata_checkpoint": false: Strata keeps and parks nothing for a summary no request continues. */
    oneShot: boolean;
    /** reasoning_effort for summaries, or "inherit" to keep the session's level. */
    reasoning: StrataEffort | "inherit";
  };
  /**
   * "system": every agent request pins its system prompt and tool list as a shared prefix
   * ("strata_prefix": {"messages": 1}). Strata then keeps that checkpoint pinned, but it also does not park the
   * conversation a request leaves when the request resumes from that very prefix - so a sibling (a new chat or a
   * subagent on the same system prompt) after a long conversation drops that conversation instead of parking it.
   * Worth it for many short sessions on one system prompt; leave "off" for long sessions that take turns.
   */
  prefix: "off" | "system";
}

export const DEFAULTS: StrataConfig = {
  provider: "strata",
  baseUrl: "http://127.0.0.1:8080/v1",
  apiKeyEnv: "STRATA_API_KEY",
  timeoutMs: 5000,
  maxTokens: 32768,
  reasoning: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
  reasoningBudgetTokens: { minimal: 1024 },
  summaries: { oneShot: true, reasoning: "low" },
  prefix: "off",
};

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return process.env.PI_STRATA_CONFIG || join(agentDir(), "strata.json");
}

/**
 * An endpoint as given ("http://host:9931", "http://host:9931/v1/") -> Strata's API root ("http://host:9931/v1").
 * Throws for anything that is not an http(s) URL.
 */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(value)} (for example http://192.168.0.66:9931/v1)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`the Strata endpoint must be http(s), not ${url.protocol}`);
  if (url.search || url.hash) throw new Error("the Strata endpoint takes no query or fragment");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
}

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Merges a parsed config file over the defaults, rejecting values of the wrong kind with a message. */
export function mergeConfig(base: StrataConfig, raw: unknown): StrataConfig {
  if (raw === undefined) return base;
  if (!object(raw)) throw new Error("strata.json must hold a JSON object");
  const out: StrataConfig = {
    ...base, reasoning: { ...base.reasoning }, reasoningBudgetTokens: { ...base.reasoningBudgetTokens },
    summaries: { ...base.summaries },
  };
  for (const key of ["provider", "baseUrl", "apiKeyEnv", "apiKey"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) throw new Error(`strata.json: "${key}" must be a non-empty string`);
    out[key] = (raw[key] as string).trim();
  }
  for (const key of ["timeoutMs", "maxTokens"] as const) {
    if (raw[key] === undefined) continue;
    if (!positiveInt(raw[key])) throw new Error(`strata.json: "${key}" must be a positive whole number`);
    out[key] = raw[key] as number;
  }
  if (raw.reasoning !== undefined) {
    if (!object(raw.reasoning)) throw new Error('strata.json: "reasoning" maps pi levels to none|low|medium|high');
    for (const [level, effort] of Object.entries(raw.reasoning)) {
      if (!(PI_LEVELS as readonly string[]).includes(level)) throw new Error(`strata.json: unknown pi level "${level}"`);
      if (!(STRATA_EFFORTS as readonly string[]).includes(effort as string)) {
        throw new Error(`strata.json: "reasoning.${level}" must be one of ${STRATA_EFFORTS.join(", ")}`);
      }
      out.reasoning[level as PiLevel] = effort as StrataEffort;
    }
  }
  if (raw.reasoningBudgetTokens !== undefined) {
    if (!object(raw.reasoningBudgetTokens)) throw new Error('strata.json: "reasoningBudgetTokens" maps pi levels to token counts');
    out.reasoningBudgetTokens = {};
    for (const [level, n] of Object.entries(raw.reasoningBudgetTokens)) {
      if (!(PI_LEVELS as readonly string[]).includes(level)) throw new Error(`strata.json: unknown pi level "${level}"`);
      if (n === null || n === 0) continue;   // 0 / null: no cap at that level
      if (!positiveInt(n)) throw new Error(`strata.json: "reasoningBudgetTokens.${level}" must be a positive whole number`);
      out.reasoningBudgetTokens[level as PiLevel] = n;
    }
  }
  if (raw.summaries !== undefined) {
    if (!object(raw.summaries)) throw new Error('strata.json: "summaries" must be an object');
    if (raw.summaries.oneShot !== undefined) {
      if (typeof raw.summaries.oneShot !== "boolean") throw new Error('strata.json: "summaries.oneShot" must be true or false');
      out.summaries.oneShot = raw.summaries.oneShot;
    }
    if (raw.summaries.reasoning !== undefined) {
      const r = raw.summaries.reasoning;
      if (r !== "inherit" && !(STRATA_EFFORTS as readonly string[]).includes(r as string)) {
        throw new Error(`strata.json: "summaries.reasoning" must be inherit or one of ${STRATA_EFFORTS.join(", ")}`);
      }
      out.summaries.reasoning = r as StrataEffort | "inherit";
    }
  }
  if (raw.prefix !== undefined) {
    if (raw.prefix !== "off" && raw.prefix !== "system") throw new Error('strata.json: "prefix" must be "off" or "system"');
    out.prefix = raw.prefix;
  }
  try {
    out.baseUrl = normalizeBaseUrl(out.baseUrl);
  } catch (error) {
    throw new Error(`strata.json: "baseUrl": ${(error as Error).message}`);
  }
  return out;
}

/** Environment overrides: STRATA_BASE_URL, PI_STRATA_PREFIX (off|system). */
export function applyEnv(config: StrataConfig, env: NodeJS.ProcessEnv = process.env): StrataConfig {
  const out = { ...config };
  if (env.STRATA_BASE_URL?.trim()) {
    try {
      out.baseUrl = normalizeBaseUrl(env.STRATA_BASE_URL);
    } catch (error) {
      throw new Error(`STRATA_BASE_URL: ${(error as Error).message}`);
    }
  }
  const prefix = env.PI_STRATA_PREFIX?.trim();
  if (prefix === "off" || prefix === "system") out.prefix = prefix;
  return out;
}

/** Writes `baseUrl` into the config file, keeping its other keys (an atomic replace). Returns the stored value. */
export async function saveBaseUrl(url: string, path = configPath()): Promise<string> {
  const baseUrl = normalizeBaseUrl(url);
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(parsed)) throw new Error("it does not hold a JSON object");
    raw = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path}: ${(error as Error).message}`);
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...raw, baseUrl }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return baseUrl;
}

export async function loadConfig(path = configPath(), env: NodeJS.ProcessEnv = process.env): Promise<StrataConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path}: ${(error as Error).message}`);
  }
  return applyEnv(mergeConfig(DEFAULTS, raw), env);
}
