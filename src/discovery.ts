// The server's models, as Strata reports them: GET /v1/models (id, meta.n_ctx, input modalities, aliases) and
// GET /v1/status (whether this is Strata at all).
import type { Model } from "@earendil-works/pi-ai";
import { PI_LEVELS, type StrataConfig } from "./config.ts";

export type Fetcher = typeof fetch;
export type StrataModel = Model<"openai-completions">;

export interface Discovery {
  models: StrataModel[];
  /** GET /v1/status said "service": "strata". */
  strata: boolean;
  /** /v1/status: how many requests the server runs at once ("parallel"). */
  concurrency?: number;
  warnings: string[];
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function object(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One chat model from a /v1/models entry, or undefined for an entry that is not one (an image model, an alias). */
export function modelFromEntry(entry: unknown, config: StrataConfig): StrataModel | undefined {
  if (!object(entry) || typeof entry.id !== "string" || !entry.id.trim()) return undefined;
  if (typeof entry.alias_of === "string") return undefined;              // listed again under its own id
  const ctx = entry.meta?.n_ctx;
  if (typeof ctx !== "number" || !Number.isSafeInteger(ctx) || ctx <= 0) return undefined;   // not a chat model
  const modalities: unknown[] = Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities : ["text"];
  const input = (["text", "image"] as const).filter(m => modalities.includes(m));
  return {
    id: entry.id,
    name: `${entry.id} (Strata)`,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    input: input.length ? [...input] : ["text"],
    cost: ZERO_COST,
    reasoning: true,
    // pi level -> Strata's reasoning_effort (none | low | medium | high)
    thinkingLevelMap: Object.fromEntries(PI_LEVELS.map(level => [level, config.reasoning[level]])),
    contextWindow: ctx,
    maxTokens: Math.min(config.maxTokens, ctx),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,       // reasoning_effort, OpenAI-style (no thinkingFormat)
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
    },
  };
}

export async function discover(
  config: StrataConfig,
  options: { apiKey?: string; signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<Discovery> {
  const fetcher = options.fetcher ?? fetch;
  const key = options.apiKey;
  const get = async (url: string, optional: boolean): Promise<Record<string, any> | undefined> => {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetcher(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal, redirect: "error" });
    } catch {
      options.signal?.throwIfAborted();
      if (optional) return undefined;
      throw new Error(`Strata did not answer at ${url}`);
    }
    if (!response.ok) {
      if (optional) return undefined;
      throw new Error(`Strata returned HTTP ${response.status} for ${url}` +
        (response.status === 401 ? ` (set $${config.apiKeyEnv} or run /login strata)` : ""));
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!object(body)) {
      if (optional) return undefined;
      throw new Error(`Strata returned something other than a JSON object for ${url}`);
    }
    return body;
  };
  const list = await get(`${config.baseUrl}/models`, false);
  if (!Array.isArray(list?.data)) throw new Error("Strata's model list has no data array");
  const warnings: string[] = [];
  const models = list.data.map(entry => modelFromEntry(entry, config)).filter((m): m is StrataModel => !!m);
  if (!models.length) warnings.push("Strata lists no loaded chat model (it may still be starting).");
  const status = await get(`${config.baseUrl}/status`, true);
  const strata = status?.service === "strata";
  if (status && !strata) warnings.push(`${config.baseUrl} does not report itself as Strata; Strata's request fields may be ignored.`);
  const concurrency = typeof status?.concurrency?.serving === "number" ? status.concurrency.serving : undefined;
  return { models, strata, concurrency, warnings };
}
