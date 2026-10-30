# Security model

Hearth holds personal data and can act on a schedule, so it is built to fail closed.

## Who can talk to the hub
- **Pairing.** The hub prints a one-time code: 8 characters from a 32-symbol alphabet, valid 10 minutes, single use, stored only as a SHA-256 hash. Redeeming it gives the device a random 256-bit token.
- **Tokens.** The hub stores only `sha256(token)` and compares in constant time. A copied database can't be used to log in. Revoking a device in the app cuts its live stream immediately.
- **Brute force.** Pairing is rate-limited to 5 attempts per IP and 30 in total per 10 minutes.
- **Transport.** The hub binds to `127.0.0.1` by default. Put Caddy (auto-HTTPS) in front; the app refuses plain `http://` for non-local hubs. Live updates use a streamed `fetch`, so the token travels in a header and never in a URL or log.
- **Browser hardening.** Strict CSP (`script-src 'self'`, no inline code), `frame-ancestors 'none'`, `nosniff`, `no-referrer`, and HSTS behind a proxy. API calls from other origins are refused unless listed in `HEARTH_ALLOWED_ORIGINS`. Request bodies must be JSON and at most 64 KB. The UI never uses `innerHTML`: model output, script output and memory are rendered as text.

## What the brain can do
- It runs as a subprocess in an empty working folder. For Claude the file, shell and edit tools are disabled and only web search and fetch are allowed; Codex runs in its read-only sandbox. `HEARTH_*` variables, including your database URL, are removed from its environment.
- It can't touch data directly. It *proposes* actions in a fenced block; the hub validates each one against a fixed list (hooks, memory, places, scripts) and drops anything else. Hooks have bounds: watches run at most every 15 minutes, and quiet hours and the daily cap are enforced by the hub.
- Script output and other fetched content are wrapped as untrusted data in the prompt.
- It can't send, spend or message anyone by itself. The only way out is an approved script with external effects, and each run of one waits for your Approve.

## Scripts
- Repo scripts (`scripts/`) are trusted because you put them there. Scripts the brain writes are saved as `proposed` and can't run until you approve them in the app.
- Approval sends the SHA-256 of the code you were shown. If the file changed in between, approval fails. If the file changes after approval, it won't run until you approve it again.
- Scripts run with Bun, a 60-second timeout and 8 KB of captured output, with an environment of only `PATH`, `HOME` (a scratch folder), `LANG` and `TZ`. They still run as the hub's OS user with network access, so read them before approving. The systemd unit in `deploy/` limits the filesystem the hub can write to.

## Approve before send
- Scripts are classified *read* or *external* when saved. External ones (an `// effects: external` header, POST/PUT/PATCH/DELETE calls, mail/SMS/payment libraries, spawning processes, file writes) only run after you tap Approve for that run. Approving the code is not enough. Recipes, workflows and hooks go through the same gate.
- The classification is a guard rail, not a proof: a script could still leak data through a GET request. Reading the code before you approve it is the real gate, which is why code always needs your review.
- Recipes may only run the approved scripts they list. A repaired recipe can't add new ones.

## Your data
- SQLite files and the data folder are created with mode `0700`. Use a Postgres or MySQL user with access only to the Hearth tables.
- Web Push VAPID keys are generated on first run and kept with your data; nothing is hard-coded. Push payloads go from your hub to your browser's push service, encrypted end to end per the Web Push standard.
- Location history is kept for 7 days. Export and full wipe are in the app.

## Reporting
Please report vulnerabilities privately through GitHub Security Advisories on this repository rather than in a public issue.
