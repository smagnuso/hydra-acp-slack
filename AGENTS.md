# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-slack` — Slack thread bridge **extension** for Hydra. Bridges
every active hydra session to a Slack thread, so any ACP agent (Claude
Code, Codex, Gemini, …) running through hydra shows up in Slack:

- One thread per agent session.
- Tool calls render as cards with status icons (▶ → ✅ / ❌).
- Tool output collapsed by default; expand with 👀 / 📖 reactions.
- Permission prompts surface as `:lock:` messages; ✅ / ❌ reactions
  approve or deny.
- Slack-side messages flow back into the agent as user prompts.
- New sessions can be created directly from Slack with the `!session`
  bang command.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`, especially RFD #533 permission-broadcast semantics.

This is a **client extension**: it uses hydra REST (`/v1/sessions`) to
discover sessions, attaches to each over WSS with `historyPolicy: "full"`
on first attach (to render history in Slack), and talks to Slack via the
Web API + Socket Mode WS. Sessions the bot itself starts (via `!session`)
are adopted immediately without waiting for the next discovery poll.

## Layout

- `src/index.ts` — entry point
- `src/hydra-discovery.ts` — hydra REST poll + adoption of self-created
  sessions
- `src/slack/` — Slack Web API + Socket Mode client
- `src/formatters/` — tool-call cards, permission cards, message rendering
- `src/transcribe.ts`, `src/synthesize.ts` — transcript ↔ Slack thread
  mapping
- `src/storage/` — persistent session ↔ thread mapping
- `src/setup/`, `src/config.ts` — first-run + user config
- `src/acp/`, `src/util/`

Config lives at `~/.hydra-acp-slack.conf`.

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-slack` on PATH. Registered via
`hydra-acp extension add hydra-acp-slack`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- Slack rate limits are strict — batch and back off. Never fan out one
  API call per hydra event without coalescing.
- The session ↔ thread mapping is persistent and must survive daemon and
  bridge restarts. Never lose a thread; on ambiguity, prefer re-attaching
  to an existing thread over creating a new one.
- Permission prompts race across clients (RFD #533). Slack reactions must
  handle `permission_resolved` updates gracefully (someone else answered
  first — remove the widget rather than error).

## Gotchas

- Slack thread `ts` values are opaque strings; treat them as such.
- Tool output can be huge; the collapse-by-default behavior is a
  usability contract, not an optimization. Don't remove it.
- Session resurrection can bring a session back on a different agent
  (via `/hydra agent`); the thread should keep working — thread identity
  is the session, not the agent.
- Users can reply to a thread from the Slack app on their phone. Message
  ordering vs. hydra's per-session prompt queue is subtle; keep the
  queueing in hydra, not here.
- **`threadRegistry` allows *multiple* bridges per thread** with
  priority order + `promote()` (`storage/registry.ts`). Overlap during
  daemon-restart is normal; inbound routing falls through the priority
  list. A "clean-up" refactor that dedupes on first-register will drop
  the surviving bridge post-restart.
- **Permalink construction is synchronous but depends on
  `teamDomain`**, cached from the startup `auth.test` handshake. Until
  that resolves it's undefined; formatters must degrade gracefully —
  there's no async fallback.
- **`ChannelMap` watches the *parent directory*, not the file**
  (`storage/channels.ts`), so editor atomic-rename saves are caught.
  100ms debounce; a bad-JSON reload keeps the previous in-memory map
  (never blows away active routing on a save error).
- **Cancel reactions target the spinner `ts`** (`reaction-map.ts`).
  Reacting on other messages is ignored. `stop_sign`, `octagonal_sign`,
  `no_entry`, and bare `stop` all map to `cancel`; workspace-custom
  aliases work as long as they contain `stop`.
- **Discovery filters `status === "warm"`** (`hydra-discovery.ts`).
  Cold sessions never get a thread; archiver-imported-but-unbound
  sessions are excluded via `upstreamSessionId` semantics. Bear this
  in mind when debugging "why doesn't this session have a thread yet".

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
