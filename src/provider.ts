// The pi provider: Strata's models behind pi's own OpenAI Chat Completions implementation.
import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { PiLevel, StrataConfig } from "./config.ts";
import { discover, type Discovery, type Fetcher, type StrataModel } from "./discovery.ts";
import { applyStrataFields, type Applied } from "./payload.ts";

export interface ProviderStatus {
  models: number;
  source: "none" | "startup" | "cache" | "live";
  strata?: boolean;
  concurrency?: number;
  checkedAt?: number;
  warnings: string[];
  lastError?: string;
}

/** Placeholder key for a keyless server (pi needs some credential to call the provider configured). */
export const KEYLESS = "strata-local";

type PayloadHook = (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;

/**
 * pi's own payload hook (if any) first, then Strata's fields. Every request to a Strata model passes here - agent
 * turns and the requests pi makes outside the agent loop (compaction, branch summaries), which the extension event
 * before_provider_request does not see.
 */
export function withStrataFields(config: StrataConfig, level: PiLevel | undefined, inner: PayloadHook | undefined,
                                 onApplied?: (applied: Applied) => void): PayloadHook {
  return async (payload, model) => {
    const base = (inner ? await inner(payload, model) : undefined) ?? payload;
    const applied = applyStrataFields(base, config, level);
    if (!applied) return inner ? base : undefined;
    onApplied?.(applied);
    return applied.payload;
  };
}

export function createStrataProvider(config: StrataConfig, deps: { fetcher?: Fetcher; onApplied?: (applied: Applied) => void } = {}) {
  let models: readonly StrataModel[] = [];
  const status: ProviderStatus = { models: 0, source: "none", warnings: [] };
  const record = (result: Discovery, source: ProviderStatus["source"]) => {
    models = result.models;
    Object.assign(status, {
      models: models.length, source, strata: result.strata, concurrency: result.concurrency,
      checkedAt: Date.now(), warnings: result.warnings, lastError: undefined,
    });
  };

  const provider: Provider<"openai-completions"> = {
    id: config.provider,
    name: "Strata",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Strata API key (blank for a server without one)",
        login: async interaction => ({
          type: "api_key",
          key: (await interaction.prompt({ type: "secret", message: "Strata API key (blank for a server without one)" })).trim() || undefined,
        }),
        resolve: async ({ ctx, credential }) => {
          const key = credential?.key ?? await ctx.env(config.apiKeyEnv) ?? config.apiKey ?? KEYLESS;
          return {
            auth: { apiKey: key, baseUrl: config.baseUrl },
            source: credential?.key ? "stored API key" : key === KEYLESS ? "no API key" : "configured API key",
          };
        },
      },
    },
    getModels: () => models,
    refreshModels: async (context: RefreshModelsContext) => {
      // offline (or before the network is allowed): the catalog stored for this endpoint, never another server's
      if (context.stored) {
        const restored = context.stored.models.filter((m): m is StrataModel =>
          (m.type === undefined || m.type === "chat") && m.provider === config.provider &&
          m.api === "openai-completions" && m.baseUrl === config.baseUrl);
        if (restored.length && !models.length) {
          await context.publish({ update: () => { models = restored; Object.assign(status, { models: restored.length, source: "cache" }); } });
        }
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      try {
        const apiKey = context.credential?.type === "api_key" ? context.credential.key : process.env[config.apiKeyEnv] ?? config.apiKey;
        const result = await discover(config, { apiKey, signal: context.signal, fetcher: deps.fetcher });
        if (context.signal.aborted) return;
        const update = () => record(result, "live");
        try {
          await context.publish({ persist: { models: result.models, checkedAt: Date.now() }, update });
        } catch {
          await context.publish({ update });   // a read-only store must not lose a good refresh
        }
      } catch (error) {
        if (context.signal.aborted) return;
        status.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    stream: (model, context, options) => stream(model, context, {
      ...options,
      onPayload: withStrataFields(config, (options as { reasoningEffort?: PiLevel } | undefined)?.reasoningEffort,
                                  options?.onPayload as PayloadHook | undefined, deps.onApplied),
    }),
    streamSimple: (model, context, options) => streamSimple(model, context, {
      ...options,
      onPayload: withStrataFields(config, options?.reasoning as PiLevel | undefined,
                                  options?.onPayload as PayloadHook | undefined, deps.onApplied),
    }),
  };

  /** Startup: list the models before pi selects one (a refresh later replaces them). */
  const prime = async (apiKey?: string) => {
    try {
      record(await discover(config, { apiKey, fetcher: deps.fetcher }), "startup");
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
    }
  };
  return { provider, status, prime };
}
