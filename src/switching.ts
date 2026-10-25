// Model variants (UltimateBoomer/Strata's "models"): one server holds several variants of one model (Q2_0 and
// IQ3_XXS of Qwen3.8-Flash-Next) and runs one at a time. A request names its variant in "model" and the server's
// turn scheduler switches the engine when that request's turn comes (about half a minute). GET /v1/status says
// which variant is loaded; POST /v1/load {"model": ...} switches at once, when nothing is running or queued.
import type { StrataConfig } from "./config.ts";
import type { Fetcher } from "./discovery.ts";

export interface Variants {
  /** The variant the engine runs (or will run, when it is unloaded). */
  active: string;
  /** The variant the server goes back to when idle (null: none). */
  default: string | null;
  /** The variant a committed switch goes to next. */
  committed: string | null;
  /** variant -> its model id (the /v1/models id). */
  models: Record<string, string>;
  switches: number;
  lastSwitchS?: number;
}

function object(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** /v1/status's "models" block -> Variants; undefined for a server without variants. */
export function parseVariants(status: unknown): Variants | undefined {
  const m = object(status) ? status.models : undefined;
  if (!object(m) || typeof m.active !== "string" || !object(m.variants)) return undefined;
  const models: Record<string, string> = {};
  for (const [name, id] of Object.entries(m.variants)) if (typeof id === "string") models[name] = id;
  return {
    active: m.active,
    default: typeof m.default === "string" ? m.default : null,
    committed: typeof m.committed === "string" ? m.committed : null,
    models,
    switches: typeof m.switches === "number" ? m.switches : 0,
    ...(typeof m.last_switch_s === "number" ? { lastSwitchS: m.last_switch_s } : {}),
  };
}

/** The variant a model id (or a variant name) is, or undefined when it is none of the server's variants. */
export function variantOf(variants: Variants, model: string): string | undefined {
  if (model in variants.models) return model;
  return Object.entries(variants.models).find(([, id]) => id === model)?.[0];
}

/** One line per variant: name, model id, which one is loaded. */
export function describeVariants(variants: Variants): string[] {
  const lines = Object.entries(variants.models).map(([name, id]) =>
    `${name}: ${id}${name === variants.active ? " (loaded)" : ""}${name === variants.committed ? " (switching to it)" : ""}` +
    `${name === variants.default ? " (default)" : ""}`);
  const last = variants.lastSwitchS !== undefined ? `, the last took ${variants.lastSwitchS} s` : "";
  return [...lines, `switches since the server started: ${variants.switches}${last}`];
}

function headers(apiKey: string | undefined, json = false): Record<string, string> {
  return { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}

/** GET /v1/status -> the server's variants now (undefined: a server without variants, or no answer). */
export async function fetchVariants(config: StrataConfig, options: { apiKey?: string; fetcher?: Fetcher } = {}):
    Promise<Variants | undefined> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(`${config.baseUrl}/status`, {
      headers: headers(options.apiKey), signal: AbortSignal.timeout(config.timeoutMs), redirect: "error",
    });
    if (!response.ok) return undefined;
    return parseVariants(await response.json().catch(() => undefined));
  } catch {
    return undefined;
  }
}

export type LoadResult =
  | { kind: "loaded"; variants?: Variants; seconds: number }
  /** A request is running or queued: the server switches when the scheduler gives a request for it the turn. */
  | { kind: "busy" }
  | { kind: "error"; message: string };

/** How long POST /v1/load may take: the engine stops and the other variant starts (a minute or two at worst). */
export const LOAD_TIMEOUT_MS = 10 * 60_000;

/** POST /v1/load {"model": model}: switch the server to that variant now. */
export async function loadVariant(config: StrataConfig, model: string,
                                  options: { apiKey?: string; fetcher?: Fetcher; signal?: AbortSignal } = {}):
    Promise<LoadResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}/load`, {
      method: "POST", headers: headers(options.apiKey, true), body: JSON.stringify({ model }), redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    return { kind: "error", message: `Strata did not answer POST /v1/load (${(error as Error).message})` };
  }
  if (response.status === 409) return { kind: "busy" };
  if (!response.ok) {
    const body: any = await response.json().catch(() => undefined);
    const why = typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
    return { kind: "error", message: `Strata returned HTTP ${response.status} for POST /v1/load${why}` };
  }
  const body: unknown = await response.json().catch(() => undefined);
  return { kind: "loaded", variants: parseVariants(body), seconds: Math.round((Date.now() - started) / 100) / 10 };
}
