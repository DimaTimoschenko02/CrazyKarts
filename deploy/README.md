# VPS Deployment Guide

This guide walks through deploying Smash Karts Clone to a Linux VPS.
All steps are manual — run them in a new shell session when you are ready.

Placeholders to replace everywhere in this file:
- `<DOMAIN>` — your domain, e.g. `karts.example.com`
- `<USER>` — the Linux user on your VPS that you SSH in as, e.g. `ubuntu` or `root`
- `<VPS_IP>` — the public IP of your VPS

---

## Prerequisites

Before starting, confirm:

- [ ] Domain DNS A-record points `<DOMAIN>` to `<VPS_IP>` (allow up to 10 min for propagation)
- [ ] VPS is running Ubuntu 22.04 or 24.04 (Debian-based)
- [ ] You can SSH in: `ssh <USER>@<VPS_IP>`
- [ ] nginx is installed: `nginx -v` (if not: `sudo apt install nginx`)
- [ ] Firewall tool available: `ufw status`

---

## Step 1 — Install Godot Headless on the VPS

Godot Linux server binary runs headless (no display, no GPU needed).

```bash
# SSH into your VPS
ssh <USER>@<VPS_IP>

# Download Godot 4.6.1 Linux server binary
wget -O /tmp/godot-server.zip \
  "https://github.com/godotengine/godot/releases/download/4.6.1-stable/Godot_v4.6.1-stable_linux.x86_64.zip"

# Extract
cd /tmp
unzip godot-server.zip

# Create install directory
sudo mkdir -p /opt/smash-karts/server

# Move the binary (filename may differ slightly — check the zip contents with: unzip -l godot-server.zip)
sudo mv /tmp/Godot_v4.6.1-stable_linux.x86_64 /opt/smash-karts/server/godot
sudo chmod +x /opt/smash-karts/server/godot
```

Verify it runs:
```bash
/opt/smash-karts/server/godot --version
# Expected output: 4.6.1.stable.official
```

---

## Step 2 — Create Directory Structure

```bash
# Game server binary will live here
sudo mkdir -p /opt/smash-karts/server

# HTML5 web build served by nginx
sudo mkdir -p /var/www/smash-karts

# Create a dedicated system user (no shell, no home dir)
sudo useradd -r -s /bin/false -d /opt/smash-karts smash-karts

# Set ownership
sudo chown -R smash-karts:smash-karts /opt/smash-karts
sudo chown -R www-data:www-data /var/www/smash-karts
```

---

## Step 3 — Upload Build Artifacts

Run these commands from your **local machine** (Windows Git Bash or WSL).
First, build the artifacts locally by running:

```bash
# On your local machine, from the project root:
bash build/export.sh
```

Then upload to the VPS:

```bash
# Upload HTML5 web build (replaces whatever is there)
rsync -avz --delete build/web/ <USER>@<VPS_IP>:/var/www/smash-karts/

# Upload the Linux server binary
scp build/server/smash-karts-server.x86_64 <USER>@<VPS_IP>:/opt/smash-karts/server/smash-karts-server.x86_64

# Make it executable
ssh <USER>@<VPS_IP> "chmod +x /opt/smash-karts/server/smash-karts-server.x86_64"
```

---

## Step 4 — Install and Start systemd Service

```bash
# Copy the unit file to your VPS
scp deploy/smash-karts.service <USER>@<VPS_IP>:/tmp/smash-karts.service

# On the VPS: install and enable
ssh <USER>@<VPS_IP>
sudo cp /tmp/smash-karts.service /etc/systemd/system/smash-karts.service

# IMPORTANT: open the file and replace <USER> with smash-karts (or your chosen user)
sudo nano /etc/systemd/system/smash-karts.service
# Change:  User=<USER>
#          Group=<USER>
# To:      User=smash-karts
#          Group=smash-karts

sudo systemctl daemon-reload
sudo systemctl enable smash-karts
sudo systemctl start smash-karts

# Verify it is running
sudo systemctl status smash-karts
```

To watch live server output:
```bash
sudo journalctl -u smash-karts -f
```

---

## Step 5 — Configure nginx

```bash
# Copy the example config to your VPS
scp deploy/nginx.example.conf <USER>@<VPS_IP>:/tmp/nginx-smash-karts.conf

# On the VPS: install the config
ssh <USER>@<VPS_IP>
sudo cp /tmp/nginx-smash-karts.conf /etc/nginx/sites-available/smash-karts

# Edit the file: replace every occurrence of <DOMAIN> with your actual domain
sudo nano /etc/nginx/sites-available/smash-karts

# Enable the site
sudo ln -s /etc/nginx/sites-available/smash-karts /etc/nginx/sites-enabled/smash-karts

# Remove the default site if still enabled
sudo rm -f /etc/nginx/sites-enabled/default

# Test config syntax
sudo nginx -t

# Reload nginx (do NOT restart yet — cert does not exist yet)
sudo nginx -s reload
```

---

## Step 6 — Obtain SSL Certificate (Let's Encrypt)

```bash
# Install certbot if not present
sudo apt install -y certbot python3-certbot-nginx

# Obtain certificate — certbot will also update the nginx config automatically
sudo certbot --nginx -d <DOMAIN>

# Follow the prompts. When certbot asks about HTTP redirect, choose: Redirect (2)
# Certbot will fill in the ssl_certificate paths in the nginx config automatically.

# Verify auto-renewal works
sudo certbot renew --dry-run
```

After certbot completes, reload nginx:
```bash
sudo nginx -s reload
```

---

## Step 7 — Open Firewall Ports

```bash
# Allow HTTP and HTTPS (WebSocket over TLS uses port 443)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Godot server listens on 127.0.0.1:4444 (localhost-only, proxied by nginx)
# Do NOT open 4444 publicly — nginx handles TLS and forwards internally.

sudo ufw enable
sudo ufw status
```

---

## Step 8 — Verify the Deployment

**Check the website loads:**
```bash
curl -I https://<DOMAIN>/
# Expected: HTTP/2 200
# Expected headers:
#   cross-origin-opener-policy: same-origin
#   cross-origin-embedder-policy: require-corp
```

**Check WebSocket connection:**

Install wscat (Node.js tool):
```bash
npm install -g wscat
wscat -c wss://<DOMAIN>/ws
# Expected: Connected (press Ctrl+C to exit)
# A Godot server is not a plain WebSocket echo server — wscat will connect
# but you will see a binary handshake then the connection may close. That is normal.
```

Alternatively, open `https://<DOMAIN>/` in Chrome, open DevTools → Network tab,
filter by WS, click the connection to inspect frames.

**Check server logs:**
```bash
sudo journalctl -u smash-karts --since "10 minutes ago"
```

---

## Updating the Game (Re-deploy)

To push a new build after changes:

```bash
# 1. Local: rebuild
bash build/export.sh

# 2. Upload web build
rsync -avz --delete build/web/ <USER>@<VPS_IP>:/var/www/smash-karts/

# 3. Upload server binary and restart service
scp build/server/smash-karts-server.x86_64 <USER>@<VPS_IP>:/opt/smash-karts/server/smash-karts-server.x86_64
ssh <USER>@<VPS_IP> "chmod +x /opt/smash-karts/server/smash-karts-server.x86_64 && sudo systemctl restart smash-karts"
```

---

## Troubleshooting

### Game loads but shows a black screen / "SharedArrayBuffer not available"

The COOP/COEP headers are missing. Check:
```bash
curl -I https://<DOMAIN>/index.html | grep -i "cross-origin"
```
Both `cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: require-corp` must appear.
If not, check the `add_header` lines in `/etc/nginx/sites-available/smash-karts` and reload nginx.

### WebSocket shows 502 Bad Gateway

The Godot server process is not running or not listening on port 4444:
```bash
# Check if the process is up
sudo systemctl status smash-karts

# Check if port 4444 is actually bound
ss -tlnp | grep 4444

# Check server logs
sudo journalctl -u smash-karts -n 50
```

### Mixed Content error in browser console

The client is trying to connect via `ws://` instead of `wss://`. This happens
when the join address is typed as a plain IP or `ws://` URL in the lobby.
The browser blocks mixed content (HTTP resource on an HTTPS page).

Fix: In the lobby UI, always enter the full `wss://<DOMAIN>/ws` address,
or update `network_manager.gd` to default to `wss://` when running in a
browser context.

### certbot says port 80 is not reachable

Make sure ufw allows HTTP: `sudo ufw allow 80/tcp`
Also make sure nginx is running: `sudo systemctl status nginx`

### Server crashes immediately on start

Check logs:
```bash
sudo journalctl -u smash-karts -n 100
```
Common causes:
- Binary not executable (`chmod +x`)
- Binary built for wrong architecture (must be `x86_64`)
- Missing Godot export template version mismatch

### `export.sh` fails with "export template not found" or similar

Godot requires export templates to be installed locally before exporting.
In the Godot editor: Editor menu -> Export -> Manage Export Templates -> Download.
Make sure templates for version 4.6.1 are installed. The Linux x86_64 template
is required for the server build even when exporting on Windows.
