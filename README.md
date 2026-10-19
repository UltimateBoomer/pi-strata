# pi-strata

A [pi](https://pi.dev) extension for [Strata](https://github.com/Niko1221/Strata): Strata as a provider, Strata's reasoning
levels, and two of Strata's request fields that a generic OpenAI-compatible provider cannot send.

| What | How |
|---|---|
| **Provider** | `strata/<model>`: the models the server reports (`GET /v1/models`: id, context, image input; aliases and the image model left out), streamed through pi's own OpenAI Chat Completions implementation. `GET /v1/status` confirms it is Strata. |
| **Reasoning** | pi's thinking levels as Strata's `reasoning_effort` (`none`, `low`, `medium`, `high`; Strata's default is `high`): `off`→`none`, `minimal`→`low`, `low`→`low`, `medium`→`medium`, `high`/`xhigh`→`high`. `reasoning_budget_tokens` (Strata's hard thinking cap) per level: by default `minimal` thinks at `low` with at most 1024 tokens. |
| **One-shot summaries** | pi's compaction, branch summaries and split-turn summaries are sent with `"strata_checkpoint": false`: no later request continues them, so Strata keeps no checkpoint for them and parks nothing (with `--conversation-cache-dir`, that is a file write of the whole summarization prompt saved). They also get `reasoning_effort: "low"`. |
| **Shared prefix** (opt-in) | `"strata_prefix": {"messages": 1}` on agent requests: the system prompt and tool list are pinned in Strata's checkpoint cache, so new sessions on the same system prompt start from it. See the trade-off below. |
| **`/strata`** | `status` (endpoint, models, mapping, what this session sent), `refresh`, `prefix on\|off` for the session. |

Only requests to this provider's models are changed. The fields are added in the provider's own stream functions,
because pi's compaction calls do not pass through the `before_provider_request` extension event.

## Install

```sh
pi install ~/Projects/pi-strata          # or: pi -e ~/Projects/pi-strata for one run
```

Point it at the server (`/v1` included) and give the API key if the server has one:

```sh
export STRATA_BASE_URL=http://192.168.0.66:9931/v1
export STRATA_API_KEY=...                # or /login strata
```

Then `/model` → `strata/<model>`. A keyless server needs no key.

## Configuration

`~/.pi/agent/strata.json` (or `$PI_STRATA_CONFIG`); every key is optional:

```json
{
  "baseUrl": "http://192.168.0.66:9931/v1",
  "apiKeyEnv": "STRATA_API_KEY",
  "maxTokens": 32768,
  "reasoning": { "off": "none", "minimal": "low", "low": "low", "medium": "medium", "high": "high", "xhigh": "high" },
  "reasoningBudgetTokens": { "minimal": 1024 },
  "summaries": { "oneShot": true, "reasoning": "low" },
  "prefix": "off"
}
```

- `STRATA_BASE_URL` and `PI_STRATA_PREFIX` (`off`/`system`) override the file.
- `reasoningBudgetTokens` replaces the default map (`{}`: no cap at any level).
- `summaries.reasoning`: a Strata level, or `"inherit"` to keep the session's.

## Matching the server

- **Output cap.** pi sends `max_completion_tokens` (default 32768, never more than the context). Strata refuses a
  request whose prompt plus that cap exceeds its context unless the server runs with `"fit_max_tokens": true`, which
  clamps the cap instead; without it keep `maxTokens` well under the context.
- **Reasoning levels** are Strata's instructions, not token limits; `reasoning_budget_tokens` is the hard limit.
- **Images** are offered when the server lists the `image` input modality (Strata's `"vision"`).

## The shared-prefix trade-off

`strata_prefix` pins the checkpoint at the end of the system prompt and tool list. Strata also does **not park the
conversation a request leaves when the request resumes exactly from that pinned prefix** (it is meant for many short
questions on one prefix). So with `prefix: "system"`, a new session or subagent on the same system prompt that follows
a long conversation discards that conversation instead of parking it, and its next turn reads its history again.

- Turn it on for many short sessions on one system prompt.
- Leave it off (the default) for long sessions that take turns on one server.
- `/strata prefix on|off` switches it for the current session.

## Development

```sh
npm install
npm run check        # tsc + node:test (config, payload rules, discovery, provider)
```

Tested against pi 1.3.0 with a stand-in server that answers like Strata: pi turns carry the mapped
`reasoning_effort` and cap, `/compact`'s summary requests carry `strata_checkpoint: false`, and `prefix: "system"`
adds `strata_prefix` to agent turns only.
