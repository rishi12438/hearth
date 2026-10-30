# Running your hub on AWS Lightsail

An always-on hub is what lets reminders and routines fire while your laptop is closed.
About $5–12/month. Any Linux VPS works the same way.

1. **Create the instance.** Ubuntu 24.04, 1–2 GB plan. Attach a **static IP** (Networking tab), or the address changes on reboot.
   Open ports 80 and 443 in the instance firewall. Leave 8790 closed; Caddy is the only way in.
2. **Point a domain at it.** Add an `A` record, e.g. `hub.example.com → <static IP>`. HTTPS is required for phone notifications.
3. **Install.**
   ```bash
   sudo adduser --disabled-password --gecos "" hearth
   sudo apt update && sudo apt install -y caddy unzip git
   sudo -iu hearth bash -c 'curl -fsSL https://bun.sh/install | bash'
   sudo git clone https://github.com/<you>/hearth /opt/hearth && sudo chown -R hearth: /opt/hearth
   sudo -iu hearth bash -c 'cd /opt/hearth && ~/.bun/bin/bun install --production'
   ```
4. **Log in your brain** as the `hearth` user, once: `sudo -iu hearth claude` (or `codex login`). The hub never sees these credentials;
   the agent CLI keeps them in its own config.
5. **Configure.** `sudo -iu hearth cp /opt/hearth/.env.example /opt/hearth/.env` and edit: `HEARTH_NAME`, `HEARTH_AGENT`,
   `HEARTH_BEHIND_PROXY=1`, `HEARTH_PUBLIC_URL=https://hub.example.com`, `HEARTH_CONTACT=mailto:you@…`. `chmod 600 .env`.
6. **Run it.** Edit the domain in `deploy/Caddyfile`, then:
   ```bash
   sudo cp /opt/hearth/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
   sudo cp /opt/hearth/deploy/hearth.service /etc/systemd/system/ && sudo systemctl enable --now hearth
   ```
7. **Pair your phone.** `sudo -iu hearth bash -c 'cd /opt/hearth && ~/.bun/bin/bun run pair'`, open the printed link on your phone,
   then Share → Add to Home Screen, open it from the Home Screen and turn on notifications under You.
8. **Back up** `/opt/hearth/data` (or your database), and take a Lightsail snapshot once it works.

Updating: `cd /opt/hearth && git pull && bun install --production && sudo systemctl restart hearth`. Open apps reload on their own.
