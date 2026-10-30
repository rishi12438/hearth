<p align="center"><img src="web/icon.svg" width="88" alt=""></p>

# Hearth

**A personal assistant that lives on your own server, uses the coding agent you already trust as its brain, and texts you first when it matters.**

- **You own the data.** Everything sits in a database you run: SQLite by default, or your own Postgres, MySQL or MongoDB. Export it all as one JSON file, or wipe it, from the app.
- **Your agent is the brain.** Each message or event becomes one headless run of `claude -p`, `codex exec`, or any CLI you configure. The hub stores no model keys.
- **Proactive by design.** The assistant creates *hooks*, rules for when to speak first. Each one has a reason it can show you, and all of them respect quiet hours and a daily limit.
- **Direct line.** Your phone pairs with your hub using a one-time code and talks to it over HTTPS. There's no relay, no account and no middleman.

## How it works

```
phone (home-screen web app) ──HTTPS──►  your hub (e.g. a $5 Lightsail box)
                                         ├─ hooks engine   when to speak first (time, schedule, watch, place, silence)
                                         ├─ memory         notebooks of facts, core facts always in mind, history kept
                                         ├─ scripts        small programs it can run; ones it writes need your approval
                                         ├─ brain          claude -p / codex exec / custom CLI, run per event
                                         └─ storage        SQLite | Postgres | MySQL | MongoDB
```

Run one hub on an always-on box so routines fire while your laptop sleeps. Run another on your laptop if you like. The app keeps a list of hubs and switches between them.

### Hooks: how it speaks first

| Trigger | Example |
|---|---|
| `at`, optionally repeating | "Remind me at 6 to call mom", "ask me how the interview went tomorrow evening" |
| `schedule` (cron-like) | "Every weekday at 8, brief me" |
| `every` N minutes | "Every 2h, check if tickets are on sale; only tell me if they are" |
| `place` arrive/leave | "When I get to the office, remind me to grab the charger" |
| `silence` | "If I haven't said anything in 48h, check in" |

A hook does one of three things: **notify** (send fixed text), **think** (run the brain, which can decide to stay quiet), or **script** (run an approved script, then send or interpret its output). Every proactive message carries a *why* you can tap. Quiet hours and the daily cap are enforced by the hub, not left to the model. Reminders you asked for yourself always come through.

### Memory

Inspired by Enkidu's notebooks, Letta's core memory, Zep's temporal facts and mem0's consolidation:

- Each fact is one sentence in a notebook (people, health, work…), with its source and your original words.
- **Core** facts (importance 3) are always in context. The rest are recalled by relevance to the current message.
- When a fact changes it is *superseded*, so you can see what it used to believe. Temporary facts expire.
- A nightly review hook merges duplicates and refreshes each notebook's summary.
- You can see, star, edit and delete everything in the Memory tab.

### Scripts

`scripts/*.ts` are yours and trusted. Two examples ship with it: `weather` (Open-Meteo, no key) and `page-watch`. The brain can also *write* scripts. Those start as proposals and only run after you read the code and tap Approve. Approval pins the file's SHA-256, so an edited script won't run until you approve it again. Scripts run with a timeout, capped output and a minimal environment that contains none of the hub's settings or secrets.

## Quick start

```bash
bun install
bun run dev            # demo brain, no keys: try "remind me in 2 minutes to stretch"
# open the pairing link it prints
```

With a real brain: log in to `claude` (or `codex`) on the machine, then `cp .env.example .env`, set `HEARTH_AGENT=claude`, and run `bun start`.

Deploying on Lightsail with HTTPS, systemd and phone notifications: [deploy/lightsail.md](deploy/lightsail.md).

## Configuration

All settings are environment variables; see [.env.example](.env.example). The main ones:

| Variable | Default | |
|---|---|---|
| `HEARTH_AGENT` | `claude` | `claude`, `codex`, `echo` (demo), or `custom` with `HEARTH_AGENT_CMD='["ollama","run","llama3.1"]'` |
| `HEARTH_DB_URL` | SQLite in `./data` | `postgres://…`, `mysql://…`, `mongodb://…` (run `bun add mongodb`) |
| `HEARTH_HOST` / `HEARTH_PORT` | `127.0.0.1:8790` | Keep it on localhost and put Caddy in front |
| `HEARTH_ALLOWED_ORIGINS` | none | Other hubs' origins allowed to call this one from the same app |

To add a storage backend, implement the `Store` interface ([src/store/types.ts](src/store/types.ts)) in one file and register its URL scheme in [src/store/index.ts](src/store/index.ts).

## Security

See [SECURITY.md](SECURITY.md). In short: one-time pairing codes, per-device tokens stored only as hashes, rate-limited pairing, strict CSP, no `innerHTML`, an origin allowlist, a brain with no file or shell tools whose actions are validated by the hub, and approval with hash pinning for scripts.

## Development

```bash
bun test               # hooks engine, quiet hours, memory, pairing, script approval
TEST_DB=postgres://… bun test   # same suite against Postgres
bun run typecheck
```

The front end is plain TypeScript in `web/src`, bundled in memory by Bun when the hub starts. There's no framework and no build folder. MIT licensed.
