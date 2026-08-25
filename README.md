# The Scrying Table

The Scrying Table is a small, self-hosted virtual tabletop for groups that want a shared encounter map without the overhead of a full VTT platform. It provides GM map preparation, player-controlled tokens, line of sight, fog of war, doors, initiative, and area-of-effect markers in a browser.

One installation can host multiple GMs. Each GM has a separate game directory, maps, tokens, player password, visibility state, fog history, and audit log.

## Features

- Prepared map library with per-map grid and visibility settings
- Multiple isolated GM sessions
- Player-controlled, delegated, and GM-controlled tokens
- Wall and closed-door line of sight
- Dark maps, light sources, night vision, and vision radii
- Persistent explored-area fog
- Ordinary and secret doors
- Circle, cone, and line area-of-effect overlays
- Initiative tracking and optional turn enforcement
- Read-only shared Viewer plus individual player views
- Live browser updates over Server-Sent Events
- GM-only connection and player-movement audit log
- Docker Compose deployment behind Nginx

## Requirements

The reference deployment uses Linux, Docker Engine with the Compose plugin, Nginx, `apache2-utils`, and OpenSSL. The container binds to `127.0.0.1:8292` by default; Nginx publishes the site over HTTPS.

See [INSTALL.md](INSTALL.md) for a clean installation.

## Quick start

```bash
sudo mkdir -p /srv
cd /srv
sudo git clone https://github.com/YOUR-ACCOUNT/scrying-table.git
sudo chown -R "$(id -u):$(id -g)" scrying-table
cd scrying-table

cp .env.example .env
secret="$(openssl rand -hex 32)"
sed -i "s/^FLASK_SECRET_KEY=.*/FLASK_SECRET_KEY=${secret}/" .env
unset secret
chmod 600 .env

mkdir -p data/games
sudo chown -R 10001:10001 data

docker compose up -d --build
sudo ./manage-gms.sh add gm
```

Copy `nginx/scrying-table.conf.example` into your Nginx configuration, replace the hostname and certificate placeholders, test the configuration, and reload Nginx.

## Routes

For a site published as `https://vtt.example.com`:

| Route | Purpose |
| --- | --- |
| `/` | Landing page |
| `/viewer` | Choose a GM session for the shared Viewer |
| `/player` | Choose a GM session for player access |
| `/login` | GM sign-in |
| `/edit` | GM editor |
| `/edit/wallmap` | Wall and door editor |
| `/help/admin` | GM help |
| `/help/player` | Player help |
| `/changes` | Version history |

Public game routes are scoped by GM username:

```text
/g/<gm>/viewer
/g/<gm>/player
/g/<gm>/vtt?player=<player-key>
/g/<gm>/events
```

There is no default public game.

## Configuration

Copy `.env.example` to `.env`. `FLASK_SECRET_KEY` is required.

| Variable | Default | Description |
| --- | --- | --- |
| `FLASK_SECRET_KEY` | none | Secret used to sign Flask sessions |
| `VTT_BIND_ADDR` | `127.0.0.1` | Host interface used by Docker |
| `VTT_PORT` | `8292` | Host TCP port |
| `MAX_UPLOAD_BYTES` | `104857600` | Maximum map upload size |
| `MAX_MAPS` | `20` | Maximum prepared maps per GM |
| `SESSION_HOURS` | `12` | Signed session lifetime |
| `LOGIN_MAX_FAILURES` | `10` | Failed logins allowed in the throttle window |
| `LOGIN_WINDOW_SECONDS` | `900` | Login throttle window |

## GM accounts

`manage-gms.sh` manages only Scrying Table GM accounts and game directories.

```bash
sudo ./manage-gms.sh list
sudo ./manage-gms.sh add alice
sudo ./manage-gms.sh passwd alice
sudo ./manage-gms.sh rename alice bob
sudo ./manage-gms.sh remove bob --archive
```

Run `sudo ./manage-gms.sh` for the interactive menu. Permanent deletion requires `--delete`.

Default locations:

```text
/etc/nginx/.htpasswd-scrying-gm
<project>/data/games/<gm>/
/var/backups/scrying-table/
```

The paths can be overridden with the environment variables shown by `./manage-gms.sh --help`.

## Data

Runtime data is not part of the repository:

```text
data/
├── feature_requests.jsonl
└── games/
    └── <gm>/
        ├── .auth-revision
        ├── current_state.json
        ├── maps/
        └── logs/
```

The monthly files under `logs/` contain player connection and movement audit entries, including source IP addresses. Treat them as administrative data.

## Authentication and public state

GM passwords live in the dedicated Nginx htpasswd file. Basic Auth is used only at `/auth/gm/check`; after Nginx validates the credentials, Flask creates a signed GM session for the editor and its APIs.

Public pages never receive raw wall or secret-door geometry. Flask calculates line of sight and filters hidden tokens, AOEs, doors, initiative details, and movement history before sending state to the browser.

The included Nginx example assumes one trusted reverse-proxy hop. If another proxy or CDN sits in front of Nginx, review `ProxyFix` and forwarded-address handling before relying on audit IP addresses.

## Development checks

```bash
python3 -m py_compile app.py
node --check static/editor.js
node --check static/login.js
node --check static/viewer.js
node --check static/vtt.js
node --check static/wallmap.js
bash -n manage-gms.sh
```

Start the local container with:

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8292/healthz
```

## Documentation

- [INSTALL.md](INSTALL.md): clean production install
- [UPGRADING.md](UPGRADING.md): upgrade procedure
- [SECURITY.md](SECURITY.md): deployment and security notes
- [CONTRIBUTING.md](CONTRIBUTING.md): development notes
- [CHANGELOG.txt](CHANGELOG.txt): release history

## License

No license has been selected yet. Add one before publishing the repository if you want others to have explicit permission to copy, modify, or redistribute the project.
