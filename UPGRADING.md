# Upgrading

Back up the installation before changing application files. The runtime state lives under `data/`, and the Flask session secret lives in `.env`; neither should be replaced by a release archive.

## Git checkout

From the project directory:

```bash
sudo tar -C /srv -czf \
    /var/backups/scrying-table-$(date +%F-%H%M%S).tar.gz \
    scrying-table

cd /srv/scrying-table
git pull --ff-only
docker compose up -d --build --force-recreate
```

## Release archive

Extract the new release into a temporary directory, then copy the tracked source files over the existing installation. Preserve `.env` and `data/`.

After updating the files:

```bash
cd /srv/scrying-table
docker compose up -d --build --force-recreate
```

## Verify

```bash
cat VERSION
docker compose ps
curl -fsS http://127.0.0.1:8292/healthz
echo
```

The same version should appear at the bottom of `/edit` after a browser refresh.

If the container does not stay up, inspect the application log before changing Nginx:

```bash
docker logs --tail 150 map-display
```

A `502 Bad Gateway` immediately after an upgrade usually means Nginx is running but the application container failed to start or is not listening on the configured local port.

## State compatibility

Release-specific migrations and behavior changes are listed in [CHANGELOG.txt](CHANGELOG.txt). State normalization occurs when a GM game is loaded; keep a backup until the new release has been exercised with your maps and player pages.
