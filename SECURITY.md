# Security model

Hearth holds personal data and can act on a schedule, so it is built to fail closed.

## Who can talk to the hub
- **Primary device.** Like a router's admin. The first device paired (with the setup code the server prints) is *primary*. Only a primary device can add devices, approve access requests, sign out other devices or hand the role on. The terminal only hands out primary codes: `bun run setup` before any device exists, and `bun run recover`, which needs a login on the server.
- **Pairing.** A one-time code: 8 characters from a 32-symbol alphabet, valid 10 minutes, single use, stored only as a SHA-256 hash. Redeeming it gives the device a random 256-bit token. Codes made in the app (Settings → Devices → Add a device, shown as a QR code) pair ordinary devices.
- **Access requests.** A new device without a code can ask to join. It and your primary device show the same 4-character code. The request lasts 10 minutes and is held in memory only, and requests are limited to 3 per IP and 10 in total per 10 minutes. Approving takes a fresh passkey signature when the primary has Face ID lock. The new token goes once to the requester, which proves itself with a 256-bit secret it got when it asked.
- **Face ID lock (passkeys).** Optional per device, or required for all with `HEARTH_REQUIRE_PASSKEY=1`. The hub stores only the passkey's public key. While a device is locked, its token reaches only the unlock endpoints. An unlock checks the challenge (single use, 5 minutes, bound to that device), the origin, the rpId hash, that the user was present *and verified*, and the ES256/EdDSA/RS256 signature. It gives a session (stored hashed, `HEARTH_UNLOCK_HOURS`, default 12) that the app keeps in `sessionStorage`, so closing the app locks it again.
- **Wrong keys.** 20 wrong device tokens from one IP within 10 minutes shuts that IP out of pairing and access requests for the rest of the window. Valid devices are never shut out. Behind a proxy, the client IP is the last `X-Forwarded-For` hop, the one the proxy added.
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

## Files
- Files are stored under `<data>/files` with mode `0600`, named by random id; original names are stripped of path parts.
- Downloads need a device token and are served with `Content-Security-Policy: sandbox` and `nosniff`. Only images, PDFs, plain text, audio and video may display inline; HTML, SVG and everything else download as `application/octet-stream`.
- A script can only hand over files from its own working folder, by name.

## Mini apps
- An app is HTML a teammate wrote, so it is treated as untrusted. It loads in an iframe with `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`, so it gets an opaque origin: it can't read the app's storage or device token, or call the hub's API.
- Its page is served with its own CSP: `sandbox`, `connect-src 'none'`, no external scripts, styles, images or fonts (only inline and `data:`), `form-action 'none'`, and `frame-ancestors` limited to this hub and `HEARTH_ALLOWED_ORIGINS`. It can't fetch, post or load a tracking pixel.
- Iframes can't send the device token, so the app screen first asks for a ticket: random, for one app only, valid 10 minutes, kept in memory.
- The only ways out of an app are `postMessage`s the app screen accepts only from that app's own frame: `hearth.save(state)` (that app's state, 48 KB max) and `hearth.ask(text)` (a message to the teammate who made it, at most one every 3 seconds and 30 an hour, shown in your DM with them). A message from an app is still just a message: anything with external effects stops at Approve.
- What remains: an app could *show* misleading text, such as a fake login form. Hearth never asks for passwords inside an app.

## Linked computers
- A computer (your Mac) joins the way a phone does: it asks, shows a 4-letter code, and only your primary device can approve it. It gets its own key, stored on the hub only as a hash.
- That key opens the computer link and nothing else. Every API call made with it gets `403`, so a computer can't read chats, memory or settings, and it can't be made primary.
- The computer dials out to the hub over the hub's HTTPS address and sends its key in a header. Wrong keys count toward the same lockout as the API.
- All thinking happens on the hub. The hub can ask a computer for nothing but the login files you chose to copy: it never runs work there and never gets a shell.
- **Copy to the hub** is off by default and set per login (Claude, Codex) by the primary device. Only a server hub (`HEARTH_TARGET=lightsail`) accepts copies, only for the logins you turned on, at most 64 KB, and only valid JSON. They're written `0600` to the hub user's home. Turning a copy off deletes it, but only if the file is still the one the hub wrote, so a login set up by hand is never removed.
- Unlinking a computer closes its line at once (the computer stops retrying) and deletes the logins it copied.
- The E2B key is checked with E2B, then kept encrypted in the hub's vault (or `HEARTH_E2B_API_KEY`); it's never in your data, exports or the app. Checking whether the hub has a login doesn't read the secret, so on a Mac there's no Keychain prompt just to show the screen.

## The workbench (where teammates' code runs)
- Teammates never run code on the hub's own process. They call tools (`run`, `write_file`, `read_file`, `copy_in`, `copy_out`) through a small MCP server, with a key that's good for one job only (30 minutes, renewed while used, dead when the job ends). The hub carries the call out on the workbench.
- The tools stay inside `/work`: paths outside it are refused, and in plain mode symlinks are resolved so a link the code made can't lead the tools elsewhere. `copy_in` only reaches files from the same chat.
- **Docker** (the default on a hub without E2B): the container sees only its own volume, not the hub's data, keys or files. It runs as an unprivileged user, with all capabilities dropped, `no-new-privileges`, and capped memory, CPU and processes. File reads and writes go through the container, never a folder shared with the host. On a server, `deploy/setup.sh` blocks containers from the cloud metadata address (169.254.169.254). Honest trade-off: the hub's user is in the `docker` group to start the container, and Docker access is powerful on the host.
- **E2B:** one sandbox for the team, on E2B's machines. Nothing secret is put on it.
- **Plain** (opt-in only, with a warning): commands run as the hub's own user, so they could read its data and keys. "Automatic" never picks it.
- Each job's session (commands, installs, files in and out, trimmed output) is stored on the hub, so you can see exactly what ran.

## API keys (the vault)
- The hub's API keys (E2B, Deepgram, your VMs' SSH keys) are kept in their own SQLite file, `data/keys/vault.db` (`0600`, folder `0700`), separate from your main data even when that's Postgres or MySQL. Each value is encrypted with AES-256-GCM under a fresh random IV and bound to its name, so a value copied to another row won't decrypt, and any tampering is detected.
- The master key lives outside the data folder: `~/.hearth/master.key` (`0600`; the hub refuses it if others can read it), or `HEARTH_MASTER_KEY`. A copy or backup of the data folder alone can't reveal your keys. A wrong master key is reported at start rather than failing quietly.
- Keys saved in plain files by older versions are moved into the vault on start, and the plain files deleted. `bun run doctor` checks all of this.
- Keys are never in the database, exports, logs or anything sent to the app; the app only learns whether a key is set (and for Deepgram, its last 4 characters).
- What's still a plain file, on purpose: the Claude/Codex login files, because those CLIs read them directly. They're `0600` in the hub user's home.

## Your data
- SQLite files and the data folder are created with mode `0700`. Use a Postgres or MySQL user with access only to the Hearth tables.
- Web Push VAPID keys are generated on first run and kept with your data; nothing is hard-coded. Push payloads go from your hub to your browser's push service, encrypted end to end per the Web Push standard.
- Location history is kept for 7 days. Export and full wipe are in the app.

## Reporting
Please report vulnerabilities privately through GitHub Security Advisories on this repository rather than in a public issue.
