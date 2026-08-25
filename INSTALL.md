# Installation

This guide installs The Scrying Table on a Linux host using Docker Compose and Nginx. The examples use `vtt.example.com`, `/srv/scrying-table`, and local port `8292`.

## 1. Install prerequisites

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y nginx apache2-utils openssl git
```

Install Docker Engine and the Docker Compose plugin using your distribution's supported method, then verify:

```bash
docker version
docker compose version
```

## 2. Clone the repository

```bash
sudo mkdir -p /srv
cd /srv
sudo git clone https://github.com/newmannodegit/scrying-table.git
sudo chown -R "$(id -u):$(id -g)" /srv/scrying-table
cd /srv/scrying-table
```

If you are using a release archive, extract it to `/srv/scrying-table` and continue from that directory.

## 3. Configure the application

```bash
cp .env.example .env
secret="$(openssl rand -hex 32)"
sed -i "s/^FLASK_SECRET_KEY=.*/FLASK_SECRET_KEY=${secret}/" .env
unset secret
chmod 600 .env
```

The default listener is local-only:

```text
VTT_BIND_ADDR=127.0.0.1
VTT_PORT=8292
```

Review the remaining values in `.env` before starting the container.

## 4. Create the data directory

The container runs as UID/GID `10001:10001`.

```bash
mkdir -p data/games
sudo chown -R 10001:10001 data
```

Keep `data/` and `.env` out of source control and release archives.

## 5. Start the application

```bash
docker compose up -d --build
```

Check the container and local health endpoint:

```bash
docker compose ps
curl -fsS http://127.0.0.1:8292/healthz
echo
```

Expected response:

```json
{"status":"ok"}
```

## 6. Create a GM account

```bash
sudo ./manage-gms.sh add gm
```

Or launch the interactive manager:

```bash
sudo ./manage-gms.sh
```

The default htpasswd file is `/etc/nginx/.htpasswd-scrying-gm`.

## 7. Configure Nginx

Copy the example:

```bash
sudo cp nginx/scrying-table.conf.example \
    /etc/nginx/sites-available/scrying-table.conf
```

Edit the copy and replace:

```text
YOUR_VTT_HOSTNAME
YOUR_CERT_FULLCHAIN
YOUR_CERT_PRIVATE_KEY
```

If the application uses a port other than `8292`, update the `proxy_pass` targets too.

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/scrying-table.conf \
    /etc/nginx/sites-enabled/scrying-table.conf
sudo nginx -t
sudo systemctl reload nginx
```

The example Nginx configuration does three important things:

- proxies normal HTTPS traffic to the local container
- validates GM Basic Auth only at `/auth/gm/check`
- disables buffering on the Server-Sent Events route

Do not expose the Docker port directly to the Internet when using this configuration.

## 8. Verify through HTTPS

After DNS and TLS are in place:

```bash
curl -fsS https://vtt.example.com/healthz
echo
```

Then open:

```text
https://vtt.example.com/
https://vtt.example.com/login
```

Sign in as the GM account created above. The editor footer shows the running application version.

## Backups

Back up the application configuration and runtime data before upgrades. At minimum, preserve:

```text
.env
data/
/etc/nginx/.htpasswd-scrying-gm
```

A simple application backup is:

```bash
sudo tar -C /srv -czf \
    /var/backups/scrying-table-$(date +%F-%H%M%S).tar.gz \
    scrying-table
```

See [UPGRADING.md](UPGRADING.md) before installing a newer release.
