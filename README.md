<p align="center"><img src="web/icon.svg" width="88" alt=""></p>

# Hearth

**A personal assistant that lives on your own server, uses the coding agent you already trust as its brain, and texts you first when it matters.**

- **You own the data.** Everything sits in a database you run: SQLite by default, or your own Postgres, MySQL or MongoDB. Export it all as one JSON file, or wipe it, from the app.
- **Just ramble.** Tap the big +, then type or hold to talk. An **orchestrator** on a smart model splits what you said into jobs, gives each to the right **teammate** (Planner, Scout, Money… or a new one it creates), and you watch the job cards finish.
- **Your agent is the brain.** Each job runs headless on `claude -p`, `codex exec` or any CLI you configure. You pick a harness and model for each role: **orchestrator** (plans), **workhorse** (light jobs), **heavy** (hard jobs, and anything the workhorse escalates). The hub stores no model keys.
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

### Rambles, teammates and escalation

1. You ramble into a chat. The **orchestrator** (default `claude-fable-5-1`) returns a title, a short reply, facts to remember, and jobs. Each job has a teammate and an effort, `light` or `heavy`.
2. Light jobs run on the **workhorse** (default `claude-sonnet-5-5`), heavy ones on **heavy** (default `claude-opus-5-5`). If the workhorse fails or answers `[[escalate]]`, the job reruns on heavy and its card says "escalated".
3. Teammates are a name plus a role prompt. If no teammate fits, the orchestrator creates one, which you can see and delete in the app.
4. Voice: the app records audio and the hub transcribes it with Deepgram (`HEARTH_DEEPGRAM_API_KEY`), so the key never reaches the phone. Speech-to-text is an interface in [src/voice.ts](src/voice.ts), so other providers can be added.

### How it looks (like Slack)

- **Home** works like Slack's sidebar: a **Jump to…** search (⌘K) that finds teammates, chats and individual tasks, then your **group chats** and **direct messages** with each teammate. Each teammate has a face that acts out what it's doing (idle, thinking, working, waiting for you, stuck, done) and a one-line status in its own voice.
- **Each ramble becomes a group chat.** Hearth posts each task as its own message ("@Scout find pottery studios near Priya"). Under each task you watch that teammate work, then see their reply, a tile preview and "1 reply". Approve and Try again sit right there.
- **Tap a task to open its thread**, full screen on a phone and beside the chat on a wide screen. Read the full answer and reply to that teammate; follow-ups keep the thread as context.
- **Direct messages** go straight to one teammate, skipping the orchestrator, and show its routines and the tasks it has in group chats.

### Parallel jobs

The orchestrator gives jobs a `dependsOn` only when one needs another's result; everything else runs at once (`HEARTH_MAX_PARALLEL`, default 4, plus `HEARTH_MAX_PARALLEL_CLAUDE` / `_CODEX` per harness). Each job is its own agent process. A new ramble is read immediately even while jobs run. Heavy jobs may split into 2-4 sub-agents (one level deep) whose results are merged. Spend caps per ramble and per day (`HEARTH_COST_CAP_RAMBLE_USD`, `HEARTH_COST_CAP_DAY_USD`) park jobs instead of running them. In the app, teammates post their results in the conversation, and only Approve or "stuck" rows ask for you.

### Tiles

Results like weather, places, checklists and numbers show as tiles: fixed components the app draws from data, never generated code. Scripts print `@tile {json}`; teammates use a `tile` action. Asking to change a tile ("show hourly", "in Fahrenheit") saves options on the skill, so it sticks.

### Workflows you keep, and a cleanup

Tap **Save as workflow** on a finished ramble to keep it, or say "save this as my …". "Run my …" replays it, reusing skills where it can. A nightly cleanup, with no model, removes skills and workflows unused for `HEARTH_PURGE_UNUSED_DAYS` (default 45), ones that keep failing, proposals never switched on, and assistant scripts nothing uses. Pinned items are never removed, and everything removed is logged.

### Files

Teammates make files (an itinerary `.md`, a calendar invite `.ics`, a `.csv`) with a `file.create` action. Scripts write files in their working folder and print `@file name`. You attach files with the paperclip. Every file shows as a card with **View** (images, PDFs, text, audio, video) and **Download** (saves to your phone or computer). Files live on your hub under `data/files`, only paired devices can fetch them, and downloads carry a sandbox CSP. HTML and SVG always download instead of rendering. Teammates read attached text files; other types are listed by name for now.

### Approve before send

Anything that would send, post, pay, book, delete or change something outside the hub stops at an **Approve** card, and the hub enforces it, not the model. Each script is classified when it's saved: an `// effects: external` header, write-style HTTP calls or known senders mark it *external*. External scripts refuse to run unless you tapped Approve for that specific run. That holds even after you've approved the script's code, inside recipes and workflows, and when a hook fires.

### Skills: don't work it out twice

- **Search before create.** Every ramble and job gets a shortlist from the library of skills, workflows and approved scripts. The shortlist uses embeddings when `HEARTH_FIREWORKS_API_KEY` is set and keyword matching otherwise; the model makes the final pick. The orchestrator can route a job straight to a skill.
- **Skills** are either a *script* (runs directly, no model, $0) or a *recipe* (steps a light model follows, limited to the approved scripts the recipe lists). Teammates save skills after solving something likely to come back, or you tap **Save as skill?** on a job card. Memory records "for X, the team uses skill Y".
- **Workflows** chain skills (`$input.x`, `$prev`). The orchestrator can propose new ones; you switch them on.
- **Self-repair.** If a skill fails, the job is solved fresh and the teammate saves a fixed version. A fixed recipe can't use any script the old one didn't; fixed code goes back through your approval.
- **Blocked, not stuck.** If a job needs something only you can give (a login, your laptop, a permission), it parks with an "Unblock me" card and a push notification, and never pretends it worked.

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
| `HEARTH_AGENT` | `claude` | Default harness: `claude`, `codex`, `echo` (demo), or `custom` with `HEARTH_AGENT_CMD='["ollama","run","llama3.1"]'` |
| `HEARTH_ORCHESTRATOR_MODEL` / `_WORKHORSE_` / `_HEAVY_` | Fable / Sonnet / Opus | Default models per role; `HEARTH_*_AGENT` sets the harness. Changeable in the app under Brains |
| `HEARTH_DEEPGRAM_API_KEY` | none | Turns on hold-to-talk |
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
