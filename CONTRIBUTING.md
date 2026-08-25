# Contributing

Small, focused changes are easiest to review. Keep server-side authorization and public-state filtering in Flask; browser checks should be treated as user-interface safeguards rather than security boundaries.

Before submitting a change, run:

```bash
python3 -m py_compile app.py
node --check static/editor.js
node --check static/login.js
node --check static/viewer.js
node --check static/vtt.js
node --check static/wallmap.js
bash -n manage-gms.sh
```

For changes that affect visibility, test both the shared Viewer and an individual player page. Check lit and dark maps, walls, open and closed doors, hidden tokens, and persistent fog where applicable.

For changes to persistent state, test loading an older `current_state.json` as well as a newly created game.

Do not commit `.env`, runtime data, map uploads, audit logs, patch rejects, or local backup files.
