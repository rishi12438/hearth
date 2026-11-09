# Voice calls: the Hearth ↔ Arca contract

Arca owns the phone line (our Vonage account and the shared number). A Hearth hub owns everything that happens on a
call (the voice model, the supervising agent, the transcript, Listen and Join). Arca dials; the call's audio goes
straight from Vonage to the hub.

Base URL: `HEARTH_ARCA_URL` on the hub (default `https://sync.tryarca.ai`). All bodies are JSON.

## 1. Register a hub (once, when the owner turns on voice calls)

`POST /v1/phone/register`

```json
{ "hub": { "name": "Rishi's hub", "url": "https://testingses.online" } }
```

→ `201 { "key": "arcaph_<43 base64url chars>", "number": "+14155550123" }`

- No account needed. Arca keeps only `sha256(key)` plus the hub name/url and when it was made.
- Rate limited per client IP (5 registrations per IP per day) → `429 { "error": "…" }`.
- Phone not set up on this Arca → `503 { "error": "Voice calls aren't set up on this server yet." }`.

Every call below sends `Authorization: Bearer <key>`. A wrong or revoked key → `401`.

## 2. Place a call

`POST /v1/phone/calls`

```json
{
  "to": "+14155550199",
  "audioUrl": "wss://testingses.online/call-audio/c_8f2a…?t=<per-call secret>",
  "eventUrl": "https://testingses.online/api/calls/events/c_8f2a…",
  "maxSeconds": 900
}
```

→ `201 { "id": "<arca call id>", "from": "+14155550123" }`

- `to`: E.164 (`^\+[1-9]\d{6,14}$`). `audioUrl` must be `wss://`, `eventUrl` must be `https://` (both ≤ 2000 chars), and
  both on the host of the `hub.url` the key was registered with (else `400`).
- `maxSeconds`: optional, clamped to 30–900 (default 900).
- Limits per key (free tier): 20 calls and 30 minutes per UTC day; also a server-wide daily cap
  (`ARCA_PHONE_DAILY_CALLS`, default 500). Over → `429 { "error": "…" }`.
- Arca calls Vonage `POST /v1/calls` with an inline NCCO, from the shared number:
  ```json
  { "to": [{ "type": "phone", "number": "14155550199" }],
    "from": { "type": "phone", "number": "14155550123" },
    "ncco": [{ "action": "connect", "from": "14155550123",
               "endpoint": [{ "type": "websocket", "uri": "<audioUrl>", "content-type": "audio/l16;rate=16000",
                              "headers": { "callId": "<arca call id>" } }] }],
    "event_url": ["<ARCA public base>/v1/phone/vonage/events?call=<arca id>&t=<per-call secret>"],
    "event_method": "POST", "length_timer": <maxSeconds>, "ringing_timer": 45 }
  ```
  Vonage error → `502 { "error": "<Vonage's reason>" }`.

## 3. Hang up

`POST /v1/phone/calls/<id>/hangup` → `200 { "ok": true }` (Vonage `PUT /v1/calls/<uuid>` `{"action":"hangup"}`).
Only the key that placed the call can hang it up (`404` otherwise). Already finished → `200`.

## 4. Call status, forwarded to the hub

Vonage posts call events to Arca (`/v1/phone/vonage/events`, checked by the per-call secret). Arca records them
(status, start, end, duration — used for the minutes limit) and forwards each to the call's `eventUrl`:

```json
{ "id": "<arca call id>", "status": "started|ringing|answered|machine|busy|cancelled|failed|rejected|timeout|unanswered|completed",
  "duration": 42, "at": "2026-11-09T18:00:00.000Z" }
```

with header `X-Arca-Signature: <hex hmac-sha256 of the raw body>`, keyed with `sha256(<the hub's API key>)` as lowercase
hex (Arca keeps only that hash, so that's what it can sign with). The hub checks it.
Forwarding is best effort (5 s timeout, no retries); Arca still answers Vonage `200`.

## 5. Status for the hub's Settings

`GET /v1/phone/status` → `200 { "number": "+1…", "today": { "calls": 3, "seconds": 410 }, "limits": { "calls": 20, "seconds": 1800 } }`

## 6. Someone calls the shared number back

The Vonage application's answer URL is `GET /v1/phone/vonage/answer` → NCCO
`[{ "action": "talk", "text": "Hi. This number doesn't take calls. Please send a text instead. Goodbye." }]`.
(Free tier: no callbacks. Your own number is the upgrade.)

## Arca server config

`ARCA_VONAGE_APPLICATION_ID`, `ARCA_VONAGE_PRIVATE_KEY` (PEM; literal `\n` accepted), `ARCA_PHONE_NUMBER` (E.164),
`ARCA_PHONE_PUBLIC_URL` (Arca's public base, for Vonage's event URL). Any missing → the phone routes answer `503`.
Vonage auth is an RS256 JWT (`application_id`, `iat`, `exp` = now+300, `jti`) signed with the private key.
