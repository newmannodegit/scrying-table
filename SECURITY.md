# Security

The reference deployment assumes that Nginx is the only network-facing service and that the Docker port remains bound to loopback.

## GM authentication

GM credentials are stored in `/etc/nginx/.htpasswd-scrying-gm`. Nginx validates Basic Auth only at `/auth/gm/check`; Flask then issues a signed GM session for the editor and GM APIs.

Keep `.env` private. `FLASK_SECRET_KEY` protects signed sessions and must not be committed to source control.

## Player access

Viewer and player routes are public application surfaces. A game may also require its shared player password. The server filters public state before returning it, including hidden tokens, AOEs, doors, initiative details, and movement history. Raw wall and secret-door geometry is not sent to player browsers.

## IP addresses and audit logs

Successful player logins and player-controlled token moves are written to the GM's monthly audit log under:

```text
data/games/<gm>/logs/
```

Those entries include source IP addresses and are shown only in the authenticated GM editor. Protect backups of the data directory accordingly.

The application trusts one reverse-proxy hop through Werkzeug `ProxyFix`. If you add a CDN, load balancer, or another proxy, review the forwarding chain before treating logged client addresses as authoritative.

## Deployment notes

- Keep the Docker listener on loopback unless you have replaced the reference proxy model.
- Serve the site over HTTPS.
- Restrict access to the htpasswd file, `.env`, and backups.
- Run `nginx -t` before reloading Nginx.
- Keep Docker, Python dependencies, Nginx, and the host OS patched.

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting feature for this repository. This allows security issues to be reported directly to the maintainer without publicly disclosing the vulnerability before a fix is available.

Reports should include, where possible:

- a description of the vulnerability
- steps to reproduce it
- the affected version
- the potential impact
- any suggested mitigation or fix

Security reports will be reviewed as promptly as possible.
