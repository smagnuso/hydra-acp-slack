# hydra-acp-slack

Bridges every active [hydra-acp](https://github.com/smagnuso/hydra-acp)
session to a Slack thread, so any ACP agent (Claude Code, Codex, Gemini,
etc.) running through hydra shows up in Slack:

- One thread per agent session.
- Tool calls render as cards with status icons (▶ → ✅ / ❌).
- Tool output is collapsed by default; expand with 👀 / 📖 reactions.
- Permission prompts surface as `:lock:` messages; ✅ / ❌ reactions
  approve or deny.
- Slack-side messages flow back into the agent as user prompts.

The bridge runs as a hydra extension (or standalone), polls hydra's
REST API for active sessions, and attaches over WSS to each one.

## How it works

```
                 hydra REST  +-------------+        Slack
       /v1/sessions   <----  |  hydra-acp-slack  |  ---->  Web API
                             |   daemon    |  <----  Socket Mode WS
       hydra WSS      <----> |             |
       /acp                  +-------------+
                                    |
                            ~/.hydra-acp/slack/
                              hidden/     (hidden originals)
                              truncated/  (full output cache)
                              channels.json  (cwd → channel map)
```

The daemon polls `GET /v1/sessions` on hydra (default every 2s) and, for
each new session id it sees, opens a WebSocket to hydra's `/acp`
endpoint and sends `session/attach`. Hydra replays the session's history
on attach, then live notifications flow through. Slack-side prompts are
forwarded back via `session/prompt`.

## Setup

### 1. Create the Slack app

The fastest path is to use the **app manifest** included in this repo
([`assets/slack-manifest.json`](assets/slack-manifest.json)) — it
pre-fills every scope and event subscription the bridge needs, so you
don't have to click through OAuth and Event Subscriptions tabs one box
at a time.

1. Go to https://api.slack.com/apps → **Create New App** → **From a
   manifest**.
2. Pick the workspace you want the bot to live in. Click **Next**.
3. **Paste the contents of `assets/slack-manifest.json`** from this
   repo. Slack defaults to YAML; switch the toggle to **JSON** so the
   paste parses cleanly. Click **Next**, then **Create**.
4. After creation, Slack drops you in **Basic Information**. Two
   credentials live elsewhere — go fetch them:
   - **Bot User OAuth Token** — left sidebar → **OAuth & Permissions** →
     scroll to "OAuth Tokens for Your Workspace". You'll see "Install to
     Workspace" first; click it, approve, and the page comes back with
     the bot token (starts with `xoxb-...`). Copy it.
   - **App-Level Token** — left sidebar → **Basic Information** → scroll
     to "App-Level Tokens" → **Generate Token and Scopes** → name it
     anything → check `connections:write` → **Generate**. Copy the
     `xapp-...` token shown once.
5. **Invite the bot to a channel.** In Slack itself, in whichever
   channel you want hydra to post to, type `/invite @HydraSlackAgent`
   (or whatever you renamed the bot to). You can't post to a channel
   the bot isn't a member of.
6. **Grab the channel ID.** In Slack, click the channel name at the top
   → **About** tab → scroll to the bottom — the channel ID (starts with
   `C` for public, `G` for private) is shown there. You'll paste this
   into the config below.

If you'd rather build the app from scratch instead of using the
manifest, the manual flow is:

- Bot scopes: `commands`, `channels:history`, `channels:read`,
  `chat:write`, `files:read`, `files:write`, `groups:history`, `groups:read`,
  `groups:write`, `im:history`, `reactions:read`.
- Enable **Socket Mode** in the Settings tab.
- Subscribe to bot events: `message.channels`, `message.groups`,
  `message.im`, `reaction_added`, `reaction_removed`.
- Enable **Interactivity** under Interactivity & Shortcuts.
- Generate an app-level token with `connections:write` and install the
  app to your workspace to mint the bot token.

### 2. Write the config file

Place credentials at `~/.hydra-acp/slack.conf`. This is a plain
`KEY=VALUE` file — quotes optional, comments with `#`. The bridge
reads it on startup; tokens never live in env vars or shell history.

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C0123456789

AUTHORIZED_USERS=U12345678,U23456789
WEBSOCKET_STALE_THRESHOLD=7200
DEBUG=false
```

Lock it down — these tokens give full read/write access to whichever
channels the bot is in, so treat them like API keys:

```sh
chmod 600 ~/.hydra-acp/slack.conf
```

`AUTHORIZED_USERS` is the allowlist of Slack user IDs whose messages
the bridge will forward to the agent as prompts (and whose reactions
are honored for allow/deny/cancel). To find your own user ID, click
your profile in Slack → **More** → **Copy member ID**.

> ⚠️ **Leaving `AUTHORIZED_USERS` empty means there is no allowlist —
> anyone the bot can see (i.e. anyone in the channels the bot is
> invited to) can prompt the agent and approve tool calls.** That's a
> reasonable default for a personal bot in a single-member workspace,
> but if other people share the workspace, set this to your own user
> ID (and any teammates you trust) before adding the bot to shared
> channels.

### 3. State directory

The bridge owns one directory on disk: `~/.hydra-acp/slack/`. It's
created lazily as the bridge runs; you don't need to set it up by
hand. Layout:

```
~/.hydra-acp/slack/
├── channels.json   # optional: { "<absolute cwd>": "<channelId>", ... }
├── hidden/         # full text of 🙈-hidden messages (so they can be restored)
└── truncated/      # full tool output cached for 📖 expand
```

**`channels.json`** is the only file you might want to seed by hand.
It routes hydra sessions to Slack channels by their cwd — useful if
you run hydra in multiple project directories and want each in its
own channel. Example:

```json
{
  "/home/me/work/big-project": "C01ABC",
  "/home/me/personal/side-quest": "C02DEF"
}
```

When a session attaches with cwd `/home/me/work/big-project`, the
bridge posts to channel `C01ABC`. If the cwd isn't in the map (or the
session has no cwd), the bridge falls back to `SLACK_CHANNEL_ID`.

The bridge watches `channels.json` and reloads it on change — edits
take effect the next time a session resolves a channel, no restart
required. Editor save styles that do atomic rename-over-original
(vim, emacs auto-save, `jq -i`, etc.) are handled. Bad JSON or a
deleted file just leaves the previous map in place and logs a
warning so a typo doesn't blow away routing for active sessions.

### 4. Install or build

From npm (recommended):

```sh
npm install -g @hydra-acp/slack
```

This drops an `hydra-acp-slack` binary on your PATH.

Or from source:

```sh
git clone https://github.com/smagnuso/hydra-acp-slack.git ~/dev/hydra-acp-slack
cd ~/dev/hydra-acp-slack
npm install
npm run build
```

### 5. Run as a hydra extension (recommended)

Register the extension with hydra. If installed via npm:

```sh
hydra-acp extensions add hydra-acp-slack --command hydra-acp-slack
```

Or pointed at a local build:

```sh
hydra-acp extensions add hydra-acp-slack \
  --command node \
  --args ~/dev/hydra-acp-slack/dist/index.js
```

That writes the equivalent entry into `~/.hydra-acp/config.json`:

```json
{
  "extensions": {
    "hydra-acp-slack": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-slack/dist/index.js"],
      "enabled": true
    }
  }
}
```

On `hydra-acp daemon start`, hydra spawns hydra-acp-slack with these env
vars set: `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`, `HYDRA_ACP_WS_URL`.
hydra-acp-slack uses them to discover and attach to sessions. Stdout/stderr
land in `~/.hydra-acp/extensions/hydra-acp-slack.log`. Lifecycle is managed
with `hydra-acp extensions start|stop|restart hydra-acp-slack` and
`hydra-acp extensions log hydra-acp-slack -f` to tail.

### 6. Run standalone (alternative)

Set `HYDRA_DAEMON_URL` and `HYDRA_TOKEN` in `~/.hydra-acp/slack.conf`
(or export them as env vars), then:

```sh
npm start
```

The daemon prints which hydra it's polling and which authorized users
it accepts.

## Configuration keys

| Key                         | Default                            | Notes |
|-----------------------------|------------------------------------|-------|
| `SLACK_BOT_TOKEN`           | (required)                         | Bot User OAuth Token from Slack, `xoxb-...`. |
| `SLACK_APP_TOKEN`           | (required)                         | App-Level Token from Slack, `xapp-...`, with `connections:write`. |
| `SLACK_CHANNEL_ID`          | none                               | Default channel ID (`C…`/`G…`). Used when the session's cwd has no entry in `~/.hydra-acp/slack/channels.json` (or the session has no cwd). |
| `AUTHORIZED_USERS`          | empty                              | Comma-separated Slack user IDs (`U…`) allowed to prompt the agent. **Empty = anyone in the bot's channels can prompt** — see security note below. Bot reactions (allow/deny/cancel) are gated the same way. |
| `UPLOAD_BUNDLE_ON_END`      | `true`                             | When the hydra session closes, attach the daemon-built `*.hydra` bundle (meta + history JSON) to the Slack thread — re-importable into any hydra via `hydra-acp sessions import` or the browser UI. Set to `false` to disable. |
| `WEBSOCKET_STALE_THRESHOLD` | `30`                               | Seconds of continuously-disconnected Slack Socket Mode WS before the bridge `process.exit(1)`s. Hydra's extension manager respawns it ~1s later with a fresh DNS cache + HTTP client; the existing process gets stuck in a reconnect loop after a network flap (VPN drop, etc.). |
| `BACKFILL_HISTORY`          | `false`                            | If true, replay hydra's cached history into Slack on attach. Off by default — replays trip Slack rate limits and create noise. |
| `LIVE_QUIET_MS`             | `2000`                             | Inbound silence (ms) needed before considering an attach "live" when `BACKFILL_HISTORY=false`. |
| `IMAGE_UPLOAD_RATE_LIMIT`   | `30`                               | Reserved. |
| `IMAGE_UPLOAD_RATE_WINDOW`  | `60`                               | Reserved. |
| `HYDRA_DAEMON_URL`          | `http://127.0.0.1:8765`            | Where to reach the hydra daemon. Set automatically when run as a hydra extension. |
| `HYDRA_WS_URL`              | derived from `HYDRA_DAEMON_URL`    | WebSocket endpoint for ACP attach. Defaults to `ws[s]://<host>:<port>/acp`. |
| `HYDRA_TOKEN`               | (required)                         | Bearer token for hydra. Set automatically when run as a hydra extension. |
| `HYDRA_POLL_INTERVAL_MS`    | `2000`                             | How often to poll hydra for session changes. |
| `DEBUG`                     | `false`                            | Verbose logging. |

## Reactions

| Reaction                                                                         | Action |
|----------------------------------------------------------------------------------|--------|
| `:white_check_mark:` / `:+1:` / `:star:`                                         | Approve once (picks the agent's `allow_once` option) |
| `:unlock:`                                                                       | Approve always (picks `allow_always` when offered, otherwise falls back to `allow_once`) |
| `:x:` / `:-1:`                                                                   | Deny |
| `:stop_sign:` / `:octagonal_sign:` / `:no_entry:` / `:no_entry_sign:` / `:stop:` | Cancel — react on the active turn spinner to send `session/cancel` to the agent. Ignored on any other message. |
| `:see_no_evil:` / `:no_bell:`                                                    | Hide message (toggle to restore) |
| `:eyes:`                                                                         | Expand truncated tool output |
| `:book:` / `:open_book:`                                                         | Expand full tool output |
| `:heart:` (and friends)                                                          | Forward as positive feedback to agent |

## Slash-style commands

| Command                          | Where            | Effect |
|----------------------------------|------------------|--------|
| `!debug`                         | inside a thread  | Replies with the session's debug info (sessionId, channel, ws state, last-frame time). |
| `!agents`                        | anywhere         | Lists agents installed in hydra's registry (`GET /v1/agents`). |
| `!session [agent] [cwd] [prompt…]` | anywhere         | Asks hydra to create a fresh ACP session (`POST /v1/sessions`). Both positionals are optional — hydra falls back to `defaultAgent` and `defaultCwd` from `~/.hydra-acp/config.json` (which itself defaults to `claude-code` and `~`). |
| `!<rest>`                        | inside a thread  | Strict-mirror of slash commands: anything else starting with `!` is forwarded as `/<rest>` — e.g. `!hydra title foo` → `/hydra title foo`, `!hydra agent claude-code` → `/hydra agent claude-code`, `!create_plan write a function` → `/create_plan write a function`. The bot validates the verb against the daemon-advertised command set (`available_commands_update`, which the daemon merges its `/hydra` registry with the agent's own commands), so any new daemon or agent verb automatically becomes a `!`-command here. Unknown verbs get a `:grey_question:` reaction and a thread reply listing what's available. |

`!session` parsing rules:

- The first token, if path-like (`/…`, `~…`, `./…`), is the cwd; otherwise it's the agentId.
- The second token, only if the first was an agentId, may be the cwd.
- Anything remaining is the prompt sent as the session's first user message.
- A `--` separator forces everything after it to be the prompt — useful when the prompt itself starts with a word that would otherwise be parsed as the agent (e.g. `!session -- what time is it?`).

Examples:

```
!session                                  # default agent + default cwd, no first prompt
!session ~/dev/foo                        # default agent in ~/dev/foo
!session opencode                         # opencode in default cwd
!session opencode ~/dev/foo               # both
!session opencode ~/dev/foo fix the bug   # both + first prompt
!session ~/dev/foo fix the bug            # cwd + default agent + first prompt
!session -- what time is it?              # all defaults + first prompt
```

The bot reacts ✅ on the command message and replies with the resolved agent/cwd. The new thread appears in whichever channel the resolved cwd maps to in `~/.hydra-acp/slack/channels.json` — falling back to `SLACK_CHANNEL_ID` when no mapping is found — which may differ from where `!session` was posted.

## Tests

```
npm test
```

Runs the formatter, ndjson, reaction-map, and command-parser tests with
the built-in Node test runner.

## Out of scope

- Outbound image upload via file watcher.
- True ACP-to-ACP bridging (different project).

## Status

Functional, in daily use, but rough around the edges. Open issues at
the project repo.
