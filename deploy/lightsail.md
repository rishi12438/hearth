# Your hub on your own domain (e.g. example.com)

When you're done, you open `https://example.com` on your phone from anywhere and it's your assistant, signed in.
Nobody else can get in: there are no passwords to guess, and new devices only join when your phone says yes.

It works like setting up a router:

1. **Plug it in.** One command on the server.
2. **The first phone becomes the admin** (your *primary device*). You scan a QR code from the server.
3. **Every other device asks your phone.** A laptop opens the site and taps *Ask your primary device*. Your phone buzzes,
   you check that the short code matches and approve it with Face ID.
4. **Reset button.** If you lose the phone, `bun run recover` over SSH makes a new primary device. Only someone who can
   log in to your server can do that.

About $5–12/month for the server and about $10/year for the domain.

## 1. Get a server

AWS Lightsail → Create instance → Linux, **Ubuntu 24.04**, 1–2 GB plan. Then, on the instance:

- **Networking → Attach static IP.** Without one, the address changes when the box reboots and your domain stops working.
- **Networking → IPv4 firewall:** keep SSH (22), add **HTTPS (443)** and **HTTP (80)**. Don't open anything else; port 8790 stays closed.
  Optionally restrict SSH to your own IP (*Restrict to IP address*).
- Lightsail logs you in with an SSH key. Keep that key; password logins get turned off.

Any other Linux VPS works the same way.

## 2. Get your domain and point it at the server

1. **Buy the domain** at a registrar that sells at cost and supports 2FA, for example
   [Porkbun](https://porkbun.com) or [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/). Search for `example.com`.
2. **Lock the account down before anything else.** Whoever controls the domain can point it at their own server.
   - Turn on **2FA** (an authenticator app or a passkey, not SMS).
   - Make sure **Transfer lock** (also called registrar lock) is on.
   - Turn on **DNSSEC** if the registrar offers it with one click.
3. **Add the DNS records** (DNS / Manage DNS on the domain):

   | Type | Host | Value |
   |---|---|---|
   | `A` | `@` (the domain itself) | your Lightsail static IP |
   | `CAA` | `@` | `0 issue "letsencrypt.org"` |
   | `CAA` | `@` | `0 issue "sectigo.com"` |

   The CAA records say that only the two certificate authorities Caddy uses may issue HTTPS certificates for your domain.
   Prefer a subdomain like `hearth.example.com`? Use `hearth` as the Host instead of `@`.
   On Cloudflare, set the A record to **DNS only** (grey cloud). See *DDoS* below for the trade-off.
4. **Check that it works** (it can take a few minutes):
   ```bash
   dig +short example.com      # should print your static IP
   ```

## 3. One command on the server

```bash
ssh ubuntu@<static IP>
git clone https://github.com/<you>/hearth && cd hearth
sudo bash deploy/setup.sh example.com you@example.com
```

It checks that your domain points at this box, then installs and turns on everything below. You can run it again safely.

- **HTTPS:** Caddy gets a certificate and renews it, and `http://` redirects to `https://`.
- **Firewall:** only SSH, 80 and 443 are open.
- **SSH:** keys only, no root login. This is skipped if you have no key, so you can't get locked out.
- **Maintenance:** automatic security updates, and fail2ban for SSH.
- **The hub:** it runs as its own user under systemd, listens only on `127.0.0.1`, and its settings go in `/opt/hearth/.env` (mode 600).

If it says so, log in the brain once with `sudo -iu hearth claude` (or `codex login`), then run `sudo systemctl restart hearth`.

## 4. Set up your primary phone

At the end, the script prints a **QR code**. Scan it with your phone's camera and tap **Pair**. Then:

1. **Share → Add to Home Screen**, and from now on open Hearth from that icon. iPhones keep a Home Screen app signed in;
   a plain Safari tab can be cleared after a week without use.
2. **Turn on Face ID lock** when it asks (or later: Settings → Face ID lock). After that, a copied key is useless without your face,
   and letting a new device in needs your face too.
3. **Turn on notifications** (Settings → Notifications), so you hear about access requests.

Lost the QR code? Run `sudo -iu hearth bash -c 'cd /opt/hearth && ~/.bun/bin/bun run setup'`.

## 5. Add your other devices

Pick whichever is easier:

- **QR code:** on your phone, go to Settings → Devices → **Add a device**, then scan the QR code with the new device, or type its code.
- **Ask:** on the new device, open `https://example.com` and tap **No code? Ask your primary device**. It shows a 4-letter code.
  Your phone gets a notification. Approve it only if the same code is shown, and confirm with Face ID.

Every device has its own key and shows up in Settings → Devices. **Sign out** cuts a device off immediately.
**Make primary** moves the admin role to a new phone.

## 6. Check everything

```bash
sudo -iu hearth bash -c 'cd /opt/hearth && ~/.bun/bin/bun run doctor'
```

It checks HTTPS and HSTS, the redirect from http, that the hub isn't exposed directly, file permissions, and that your primary device has Face ID.

For the strictest setup, add `HEARTH_REQUIRE_PASSKEY=1` to `/opt/hearth/.env` and restart. Every device then has to set up Face ID before it can see anything.

## What protects you, in plain words

| Worry | What stops it |
|---|---|
| Someone on café Wi-Fi sniffing | Everything is HTTPS (TLS 1.3), and HSTS stops downgrades to http |
| A stranger opening the site | No passwords. Without a device key they get nothing, and setup only works with the code printed on your server |
| Guessing keys or codes | Keys are 256-bit random. Codes are single use and expire in 10 minutes, attempts are rate-limited, and an address sending wrong keys gets shut out |
| Stolen or copied key | Face ID lock: the key alone only reaches the lock screen. Sign the device out and it's cut off at once |
| Spam access requests | Rate-limited, and nothing gets in without your approval and Face ID |
| A stolen database | It holds only hashes of keys and public keys. Neither can be used to log in |
| Someone hijacking the domain | 2FA and transfer lock at the registrar. CAA limits who can issue certificates |
| SSH break-ins | Keys only, fail2ban, and optionally SSH limited to your IP in Lightsail |

### DDoS
Bots scanning and brute-forcing your site get nowhere, because of the rate limits and bans above.
A large flood is a different thing: it can knock *any* $5 server offline for a while. Your data stays safe, but the site is unreachable.
If that ever happens or worries you, you have two options:
- **Cloudflare proxy (orange cloud):** it absorbs floods for free. The cost is that Cloudflare decrypts your traffic in the middle.
  Your keys and data still live only on your server, but it's no longer a direct line.
- **VPN-only (below):** the site isn't reachable from the internet at all.

## Optional: VPN-only mode (WireGuard)
For when you'd rather the hub not be on the public internet at all. Your devices run the WireGuard app, and Caddy refuses everyone else.
This is more setup on every device, which is why it isn't the default.

1. `sudo apt install wireguard qrencode`. Then create `/etc/wireguard/wg0.conf` with `Address = 10.8.0.1/24` and `ListenPort = 51820`,
   and one `[Peer]` per device. Run `sudo ufw allow 51820/udp` and open UDP 51820 in Lightsail.
2. For each device, generate its config with `AllowedIPs = 10.8.0.0/24, <static IP>/32`, so traffic to your domain goes through the tunnel.
   Show it as a QR code with `qrencode -t ansiutf8 < phone.conf` and scan it in the WireGuard app.
3. In `/etc/caddy/Caddyfile`, add these lines inside your site block and reload Caddy. Certificates still renew,
   because Caddy answers those checks itself.
   ```
   @outside not remote_ip 10.8.0.0/24
   abort @outside
   ```

Everything else (primary device, Face ID, approvals) works the same on top.

## Updating and backups

```bash
cd /opt/hearth && sudo -u hearth git pull && sudo -iu hearth bash -c 'cd /opt/hearth && ~/.bun/bin/bun install --production' && sudo systemctl restart hearth
```

Back up `/opt/hearth/data` (or your database), and turn on automatic snapshots in Lightsail (Snapshots tab).
