// The pi provider: Strata's models behind pi's own OpenAI Chat Completions implementation.
import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { normalizeBaseUrl, saveBaseUrl, type PiLevel, type StrataConfig } from "./config.ts";
import { discover, type Discovery, type Fetcher, type StrataModel } from "./discovery.ts";
import { applyStrataFields, type Applied, type Call } from "./payload.ts";
import type { Variants } from "./switching.ts";

/**
 * pi's built-in OpenAI Chat Completions implementation, looked up per request. pi hands extensions its own
 * @earendil-works/pi-ai entry points (the package, /compat, /oauth, /providers/all), not the api/ subpaths,
 * so an installed package cannot import api/openai-completions.
 */
function completions() {
  const api = getApiProvider("openai-completions");
  if (!api) throw new Error("pi has no openai-completions implementation registered");
  return api;
}

export interface ProviderStatus {
  models: number;
  source: "none" | "startup" | "cache" | "live";
  strata?: boolean;
  concurrency?: number;
  variants?: Variants;
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
                                 onApplied?: (applied: Applied) => void, call: () => Call = () => ({})): PayloadHook {
  return async (payload, model) => {
    const base = (inner ? await inner(payload, model) : undefined) ?? payload;
    const applied = applyStrataFields(base, config, level, call());
    if (!applied) return inner ? base : undefined;
    onApplied?.(applied);
    return applied.payload;
  };
}

export interface ProviderDeps {
  fetcher?: Fetcher;
  onApplied?: (applied: Applied) => void;
  /** The session and what pi summarizes now, read as each request goes out (index.ts keeps them). */
  call?: () => Call;
  /** Stores the endpoint /login chose (default: "baseUrl" in strata.json). Returns the stored value. */
  saveBaseUrl?: (url: string) => Promise<string>;
}

export function createStrataProvider(config: StrataConfig, deps: ProviderDeps = {}) {
  let models: readonly StrataModel[] = [];
  const status: ProviderStatus = { models: 0, source: "none", warnings: [] };
  const record = (result: Discovery, source: ProviderStatus["source"]) => {
    models = result.models;
    Object.assign(status, {
      models: models.length, source, strata: result.strata, concurrency: result.concurrency, variants: result.variants,
      checkedAt: Date.now(), warnings: result.warnings, lastError: undefined,
    });
  };

  const provider: Provider<"openai-completions"> = {
    id: config.provider,
    name: "Strata",
    get baseUrl() { return config.baseUrl; },    // follows /login
    auth: {
      apiKey: {
        name: "Strata endpoint and API key",
        // /login strata: the server's endpoint (saved in strata.json), then its API key (stored by pi)
        login: async interaction => {
          let why = "";
          for (;;) {
            const answer = (await interaction.prompt({
              type: "text",
              message: `${why}Strata endpoint (blank keeps ${config.baseUrl})`,
              placeholder: "http://192.168.0.66:9931",
            })).trim();
            if (!answer) break;
            try {
              config.baseUrl = await (deps.saveBaseUrl ?? saveBaseUrl)(normalizeBaseUrl(answer));
              break;
            } catch (error) {
              why = `${(error as Error).message}. `;      // asked again with the reason
            }
          }
          const key = (await interaction.prompt({ type: "secret", message: "Strata API key (blank for a server without one)" })).trim() || undefined;
          interaction.notify({ type: "progress", message: `Looking for models at ${config.baseUrl} ...` });
          try {
            record(await discover(config, { apiKey: key ?? config.apiKey,
                                            signal: interaction.signal, fetcher: deps.fetcher }), "live");
            interaction.notify({ type: "info", message: `${status.models} model(s) at ${config.baseUrl}. Run /model to pick one.` });
          } catch (error) {
            status.lastError = error instanceof Error ? error.message : String(error);
            interaction.notify({ type: "info", message: `Saved, but ${status.lastError}` });
          }
          return { type: "api_key", key };
        },
        resolve: async ({ credential }) => {
          const key = credential?.key ?? config.apiKey ?? KEYLESS;
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
        const apiKey = context.credential?.type === "api_key" ? context.credential.key : config.apiKey;
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
    stream: (model, context, options) => completions().stream(model, context, {
      ...options,
      onPayload: withStrataFields(config, (options as { reasoningEffort?: PiLevel } | undefined)?.reasoningEffort,
                                  options?.onPayload as PayloadHook | undefined, deps.onApplied, deps.call),
    }),
    streamSimple: (model, context, options) => completions().streamSimple(model, context, {
      ...options,
      onPayload: withStrataFields(config, options?.reasoning as PiLevel | undefined,
                                  options?.onPayload as PayloadHook | undefined, deps.onApplied, deps.call),
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
