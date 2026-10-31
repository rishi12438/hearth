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

## Shared teammates
- A shared link runs in its own container: non-root, read-only image, no capabilities, `no-new-privileges`, memory, CPU and
  process limits. It sees two folders: its bundle (read-only) and its own data. The bundle holds only the notebooks, notes,
  scope and folder files you picked; the teammate's private prompt, other memory, people, location, messages, files, hooks
  and apps are never copied.
- Its network is an internal Docker network with no route out (not the host, not `169.254.169.254`, no outside DNS). The
  only way out is an egress proxy that tunnels HTTPS to `api.anthropic.com` and refuses everything else, including IP
  literals and private addresses. It uses its own API key, which the hub never sees; set a spend limit on that key.
- The hub doesn't get Docker access: `hearth-boxctl` (root, installed outside the hub's folder) accepts only
  start/stop/remove for a 24-hex-digit id and builds every path and flag itself. It refuses a bundle that's a symlink.
- The box can't reach the hub. The hub reads the box's outbox file and rebuilds every event field by field; malformed
  events are dropped. Visitor text is shown as text and never becomes memory.
- Visitors reach the box only through `/t/<link>/api/*`, which the hub forwards as JSON with `Content-Security-Policy: sandbox`.
  The chat page is the hub's own code, served with a sandbox CSP (opaque origin), so it can't read the app's storage or
  device token. Links are 144-bit random capabilities; turning one off removes its box and data.
- Folders: copies skip `.env*`, keys, `.git`, `node_modules`, anything in `.gitignore`, symlinks, binary files and files
  that look like they hold a secret. `read` files are mounted read-only; writes land only in that visitor's copy. Changes
  come back as proposals; the hub checks each path against your rules again (and refuses files it never copied) before
  writing, keeps the previous contents for Undo, and stops on a conflict instead of overwriting your edits.
- A guard model screens each message for scope, rule-change attempts and abuse, and a reply check blocks code and essays
  where the scope doesn't allow them. These keep the teammate on its job; they are not what protects your data. The
  container is: assume anything in the bundle can be read out word for word.
- A link can run on **your Claude subscription** instead of an API key. The box then writes each model request into its
  own folder and the hub answers into its read-only bundle: still no network path to the hub, and your login never enters
  the box. The hub runs each request as `claude -p` with no tools, no MCP and no settings, only with the models that link
  is set to, and at most 400 calls a day per link. The cost is that visitors spend your subscription, and serving other
  people this way may be against your plan's terms; the app says so where you choose it.
- The `local` runner (a plain subprocess) is for trying the feature on your own machine and is not sealed.

## Your data
- SQLite files and the data folder are created with mode `0700`. Use a Postgres or MySQL user with access only to the Hearth tables.
- Web Push VAPID keys are generated on first run and kept with your data; nothing is hard-coded. Push payloads go from your hub to your browser's push service, encrypted end to end per the Web Push standard.
- Location history is kept for 7 days. Export and full wipe are in the app.

## Reporting
Please report vulnerabilities privately through GitHub Security Advisories on this repository rather than in a public issue.
