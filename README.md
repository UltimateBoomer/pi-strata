# pi-strata

A [pi](https://pi.dev) extension for [Strata](https://github.com/Niko1221/Strata): Strata as a provider, Strata's reasoning
levels, and Strata's request fields that a generic OpenAI-compatible provider cannot send.

Turn priority (`strata_priority`) needs [UltimateBoomer/Strata](https://github.com/UltimateBoomer/Strata), a fork of
Strata whose turn scheduler adds priority bands, reservations, aging and preemption (see its
[docs/BATCHING.md](https://github.com/UltimateBoomer/Strata/blob/main/docs/BATCHING.md), "Priorities"). Upstream
Strata never reads the field, so a priority has no effect there. Everything else works with upstream Strata.

| What | How |
|---|---|
| **Provider** | `strata/<model>`: the models the server reports (`GET /v1/models`: id, context, image input; aliases and the image model left out), streamed through pi's own OpenAI Chat Completions implementation. `GET /v1/status` confirms it is Strata. |
| **Reasoning** | pi's thinking levels as Strata's `reasoning_effort` (`none`, `low`, `medium`, `high`; Strata's default is `high`): `off`→`none`, `minimal`→`low`, `low`→`low`, `medium`→`medium`, `high`/`xhigh`→`high`. `reasoning_budget_tokens` (Strata's hard thinking cap) per level: by default `minimal` thinks at `low` with at most 1024 tokens. |
| **One-shot summaries** | pi's compaction, branch summaries and split-turn summaries are sent with `"strata_checkpoint": false`: no later request continues them, so Strata keeps no checkpoint for them and parks nothing (with `--conversation-cache-dir`, that is a file write of the whole summarization prompt saved). They also get `reasoning_effort: "low"`. |
| **Shared prefix** (opt-in) | `"strata_prefix": {"messages": 1}` on agent requests: the system prompt and tool list are pinned in Strata's checkpoint cache, so new sessions on the same system prompt start from it. See the trade-off below. |
| **Priority** (opt-in, [fork](https://github.com/UltimateBoomer/Strata) only) | `"strata_priority"` on every request, for Strata's turn scheduler: -20 to 19 like Unix nice, lower first. A request a band better (the server's `priority_preempt_delta`, default 5) preempts a worse one; a session's tool calls keep worse bands waiting. Set `"priority"` in `strata.json`, `--strata-priority` for one run, or `/strata priority` for the session. Subagents from pi-simple-subagents get the session's priority. |
| **`/strata`** | `status` (endpoint, models, mapping, what this session sent), `refresh`, `prefix on\|off`, `priority <-20..19\|off>` for the session. The endpoint is set with `/login`. |

Only requests to this provider's models are changed. The fields are added in the provider's own stream functions,
because pi's compaction calls do not pass through the `before_provider_request` extension event.

## Install

```sh
pi install npm:pi-strata                          # or: pi -e npm:pi-strata for one run
pi install git:github.com/UltimateBoomer/pi-strata   # from GitHub
```

Point it at the server, in pi: `/login` → **Sign in with an API key** → **Strata** asks for the endpoint first
(blank keeps the current one; an invalid URL is asked again), then the API key (blank for a server without one), and
lists the models there. Then `/model` → `strata/<model>`. Run `/login` again to change the endpoint.

This saves `"baseUrl"` in `~/.pi/agent/strata.json` (pi keeps the key in its own `auth.json`), or set it in the file.
`/v1` is added when the URL does not end with it; a path in front of it (a reverse proxy's prefix) is kept. A keyless
server needs no key.

## Configuration

`strata.json` in pi's agent directory (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`); every key is optional:

```json
{
  "baseUrl": "http://192.168.0.66:9931/v1",
  "maxTokens": 32768,
  "reasoning": { "off": "none", "minimal": "low", "low": "low", "medium": "medium", "high": "high", "xhigh": "high" },
  "reasoningBudgetTokens": { "minimal": 1024 },
  "summaries": { "oneShot": true, "reasoning": "low" },
  "prefix": "off"
}
```

- `baseUrl`: the server's endpoint, default `http://127.0.0.1:8080/v1` (Strata's own default). Any http(s) URL;
  `/v1` is added when missing. `/login` writes it, keeping the file's other keys.
- `--strata-priority <-20..19>` overrides `"priority"` for one run; `/strata priority` and `/strata prefix on|off`
  change the session.
- `apiKey`: a key for startup model discovery. pi does not hand `/login`'s stored key to an extension at startup, so
  `pi -p`, json and rpc runs (and subagents) on a server that needs a key use the model list pi saved at the last
  `/login` or interactive refresh. Set `apiKey` instead where no list is saved yet, such as CI. No setting is read from
  the environment.
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
