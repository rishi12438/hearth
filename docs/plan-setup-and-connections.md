# Plan: setup flow and connections

Status: idea, nothing built yet (noted 2026-11-01).

## What the user wants

One setup flow, so nobody has to edit env vars or run scripts by hand:

- **It ships as a Mac app in a DMG (asked 2026-11-01).** Download `Hearth.dmg`, drag Hearth to Applications, open it, and the setup wizard below appears in its window. The app bundles the hub, so there's no Bun, git or terminal to install. After setup, the same app is how the Mac links to the hub (status, logins), and on a local hub it also runs the hub itself.

0. **First step: pick the brain.** Setup detects which supported coding agents are installed on this machine (look on PATH and in the usual install spots, and check whether each one is logged in). **Supported for now: Claude Code (`claude`) and Codex (`codex`) only.** Cursor (`cursor-agent`) maybe later. No OpenCode. Then it asks "Who do you want the brain to be?" as a **multi-select**: tick one or several. Show each agent's version and whether it's logged in; offer "log in" for any that aren't. If the hub is remote, the chosen logins are copied up to it (below), because thinking only happens on the hub.
   - **Getting the logins to the hub (copying Enkidu's cloud agents, herdr `src/cli/cloud_agent.rs`, `src/cloud/sources.rs`).** If the hub is **this Mac**, nothing is copied: the hub uses the logins already here. If the hub is a **server**, setup makes long-lived logins on the Mac and copies them up:
     - **Claude Code:** run `claude setup-token` (the user approves once in the browser; the token lasts about a year). Run it under `script` with output to /dev/null and catch the `sk-ant-oat…` token from the stream, so it's never written to disk or shown. Show the output with the token replaced by `[redacted]`. If it can't be caught, ask the user to paste it. On the hub the token goes in the vault and is passed to every `claude` run as `CLAUDE_CODE_OAUTH_TOKEN`.
     - **Codex:** copy `~/.codex/auth.json` (it has a refresh token, and Codex renews it itself) to the hub's `~/.codex/auth.json`, mode 0600. Codex rotates refresh tokens, so both copies are kept in sync by their `last_refresh` and the newest wins; otherwise one side's refresh would sign the other out.
     - The agent CLI does the same: `hearth brains login claude --to-hub` and `hearth brains login codex --to-hub`.
     - Removing a brain deletes its token or `auth.json` from the hub.
     - Live usage with a setup token: `api/oauth/usage` may not accept it. If not, use the `rate_limit_event` from each run (checked 2026-11-01: `claude -p --output-format stream-json --verbose` emits `{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.17,"resetsAt":…}}}}`).
   - **Several brains picked → the one with the most room on its live limits goes first (decided 2026-11-01, copying Mako: github.com/Verbiflow/mako, `packages/host/src/harnesses/{claude,codex}/accounts.ts`, `contracts/account-usage.ts`).** Not Hearth's own counts: read each subscription's real usage from the provider.
     - **Claude Code:** `GET https://api.anthropic.com/api/oauth/usage` with the login's OAuth token (`Authorization: Bearer …`, `anthropic-beta: oauth-2025-04-20`). It returns `five_hour`, `seven_day` and `seven_day_opus`, each with `utilization` and `resets_at`. A 401 means the token is stale (Claude refreshes it on its next run): keep the last reading and don't treat it as an error. Updated live from the `rate_limit_event` messages in Claude's stream-json output while a job runs.
     - **Codex:** start `codex app-server` and send JSON-RPC: `initialize`, then the `initialized` notification, then `account/rateLimits/read`. It returns `rateLimits.primary` and `.secondary`, each with `usedPercent`, `resetsAt` and `windowDurationMins`, plus `planType`. This is read-only and costs nothing. Updated live by `account/rateLimits/updated` (only if Hearth drives Codex through app-server; with `codex exec`, re-read after each job). Mako also falls back to ChatGPT's `backend-api/wham/usage`.
     - **Score = the "binding" window**, i.e. the fullest of that brain's windows; any window already past its `resets_at` counts as 0%. Each new job goes to the chosen brain with the lowest score.
     - **Refresh** every ~5 min, right after each job, and immediately when a brain refuses a job for hitting its limit. A refused brain counts as full until its reset time, and the job is retried on the next one.
     - **Thresholds (Mako's):** a brain at 90% or more is "near its limit". Only move work to a brain at 70% or less; if every brain is past 90%, park the job and show when the earliest one resets.
     - **Unlike Mako, Hearth switches by itself.** Mako only suggests a switch because its "accounts are money"; here the user picked the brains and asked for automatic routing.
     - Every brain tile shows its live bars (5-hour / weekly, % and reset time), like Mako's account usage.
     - Hub-only rule: these reads run on the hub, using the logins copied up there.
1. **Where the hub runs**
   - **Remote server:** enter the domain plus the server's IP and SSH details (user and key). Setup connects over SSH and does what `deploy/setup.sh lightsail <domain> <email>` does now: installs the hub, sets up HTTPS and starts the service.
   - **Local:** run the hub on this machine instead, with no domain or server.
2. **API keys:** add **Serper** (web search) and **Deepgram** (voice). Each key is checked when it's pasted, stored in the vault and never shown again. This is how Deepgram already works in Settings → Voice.
3. **Social connections:** connect **Slack**, **WhatsApp**, **Instagram** and **LinkedIn** so teammates can read them (and send, behind Approve). Decided 2026-11-01:
   - **WhatsApp:** link a device by scanning a QR code, the way WhatsApp Web works (e.g. Baileys), using the owner's personal number. No Business API.
   - **Instagram:** use the owner's login cookies (`sessionid`), so personal DMs work. No Graph API.
   - **LinkedIn:** use the owner's login cookies (`li_at`).
   - **Slack:** a normal Slack app token.
   - **Ban-risk warning:** WhatsApp, Instagram and LinkedIn are unofficial, so before connecting, show a clear warning that this breaks the site's terms and the account could be limited or banned. It's the owner's choice, and they must confirm it once per connection. The CLI and API need an explicit flag for the same confirmation (e.g. `--accept-risk`).
4. **WhatsApp ignore rules:** choose what Hearth never sees or acts on:
   - specific contacts
   - groups
   - keywords or topics
   - possibly archived or muted chats
5. **A grid of connectors.** Settings shows every connector as a tile in a grid: logo, name, and a status (not connected / connected / needs reconnecting). Tapping a tile opens its own short add flow: paste a key, scan a QR code, or bring cookies over from the Mac, plus the risk warning where one applies. Tiles:
   - **Brain:** a tile for each coding agent picked in step 0 (Claude Code, Codex), so brains can be added or removed later. "Detect again" re-scans the machine.
   - **Keys:** Serper, Deepgram.
   - **Messaging and social:** WhatsApp, Slack, Instagram, LinkedIn.
   - New connectors are added as one more tile, using the same pattern.
6. **Agents can do all of it too.** Every step above must also work without a person clicking through it, so a coding agent (Claude Code, Codex) can set up Hearth on its own:
   - a CLI that never prompts, e.g. `hearth setup --remote --domain x --ip y --ssh-key ~/.ssh/k` or `hearth setup --local`, `hearth keys set serper <key>`, `hearth connect slack --token …`, `hearth whatsapp ignore add <contact|group|keyword>`;
   - the same actions over the hub's API, so a running teammate can do them;
   - JSON output and clear exit codes, so an agent can tell whether a step worked;
   - one source of truth: the wizard, the CLI and the API all call the same code, so none of them can drift;
   - steps a person must do (scanning a WhatsApp QR code, approving OAuth in Slack or Instagram) print a link or QR code for the agent to pass on, then wait until the step is done;
   - keys pasted by an agent go through the same check and vault, and are never echoed back in output or logs.

## Notes on what's possible (check before building)

- **Slack:** straightforward. Use a Slack app with a bot or user token; Socket Mode avoids needing a public webhook.
- **WhatsApp (linked device):** the hub keeps the linked-device session in the vault. Ignore rules work because every message carries a chat ID, so the hub can drop ignored ones before storing them or showing them to a model.
- **Instagram and LinkedIn (cookies):** cookie connections already exist in `src/cookie-sites.ts` (presets for `instagram` → `sessionid` and `linkedin` → `li_at`), and the Mac link can copy them up from Chrome. What's new is reading and sending DMs and messages, plus handling expired cookies (ask the owner to reconnect).
- Existing pieces to reuse: the vault (`src/vault.ts`), the Deepgram key flow (`src/voice.ts`), and the deploy scripts (`deploy/`). Following the hub-only rule, every connection runs on the hub and devices only link.

## Open questions


- When an agent connects something that can send messages (WhatsApp, Slack), should it still need the owner's Approve on the phone?
- Is the setup flow a web wizard served by a local CLI, a screen in the phone app, or both?
- Should ignored WhatsApp messages be dropped completely, or stored but hidden from teammates?
