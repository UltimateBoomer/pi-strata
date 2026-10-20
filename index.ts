// pi-strata: Strata as a pi provider, with Strata's request fields.
//
// - Models: discovered from the server (GET /v1/models: id, context, image input), listed as strata/<id>.
// - Reasoning: pi's levels are sent as Strata's reasoning_effort (none | low | medium | high), and per-level
//   reasoning_budget_tokens caps the thinking where configured (default: minimal = low with 1024 tokens).
// - Summaries: pi's compaction and branch summaries are sent with "strata_checkpoint": false (nothing continues
//   them, so Strata keeps and parks nothing for them) and a low reasoning effort.
// - Shared prefix (opt-in, "prefix": "system"): every agent request pins its system prompt and tool list with
//   "strata_prefix": {"messages": 1}.
// Only requests to this provider's models are changed: the fields are added in its own stream functions.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, type PiLevel } from "./src/config.ts";
import type { Applied } from "./src/payload.ts";
import { createStrataProvider } from "./src/provider.ts";

export default async function (pi: ExtensionAPI) {
  const config = await loadConfig();
  const counts = { summaries: 0, turns: 0, prefixed: 0, budgeted: 0 };
  const onApplied = (applied: Applied) => {
    if (applied.kind === "summary") counts.summaries++;
    else counts.turns++;
    if (applied.added.includes("strata_prefix")) counts.prefixed++;
    if (applied.added.includes("reasoning_budget_tokens")) counts.budgeted++;
  };
  // the fields are added in the provider's stream functions (src/provider.ts), so they reach every request to a
  // Strata model: pi's compaction calls do not pass through the before_provider_request event
  const key = () => process.env[config.apiKeyEnv] ?? config.apiKey;
  const current = createStrataProvider(config, { onApplied });
  await current.prime(key());
  pi.registerProvider(current.provider);

  pi.registerCommand("strata", {
    description: "Strata: status, refresh, or prefix on|off (the endpoint is set with /login)",
    handler: async (args, ctx) => {
      const { status } = current;
      const [action = "status", value] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "prefix") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify(`Usage: /strata prefix on|off (now ${config.prefix === "system" ? "on" : "off"})`, "warning");
          return;
        }
        config.prefix = value === "on" ? "system" : "off";
        ctx.ui.notify(value === "on"
          ? "Strata: pinning the system prompt and tools as a shared prefix for this session. A request that resumes from it does not park the conversation it leaves."
          : "Strata: no shared prefix pinned.", "info");
        return;
      }
      if (action === "refresh") {
        await current.prime(key());
        if (status.lastError) ctx.ui.notify(`Strata: ${status.lastError}`, "error");
        else ctx.ui.notify(`Strata: ${status.models} model(s) at ${config.baseUrl}. Run /model to pick one.`, "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /strata [status|refresh|prefix on|off]", "warning");
        return;
      }
      const lines = [
        `endpoint: ${config.baseUrl}${status.strata === false ? " (does not report itself as Strata)" : ""}`,
        `models: ${status.models} (${status.source})${status.concurrency ? `, server runs ${status.concurrency} request(s) at once` : ""}`,
        `reasoning: ${Object.entries(config.reasoning).map(([l, e]) => `${l}=${e}${config.reasoningBudgetTokens[l as PiLevel] ? `/${config.reasoningBudgetTokens[l as PiLevel]}` : ""}`).join(" ")}`,
        `summaries: ${config.summaries.oneShot ? "one-shot (strata_checkpoint=false)" : "kept"}, reasoning ${config.summaries.reasoning}`,
        `shared prefix: ${config.prefix === "system" ? "system prompt + tools" : "off"}`,
        `this session: ${counts.turns} turn(s), ${counts.summaries} summar${counts.summaries === 1 ? "y" : "ies"}, ${counts.prefixed} with a pinned prefix, ${counts.budgeted} with a thinking cap`,
        `config: ${configPath()}`,
        ...status.warnings,
        ...(status.lastError ? [`last error: ${status.lastError}`] : []),
      ];
      ctx.ui.notify(lines.join("\n"), status.lastError ? "warning" : "info");
    },
  });
}
