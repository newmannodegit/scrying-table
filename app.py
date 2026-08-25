"""Server-side application for The Scrying Table."""

import base64
import copy
import hmac
import io
import json
import math
import os
import re
import secrets
import shlex
import threading
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from PIL import Image, ImageChops, ImageDraw
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

# Runtime configuration
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
GAMES_DIR = DATA_DIR / "games"
GAME_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,31}$")
MAX_MAPS = int(os.getenv("MAX_MAPS", "20"))
MAP_NAME_MAX_CHARS = 80
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
SESSION_HOURS = int(os.getenv("SESSION_HOURS", "12"))
LOGIN_MAX_FAILURES = int(os.getenv("LOGIN_MAX_FAILURES", "10"))
LOGIN_WINDOW_SECONDS = int(os.getenv("LOGIN_WINDOW_SECONDS", "900"))


def load_app_version():
    """Return the release version shipped beside app.py."""
    try:
        return Path(__file__).with_name("VERSION").read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


APP_VERSION = load_app_version()
ALLOWED_FORMATS = {
    "JPEG": ("jpg", "image/jpeg"),
    "PNG": ("png", "image/png"),
    "GIF": ("gif", "image/gif"),
    "WEBP": ("webp", "image/webp"),
    "BMP": ("bmp", "image/bmp"),
    "TIFF": ("png", "image/png"),
}
ALLOWED_BACKGROUNDS = {"#000000", "#202020", "#ffffff", "#123b2a", "#3a2d1f"}
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
TOKEN_COLORS = [
    "#e53935",
    "#1e88e5",
    "#43a047",
    "#fdd835",
    "#8e24aa",
    "#fb8c00",
    "#00acc1",
    "#d81b60",
]

# Nginx checks GM credentials; Flask sessions carry the authenticated editor identity.
secret = os.getenv("FLASK_SECRET_KEY", "").strip()
if not secret:
    raise RuntimeError("Missing FLASK_SECRET_KEY.")

app = Flask(__name__)
app.secret_key = secret
app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=SESSION_HOURS * 3600,
    MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES + 1024 * 1024,
)
GM_LOGIN_TICKET_MAX_AGE = 30
gm_login_serializer = URLSafeTimedSerializer(app.secret_key, salt="scrying-gm-login-v1")

app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

DATA_DIR.mkdir(parents=True, exist_ok=True)
GAMES_DIR.mkdir(parents=True, exist_ok=True)


class GameRuntime:
    def __init__(self):
        self.lock = threading.RLock()
        self.condition = threading.Condition()
        self.version = int(time.time() * 1000)


_game_runtimes = {}
_game_runtimes_lock = threading.Lock()


def normalize_game_slug(value):
    slug = str(value or "").strip().lower()
    return slug if GAME_SLUG_RE.fullmatch(slug) else None


class GamePrefixMiddleware:
    """Mount public games below /g/<gm-user> without duplicating Flask routes."""
    def __init__(self, application):
        self.application = application

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "") or "/"
        match = re.match(r"^/g/([a-z0-9][a-z0-9_.-]{0,31})(/.*)?$", path)
        if match:
            slug = normalize_game_slug(match.group(1))
            if slug:
                remainder = match.group(2) or "/"
                environ["VTT_GAME_SLUG"] = slug
                existing_script = environ.get("SCRIPT_NAME", "")
                environ["SCRIPT_NAME"] = f"{existing_script}/g/{slug}"
                environ["PATH_INFO"] = remainder
        return self.application(environ, start_response)


def gm_auth_revision(gm_user):
    """Return the account revision used to invalidate signed GM sessions."""
    gm_user = normalize_game_slug(gm_user)
    if not gm_user:
        return "0"
    path = GAMES_DIR / gm_user / ".auth-revision"
    try:
        value = path.read_text(encoding="utf-8").strip()[:128]
    except OSError:
        return "0"
    return value or "0"


def current_editor_user():
    """Return the active GM while its game directory and auth revision are valid."""
    if not session.get("editor_authenticated"):
        return None
    gm_user = normalize_game_slug(session.get("editor_user"))
    if not gm_user:
        return None
    if not (GAMES_DIR / gm_user).is_dir():
        return None
    expected_revision = str(session.get("editor_auth_revision") or "")
    current_revision = gm_auth_revision(gm_user)
    if not expected_revision or not hmac.compare_digest(expected_revision, current_revision):
        return None
    return gm_user


def current_game_slug():
    prefixed = normalize_game_slug(request.environ.get("VTT_GAME_SLUG"))
    if prefixed:
        return prefixed
    return current_editor_user()


def game_root(slug=None):
    slug = normalize_game_slug(slug) or current_game_slug()
    if not slug:
        abort(404)
    return GAMES_DIR / slug


def game_state_file():
    return game_root() / "current_state.json"


def game_maps_dir():
    return game_root() / "maps"


def game_token_log_dir():
    return game_root() / "logs"


def current_runtime():
    slug = current_game_slug()
    if not slug:
        abort(404)
    with _game_runtimes_lock:
        runtime = _game_runtimes.get(slug)
        if runtime is None:
            runtime = GameRuntime()
            _game_runtimes[slug] = runtime
        return runtime


def game_public_prefix():
    slug = current_game_slug()
    if not slug:
        abort(404)
    return f"/g/{slug}"


def public_session_label(slug):
    """Return a friendly label for a public game/session selector."""
    slug = normalize_game_slug(slug)
    if not slug:
        return "Session"
    if slug == "gm":
        return "GM's Session"
    display = re.sub(r"[._-]+", " ", slug).strip().title() or slug
    return f"{display}'s Session"


def available_public_sessions():
    """List initialized game stores under /data/games for public selection."""
    slugs = []
    try:
        game_dirs = list(GAMES_DIR.iterdir())
    except OSError:
        game_dirs = []

    for root in game_dirs:
        slug = normalize_game_slug(root.name)
        if not slug or not root.is_dir():
            continue
        if (root / "current_state.json").is_file():
            slugs.append(slug)

    slugs = sorted(set(slugs), key=str.casefold)
    return [
        {
            "slug": slug,
            "label": public_session_label(slug),
            "viewer_url": f"/g/{slug}/viewer",
            "player_url": f"/g/{slug}/player",
        }
        for slug in slugs
    ]


app.wsgi_app = GamePrefixMiddleware(app.wsgi_app)
failures = {"editor": {}, "vtt": {}}
failures_lock = threading.Lock()
token_log_lock = threading.Lock()
vision_polygon_cache = {}
vision_polygon_cache_lock = threading.Lock()
VISION_POLYGON_CACHE_MAX = 512
FEATURE_REQUEST_FILE = DATA_DIR / "feature_requests.jsonl"
FEATURE_REQUEST_MAX_CHARS = 3000
FEATURE_REQUEST_NAME_MAX_CHARS = 80
FEATURE_REQUEST_CHALLENGE_SECONDS = 15 * 60
feature_request_lock = threading.Lock()
FEET_PER_GRID_SQUARE = 5.0
NPC_REVEAL_RADIUS_FEET = 1.0
VISION_RAY_COUNT = 128
VISION_RAY_EPSILON = 1e-5
GEOMETRY_EPSILON = 1e-9
PLAYER_COLLISION_RADIUS_FACTOR = 0.40
MAX_PLAYER_MOVE_PATH_POINTS = 1024
EXPLORED_MASK_SIZE = 512



# ---- Persistent state ------------------------------------------------------
# Normalization also handles older state files as they are loaded.
def blank_vtt_state():
    return {
        "token_size": 0.04,
        "mobile_token_size": 0.06,
        "tokens_visible": True,
        "movement_enabled": True,
        "initiative_enforced": False,
        "active_initiative_token_id": None,
        "dark_environment": False,
        "stack_player_vision": False,
        "persistent_explored_fog": False,
        "password_hash": None,
        "password_version": 0,
        "tokens": [],
        "areas": [],
        "vision_blockers": [],
        "door_color": "#ffd54d",
        "door_opacity": 0.72,
    }


def blank_state():
    return {
        "schema_version": 24,
        "has_image": False,
        "stored_filename": None,
        "mime_type": None,
        "original_filename": None,
        "zoom": 1.0,
        "background": "#000000",
        "version": 0,
        "grid": {
            "enabled": True,
            "size": 0.05,
            "color": "#ffffff",
            "opacity": 1.0,
        },
        "vtt": blank_vtt_state(),
        "active_map_id": None,
        "explored_masks": {},
        "maps": [],
    }


def clamp(value, low, high):
    return min(high, max(low, value))


def normalize_player_key(value):
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")[:40]


def normalize_initiative(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("Initiative must be a whole number from -99 to 99.")
    if isinstance(value, int):
        number = value
    elif isinstance(value, float):
        if not value.is_integer():
            raise ValueError("Initiative must be a whole number from -99 to 99.")
        number = int(value)
    else:
        text = str(value).strip()
        if not re.fullmatch(r"[+-]?\d+", text):
            raise ValueError("Initiative must be a whole number from -99 to 99.")
        number = int(text)
    if not -99 <= number <= 99:
        raise ValueError("Initiative must be a whole number from -99 to 99.")
    return number


# Validate persisted token records and fill defaults for newer fields.
def normalize_token(raw):
    if not isinstance(raw, dict):
        return None
    token_id = str(raw.get("id") or "").strip()
    name = str(raw.get("name") or "").strip()[:60]
    if not token_id or not name:
        return None
    color = str(raw.get("color") or "#e53935").lower()
    if not COLOR_RE.fullmatch(color):
        color = "#e53935"
    try:
        x = clamp(float(raw.get("x", 0.5)), 0.0, 1.0)
        y = clamp(float(raw.get("y", 0.5)), 0.0, 1.0)
    except Exception:
        x, y = 0.5, 0.5
    player_controlled = bool(raw.get("player_controlled", False))
    # Keep the stored key until normalize_state() resolves derived names and collisions.
    player_key = normalize_player_key(raw.get("player_key") or name) if player_controlled else None
    try:
        initiative = normalize_initiative(raw.get("initiative"))
    except ValueError:
        initiative = None
    moved_by_token_id = str(raw.get("moved_by_token_id") or "").strip() or None
    visible = bool(raw.get("visible", True))
    vision_enabled = bool(raw.get("vision_enabled", False))
    try:
        if "vision_radius_feet" in raw:
            vision_radius_feet = clamp(float(raw.get("vision_radius_feet", 60.0)), 1.0, 300.0)
        else:
            # Legacy state stored this value in 5-foot grid squares.
            vision_radius_feet = clamp(
                float(raw.get("vision_radius_squares", 12.0)) * FEET_PER_GRID_SQUARE,
                1.0,
                300.0,
            )
    except Exception:
        vision_radius_feet = 60.0
    vision_type = str(raw.get("vision_type") or "light").strip().lower()
    if vision_type not in {"light", "nightvision"}:
        vision_type = "light"
    reveal_in_darkness = bool(raw.get("reveal_in_darkness", False)) if not player_controlled else False
    # Delegated NPC vision is opt-in; movement delegation alone does not grant sight.
    share_vision_with_controller = (
        bool(raw.get("share_vision_with_controller", False))
        if not player_controlled and moved_by_token_id
        else False
    )
    return {
        "id": token_id,
        "name": name,
        "color": color,
        "x": x,
        "y": y,
        "player_controlled": player_controlled,
        "player_key": player_key,
        "initiative": initiative,
        "visible": visible,
        "vision_enabled": vision_enabled if player_controlled else False,
        "vision_radius_feet": vision_radius_feet,
        # Retain NPC vision settings while sharing is disabled.
        "vision_type": vision_type,
        "share_vision_with_controller": share_vision_with_controller,
        "reveal_in_darkness": reveal_in_darkness,
        "moved_by_token_id": None if player_controlled else moved_by_token_id,
    }


def normalize_vision_blocker(raw):
    """Normalize one GM-drawn wall or door segment."""
    if not isinstance(raw, dict):
        return None
    blocker_id = str(raw.get("id") or "").strip()
    if not blocker_id:
        return None
    blocker_type = str(raw.get("type") or "wall").strip().lower()
    if blocker_type not in {"wall", "door"}:
        blocker_type = "wall"
    try:
        x1 = clamp(float(raw.get("x1")), 0.0, 1.0)
        y1 = clamp(float(raw.get("y1")), 0.0, 1.0)
        x2 = clamp(float(raw.get("x2")), 0.0, 1.0)
        y2 = clamp(float(raw.get("y2")), 0.0, 1.0)
    except Exception:
        return None
    # Zero-length lines are hard to select and do not block anything useful.
    if abs(x2 - x1) + abs(y2 - y1) < 1e-6:
        return None
    return {
        "id": blocker_id,
        "type": blocker_type,
        "x1": x1,
        "y1": y1,
        "x2": x2,
        "y2": y2,
        "open": bool(raw.get("open", False)) if blocker_type == "door" else False,
        # Secret doors use the same blocking geometry but are omitted from public door cues.
        "visible_to_players": bool(raw.get("visible_to_players", True)) if blocker_type == "door" else False,
    }



def blank_map_record(map_id="map-1", name="Current Map"):
    """Return one map-library record with safe defaults."""
    return {
        "id": str(map_id or "map-1")[:64],
        "name": str(name or "Current Map").strip()[:MAP_NAME_MAX_CHARS] or "Current Map",
        "has_image": False,
        "stored_filename": None,
        "mime_type": None,
        "original_filename": None,
        "zoom": 1.0,
        "background": "#000000",
        "version": 0,
        "grid": {"enabled": True, "size": 0.05, "color": "#ffffff", "opacity": 1.0},
        "vision_blockers": [],
        "door_color": "#ffd54d",
        "door_opacity": 0.72,
        "explored_masks": {},
        # Visibility belongs to the map. Missing IDs default to hidden.
        "token_visibility": {},
        "area_visibility": {},
    }


def normalize_map_record(raw, fallback_id="map-1", fallback_name="Current Map"):
    """Normalize map-specific image, grid, and wall/door settings."""
    if not isinstance(raw, dict):
        raw = {}
    map_id = str(raw.get("id") or fallback_id).strip()[:64]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", map_id):
        map_id = fallback_id
    name = str(raw.get("name") or fallback_name).strip()[:MAP_NAME_MAX_CHARS] or fallback_name
    result = blank_map_record(map_id, name)
    for key in ("has_image", "stored_filename", "mime_type", "original_filename", "zoom", "background", "version"):
        if key in raw:
            result[key] = raw[key]

    try:
        result["zoom"] = clamp(float(result.get("zoom", 1.0)), 0.1, 5.0)
    except Exception:
        result["zoom"] = 1.0
    if result.get("background") not in ALLOWED_BACKGROUNDS:
        result["background"] = "#000000"

    raw_grid = raw.get("grid") if isinstance(raw.get("grid"), dict) else {}
    grid = result["grid"].copy()
    grid.update({key: raw_grid[key] for key in grid if key in raw_grid})
    grid["enabled"] = bool(grid.get("enabled", True))
    try:
        grid["size"] = clamp(float(grid.get("size", 0.05)), 0.01, 0.15)
    except Exception:
        grid["size"] = 0.05
    grid["color"] = str(grid.get("color") or "#ffffff").lower()
    if not COLOR_RE.fullmatch(grid["color"]):
        grid["color"] = "#ffffff"
    try:
        grid["opacity"] = clamp(float(grid.get("opacity", 1.0)), 0.10, 1.0)
    except Exception:
        grid["opacity"] = 1.0
    result["grid"] = grid

    blockers = []
    seen_ids = set()
    for raw_blocker in raw.get("vision_blockers", []):
        blocker = normalize_vision_blocker(raw_blocker)
        if not blocker or blocker["id"] in seen_ids:
            continue
        seen_ids.add(blocker["id"])
        blockers.append(blocker)
    result["vision_blockers"] = blockers

    result["door_color"] = str(raw.get("door_color") or "#ffd54d").lower()
    if not COLOR_RE.fullmatch(result["door_color"]):
        result["door_color"] = "#ffd54d"
    try:
        result["door_opacity"] = clamp(float(raw.get("door_opacity", 0.72)), 0.10, 1.0)
    except Exception:
        result["door_opacity"] = 0.72

    raw_explored = raw.get("explored_masks") if isinstance(raw.get("explored_masks"), dict) else {}
    explored_masks = {}
    for token_id, encoded in raw_explored.items():
        token_id = str(token_id or "").strip()[:80]
        encoded = str(encoded or "").strip()
        if token_id and 0 < len(encoded) <= 200000:
            explored_masks[token_id] = encoded
    result["explored_masks"] = explored_masks

    raw_token_visibility = raw.get("token_visibility") if isinstance(raw.get("token_visibility"), dict) else {}
    result["token_visibility"] = {
        str(token_id).strip()[:80]: bool(visible)
        for token_id, visible in raw_token_visibility.items()
        if str(token_id or "").strip()
    }
    raw_area_visibility = raw.get("area_visibility") if isinstance(raw.get("area_visibility"), dict) else {}
    result["area_visibility"] = {
        str(area_id).strip()[:80]: bool(visible)
        for area_id, visible in raw_area_visibility.items()
        if str(area_id or "").strip()
    }

    result["stored_filename"] = str(result.get("stored_filename") or "").strip() or None
    result["mime_type"] = str(result.get("mime_type") or "").strip() or None
    result["original_filename"] = str(result.get("original_filename") or "").strip()[:255] or None
    result["has_image"] = bool(result.get("stored_filename"))
    try:
        result["version"] = max(0, int(result.get("version", 0)))
    except Exception:
        result["version"] = 0
    return result


def default_map_name(original_filename=None):
    stem = Path(str(original_filename or "")).stem.strip()
    return stem[:MAP_NAME_MAX_CHARS] or "Current Map"


def map_record_from_active_state(state, map_id="map-1", name=None):
    """Capture the legacy active-map fields into a map-library record."""
    record = blank_map_record(map_id, name or default_map_name(state.get("original_filename")))
    record.update(
        has_image=bool(state.get("stored_filename")),
        stored_filename=state.get("stored_filename"),
        mime_type=state.get("mime_type"),
        original_filename=state.get("original_filename"),
        zoom=state.get("zoom", 1.0),
        background=state.get("background", "#000000"),
        version=state.get("version", 0),
        grid=copy.deepcopy(state.get("grid") or record["grid"]),
        vision_blockers=copy.deepcopy((state.get("vtt") or {}).get("vision_blockers", [])),
        door_color=(state.get("vtt") or {}).get("door_color", "#ffd54d"),
        door_opacity=(state.get("vtt") or {}).get("door_opacity", 0.72),
        explored_masks=copy.deepcopy(state.get("explored_masks") or {}),
        token_visibility={
            token["id"]: bool(token.get("visible", True))
            for token in (state.get("vtt") or {}).get("tokens", [])
        },
        area_visibility={
            area["id"]: bool(area.get("visible", True))
            for area in (state.get("vtt") or {}).get("areas", [])
        },
    )
    return normalize_map_record(record, fallback_id=map_id, fallback_name=record["name"])


def find_map_by_id(state, map_id):
    wanted = str(map_id or "").strip()
    return next((item for item in state.get("maps", []) if item.get("id") == wanted), None)


def apply_map_record_to_active_state(state, record):
    """Mirror a selected map into the legacy active-map fields used by the VTT."""
    state["has_image"] = bool(record.get("stored_filename"))
    state["stored_filename"] = record.get("stored_filename")
    state["mime_type"] = record.get("mime_type")
    state["original_filename"] = record.get("original_filename")
    state["zoom"] = record.get("zoom", 1.0)
    state["background"] = record.get("background", "#000000")
    state["version"] = record.get("version", 0)
    state["grid"] = copy.deepcopy(record.get("grid") or blank_map_record()["grid"])
    state.setdefault("vtt", blank_vtt_state())
    state["vtt"]["vision_blockers"] = copy.deepcopy(record.get("vision_blockers", []))
    state["vtt"]["door_color"] = record.get("door_color", "#ffd54d")
    state["vtt"]["door_opacity"] = record.get("door_opacity", 0.72)
    state["explored_masks"] = copy.deepcopy(record.get("explored_masks") or {})

    token_visibility = record.get("token_visibility") or {}
    for token in state["vtt"].get("tokens", []):
        token["visible"] = bool(token_visibility.get(token.get("id"), False))
    state["vtt"]["tokens_visible"] = all(
        token.get("visible", False) for token in state["vtt"].get("tokens", [])
    )

    area_visibility = record.get("area_visibility") or {}
    for area in state["vtt"].get("areas", []):
        area["visible"] = bool(area_visibility.get(area.get("id"), False))


def clear_active_map_from_state(state):
    """Clear only map-specific active state while preserving session-wide VTT data."""
    blank = blank_map_record()
    state["has_image"] = False
    state["stored_filename"] = None
    state["mime_type"] = None
    state["original_filename"] = None
    state["zoom"] = blank["zoom"]
    state["background"] = blank["background"]
    state["version"] = int(time.time() * 1000)
    state["grid"] = copy.deepcopy(blank["grid"])
    state.setdefault("vtt", blank_vtt_state())
    state["vtt"]["vision_blockers"] = []
    state["vtt"]["door_color"] = blank["door_color"]
    state["vtt"]["door_opacity"] = blank["door_opacity"]
    state["explored_masks"] = {}
    # No active map means no public encounter state.
    for token in state["vtt"].get("tokens", []):
        token["visible"] = False
    state["vtt"]["tokens_visible"] = False if state["vtt"].get("tokens") else True
    for area in state["vtt"].get("areas", []):
        area["visible"] = False


def sync_active_map_from_state(state):
    """Persist the active-map mirror back into its map-library record before writes."""
    active_id = str(state.get("active_map_id") or "").strip()
    if not active_id or not isinstance(state.get("maps"), list):
        return
    record = find_map_by_id(state, active_id)
    if not record:
        return
    name = record.get("name") or default_map_name(state.get("original_filename"))
    updated = map_record_from_active_state(state, active_id, name)
    record.clear()
    record.update(updated)


def map_view_state(state, map_id=None):
    """Return a state-shaped view for the active map or an inactive prep map."""
    requested = str(map_id or state.get("active_map_id") or "").strip()
    record = find_map_by_id(state, requested)
    if not record:
        return None
    view = copy.deepcopy(state)
    view["active_map_id"] = requested
    apply_map_record_to_active_state(view, record)
    return view


def map_settings_target(state, map_id=None):
    """Return the mutable map-specific settings object and whether it is active."""
    requested = str(map_id or state.get("active_map_id") or "").strip()
    record = find_map_by_id(state, requested)
    if not record:
        return None, None, False
    is_active = requested == state.get("active_map_id")
    return (state["vtt"] if is_active else record), record, is_active


def map_public_metadata(record, active_map_id):
    blockers = record.get("vision_blockers", [])
    return {
        "id": record.get("id"),
        "name": record.get("name") or "Map",
        "original_filename": record.get("original_filename"),
        "has_image": bool(record.get("stored_filename")),
        "active": record.get("id") == active_map_id,
        "wall_count": sum(1 for item in blockers if item.get("type") == "wall"),
        "door_count": sum(1 for item in blockers if item.get("type") == "door"),
    }


def normalize_area(raw):
    if not isinstance(raw, dict):
        return None
    area_id = str(raw.get("id") or "").strip()
    if not area_id:
        return None
    name = str(raw.get("name") or "Area").strip()[:60] or "Area"
    color = str(raw.get("color") or "#e53935").lower()
    if not COLOR_RE.fullmatch(color):
        color = "#e53935"
    shape = str(raw.get("shape") or "circle").strip().lower()
    if shape not in {"circle", "cone", "line"}:
        shape = "circle"
    try:
        x = clamp(float(raw.get("x", 0.5)), 0.0, 1.0)
        y = clamp(float(raw.get("y", 0.5)), 0.0, 1.0)
        diameter = clamp(float(raw.get("diameter", 0.20)), 0.01, 2.0)
        length_squares = clamp(float(raw.get("length_squares", 6.0)), 0.5, 60.0)
        width_squares = clamp(float(raw.get("width_squares", 1.0)), 0.25, 20.0)
        angle = clamp(float(raw.get("angle", 60.0)), 15.0, 120.0)
        rotation = float(raw.get("rotation", 0.0)) % 360.0
    except Exception:
        x, y = 0.5, 0.5
        diameter = 0.20
        length_squares = 6.0
        width_squares = 1.0
        angle = 60.0
        rotation = 0.0
    return {
        "id": area_id,
        "name": name,
        "color": color,
        "shape": shape,
        "x": x,
        "y": y,
        "diameter": diameter,
        "length_squares": length_squares,
        "width_squares": width_squares,
        "angle": angle,
        "rotation": rotation,
        "visible": bool(raw.get("visible", True)),
    }


# Rebuild persisted state from validated fields before use.
def normalize_state(raw):
    state = blank_state()
    source_schema = 0
    if isinstance(raw, dict):
        for key in (
            "has_image",
            "stored_filename",
            "mime_type",
            "original_filename",
            "zoom",
            "background",
            "version",
        ):
            if key in raw:
                state[key] = raw[key]

        raw_grid = raw.get("grid") if isinstance(raw.get("grid"), dict) else {}
        grid = state["grid"].copy()
        grid.update({k: raw_grid[k] for k in grid if k in raw_grid})
        grid["enabled"] = bool(grid.get("enabled", True))
        try:
            grid["size"] = clamp(float(grid.get("size", 0.05)), 0.01, 0.15)
        except Exception:
            grid["size"] = 0.05
        grid["color"] = str(grid.get("color") or "#ffffff").lower()
        if not COLOR_RE.fullmatch(grid["color"]):
            grid["color"] = "#ffffff"
        try:
            grid["opacity"] = clamp(float(grid.get("opacity", 1.0)), 0.10, 1.0)
        except Exception:
            grid["opacity"] = 1.0
        state["grid"] = grid

        raw_vtt = raw.get("vtt") if isinstance(raw.get("vtt"), dict) else {}
        vtt = blank_vtt_state()
        vtt.update({k: raw_vtt[k] for k in vtt if k in raw_vtt})
        try:
            vtt["token_size"] = clamp(float(vtt["token_size"]), 0.01, 0.20)
        except Exception:
            vtt["token_size"] = 0.04
        # Older state has one token size; use it as the initial mobile size too.
        raw_mobile_token_size = raw_vtt.get("mobile_token_size", vtt["token_size"])
        try:
            vtt["mobile_token_size"] = clamp(float(raw_mobile_token_size), 0.01, 0.20)
        except Exception:
            vtt["mobile_token_size"] = vtt["token_size"]
        vtt["tokens_visible"] = bool(vtt.get("tokens_visible", True))
        vtt["movement_enabled"] = bool(vtt.get("movement_enabled", True))
        vtt["initiative_enforced"] = bool(vtt.get("initiative_enforced", False))
        vtt["active_initiative_token_id"] = str(vtt.get("active_initiative_token_id") or "").strip() or None
        vtt["dark_environment"] = bool(vtt.get("dark_environment", False))
        vtt["stack_player_vision"] = bool(vtt.get("stack_player_vision", False))
        vtt["persistent_explored_fog"] = bool(vtt.get("persistent_explored_fog", False))
        vtt["door_color"] = str(vtt.get("door_color") or "#ffd54d").lower()
        if not COLOR_RE.fullmatch(vtt["door_color"]):
            vtt["door_color"] = "#ffd54d"
        try:
            vtt["door_opacity"] = clamp(float(vtt.get("door_opacity", 0.72)), 0.10, 1.0)
        except Exception:
            vtt["door_opacity"] = 0.72
        vtt["password_hash"] = str(vtt.get("password_hash") or "") or None
        try:
            vtt["password_version"] = max(0, int(vtt.get("password_version", 0)))
        except Exception:
            vtt["password_version"] = 0

        try:
            source_schema = int(raw.get("schema_version", 0))
        except Exception:
            source_schema = 0
        legacy_hide_all_tokens = source_schema < 24 and raw_vtt.get("tokens_visible") is False

        tokens = []
        seen_ids = set()
        seen_keys = set()
        for raw_token in raw_vtt.get("tokens", []):
            token = normalize_token(raw_token)
            if not token or token["id"] in seen_ids:
                continue
            if token["player_controlled"]:
                base = normalize_player_key(token["name"]) or "player"
                current_key = token.get("player_key")
                # Rebuild legacy player keys from token names, then keep valid keys stable.
                key_matches_name = (
                    current_key == base
                    or bool(current_key and re.fullmatch(rf"{re.escape(base)}-[2-9][0-9]*", current_key))
                )
                if source_schema < 16 or not key_matches_name or current_key in seen_keys:
                    current_key = base
                    suffix = 2
                    while current_key in seen_keys:
                        current_key = f"{base}-{suffix}"
                        suffix += 1
                token["player_key"] = current_key
                seen_keys.add(current_key)
            seen_ids.add(token["id"])
            tokens.append(token)

        player_token_ids = {
            token["id"]
            for token in tokens
            if token.get("player_controlled") and token.get("player_key")
        }
        for token in tokens:
            if token.get("player_controlled"):
                token["moved_by_token_id"] = None
                token["share_vision_with_controller"] = False
            elif token.get("moved_by_token_id") not in player_token_ids:
                token["moved_by_token_id"] = None
                token["share_vision_with_controller"] = False
        # Convert the old global visibility gate into per-token visibility once.
        if legacy_hide_all_tokens:
            for token in tokens:
                token["visible"] = False
        vtt["tokens"] = tokens
        vtt["tokens_visible"] = all(token.get("visible", True) for token in tokens)
        eligible_initiative_tokens = [
            token for token in tokens if token.get("initiative") is not None
        ]
        eligible_initiative_ids = {token["id"] for token in eligible_initiative_tokens}
        if not eligible_initiative_tokens:
            vtt["active_initiative_token_id"] = None
            vtt["initiative_enforced"] = False
        elif vtt.get("active_initiative_token_id") not in eligible_initiative_ids:
            if vtt.get("initiative_enforced", False):
                first = sorted(
                    eligible_initiative_tokens,
                    key=lambda token: (
                        -int(token.get("initiative")),
                        str(token.get("name") or "").casefold(),
                        str(token.get("id") or ""),
                    ),
                )[0]
                vtt["active_initiative_token_id"] = first["id"]
            else:
                vtt["active_initiative_token_id"] = None

        areas = []
        seen_area_ids = set()
        for raw_area in raw_vtt.get("areas", []):
            area = normalize_area(raw_area)
            if not area or area["id"] in seen_area_ids:
                continue
            seen_area_ids.add(area["id"])
            areas.append(area)
        vtt["areas"] = areas

        blockers = []
        seen_blocker_ids = set()
        for raw_blocker in raw_vtt.get("vision_blockers", []):
            blocker = normalize_vision_blocker(raw_blocker)
            if not blocker or blocker["id"] in seen_blocker_ids:
                continue
            seen_blocker_ids.add(blocker["id"])
            blockers.append(blocker)
        vtt["vision_blockers"] = blockers
        state["vtt"] = vtt

    try:
        state["zoom"] = clamp(float(state["zoom"]), 0.1, 5.0)
    except Exception:
        state["zoom"] = 1.0
    if state["background"] not in ALLOWED_BACKGROUNDS:
        state["background"] = "#000000"
    if not state.get("stored_filename"):
        state["has_image"] = False

    raw_maps = raw.get("maps") if isinstance(raw, dict) and isinstance(raw.get("maps"), list) else []
    maps = []
    seen_map_ids = set()
    for index, raw_map in enumerate(raw_maps[:MAX_MAPS], start=1):
        candidate = normalize_map_record(raw_map, fallback_id=f"map-{index}", fallback_name=f"Map {index}")
        if candidate["id"] in seen_map_ids:
            continue
        seen_map_ids.add(candidate["id"])
        maps.append(candidate)

    # Legacy single-map state is promoted into the map library when real map content exists.
    if not raw_maps and (
        state.get("stored_filename")
        or state.get("original_filename")
        or state.get("vtt", {}).get("vision_blockers")
    ):
        maps = [map_record_from_active_state(state, "map-1", default_map_name(state.get("original_filename")))]

    requested_active_id = str(raw.get("active_map_id") or "").strip() if isinstance(raw, dict) else ""
    map_ids = {item["id"] for item in maps}
    if requested_active_id not in map_ids:
        # Preserve a real legacy active map, but do not recreate a deleted placeholder.
        requested_active_id = maps[0]["id"] if source_schema < 24 and maps else None
    # When map-local visibility is missing, preserve the active encounter and hide objects on other maps.
    if source_schema < 24:
        for record in maps:
            record["token_visibility"] = {}
            record["area_visibility"] = {}
        legacy_active = next((item for item in maps if item.get("id") == requested_active_id), None)
        if legacy_active:
            legacy_active["token_visibility"] = {
                token["id"]: bool(token.get("visible", True))
                for token in state["vtt"].get("tokens", [])
            }
            legacy_active["area_visibility"] = {
                area["id"]: bool(area.get("visible", True))
                for area in state["vtt"].get("areas", [])
            }

    state["maps"] = maps
    state["active_map_id"] = requested_active_id or None
    active_record = find_map_by_id(state, state["active_map_id"])
    if active_record:
        apply_map_record_to_active_state(state, active_record)
    elif source_schema >= 24 or not maps:
        clear_active_map_from_state(state)

    state["schema_version"] = 24
    return state


# ---- Explored-area fog -----------------------------------------------------
# Exploration is a per-player, per-map grayscale mask. Dynamic objects always use current LOS.
def _blank_explored_mask():
    return Image.new("L", (EXPLORED_MASK_SIZE, EXPLORED_MASK_SIZE), 0)


def _decode_explored_mask(encoded):
    if not encoded:
        return _blank_explored_mask()
    try:
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            return image.convert("L").resize(
                (EXPLORED_MASK_SIZE, EXPLORED_MASK_SIZE), Image.Resampling.NEAREST
            )
    except Exception:
        return _blank_explored_mask()


def _encode_explored_mask(image):
    buffer = io.BytesIO()
    image.convert("L").save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _circle_visibility_points(state, source, aspect, point_count=96):
    grid_fraction = max(0.01, float(state["grid"].get("size", 0.05)))
    radius = grid_fraction * (float(source.get("vision_radius_feet", 60.0)) / FEET_PER_GRID_SQUARE)
    cx = float(source.get("x", 0.5))
    cy = float(source.get("y", 0.5))
    points = []
    for index in range(point_count):
        angle = 2.0 * math.pi * index / point_count
        x = clamp(cx + math.cos(angle) * radius, 0.0, 1.0)
        y = clamp(cy + math.sin(angle) * radius / max(GEOMETRY_EPSILON, aspect), 0.0, 1.0)
        points.append([x, y])
    return points


def _individual_exploration_sources(state, player):
    if not player or not player.get("visible", True):
        return []
    sources = []
    if state["vtt"].get("dark_environment", False):
        if player.get("vision_enabled", False):
            sources.append(player)
    else:
        sources.append(player)
    sources.extend(shared_npc_vision_tokens(state, controller_id=player.get("id")))
    return sources


def _exploration_polygons(state, sources, aspect):
    if not sources:
        return []
    if state["vtt"].get("dark_environment", False):
        polygons = []
        for source in sources:
            points = visibility_polygon(state, source, aspect=aspect)
            polygons.append(points if points is not None else _circle_visibility_points(state, source, aspect))
        return polygons
    if not active_vision_blockers(state):
        return [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]
    return [line_of_sight_polygon(state, source, aspect=aspect) for source in sources]


def _paint_explored_polygons(mask, polygons):
    draw = ImageDraw.Draw(mask)
    max_pixel = EXPLORED_MASK_SIZE - 1
    for points in polygons:
        if not points or len(points) < 3:
            continue
        pixels = [
            (
                int(round(clamp(float(point[0]), 0.0, 1.0) * max_pixel)),
                int(round(clamp(float(point[1]), 0.0, 1.0) * max_pixel)),
            )
            for point in points
        ]
        draw.polygon(pixels, fill=255)


def update_explored_masks(state):
    """Accumulate each player's currently visible terrain into the active map."""
    if not state.get("has_image") or not state.get("active_map_id"):
        return
    if not state.get("vtt", {}).get("persistent_explored_fog", False):
        return

    player_tokens = [
        token for token in state["vtt"].get("tokens", [])
        if token.get("player_controlled") and token.get("player_key")
    ]
    valid_ids = {token["id"] for token in player_tokens}
    masks = {
        token_id: encoded
        for token_id, encoded in (state.get("explored_masks") or {}).items()
        if token_id in valid_ids
    }
    aspect = map_height_to_width_ratio(state)

    for player in player_tokens:
        sources = _individual_exploration_sources(state, player)
        polygons = _exploration_polygons(state, sources, aspect)
        if not polygons:
            continue
        old_encoded = masks.get(player["id"], "")
        mask = _decode_explored_mask(old_encoded)
        _paint_explored_polygons(mask, polygons)
        new_encoded = _encode_explored_mask(mask)
        if new_encoded != old_encoded:
            masks[player["id"]] = new_encoded

    state["explored_masks"] = masks


def combined_explored_mask(state, player_ids):
    if not state.get("vtt", {}).get("persistent_explored_fog", False):
        return None
    encoded_masks = state.get("explored_masks") or {}
    combined = None
    for token_id in player_ids:
        encoded = encoded_masks.get(token_id)
        if not encoded:
            continue
        mask = _decode_explored_mask(encoded)
        combined = mask if combined is None else ImageChops.lighter(combined, mask)
    return _encode_explored_mask(combined) if combined is not None else None


def viewer_explored_mask(state):
    return combined_explored_mask(
        state,
        [
            token["id"] for token in state["vtt"].get("tokens", [])
            if token.get("player_controlled")
            and token.get("player_key")
            and token.get("visible", True)
        ],
    )


def player_explored_mask(state, player):
    if not player or not player.get("visible", True):
        return None
    if state["vtt"].get("stack_player_vision", False):
        return viewer_explored_mask(state)
    return combined_explored_mask(state, [player["id"]])


# ---- State I/O and live updates -------------------------------------------
def _load_state_unlocked():
    try:
        raw = json.loads(game_state_file().read_text())
    except Exception:
        raw = {}
    return normalize_state(raw)


def load_state():
    with current_runtime().lock:
        return _load_state_unlocked()


# State writes are atomic; a successful write wakes connected SSE clients.
def _write_state_unlocked(state):
    runtime = current_runtime()
    update_explored_masks(state)
    sync_active_map_from_state(state)
    state = normalize_state(state)
    root = game_root()
    root.mkdir(parents=True, exist_ok=True)
    state_file = game_state_file()
    tmp = state_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, state_file)
    with runtime.condition:
        runtime.version += 1
        runtime.condition.notify_all()
    return state


def write_state(state):
    with current_runtime().lock:
        return _write_state_unlocked(state)


def notify_clients():
    """Wake SSE clients when non-state activity, such as a player login, changes."""
    runtime = current_runtime()
    with runtime.condition:
        runtime.version += 1
        runtime.condition.notify_all()


def image_path(state):
    filename = state.get("stored_filename")
    path = game_root() / filename if filename else None
    return path if path and path.is_file() else None


# ---- Authentication -------------------------------------------------------
def csrf_token():
    token = session.get("_csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["_csrf_token"] = token
    return token


app.jinja_env.globals["csrf_token"] = csrf_token


def check_csrf():
    expected = session.get("_csrf_token", "")
    supplied = request.headers.get("X-CSRF-Token", "") or request.form.get("_csrf_token", "")
    if not expected or not supplied or not hmac.compare_digest(expected, supplied):
        abort(400)


# Only /auth/gm/check accepts the trusted username supplied by Nginx.
EDITOR_LOGIN_PATHS = {"/edit", "/edit/wallmap"}


def normalized_editor_next(value):
    requested = str(value or "").strip()
    return requested if requested in EDITOR_LOGIN_PATHS else url_for("edit")


def clear_editor_session():
    for key in ("editor_authenticated", "editor_user", "editor_auth_revision"):
        session.pop(key, None)


def editor_auth_failure():
    clear_editor_session()
    login_url = url_for("login", next=request.path if request.path in EDITOR_LOGIN_PATHS else "/edit")
    if request.path.startswith("/api/") or request.path.startswith("/edit/api/"):
        return jsonify(error="GM login is required.", login_url=login_url), 401
    return redirect(login_url)


def editor_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if request.environ.get("VTT_GAME_SLUG"):
            abort(404)
        if not current_editor_user():
            return editor_auth_failure()
        return fn(*args, **kwargs)

    return wrapped


# The in-memory throttle protects the shared player password; Nginx handles GM auth.
def client_ip():
    return request.remote_addr or "unknown"


def is_limited(kind, ip):
    now = time.time()
    cutoff = now - LOGIN_WINDOW_SECONDS
    with failures_lock:
        bucket = failures[kind].setdefault(current_game_slug(), {})
        bucket[ip] = [stamp for stamp in bucket.get(ip, []) if stamp >= cutoff]
        return len(bucket[ip]) >= LOGIN_MAX_FAILURES


def fail_login(kind, ip):
    with failures_lock:
        failures[kind].setdefault(current_game_slug(), {}).setdefault(ip, []).append(time.time())


def clear_failures(kind, ip):
    with failures_lock:
        failures[kind].setdefault(current_game_slug(), {}).pop(ip, None)


# The feature-request challenge is short-lived and consumed after one attempt.
def feature_request_challenge(force_new=False):
    now = int(time.time())
    challenge = session.get("_feature_request_math")
    valid = (
        isinstance(challenge, dict)
        and isinstance(challenge.get("left"), int)
        and isinstance(challenge.get("right"), int)
        and int(challenge.get("created", 0)) >= now - FEATURE_REQUEST_CHALLENGE_SECONDS
    )
    if force_new or not valid:
        challenge = {
            "left": secrets.randbelow(8) + 2,
            "right": secrets.randbelow(8) + 2,
            "created": now,
        }
        session["_feature_request_math"] = challenge
    return challenge


def append_feature_request(name, request_text):
    record = {
        "submitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "status": "active",
        "name": name or None,
        "request": request_text,
    }
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with feature_request_lock:
        # Keep user-submitted request data private to the service account.
        fd = os.open(FEATURE_REQUEST_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)


def read_feature_requests():
    """Return public feature requests grouped by status, then newest first."""
    if not FEATURE_REQUEST_FILE.exists():
        return []

    records = []
    with feature_request_lock:
        try:
            lines = FEATURE_REQUEST_FILE.read_text(encoding="utf-8").splitlines()
        except OSError:
            app.logger.exception("Could not read feature requests")
            return []

    for line in lines:
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(item, dict):
            continue

        request_text = str(item.get("request") or "").strip()
        if not request_text:
            continue
        name = str(item.get("name") or "").strip() or None

        # Older request records have no status and are treated as active.
        raw_status = str(item.get("status") or "active").strip().casefold() or "active"
        if raw_status == "active":
            status = "active"
            status_rank = 0
        elif raw_status == "completed":
            status = "completed"
            status_rank = 1
        else:
            status = raw_status
            status_rank = 2

        submitted_at = str(item.get("submitted_at") or "").strip()
        submitted_display = submitted_at
        submitted_sort = datetime.min.replace(tzinfo=timezone.utc)
        if submitted_at:
            try:
                stamp = datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
                if stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=timezone.utc)
                submitted_sort = stamp.astimezone(timezone.utc)
                submitted_display = submitted_sort.strftime("%Y-%m-%d %H:%M UTC")
            except ValueError:
                pass

        # Pass only public fields to the template.
        records.append({
            "name": name,
            "request": request_text,
            "status": status,
            "status_class": status if status in {"active", "completed"} else "other",
            "submitted_at": submitted_display,
            "_status_rank": status_rank,
            "_submitted_sort": submitted_sort,
        })

    # Stable sorts keep newest-first ordering inside each status group.
    records.sort(key=lambda item: item["_submitted_sort"], reverse=True)
    records.sort(key=lambda item: item["_status_rank"])
    for item in records:
        item.pop("_status_rank", None)
        item.pop("_submitted_sort", None)
    return records


# ---- Audit log ------------------------------------------------------------
def _audit_value(value):
    return json.dumps(str(value), ensure_ascii=False)


def log_token_event(event, *, actor="GM", player=None, ip=None, **fields):
    """Append an audit event without making logging failures fatal to game state."""
    try:
        now = datetime.now(timezone.utc)
        log_dir = game_token_log_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / f"token-events-{now:%Y-%m}.log"
        parts = [
            now.isoformat(timespec="seconds").replace("+00:00", "Z"),
            str(event).upper(),
            f"actor={str(actor).upper()}",
        ]
        if player:
            parts.append(f"player={_audit_value(player)}")
        parts.append(f"ip={ip or client_ip()}")
        for key, value in fields.items():
            if value is None:
                continue
            if isinstance(value, bool):
                rendered = "true" if value else "false"
            elif isinstance(value, (int, float)):
                rendered = str(value)
            else:
                rendered = _audit_value(value)
            parts.append(f"{key}={rendered}")
        line = " ".join(parts) + "\n"
        with token_log_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line)
    except Exception:
        app.logger.exception("Unable to append token audit event")


def token_controller_name(state, token_id):
    if not token_id:
        return None
    token = find_token_by_id(state, token_id)
    return token.get("name") if token else None


def _recent_token_log_paths():
    now = datetime.now(timezone.utc)
    log_dir = game_token_log_dir()
    current = log_dir / f"token-events-{now:%Y-%m}.log"
    if now.month == 1:
        previous_year, previous_month = now.year - 1, 12
    else:
        previous_year, previous_month = now.year, now.month - 1
    previous = log_dir / f"token-events-{previous_year:04d}-{previous_month:02d}.log"
    return (current, previous)


def parse_audit_line(line):
    """Parse one human-readable audit line into timestamp, event, and fields."""
    try:
        parts = shlex.split(line)
    except ValueError:
        return None
    if len(parts) < 3:
        return None
    fields = {}
    for part in parts[2:]:
        if "=" in part:
            key, value = part.split("=", 1)
            fields[key] = value
    return {"timestamp": parts[0], "event": parts[1].upper(), "fields": fields}


def recent_player_activity(connection_limit=20, move_limit=20):
    """Return recent GM-only connection and movement entries."""
    connections = []
    moves = []
    for path in _recent_token_log_paths():
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            continue
        except Exception:
            app.logger.exception("Unable to read audit log for GM player activity")
            continue

        for line in reversed(lines):
            parsed = parse_audit_line(line)
            if not parsed:
                continue
            event = parsed["event"]
            fields = parsed["fields"]
            if fields.get("actor", "").upper() != "PLAYER":
                continue
            if event == "CONNECT" and len(connections) < connection_limit:
                connections.append({
                    "timestamp": parsed["timestamp"],
                    "player": fields.get("player") or "Player",
                    "ip": fields.get("ip") or "unknown",
                })
            elif event == "MOVE" and len(moves) < move_limit:
                moves.append({
                    "timestamp": parsed["timestamp"],
                    "moved_by": fields.get("player") or "Player",
                    "token_name": fields.get("token") or "Token",
                    "ip": fields.get("ip") or "unknown",
                })
            if len(connections) >= connection_limit and len(moves) >= move_limit:
                return {"connections": connections, "moves": moves}
    return {"connections": connections, "moves": moves}


def log_player_connection(player, ip=None):
    """Log a successful player login and wake the GM editor."""
    log_token_event(
        "CONNECT",
        actor="PLAYER",
        player=player.get("name") or "Player",
        ip=ip,
        id=player.get("id"),
    )
    notify_clients()


# Public recent-move rows are filtered against the token IDs visible to that view.
def recent_move_events(state, visible_token_ids, limit=2):
    """Return recent MOVE audit events safe for the current public view.

    Only moves for token IDs already admitted by the view's normal visibility
    filtering are returned. This prevents the activity overlay from leaking the
    name or movement of an NPC hidden by darkness or GM visibility controls.
    """
    visible_ids = set(visible_token_ids or ())
    if not visible_ids or limit <= 0:
        return []

    token_names = {
        token.get("id"): token.get("name") or "Token"
        for token in state["vtt"]["tokens"]
        if token.get("id") in visible_ids
    }
    result = []
    for path in _recent_token_log_paths():
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            continue
        except Exception:
            app.logger.exception("Unable to read token audit log for recent move display")
            continue

        for line in reversed(lines):
            parsed = parse_audit_line(line)
            if not parsed or parsed["event"] != "MOVE":
                continue
            fields = parsed["fields"]
            token_id = fields.get("id")
            if token_id not in visible_ids:
                continue
            actor = fields.get("actor", "GM").upper()
            moved_by = fields.get("player") if actor == "PLAYER" else "GM"
            moved_by = moved_by or "Player"
            result.append(
                {
                    "timestamp": parsed["timestamp"],
                    "moved_by": moved_by,
                    "token_name": token_names.get(token_id, fields.get("token") or "Token"),
                }
            )
            if len(result) >= limit:
                return result
    return result


# ---- Map upload and public-state shaping ---------------------------------
def validate_map_upload(raw):
    if not raw:
        raise ValueError("No image data was received.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("The uploaded file exceeds the configured size limit.")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            fmt = (image.format or "").upper()
            image.verify()
    except Exception as exc:
        raise ValueError("The uploaded file is not a valid supported image.") from exc
    if fmt not in ALLOWED_FORMATS:
        raise ValueError("Supported formats: JPEG, PNG, GIF, WebP, BMP, and TIFF.")
    ext, mime = ALLOWED_FORMATS[fmt]
    return fmt, ext, mime


def store_map_upload(raw, map_id):
    """Store one map image in its own persistent directory."""
    fmt, ext, mime = validate_map_upload(raw)
    map_dir = game_maps_dir() / str(map_id)
    map_dir.mkdir(parents=True, exist_ok=True)
    dest = map_dir / f"map.{ext}"
    tmp = map_dir / f".map.{ext}.tmp"
    if fmt == "TIFF":
        with Image.open(io.BytesIO(raw)) as image:
            image.seek(0)
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(
                tmp, format="PNG", optimize=True
            )
    else:
        tmp.write_bytes(raw)
    os.replace(tmp, dest)
    for old in map_dir.glob("map.*"):
        if old != dest and old.is_file():
            old.unlink(missing_ok=True)
    return str(dest.relative_to(game_root())), mime


def remove_map_storage(record):
    """Delete a map image after its library record has safely been removed."""
    filename = str(record.get("stored_filename") or "").strip()
    if not filename:
        return
    path = (game_root() / filename).resolve()
    root = game_root().resolve()
    if path.is_relative_to(root) and path.is_file():
        path.unlink(missing_ok=True)
    map_dir = path.parent
    maps_root = game_maps_dir().resolve()
    if map_dir.is_relative_to(maps_root) and map_dir.is_dir():
        try:
            map_dir.rmdir()
        except OSError:
            pass


def store_upload(raw, map_id):
    """Backward-compatible active-map replacement helper."""
    return store_map_upload(raw, map_id)


def public_token(token):
    return {
        "id": token["id"],
        "name": token["name"],
        "color": token["color"],
        "x": token["x"],
        "y": token["y"],
        "initiative": token.get("initiative"),
    }


def public_vision_source(state, token, aspect=None):
    source = {
        "token_id": token["id"],
        "x": token["x"],
        "y": token["y"],
        "radius_feet": token.get("vision_radius_feet", 60.0),
        "vision_type": token.get("vision_type", "light"),
        "door_vision": True,
    }
    if state["vtt"].get("dark_environment", False):
        points = visibility_polygon(state, token, aspect=aspect)
        if points is not None:
            source["points"] = points
    return source


def public_vision_sources(state, tokens):
    tokens = list(tokens or [])
    if not tokens:
        return []
    aspect = map_height_to_width_ratio(state)
    return [public_vision_source(state, token, aspect=aspect) for token in tokens]


def public_line_of_sight_source(state, token, aspect=None):
    """Unlimited-range terrain LOS for normally lit player/viewer maps."""
    source = {
        "token_id": token["id"],
        "x": token["x"],
        "y": token["y"],
        "door_vision": True,
    }
    points = line_of_sight_polygon(state, token, aspect=aspect)
    if points is not None:
        source["points"] = points
    return source


def public_line_of_sight_sources(state, tokens):
    """Return lit-map LOS polygons without exposing the underlying wall geometry."""
    if not active_vision_blockers(state):
        return []
    tokens = list(tokens or [])
    if not tokens:
        return []
    aspect = map_height_to_width_ratio(state)
    return [public_line_of_sight_source(state, token, aspect=aspect) for token in tokens]


def public_npc_reveal_source(token):
    # NPC self-reveal is a GM override and does not become a vision source.
    return {
        "token_id": token["id"],
        "x": token["x"],
        "y": token["y"],
        "radius_feet": NPC_REVEAL_RADIUS_FEET,
        "vision_type": "light",
        "door_vision": False,
    }


# ---- Darkness and vision -------------------------------------------------
# NPC self-reveal may expose that NPC but never lights nearby creatures.
def shared_npc_vision_tokens(state, controller_id=None):
    """Return delegated NPCs that share sight with a player."""
    return [
        token
        for token in state["vtt"]["tokens"]
        if not token.get("player_controlled")
        and token.get("visible", True)
        and token.get("moved_by_token_id")
        and token.get("share_vision_with_controller", False)
        and (controller_id is None or token.get("moved_by_token_id") == controller_id)
    ]


def party_vision_tokens(state):
    # Darkness uses only player tokens whose Vision in darkness option is enabled,
    # plus any delegated NPC sight the GM explicitly shares.
    player_sources = [
        token
        for token in state["vtt"]["tokens"]
        if token.get("player_controlled")
        and token.get("player_key")
        and token.get("visible", True)
        and token.get("vision_enabled", False)
    ]
    return player_sources + shared_npc_vision_tokens(state)


def party_line_of_sight_tokens(state):
    """Party viewpoints used for wall/door occlusion on a lit map.

    Normal lighting has no vision-radius limit, so every visible player character
    is a viewpoint even when Vision in darkness is disabled. Delegated NPC sight
    still requires the explicit Share vision with controlling player option.
    """
    player_sources = [
        token
        for token in state["vtt"]["tokens"]
        if token.get("player_controlled")
        and token.get("player_key")
        and token.get("visible", True)
    ]
    return player_sources + shared_npc_vision_tokens(state)


def revealed_npc_tokens(state):
    return [
        token
        for token in state["vtt"]["tokens"]
        if not token.get("player_controlled")
        and token.get("visible", True)
        and token.get("reveal_in_darkness", False)
    ]


def viewer_player_vision_tokens(state):
    """Real party vision sources used for visibility tests on /viewer."""
    return party_vision_tokens(state)


def player_vision_tokens_for_player(state, player):
    """Real darkness vision sources for one player VTT.

    A player always gets any delegated NPC sight the GM explicitly shares with
    that character. With party stacking enabled, those sources join the full
    party union. NPC Reveal in darkness remains a separate one-foot self-reveal
    and never illuminates neighboring tokens, AOEs, or movement checks.
    """
    if state["vtt"].get("stack_player_vision", False):
        return party_vision_tokens(state)
    if not player:
        return []
    sources = []
    if player.get("visible", True) and player.get("vision_enabled", False):
        sources.append(player)
    sources.extend(shared_npc_vision_tokens(state, controller_id=player.get("id")))
    return sources


def player_line_of_sight_tokens_for_player(state, player):
    """Unlimited-range lit-map viewpoints for one player VTT.

    Walls and closed doors still occlude NPCs in normal lighting. The player's
    own visible character is therefore a viewpoint even when Vision in darkness
    is disabled. Party stacking expands that to every visible player character.
    """
    if state["vtt"].get("stack_player_vision", False):
        return party_line_of_sight_tokens(state)
    if not player:
        return []
    sources = []
    if player.get("visible", True):
        sources.append(player)
    sources.extend(shared_npc_vision_tokens(state, controller_id=player.get("id")))
    return sources


def map_height_to_width_ratio(state):
    path = image_path(state)
    if not path:
        return 1.0
    try:
        with Image.open(path) as image:
            width, height = image.size
        return (height / width) if width else 1.0
    except Exception:
        return 1.0


def active_vision_blockers(state):
    """Return walls and closed doors that currently stop line of sight."""
    return [
        blocker
        for blocker in state["vtt"].get("vision_blockers", [])
        if blocker.get("type") == "wall"
        or (blocker.get("type") == "door" and not blocker.get("open", False))
    ]


def _scaled_segment(blocker, aspect):
    return (
        float(blocker["x1"]),
        float(blocker["y1"]) * aspect,
        float(blocker["x2"]),
        float(blocker["y2"]) * aspect,
    )


def _cross(ax, ay, bx, by):
    return ax * by - ay * bx


def _ray_segment_distance(ox, oy, dx, dy, segment, max_distance):
    """Distance from a ray origin to a blocker, or None when they do not meet."""
    x1, y1, x2, y2 = segment
    sx = x2 - x1
    sy = y2 - y1
    denominator = _cross(dx, dy, sx, sy)
    if abs(denominator) < GEOMETRY_EPSILON:
        return None
    qx = x1 - ox
    qy = y1 - oy
    ray_t = _cross(qx, qy, sx, sy) / denominator
    segment_u = _cross(qx, qy, dx, dy) / denominator
    if ray_t <= 1e-7 or ray_t > max_distance + GEOMETRY_EPSILON:
        return None
    if segment_u < -GEOMETRY_EPSILON or segment_u > 1.0 + GEOMETRY_EPSILON:
        return None
    return ray_t


def _point_segment_distance(px, py, segment):
    """Shortest distance from a point to a line segment in scaled map space."""
    x1, y1, x2, y2 = segment
    vx = x2 - x1
    vy = y2 - y1
    length_sq = vx * vx + vy * vy
    if length_sq <= GEOMETRY_EPSILON:
        return math.hypot(px - x1, py - y1)
    projection = ((px - x1) * vx + (py - y1) * vy) / length_sq
    projection = clamp(projection, 0.0, 1.0)
    closest_x = x1 + projection * vx
    closest_y = y1 + projection * vy
    return math.hypot(px - closest_x, py - closest_y)


def _segment_intersection_parameter(segment_a, segment_b):
    """Return the first intersection position along segment_a, or None.

    A return value of 0 means the movement starts on the blocker. Collinear
    overlap returns 0 as well so a token cannot travel along the center of a wall.
    """
    ax1, ay1, ax2, ay2 = segment_a
    bx1, by1, bx2, by2 = segment_b
    rx = ax2 - ax1
    ry = ay2 - ay1
    sx = bx2 - bx1
    sy = by2 - by1
    denominator = _cross(rx, ry, sx, sy)
    qx = bx1 - ax1
    qy = by1 - ay1

    if abs(denominator) > GEOMETRY_EPSILON:
        t = _cross(qx, qy, sx, sy) / denominator
        u = _cross(qx, qy, rx, ry) / denominator
        if (-GEOMETRY_EPSILON <= t <= 1.0 + GEOMETRY_EPSILON
                and -GEOMETRY_EPSILON <= u <= 1.0 + GEOMETRY_EPSILON):
            return clamp(t, 0.0, 1.0)
        return None

    # Parallel segments intersect only when they are collinear and their
    # projections overlap. Use the dominant movement axis to find that overlap.
    if abs(_cross(qx, qy, rx, ry)) > GEOMETRY_EPSILON:
        return None
    length_sq = rx * rx + ry * ry
    if length_sq <= GEOMETRY_EPSILON:
        return 0.0 if _point_segment_distance(ax1, ay1, segment_b) <= GEOMETRY_EPSILON else None
    t0 = ((bx1 - ax1) * rx + (by1 - ay1) * ry) / length_sq
    t1 = ((bx2 - ax1) * rx + (by2 - ay1) * ry) / length_sq
    low = max(0.0, min(t0, t1))
    high = min(1.0, max(t0, t1))
    return low if low <= high + GEOMETRY_EPSILON else None


def _segment_segment_distance(segment_a, segment_b):
    if _segment_intersection_parameter(segment_a, segment_b) is not None:
        return 0.0
    ax1, ay1, ax2, ay2 = segment_a
    bx1, by1, bx2, by2 = segment_b
    return min(
        _point_segment_distance(ax1, ay1, segment_b),
        _point_segment_distance(ax2, ay2, segment_b),
        _point_segment_distance(bx1, by1, segment_a),
        _point_segment_distance(bx2, by2, segment_a),
    )


def normalize_player_move_path(raw_path, start_x, start_y, end_x, end_y):
    """Build the authoritative movement polyline from a player's drag trace.

    The server always supplies the real starting coordinate and requested final
    coordinate. Older clients that omit path still get a direct start-to-end
    collision check.
    """
    points = [(float(start_x), float(start_y))]
    if raw_path is not None:
        if not isinstance(raw_path, list):
            raise ValueError("Invalid movement path.")
        if len(raw_path) > MAX_PLAYER_MOVE_PATH_POINTS:
            raise ValueError("Movement path is too detailed.")
        for raw_point in raw_path:
            try:
                if isinstance(raw_point, dict):
                    px = float(raw_point.get("x"))
                    py = float(raw_point.get("y"))
                elif isinstance(raw_point, (list, tuple)) and len(raw_point) >= 2:
                    px = float(raw_point[0])
                    py = float(raw_point[1])
                else:
                    raise ValueError
            except Exception as exc:
                raise ValueError("Invalid movement path.") from exc
            px = clamp(px, 0.0, 1.0)
            py = clamp(py, 0.0, 1.0)
            if math.hypot(px - points[-1][0], py - points[-1][1]) > GEOMETRY_EPSILON:
                points.append((px, py))

    final_point = (float(end_x), float(end_y))
    if math.hypot(final_point[0] - points[-1][0], final_point[1] - points[-1][1]) > GEOMETRY_EPSILON:
        points.append(final_point)
    return points


def player_move_path_blocked(state, path):
    """Return True if a player's swept token footprint hits a wall or closed door.

    Collision uses the same GM-only blocker geometry as line of sight but is not
    conditional on Dark environment. The footprint is slightly smaller than the
    displayed token so ordinary doorways remain comfortable to use.
    """
    blockers = active_vision_blockers(state)
    if not blockers or len(path) < 2:
        return False

    aspect = max(GEOMETRY_EPSILON, map_height_to_width_ratio(state))
    token_diameter = max(0.0, float(state["vtt"].get("token_size", 0.04)))
    radius = token_diameter * PLAYER_COLLISION_RADIUS_FACTOR
    scaled_path = [(float(x), float(y) * aspect) for x, y in path]

    for blocker in blockers:
        blocker_segment = _scaled_segment(blocker, aspect)
        start_distance = _point_segment_distance(
            scaled_path[0][0], scaled_path[0][1], blocker_segment
        )
        # A legacy/GM-placed token might already overlap a blocker. Let it escape
        # that clearance zone, but never let its center cross the blocker while
        # doing so. Once clear, normal swept-radius collision takes over.
        escaping_existing_overlap = start_distance < radius - GEOMETRY_EPSILON

        for index in range(1, len(scaled_path)):
            start = scaled_path[index - 1]
            end = scaled_path[index]
            movement_segment = (start[0], start[1], end[0], end[1])
            intersection_t = _segment_intersection_parameter(movement_segment, blocker_segment)
            if intersection_t is not None:
                # Contact exactly at the authoritative starting point is allowed
                # only so an already-misplaced token can be dragged away from a wall.
                if not (escaping_existing_overlap and index == 1 and intersection_t <= 1e-7):
                    return True

            end_distance = _point_segment_distance(end[0], end[1], blocker_segment)
            if escaping_existing_overlap:
                if end_distance >= radius - GEOMETRY_EPSILON:
                    escaping_existing_overlap = False
                continue

            if _segment_segment_distance(movement_segment, blocker_segment) < radius - GEOMETRY_EPSILON:
                return True
    return False


def _line_of_sight_clear(source_x, source_y, target_x, target_y, blockers, aspect):
    ox = float(source_x)
    oy = float(source_y) * aspect
    tx = float(target_x)
    ty = float(target_y) * aspect
    dx = tx - ox
    dy = ty - oy
    distance = math.hypot(dx, dy)
    if distance <= GEOMETRY_EPSILON:
        return True
    dx /= distance
    dy /= distance
    for blocker in blockers:
        hit = _ray_segment_distance(
            ox, oy, dx, dy, _scaled_segment(blocker, aspect), distance
        )
        # Treat an intersection at the target itself as blocked too. A token
        # centered directly on a wall should not become a visibility loophole.
        if hit is not None and hit <= distance + GEOMETRY_EPSILON:
            return False
    return True


def _ray_map_bounds_distance(ox, oy, dx, dy, aspect):
    """Distance from a ray origin to the normalized map rectangle boundary."""
    distances = []
    if dx > GEOMETRY_EPSILON:
        distances.append((1.0 - ox) / dx)
    elif dx < -GEOMETRY_EPSILON:
        distances.append((0.0 - ox) / dx)
    if dy > GEOMETRY_EPSILON:
        distances.append((aspect - oy) / dy)
    elif dy < -GEOMETRY_EPSILON:
        distances.append((0.0 - oy) / dy)
    positive = [distance for distance in distances if distance >= -GEOMETRY_EPSILON]
    return max(GEOMETRY_EPSILON, min(positive)) if positive else GEOMETRY_EPSILON


def line_of_sight_polygon(state, source, aspect=None):
    """Build unlimited-range LOS clipped by walls, closed doors, and map edges.

    Normally lit maps have no sight-radius or illumination limit; blocker geometry
    still controls occlusion. Points use normalized map coordinates. None means no
    terrain mask is needed because no blockers are active.
    """
    blockers = active_vision_blockers(state)
    if not blockers:
        return None
    if aspect is None:
        aspect = map_height_to_width_ratio(state)
    aspect = max(GEOMETRY_EPSILON, float(aspect))
    source_x = float(source.get("x", 0.5))
    source_y = float(source.get("y", 0.5))

    blocker_key = tuple(
        (
            blocker.get("id"), blocker.get("type"), bool(blocker.get("open", False)),
            float(blocker["x1"]), float(blocker["y1"]),
            float(blocker["x2"]), float(blocker["y2"]),
        )
        for blocker in blockers
    )
    cache_key = (
        "lit-los", round(aspect, 9), round(source_x, 9), round(source_y, 9), blocker_key,
    )
    with vision_polygon_cache_lock:
        cached = vision_polygon_cache.get(cache_key)
    if cached is not None:
        return cached

    ox = source_x
    oy = source_y * aspect
    segments = [_scaled_segment(blocker, aspect) for blocker in blockers]

    # Regular rays provide stable coverage. Rays immediately around every blocker
    # endpoint prevent corner leaks, while rays around the four map corners keep
    # the unlimited polygon flush with the map rectangle instead of cutting them off.
    angles = [2.0 * math.pi * i / VISION_RAY_COUNT for i in range(VISION_RAY_COUNT)]
    angle_points = []
    for x1, y1, x2, y2 in segments:
        angle_points.extend(((x1, y1), (x2, y2)))
    angle_points.extend(((0.0, 0.0), (1.0, 0.0), (1.0, aspect), (0.0, aspect)))
    full_turn = 2.0 * math.pi
    for px, py in angle_points:
        if math.hypot(px - ox, py - oy) <= GEOMETRY_EPSILON:
            continue
        angle = math.atan2(py - oy, px - ox)
        angles.extend((
            (angle - VISION_RAY_EPSILON) % full_turn,
            angle % full_turn,
            (angle + VISION_RAY_EPSILON) % full_turn,
        ))
    angles.sort()

    points = []
    for angle in angles:
        dx = math.cos(angle)
        dy = math.sin(angle)
        boundary_distance = _ray_map_bounds_distance(ox, oy, dx, dy, aspect)
        distance = boundary_distance
        for segment in segments:
            hit = _ray_segment_distance(ox, oy, dx, dy, segment, boundary_distance)
            if hit is not None and hit < distance:
                distance = hit
        x = clamp(ox + dx * distance, 0.0, 1.0)
        y = clamp((oy + dy * distance) / aspect, 0.0, 1.0)
        points.append([round(x, 7), round(y, 7)])

    with vision_polygon_cache_lock:
        if len(vision_polygon_cache) >= VISION_POLYGON_CACHE_MAX:
            vision_polygon_cache.clear()
        vision_polygon_cache[cache_key] = points
    return points


def visibility_polygon(state, source, aspect=None):
    """Build the circular vision region clipped by GM-drawn walls and closed doors.

    Returned points are normalized map coordinates. When there are no active
    blockers, None tells the browser to keep using its cheaper SVG circle.
    """
    blockers = active_vision_blockers(state)
    if not blockers:
        return None
    if aspect is None:
        aspect = map_height_to_width_ratio(state)
    aspect = max(GEOMETRY_EPSILON, float(aspect))
    grid_fraction = max(0.01, float(state["grid"].get("size", 0.05)))
    radius_feet = float(source.get("vision_radius_feet", 60.0))
    radius = grid_fraction * (radius_feet / FEET_PER_GRID_SQUARE)
    source_x = float(source.get("x", 0.5))
    source_y = float(source.get("y", 0.5))

    # Viewer and player pages often request the same party polygons within a few
    # milliseconds of one another. Cache by geometry, not by request, so one GM
    # move does not make every connected browser repeat the same ray casting.
    blocker_key = tuple(
        (
            blocker.get("id"), blocker.get("type"), bool(blocker.get("open", False)),
            float(blocker["x1"]), float(blocker["y1"]),
            float(blocker["x2"]), float(blocker["y2"]),
        )
        for blocker in blockers
    )
    cache_key = (
        round(aspect, 9), round(grid_fraction, 9), round(source_x, 9),
        round(source_y, 9), round(radius_feet, 6), blocker_key,
    )
    with vision_polygon_cache_lock:
        cached = vision_polygon_cache.get(cache_key)
    if cached is not None:
        return cached

    ox = source_x
    oy = source_y * aspect
    segments = [_scaled_segment(blocker, aspect) for blocker in blockers]

    # Regular rays make the unblocked circumference smooth. Extra rays just to
    # either side of every wall endpoint prevent light leaking around corners.
    angles = [2.0 * math.pi * i / VISION_RAY_COUNT for i in range(VISION_RAY_COUNT)]
    for x1, y1, x2, y2 in segments:
        for px, py in ((x1, y1), (x2, y2)):
            angle = math.atan2(py - oy, px - ox)
            full_turn = 2.0 * math.pi
            angles.extend((
                (angle - VISION_RAY_EPSILON) % full_turn,
                angle % full_turn,
                (angle + VISION_RAY_EPSILON) % full_turn,
            ))
    angles.sort()

    points = []
    for angle in angles:
        dx = math.cos(angle)
        dy = math.sin(angle)
        distance = radius
        for segment in segments:
            hit = _ray_segment_distance(ox, oy, dx, dy, segment, radius)
            if hit is not None and hit < distance:
                distance = hit
        x = clamp(ox + dx * distance, 0.0, 1.0)
        y = clamp((oy + dy * distance) / aspect, 0.0, 1.0)
        points.append([round(x, 7), round(y, 7)])
    with vision_polygon_cache_lock:
        if len(vision_polygon_cache) >= VISION_POLYGON_CACHE_MAX:
            vision_polygon_cache.clear()
        vision_polygon_cache[cache_key] = points
    return points


def point_in_vision(state, x, y, vision_tokens, aspect=None):
    if not vision_tokens:
        return False
    grid_fraction = max(0.01, float(state["grid"].get("size", 0.05)))
    if aspect is None:
        aspect = map_height_to_width_ratio(state)
    blockers = active_vision_blockers(state)
    for source in vision_tokens:
        radius = grid_fraction * (float(source.get("vision_radius_feet", 60.0)) / FEET_PER_GRID_SQUARE)
        dx = float(x) - float(source.get("x", 0.5))
        dy = (float(y) - float(source.get("y", 0.5))) * aspect
        if dx * dx + dy * dy > radius * radius:
            continue
        if not blockers or _line_of_sight_clear(
            source.get("x", 0.5), source.get("y", 0.5), x, y, blockers, aspect
        ):
            return True
    return False


def point_in_line_of_sight(state, x, y, sight_tokens, aspect=None):
    """Return True when a lit-map viewpoint can see a point.

    Unlike point_in_vision(), this applies no radius. It exists so normal lighting
    can leave the map fully illuminated while walls and closed doors still hide
    NPCs that are physically out of sight.
    """
    if not sight_tokens:
        return False
    blockers = active_vision_blockers(state)
    if not blockers:
        return True
    if aspect is None:
        aspect = map_height_to_width_ratio(state)
    for source in sight_tokens:
        if _line_of_sight_clear(
            source.get("x", 0.5), source.get("y", 0.5), x, y, blockers, aspect
        ):
            return True
    return False


# Decide which token records can leave the server. Visibility filtering happens
# here, not just in CSS, so an occluded NPC name and position are absent from the
# browser payload. Darkness adds radius/illumination limits; walls and closed
# doors occlude NPCs in both dark and normally lit environments.
def visible_public_tokens(
    state,
    player_vision_tokens=None,
    line_of_sight_tokens=None,
    always_include_ids=None,
):
    always_include_ids = set(always_include_ids or ())
    dark = state["vtt"].get("dark_environment", False)
    aspect = map_height_to_width_ratio(state)
    result = []
    for token in state["vtt"]["tokens"]:
        if not token.get("visible", True):
            continue
        if token["id"] in always_include_ids:
            result.append(public_token(token))
            continue
        if dark:
            if not token.get("player_controlled") and token.get("reveal_in_darkness", False):
                pass
            elif not point_in_vision(
                state,
                token["x"],
                token["y"],
                player_vision_tokens or [],
                aspect=aspect,
            ):
                continue
        elif token.get("player_controlled"):
            # Preserve normal-light behavior for player characters. Only NPCs are
            # subject to the new unlimited-range wall/door occlusion check.
            pass
        elif not point_in_line_of_sight(
            state,
            token["x"],
            token["y"],
            line_of_sight_tokens or [],
            aspect=aspect,
        ):
            continue
        result.append(public_token(token))
    return result


def visible_public_areas(state, vision_tokens=None, line_of_sight_tokens=None):
    """Filter AOEs by the same audience visibility rule used for terrain/tokens."""
    dark = state["vtt"].get("dark_environment", False)
    aspect = map_height_to_width_ratio(state)
    if dark:
        return [
            public_area(area)
            for area in state["vtt"]["areas"]
            if area.get("visible", True)
            and point_in_vision(state, area["x"], area["y"], vision_tokens or [], aspect=aspect)
        ]
    return [
        public_area(area)
        for area in state["vtt"]["areas"]
        if area.get("visible", True)
        and point_in_line_of_sight(
            state, area["x"], area["y"], line_of_sight_tokens or [], aspect=aspect
        )
    ]


def visible_public_doors(state, vision_tokens=None, line_of_sight_tokens=None):
    """Return ordinary doors that are actually visible to this audience.

    The full blocker map remains GM-only. A player gets a door segment only after
    an approved viewpoint can reach part of that door. A candidate closed door is
    removed from its own LOS test so the player can see the near face of the door.
    Darkness adds the configured vision-radius test; normal lighting has unlimited
    range but still respects every other wall and closed door.
    """
    dark = state["vtt"].get("dark_environment", False)
    sources = list((vision_tokens if dark else line_of_sight_tokens) or [])
    if not sources:
        return []

    aspect = map_height_to_width_ratio(state)
    grid_fraction = max(0.01, float(state["grid"].get("size", 0.05)))
    active_blockers = active_vision_blockers(state)
    visible = []

    # A few points along the segment handle a door that is only partly reachable
    # without exposing unrelated door or wall geometry.
    sample_positions = (0.0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0)
    for door in state["vtt"].get("vision_blockers", []):
        if door.get("type") != "door" or not door.get("visible_to_players", True):
            continue
        other_blockers = [
            blocker for blocker in active_blockers if blocker.get("id") != door.get("id")
        ]
        door_visible = False
        for source in sources:
            radius = None
            if dark:
                radius = grid_fraction * (
                    float(source.get("vision_radius_feet", 60.0)) / FEET_PER_GRID_SQUARE
                )
            sx = float(source.get("x", 0.5))
            sy = float(source.get("y", 0.5))
            for position in sample_positions:
                x = float(door["x1"]) + (float(door["x2"]) - float(door["x1"])) * position
                y = float(door["y1"]) + (float(door["y2"]) - float(door["y1"])) * position
                if radius is not None:
                    dx = x - sx
                    dy = (y - sy) * aspect
                    if dx * dx + dy * dy > radius * radius:
                        continue
                if not other_blockers or _line_of_sight_clear(
                    sx, sy, x, y, other_blockers, aspect
                ):
                    door_visible = True
                    break
            if door_visible:
                break
        if door_visible:
            visible.append({
                "x1": door["x1"],
                "y1": door["y1"],
                "x2": door["x2"],
                "y2": door["y2"],
                "open": bool(door.get("open", False)),
            })
    return visible


def public_area(area):
    return {
        "id": area["id"],
        "color": area["color"],
        "shape": area.get("shape", "circle"),
        "x": area["x"],
        "y": area["y"],
        "diameter": area.get("diameter", 0.20),
        "length_squares": area.get("length_squares", 6.0),
        "width_squares": area.get("width_squares", 1.0),
        "angle": area.get("angle", 60.0),
        "rotation": area.get("rotation", 0.0),
    }


def find_area_by_id(state, area_id):
    return next((area for area in state["vtt"]["areas"] if area["id"] == area_id), None)


def find_token_by_id(state, token_id):
    return next((token for token in state["vtt"]["tokens"] if token["id"] == token_id), None)


def find_player_by_key(state, player_key):
    key = normalize_player_key(player_key)
    return next(
        (
            token
            for token in state["vtt"]["tokens"]
            if token.get("player_controlled") and token.get("player_key") == key
        ),
        None,
    )


def player_tokens(state, exclude_token_id=None):
    tokens = [
        token
        for token in state["vtt"]["tokens"]
        if token.get("player_controlled") and token.get("player_key")
    ]
    if exclude_token_id:
        tokens = [token for token in tokens if token["id"] != exclude_token_id]
    return tokens


# ---- Player control and initiative ---------------------------------------
# Delegation is stored by controller token ID instead of player name so renaming a
# character does not break control of familiars, summons, or other NPCs.
def movable_token_ids_for_player(state, player_token):
    if not player_token:
        return set()
    player_id = player_token.get("id")
    return {
        token["id"]
        for token in state["vtt"]["tokens"]
        if token.get("visible", True)
        and (
            (token.get("player_controlled") and token.get("id") == player_id)
            or (not token.get("player_controlled") and token.get("moved_by_token_id") == player_id)
        )
    }


def ordered_initiative_tokens(state):
    """Return turn-eligible tokens in deterministic initiative order."""
    tokens = [
        token for token in state["vtt"]["tokens"]
        if token.get("initiative") is not None
    ]
    return sorted(
        tokens,
        key=lambda token: (
            -int(token.get("initiative")),
            str(token.get("name") or "").casefold(),
            str(token.get("id") or ""),
        ),
    )


# Initiative enforcement is a server-side permission, not merely a disabled
# drag handle. This keeps direct API calls subject to the same turn rules.
def active_delegated_npc_for_player(state, player_token):
    """Return the delegated NPC whose current initiative belongs to this player.

    The initiative pointer is useful even when movement enforcement is off. The active
    delegated NPC is therefore shown to its controller whenever that NPC is the current
    turn. This is only a token-visibility exception; it does not illuminate the map
    unless shared vision is separately enabled for that NPC.
    """
    if not player_token:
        return None
    active_id = state["vtt"].get("active_initiative_token_id")
    active = find_token_by_id(state, active_id) if active_id else None
    if (
        active
        and active.get("initiative") is not None
        and not active.get("player_controlled")
        and active.get("moved_by_token_id") == player_token.get("id")
    ):
        return active
    return None


def initiative_movable_token_ids_for_player(state, player_token):
    """Apply initiative turn enforcement to the player's normal movement grants."""
    base_ids = movable_token_ids_for_player(state, player_token)
    if not state["vtt"].get("initiative_enforced", False):
        return base_ids
    if not player_token:
        return set()

    active_id = state["vtt"].get("active_initiative_token_id")
    active = find_token_by_id(state, active_id) if active_id else None
    if not active or active.get("initiative") is None:
        return set()

    player_id = player_token.get("id")
    if active.get("id") == player_id:
        # On the player's own turn, their character and all delegated NPCs may move.
        return base_ids
    if (
        not active.get("player_controlled")
        and active.get("moved_by_token_id") == player_id
    ):
        # On a delegated NPC's turn, only that NPC may move.
        return {active["id"]} & base_ids
    return set()


def ensure_active_initiative_token(state):
    """Ensure enforcement has a valid active token; choose the highest initiative if needed."""
    ordered = ordered_initiative_tokens(state)
    if not ordered:
        state["vtt"]["active_initiative_token_id"] = None
        return None
    valid_ids = {token["id"] for token in ordered}
    current_id = state["vtt"].get("active_initiative_token_id")
    if current_id not in valid_ids:
        current_id = ordered[0]["id"]
        state["vtt"]["active_initiative_token_id"] = current_id
    return current_id


def public_current_initiative(state, visible_token_ids):
    """Return privacy-safe active-turn information for player/viewer pages."""
    if not state["vtt"].get("initiative_enforced", False):
        return None
    active_id = state["vtt"].get("active_initiative_token_id")
    active = find_token_by_id(state, active_id) if active_id else None
    if not active or active.get("initiative") is None:
        return None
    if active["id"] not in visible_token_ids:
        return {"visible": False}
    return {
        "visible": True,
        "token_name": active.get("name") or "Token",
        "initiative": int(active["initiative"]),
    }


def validate_moved_by_token_id(state, moved_by_token_id, exclude_token_id=None):
    value = str(moved_by_token_id or "").strip() or None
    if value is None:
        return None
    player = next(
        (token for token in player_tokens(state, exclude_token_id=exclude_token_id) if token["id"] == value),
        None,
    )
    if not player:
        raise ValueError("Choose a valid player token for delegated movement.")
    return value


def unique_player_key(state, player_name, exclude_token_id=None):
    """Build the internal /vtt player key from the token name."""
    base = normalize_player_key(player_name) or "player"
    used = {
        token.get("player_key")
        for token in state["vtt"]["tokens"]
        if token.get("player_controlled") and token["id"] != exclude_token_id
    }
    if base not in used:
        return base
    suffix = 2
    while f"{base}-{suffix}" in used:
        suffix += 1
    return f"{base}-{suffix}"


# ---- Player-session helpers ----------------------------------------------
def session_vtt_token(state):
    vtt = state["vtt"]
    if not vtt.get("password_hash") or not session.get("vtt_authenticated"):
        return None
    if session.get("vtt_game_slug") != current_game_slug():
        return None
    if session.get("vtt_password_version") != vtt.get("password_version"):
        return None
    token = find_token_by_id(state, session.get("vtt_token_id", ""))
    if not token or not token.get("player_controlled"):
        return None
    if token.get("player_key") != session.get("vtt_player_key"):
        return None
    return token


def vtt_json_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        state = load_state()
        token = session_vtt_token(state)
        if not token:
            return jsonify(error="VTT authentication is required."), 401
        return fn(state, token, *args, **kwargs)

    return wrapped


# ---- Page routes ----------------------------------------------------------
# Common response headers apply to both HTML pages and JSON endpoints. Nginx adds
# the corresponding HTTPS-facing headers as well.
@app.after_request
def headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


@app.get("/")
def home():
    return render_template("home.html")


@app.get("/viewer")
def viewer():
    if not request.environ.get("VTT_GAME_SLUG"):
        return render_template(
            "session_select.html",
            mode="viewer",
            sessions=available_public_sessions(),
        )
    return render_template("viewer.html")


@app.route("/feature-request", methods=["GET", "POST"])
def feature_request():
    error = None
    success = bool(session.pop("_feature_request_submitted", False))
    name = ""
    request_text = ""

    if request.method == "POST":
        check_csrf()
        if request.content_length and request.content_length > 16 * 1024:
            abort(413)

        name = str(request.form.get("name") or "").strip()
        request_text = str(request.form.get("request_text") or "").strip()
        answer = str(request.form.get("math_answer") or "").strip()

        if len(name) > FEATURE_REQUEST_NAME_MAX_CHARS:
            error = f"Name must be {FEATURE_REQUEST_NAME_MAX_CHARS} characters or fewer."
        elif not request_text:
            error = "Enter a feature request."
        elif len(request_text) > FEATURE_REQUEST_MAX_CHARS:
            error = f"Feature request must be {FEATURE_REQUEST_MAX_CHARS} characters or fewer."
        else:
            challenge = feature_request_challenge()
            session.pop("_feature_request_math", None)
            try:
                correct = int(answer) == challenge["left"] + challenge["right"]
            except (TypeError, ValueError):
                correct = False

            if not correct:
                error = "The math answer was incorrect. Try the new question below."
            else:
                try:
                    append_feature_request(name, request_text)
                except OSError:
                    app.logger.exception("Could not write feature request")
                    error = "The request could not be saved. Please try again."
                else:
                    session["_feature_request_submitted"] = True
                    return redirect(url_for("feature_request"))

    challenge = feature_request_challenge(force_new=bool(error and request.method == "POST"))
    return render_template(
        "feature_request.html",
        error=error,
        success=success,
        name=name,
        request_text=request_text,
        math_left=challenge["left"],
        math_right=challenge["right"],
        max_request_chars=FEATURE_REQUEST_MAX_CHARS,
        max_name_chars=FEATURE_REQUEST_NAME_MAX_CHARS,
    )


@app.get("/feature-requests")
def feature_requests():
    return render_template(
        "feature_requests.html",
        feature_requests=read_feature_requests(),
    )


@app.route("/player", methods=["GET", "POST"])
def player_portal():
    if not request.environ.get("VTT_GAME_SLUG"):
        if request.method != "GET":
            return redirect(url_for("player_portal"))
        return render_template(
            "session_select.html",
            mode="player",
            sessions=available_public_sessions(),
        )

    state = load_state()
    players = sorted(
        player_tokens(state),
        key=lambda token: str(token.get("name") or "").casefold(),
    )
    error = None

    if request.method == "POST":
        check_csrf()
        player_key = normalize_player_key(request.form.get("player"))
        player = find_player_by_key(state, player_key)
        if not player:
            error = "Choose a player token."
        elif not state["vtt"].get("password_hash"):
            error = "Player VTT access has not been enabled by the GM."
        else:
            ip = client_ip()
            if is_limited("vtt", ip):
                error = "Too many failed attempts. Try again later."
            elif check_password_hash(state["vtt"]["password_hash"], request.form.get("password", "")):
                clear_failures("vtt", ip)
                for key in (
                    "vtt_authenticated",
                    "vtt_token_id",
                    "vtt_player_key",
                    "vtt_password_version",
                    "vtt_game_slug",
                ):
                    session.pop(key, None)
                session["vtt_authenticated"] = True
                session["vtt_token_id"] = player["id"]
                session["vtt_player_key"] = player["player_key"]
                session["vtt_password_version"] = state["vtt"]["password_version"]
                session["vtt_game_slug"] = current_game_slug()
                session.permanent = True
                session["_csrf_token"] = secrets.token_urlsafe(32)
                log_player_connection(player, ip=ip)
                return redirect(url_for("vtt", player=player["player_key"]))
            else:
                fail_login("vtt", ip)
                error = "Incorrect game password."

    return render_template(
        "player.html",
        players=players,
        error=error,
        vtt_enabled=bool(state["vtt"].get("password_hash")),
    )


@app.get("/edit")
@editor_required
def edit():
    return render_template(
        "edit.html",
        csrf=csrf_token(),
        max_mb=MAX_UPLOAD_BYTES // 1048576,
        max_maps=MAX_MAPS,
        gm_user=current_game_slug(),
        public_prefix=game_public_prefix(),
        app_version=APP_VERSION,
    )


@app.get("/edit/wallmap")
@editor_required
def wallmap():
    state = load_state()
    requested = str(request.args.get("map") or state.get("active_map_id") or "").strip()
    record = find_map_by_id(state, requested)
    if not record:
        abort(404)
    return render_template("wallmap.html", csrf=csrf_token(), map_id=record["id"], map_name=record["name"])


@app.get("/edit/map-image/<map_id>")
@editor_required
def editor_map_image(map_id):
    state = load_state()
    view = map_view_state(state, map_id)
    if not view:
        abort(404)
    path = image_path(view)
    if not path:
        abort(404)
    return send_file(
        path,
        mimetype=view.get("mime_type") or "application/octet-stream",
        conditional=True,
        etag=False,
        max_age=0,
    )


@app.get("/help/admin")
@editor_required
def admin_help():
    return render_template("help_admin.html", gm_user=current_game_slug(), public_prefix=game_public_prefix())


@app.get("/help/player")
def player_help():
    return render_template("help_player.html")


@app.get("/login")
def login():
    if request.environ.get("VTT_GAME_SLUG"):
        abort(404)
    next_path = normalized_editor_next(request.args.get("next"))
    if current_editor_user() and request.args.get("switch") != "1":
        return redirect(next_path)
    return render_template(
        "login.html",
        csrf=csrf_token(),
        next_path=next_path,
        switched=request.args.get("switched") == "1",
    )


@app.post("/auth/gm/check")
def gm_auth_check():
    # Only the dedicated Nginx auth location may set these headers. Every other
    # Nginx location overwrites them with empty values.
    if request.environ.get("VTT_GAME_SLUG"):
        abort(404)
    if request.headers.get("X-RPG-GM-Auth") != "validated":
        abort(403)
    gm_user = normalize_game_slug(request.headers.get("X-RPG-GM-User"))
    if not gm_user:
        return jsonify(error="GM authentication failed."), 401
    if not (GAMES_DIR / gm_user).is_dir():
        return jsonify(error="This GM account does not have a game session directory."), 403
    ticket = gm_login_serializer.dumps({"user": gm_user, "revision": gm_auth_revision(gm_user), "nonce": secrets.token_urlsafe(16)})
    return jsonify(status="ok", user=gm_user, ticket=ticket)


@app.post("/auth/gm/session")
def gm_auth_session():
    if request.environ.get("VTT_GAME_SLUG"):
        abort(404)
    check_csrf()
    payload = request.get_json(silent=True) or {}
    ticket = str(payload.get("ticket") or "").strip()
    try:
        authenticated = gm_login_serializer.loads(ticket, max_age=GM_LOGIN_TICKET_MAX_AGE)
    except SignatureExpired:
        return jsonify(error="The login check expired. Enter your password again."), 401
    except BadSignature:
        return jsonify(error="The login check was invalid. Enter your password again."), 401

    gm_user = normalize_game_slug(authenticated.get("user")) if isinstance(authenticated, dict) else None
    ticket_revision = str(authenticated.get("revision") or "") if isinstance(authenticated, dict) else ""
    if not gm_user or not (GAMES_DIR / gm_user).is_dir():
        return jsonify(error="This GM session is no longer available."), 403
    current_revision = gm_auth_revision(gm_user)
    if not ticket_revision or not hmac.compare_digest(ticket_revision, current_revision):
        return jsonify(error="The GM account changed during login. Enter your password again."), 401

    next_path = normalized_editor_next(payload.get("next"))
    session.clear()
    session["editor_authenticated"] = True
    session["editor_user"] = gm_user
    session["editor_auth_revision"] = current_revision
    session.permanent = True
    session["_csrf_token"] = secrets.token_urlsafe(32)
    return jsonify(status="ok", user=gm_user, next=next_path)


@app.post("/logout")
@editor_required
def logout():
    check_csrf()
    session.clear()
    return redirect(url_for("login", next="/edit", switched="1"))


@app.route("/vtt", methods=["GET", "POST"])
def vtt():
    if not request.environ.get("VTT_GAME_SLUG"):
        return redirect(url_for("player_portal"))
    player_key = normalize_player_key(request.args.get("player") or request.form.get("player"))
    if not player_key:
        return redirect(url_for("player_portal"))
    state = load_state()
    player = find_player_by_key(state, player_key)
    if not player:
        return render_template("vtt_login.html", player_key=player_key, error="Player not found."), 404
    if not state["vtt"].get("password_hash"):
        return render_template(
            "vtt_login.html",
            player_key=player_key,
            player_name=player["name"],
            error="Player VTT access has not been enabled by the GM.",
        ), 403

    authenticated_player = session_vtt_token(state)
    if authenticated_player and authenticated_player["id"] == player["id"]:
        return render_template(
            "vtt.html",
            csrf=csrf_token(),
            player_name=player["name"],
            player_key=player_key,
        )

    error = None
    if request.method == "POST":
        check_csrf()
        ip = client_ip()
        if is_limited("vtt", ip):
            return render_template(
                "vtt_login.html",
                player_key=player_key,
                player_name=player["name"],
                error="Too many failed attempts. Try again later.",
            ), 429
        if check_password_hash(state["vtt"]["password_hash"], request.form.get("password", "")):
            clear_failures("vtt", ip)
            for key in (
                "vtt_authenticated",
                "vtt_token_id",
                "vtt_player_key",
                "vtt_password_version",
                "vtt_game_slug",
            ):
                session.pop(key, None)
            session["vtt_authenticated"] = True
            session["vtt_token_id"] = player["id"]
            session["vtt_player_key"] = player["player_key"]
            session["vtt_password_version"] = state["vtt"]["password_version"]
            session["vtt_game_slug"] = current_game_slug()
            session.permanent = True
            session["_csrf_token"] = secrets.token_urlsafe(32)
            log_player_connection(player, ip=ip)
            return redirect(url_for("vtt", player=player["player_key"]))
        fail_login("vtt", ip)
        error = "Incorrect game password."

    return render_template(
        "vtt_login.html",
        player_key=player_key,
        player_name=player["name"],
        error=error,
    )


@app.post("/vtt/logout")
def vtt_logout():
    check_csrf()
    player_key = session.get("vtt_player_key")
    for key in (
        "vtt_authenticated",
        "vtt_token_id",
        "vtt_player_key",
        "vtt_password_version",
        "vtt_game_slug",
    ):
        session.pop(key, None)
    return redirect(url_for("player_portal"))


# ---- Read-only JSON state -------------------------------------------------
# Each endpoint returns only what its audience should know. The viewer gets party
# vision; an authenticated player gets that player's applicable visibility and
# movement permissions; the editor gets the complete GM state.
@app.get("/api/state")
def api_state():
    state = load_state()
    player_vision = viewer_player_vision_tokens(state)
    player_line_of_sight = party_line_of_sight_tokens(state)
    npc_reveals = revealed_npc_tokens(state)
    public_tokens = visible_public_tokens(
        state,
        player_vision_tokens=player_vision,
        line_of_sight_tokens=player_line_of_sight,
    )
    visible_token_ids = {token["id"] for token in public_tokens}
    runtime = current_runtime()
    with runtime.condition:
        version = runtime.version
    return jsonify(
        has_image=bool(image_path(state)),
        zoom=state["zoom"],
        background=state["background"],
        grid_enabled=state["grid"]["enabled"],
        grid_size=state["grid"]["size"],
        grid_color=state["grid"]["color"],
        grid_opacity=state["grid"].get("opacity", 1.0),
        image_version=f"{state.get('version', 0)}-{state.get('active_map_id') or 'map'}",
        image_url=url_for("current_image"),
        token_size=state["vtt"]["token_size"],
        mobile_token_size=state["vtt"]["mobile_token_size"],
        door_color=state["vtt"].get("door_color", "#ffd54d"),
        door_opacity=state["vtt"].get("door_opacity", 0.72),
        tokens_visible=state["vtt"]["tokens_visible"],
        dark_environment=state["vtt"]["dark_environment"],
        terrain_occlusion=bool(active_vision_blockers(state)) or not bool(player_line_of_sight),
        persistent_explored_fog=state["vtt"].get("persistent_explored_fog", False),
        explored_mask_png=viewer_explored_mask(state),
        vision_sources=(
            public_vision_sources(state, player_vision)
            + [public_npc_reveal_source(token) for token in npc_reveals]
        ),
        line_of_sight_sources=public_line_of_sight_sources(state, player_line_of_sight),
        tokens=public_tokens,
        areas=visible_public_areas(
            state,
            vision_tokens=player_vision,
            line_of_sight_tokens=player_line_of_sight,
        ),
        visible_doors=visible_public_doors(
            state,
            vision_tokens=player_vision,
            line_of_sight_tokens=player_line_of_sight,
        ),
        initiative_enforced=state["vtt"].get("initiative_enforced", False),
        current_initiative=public_current_initiative(state, visible_token_ids),
        recent_moves=recent_move_events(state, visible_token_ids),
        version=version,
    )


@app.get("/api/editor-state")
@editor_required
def editor_state():
    state = load_state()
    explicit_map_id = str(request.args.get("map_id") or "").strip()
    requested_map_id = explicit_map_id or str(state.get("active_map_id") or "").strip()
    if requested_map_id:
        view = map_view_state(state, requested_map_id)
        if not view:
            return jsonify(error="Map not found."), 404
        record = find_map_by_id(state, requested_map_id)
        is_active = requested_map_id == state.get("active_map_id")
    else:
        # The editor remains usable when no map is active.
        view = copy.deepcopy(state)
        record = None
        is_active = False
    editor_tokens = view["vtt"]["tokens"] if not requested_map_id or is_active else []
    editor_areas = view["vtt"]["areas"] if not requested_map_id or is_active else []
    player_activity = recent_player_activity()
    vision_sources = []
    if is_active:
        vision_sources = (
            public_vision_sources(view, party_vision_tokens(view))
            + [public_npc_reveal_source(token) for token in revealed_npc_tokens(view)]
        )
    return jsonify(
        game_slug=current_game_slug(),
        public_prefix=game_public_prefix(),
        has_image=bool(image_path(view)),
        zoom=view["zoom"],
        background=view["background"],
        grid_enabled=view["grid"]["enabled"],
        grid_size=view["grid"]["size"],
        grid_color=view["grid"]["color"],
        grid_opacity=view["grid"].get("opacity", 1.0),
        image_version=f"{view.get('version', 0)}-{requested_map_id}",
        image_url=(url_for("editor_map_image", map_id=requested_map_id) if requested_map_id else None),
        original_filename=view.get("original_filename"),
        map_id=requested_map_id,
        map_name=(record or {}).get("name") or "Map",
        map_is_active=is_active,
        active_map_id=state.get("active_map_id"),
        maps=[map_public_metadata(item, state.get("active_map_id")) for item in state.get("maps", [])],
        max_maps=MAX_MAPS,
        token_size=view["vtt"]["token_size"],
        mobile_token_size=view["vtt"]["mobile_token_size"],
        door_color=view["vtt"].get("door_color", "#ffd54d"),
        door_opacity=view["vtt"].get("door_opacity", 0.72),
        tokens_visible=view["vtt"]["tokens_visible"],
        movement_enabled=view["vtt"]["movement_enabled"],
        initiative_enforced=view["vtt"].get("initiative_enforced", False),
        active_initiative_token_id=view["vtt"].get("active_initiative_token_id"),
        dark_environment=(view["vtt"]["dark_environment"] if is_active else False),
        stack_player_vision=view["vtt"]["stack_player_vision"],
        persistent_explored_fog=view["vtt"].get("persistent_explored_fog", False),
        vtt_password_set=bool(view["vtt"].get("password_hash")),
        tokens=editor_tokens,
        areas=editor_areas,
        vision_blockers=view["vtt"].get("vision_blockers", []),
        vision_sources=vision_sources,
        player_connections=player_activity["connections"],
        player_moves=player_activity["moves"],
    )


@app.get("/api/vtt-state")
@vtt_json_required
def vtt_state(state, player):
    permitted_movable_ids = initiative_movable_token_ids_for_player(state, player)
    player_vision = player_vision_tokens_for_player(state, player)
    player_line_of_sight = player_line_of_sight_tokens_for_player(state, player)
    npc_reveals = revealed_npc_tokens(state)

    # A delegated NPC must be usable on its own initiative turn even if it is
    # standing outside the controller's normal sight. Force only that token into
    # this player's payload; it does not become a vision source unless the GM has
    # separately enabled shared vision for the NPC.
    always_include_ids = {player["id"]}
    active_delegated_npc = active_delegated_npc_for_player(state, player)
    if active_delegated_npc:
        always_include_ids.add(active_delegated_npc["id"])

    public_tokens = visible_public_tokens(
        state,
        player_vision_tokens=player_vision,
        line_of_sight_tokens=player_line_of_sight,
        always_include_ids=always_include_ids,
    )
    visible_token_ids = {token["id"] for token in public_tokens}
    movable_ids = sorted(permitted_movable_ids & visible_token_ids)
    return jsonify(
        has_image=bool(image_path(state)),
        zoom=state["zoom"],
        background=state["background"],
        grid_enabled=state["grid"]["enabled"],
        grid_size=state["grid"]["size"],
        grid_color=state["grid"]["color"],
        grid_opacity=state["grid"].get("opacity", 1.0),
        image_version=f"{state.get('version', 0)}-{state.get('active_map_id') or 'map'}",
        image_url=url_for("current_image"),
        token_size=state["vtt"]["token_size"],
        mobile_token_size=state["vtt"]["mobile_token_size"],
        door_color=state["vtt"].get("door_color", "#ffd54d"),
        door_opacity=state["vtt"].get("door_opacity", 0.72),
        tokens_visible=state["vtt"]["tokens_visible"],
        movement_enabled=state["vtt"]["movement_enabled"],
        initiative_enforced=state["vtt"].get("initiative_enforced", False),
        dark_environment=state["vtt"]["dark_environment"],
        terrain_occlusion=bool(active_vision_blockers(state)) or not bool(player_line_of_sight),
        stack_player_vision=state["vtt"]["stack_player_vision"],
        persistent_explored_fog=state["vtt"].get("persistent_explored_fog", False),
        explored_mask_png=player_explored_mask(state, player),
        vision_sources=(
            public_vision_sources(state, player_vision)
            + [public_npc_reveal_source(token) for token in npc_reveals]
        ),
        line_of_sight_sources=public_line_of_sight_sources(state, player_line_of_sight),
        own_token_id=player["id"],
        own_token_visible=bool(player.get("visible", True)),
        movable_token_ids=movable_ids,
        player_name=player["name"],
        # The player's own character remains available even with no vision so the
        # player cannot strand themselves. Delegated NPCs obey normal LOS/darkness
        # rules except for the active initiative token explicitly forced above.
        tokens=public_tokens,
        areas=visible_public_areas(
            state,
            vision_tokens=player_vision,
            line_of_sight_tokens=player_line_of_sight,
        ),
        visible_doors=visible_public_doors(
            state,
            vision_tokens=player_vision,
            line_of_sight_tokens=player_line_of_sight,
        ),
        current_initiative=public_current_initiative(state, visible_token_ids),
        recent_moves=recent_move_events(state, visible_token_ids),
    )


@app.get("/current-image")
def current_image():
    state = load_state()
    path = image_path(state)
    if not path:
        abort(404)
    return send_file(
        path,
        mimetype=state.get("mime_type") or "application/octet-stream",
        conditional=True,
        etag=False,
        max_age=0,
    )


# ---- GM mutation endpoints -----------------------------------------------
# Every GM write goes through editor_required and CSRF validation. State-changing
# helpers take state_lock so two browsers cannot interleave JSON writes.
@app.post("/edit/api/maps")
@editor_required
def add_map_to_library():
    check_csrf()
    uploaded = request.files.get("image")
    if not uploaded:
        return jsonify(error="Select an image file."), 400
    raw = uploaded.read(MAX_UPLOAD_BYTES + 1)
    requested_name = str(request.form.get("name") or "").strip()[:MAP_NAME_MAX_CHARS]

    # A fresh installation may have no maps at all. The first upload becomes
    # active; later uploads are added as inactive prep maps so the table never
    # changes unexpectedly. The legacy empty-slot branch remains useful when an
    # older state already contains a blank active map record.
    with current_runtime().lock:
        state = _load_state_unlocked()
        maps = state.get("maps", [])
        active_record = find_map_by_id(state, state.get("active_map_id"))
        fill_initial_slot = bool(
            len(maps) == 1
            and active_record
            and not active_record.get("stored_filename")
            and not active_record.get("vision_blockers")
        )
        if not fill_initial_slot and len(maps) >= MAX_MAPS:
            return jsonify(error=f"The map library is limited to {MAX_MAPS} maps."), 400
        activate_new_map = not state.get("active_map_id") and not maps
        map_id = active_record["id"] if fill_initial_slot else secrets.token_hex(8)

    try:
        filename, mime = store_map_upload(raw, map_id)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    with current_runtime().lock:
        state = _load_state_unlocked()
        map_name = requested_name or default_map_name(uploaded.filename)
        existing = find_map_by_id(state, map_id)
        if existing and map_id == state.get("active_map_id") and not existing.get("stored_filename"):
            record = existing
            record.clear()
            record.update(blank_map_record(map_id, map_name))
        else:
            if len(state.get("maps", [])) >= MAX_MAPS:
                staged = blank_map_record(map_id)
                staged["stored_filename"] = filename
                remove_map_storage(staged)
                return jsonify(error=f"The map library is limited to {MAX_MAPS} maps."), 400
            record = blank_map_record(map_id, map_name)
            state.setdefault("maps", []).append(record)
        record.update(
            has_image=True,
            stored_filename=filename,
            mime_type=mime,
            original_filename=uploaded.filename or "uploaded-image",
            version=int(time.time() * 1000),
        )
        normalized = normalize_map_record(record, fallback_id=map_id, fallback_name=map_name)
        record.clear()
        record.update(normalized)
        if activate_new_map:
            state["active_map_id"] = map_id
            apply_map_record_to_active_state(state, record)
        elif map_id == state.get("active_map_id"):
            apply_map_record_to_active_state(state, record)
        _write_state_unlocked(state)
    return jsonify(status="ok", map=map_public_metadata(record, state.get("active_map_id")))


@app.post("/edit/api/maps/<map_id>")
@editor_required
def rename_map(map_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()[:MAP_NAME_MAX_CHARS]
    if not name:
        return jsonify(error="Enter a map name."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        record = find_map_by_id(state, map_id)
        if not record:
            return jsonify(error="Map not found."), 404
        record["name"] = name
        _write_state_unlocked(state)
    return jsonify(status="ok", name=name)


@app.post("/edit/api/maps/<map_id>/activate")
@editor_required
def activate_map(map_id):
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        record = find_map_by_id(state, map_id)
        if not record:
            return jsonify(error="Map not found."), 404
        if state.get("active_map_id") != map_id:
            sync_active_map_from_state(state)
            state["active_map_id"] = map_id
            apply_map_record_to_active_state(state, record)
            _write_state_unlocked(state)
    return jsonify(status="ok", active_map_id=map_id, name=record.get("name") or "Map")


@app.post("/edit/api/maps/<map_id>/reset")
@editor_required
def reset_map_encounter(map_id):
    """Reset transient encounter visibility/fog for one map, preserving prep geometry."""
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        record = find_map_by_id(state, map_id)
        if not record:
            return jsonify(error="Map not found."), 404

        token_ids = [token["id"] for token in state["vtt"].get("tokens", [])]
        area_ids = [area["id"] for area in state["vtt"].get("areas", [])]
        record["explored_masks"] = {}
        record["token_visibility"] = {token_id: False for token_id in token_ids}
        record["area_visibility"] = {area_id: False for area_id in area_ids}

        if state.get("active_map_id") == map_id:
            state["explored_masks"] = {}
            for token in state["vtt"].get("tokens", []):
                token["visible"] = False
            state["vtt"]["tokens_visible"] = False if token_ids else True
            for area in state["vtt"].get("areas", []):
                area["visible"] = False

        _write_state_unlocked(state)

    # Cached LOS polygons contain no visibility state, but clearing this small
    # derived cache ensures a reset begins from a completely fresh sight pass.
    with vision_polygon_cache_lock:
        vision_polygon_cache.clear()
    return jsonify(
        status="ok",
        map_id=map_id,
        hidden_tokens=len(token_ids),
        hidden_areas=len(area_ids),
    )


@app.delete("/edit/api/maps/<map_id>")
@editor_required
def delete_map_from_library(map_id):
    check_csrf()
    removed = None
    with current_runtime().lock:
        state = _load_state_unlocked()
        record = find_map_by_id(state, map_id)
        if not record:
            return jsonify(error="Map not found."), 404
        removed = copy.deepcopy(record)
        deleting_active = state.get("active_map_id") == map_id
        state["maps"] = [item for item in state.get("maps", []) if item.get("id") != map_id]
        if deleting_active:
            state["active_map_id"] = None
            clear_active_map_from_state(state)
        _write_state_unlocked(state)
    remove_map_storage(removed)
    return jsonify(status="ok")


@app.post("/api/upload")
@editor_required
def upload():
    check_csrf()
    uploaded = request.files.get("image")
    if not uploaded:
        return jsonify(error="Select an image file."), 400
    raw = uploaded.read(MAX_UPLOAD_BYTES + 1)
    with current_runtime().lock:
        state = _load_state_unlocked()
        active_map_id = state.get("active_map_id")
        if not active_map_id:
            active_map_id = secrets.token_hex(8)
            state.setdefault("maps", []).append(blank_map_record(active_map_id, default_map_name(uploaded.filename)))
            state["active_map_id"] = active_map_id
            apply_map_record_to_active_state(state, state["maps"][-1])
            _write_state_unlocked(state)
    try:
        filename, mime = store_upload(raw, active_map_id)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        state.update(
            has_image=True,
            stored_filename=filename,
            mime_type=mime,
            original_filename=uploaded.filename or "uploaded-image",
            zoom=1.0,
            version=int(time.time() * 1000),
        )
        state["explored_masks"] = {}
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/settings")
@editor_required
def settings():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    with current_runtime().lock:
        state = _load_state_unlocked()
        requested_map_id = str(payload.get("map_id") or state.get("active_map_id") or "").strip()
        record = find_map_by_id(state, requested_map_id)
        if not record:
            return jsonify(error="No map is selected for display settings."), 400
        is_active = requested_map_id == state.get("active_map_id")
        current = state if is_active else record
        current_grid = current.get("grid") or blank_map_record()["grid"]
        try:
            zoom = clamp(float(payload.get("zoom", current.get("zoom", 1.0))), 0.1, 5.0)
        except Exception:
            return jsonify(error="Invalid zoom value."), 400
        background = payload.get("background", current.get("background", "#000000"))
        if background not in ALLOWED_BACKGROUNDS:
            return jsonify(error="Invalid background selection."), 400
        try:
            grid_size = clamp(float(payload.get("grid_size", current_grid.get("size", 0.05))), 0.01, 0.15)
        except Exception:
            return jsonify(error="Invalid grid square size."), 400
        grid_color = str(payload.get("grid_color", current_grid.get("color", "#ffffff")) or "").lower()
        if not COLOR_RE.fullmatch(grid_color):
            return jsonify(error="Invalid grid color."), 400
        try:
            grid_opacity = clamp(float(payload.get("grid_opacity", current_grid.get("opacity", 1.0))), 0.10, 1.0)
        except Exception:
            return jsonify(error="Invalid grid opacity."), 400
        grid_enabled = bool(payload.get("grid_enabled", current_grid.get("enabled", True)))

        # The map id travels with the save so a delayed browser autosave cannot
        # accidentally write one map's grid settings into a newly activated map.
        if is_active:
            state["zoom"] = zoom
            state["background"] = background
            state["grid"]["enabled"] = grid_enabled
            state["grid"]["size"] = grid_size
            state["grid"]["color"] = grid_color
            state["grid"]["opacity"] = grid_opacity
        else:
            record["zoom"] = zoom
            record["background"] = background
            record.setdefault("grid", {})
            record["grid"].update(
                enabled=grid_enabled,
                size=grid_size,
                color=grid_color,
                opacity=grid_opacity,
            )
        _write_state_unlocked(state)
    return jsonify(status="ok", map_id=requested_map_id)


@app.post("/api/clear")
@editor_required
def clear():
    check_csrf()
    old_record = None
    with current_runtime().lock:
        state = _load_state_unlocked()
        old_record = copy.deepcopy(find_map_by_id(state, state.get("active_map_id")) or {})
        state.update(
            has_image=False,
            stored_filename=None,
            mime_type=None,
            original_filename=None,
            zoom=1.0,
            version=int(time.time() * 1000),
        )
        state["explored_masks"] = {}
        _write_state_unlocked(state)
    if old_record:
        remove_map_storage(old_record)
    return jsonify(status="ok")


@app.post("/api/vtt/settings")
@editor_required
def vtt_settings():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    try:
        token_size = clamp(float(payload.get("token_size")), 0.01, 0.20)
        mobile_token_size = clamp(float(payload.get("mobile_token_size", token_size)), 0.01, 0.20)
    except Exception:
        return jsonify(error="Invalid token size."), 400
    movement_enabled = bool(payload.get("movement_enabled", True))
    dark_environment = bool(payload.get("dark_environment", False))
    stack_player_vision = bool(payload.get("stack_player_vision", False))
    persistent_explored_fog = bool(payload.get("persistent_explored_fog", False))
    with current_runtime().lock:
        state = _load_state_unlocked()
        state["vtt"]["token_size"] = token_size
        state["vtt"]["mobile_token_size"] = mobile_token_size
        state["vtt"]["movement_enabled"] = movement_enabled
        state["vtt"]["dark_environment"] = dark_environment
        state["vtt"]["stack_player_vision"] = stack_player_vision
        old_persistent_fog = state["vtt"].get("persistent_explored_fog", False)
        state["vtt"]["persistent_explored_fog"] = persistent_explored_fog
        # Turning persistent fog off starts a fresh exploration history.
        if old_persistent_fog and not persistent_explored_fog:
            state["explored_masks"] = {}
            for record in state.get("maps", []):
                record["explored_masks"] = {}
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/tokens/visibility-all")
@editor_required
def set_all_token_visibility():
    """Make Show all tokens a real select-all control over per-token visibility."""
    check_csrf()
    payload = request.get_json(silent=True) or {}
    visible = bool(payload.get("visible", True))
    changed = 0
    with current_runtime().lock:
        state = _load_state_unlocked()
        for token in state["vtt"].get("tokens", []):
            if bool(token.get("visible", True)) != visible:
                token["visible"] = visible
                changed += 1
        state["vtt"]["tokens_visible"] = all(
            token.get("visible", True) for token in state["vtt"].get("tokens", [])
        )
        _write_state_unlocked(state)
        if changed:
            log_token_event(
                "VISIBILITY",
                actor="GM",
                scope="all",
                after=visible,
                changed=changed,
            )
    return jsonify(status="ok", visible=visible, changed=changed)


@app.post("/api/initiative/enforce")
@editor_required
def set_initiative_enforcement():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    enabled = bool(payload.get("enabled", False))
    with current_runtime().lock:
        state = _load_state_unlocked()
        state["vtt"]["initiative_enforced"] = enabled
        if enabled:
            ensure_active_initiative_token(state)
        _write_state_unlocked(state)
        active_id = state["vtt"].get("active_initiative_token_id")
    return jsonify(status="ok", initiative_enforced=enabled, active_initiative_token_id=active_id)


@app.post("/api/initiative/step")
@editor_required
def step_initiative():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    direction = str(payload.get("direction") or "next").strip().lower()
    if direction not in {"next", "previous"}:
        return jsonify(error="Initiative direction must be next or previous."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        ordered = ordered_initiative_tokens(state)
        if not ordered:
            state["vtt"]["active_initiative_token_id"] = None
            _write_state_unlocked(state)
            return jsonify(error="No initiative numbers are currently assigned."), 409
        current_id = state["vtt"].get("active_initiative_token_id")
        current_index = next(
            (index for index, token in enumerate(ordered) if token["id"] == current_id),
            None,
        )
        if current_index is None:
            active = ordered[0] if direction == "next" else ordered[-1]
        else:
            delta = 1 if direction == "next" else -1
            active = ordered[(current_index + delta) % len(ordered)]
        state["vtt"]["active_initiative_token_id"] = active["id"]
        _write_state_unlocked(state)
    return jsonify(
        status="ok",
        active_initiative_token_id=active["id"],
        active_initiative_token_name=active["name"],
        initiative=active.get("initiative"),
    )


@app.post("/api/vtt/password")
@editor_required
def vtt_password():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    password = str(payload.get("password") or "")
    confirm = str(payload.get("confirm") or "")
    if not password:
        return jsonify(error="Enter a game password."), 400
    if password != confirm:
        return jsonify(error="The game passwords do not match."), 400
    if len(password) > 128:
        return jsonify(error="The game password is too long."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        state["vtt"]["password_hash"] = generate_password_hash(password)
        state["vtt"]["password_version"] += 1
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/vtt/password/clear")
@editor_required
def clear_vtt_password():
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        state["vtt"]["password_hash"] = None
        state["vtt"]["password_version"] += 1
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/areas")
@editor_required
def add_area():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "Area").strip()[:60] or "Area"
    color = str(payload.get("color") or "").lower()
    if not COLOR_RE.fullmatch(color):
        return jsonify(error="Select a valid area color."), 400
    shape = str(payload.get("shape") or "circle").strip().lower()
    if shape not in {"circle", "cone", "line"}:
        return jsonify(error="Area shape must be Circle, Cone, or Line."), 400
    try:
        diameter = clamp(float(payload.get("diameter", 0.20)), 0.01, 2.0)
        length_squares = clamp(float(payload.get("length_squares", 6.0)), 0.5, 60.0)
        width_squares = clamp(float(payload.get("width_squares", 1.0)), 0.25, 20.0)
        angle = clamp(float(payload.get("angle", 60.0)), 15.0, 120.0)
        rotation = float(payload.get("rotation", 0.0)) % 360.0
    except Exception:
        return jsonify(error="Invalid area size, angle, or direction."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        if not payload.get("name"):
            used_names = {str(area.get("name") or "").lower() for area in state["vtt"]["areas"]}
            number = 1
            while f"area {number}" in used_names:
                number += 1
            name = f"Area {number}"
        area = {
            "id": secrets.token_hex(8),
            "name": name,
            "color": color,
            "shape": shape,
            "x": 0.5,
            "y": 0.5,
            "diameter": diameter,
            "length_squares": length_squares,
            "width_squares": width_squares,
            "angle": angle,
            "rotation": rotation,
            "visible": bool(payload.get("visible", True)),
        }
        state["vtt"]["areas"].append(area)
        _write_state_unlocked(state)
    return jsonify(status="ok", area=area)


@app.post("/api/areas/<area_id>")
@editor_required
def update_area(area_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    with current_runtime().lock:
        state = _load_state_unlocked()
        area = find_area_by_id(state, area_id)
        if not area:
            return jsonify(error="Area not found."), 404
        name = str(payload.get("name") or "Area").strip()[:60] or "Area"
        color = str(payload.get("color") or "").lower()
        if not COLOR_RE.fullmatch(color):
            return jsonify(error="Select a valid area color."), 400
        shape = str(payload.get("shape") or area.get("shape") or "circle").strip().lower()
        if shape not in {"circle", "cone", "line"}:
            return jsonify(error="Area shape must be Circle, Cone, or Line."), 400
        try:
            diameter = clamp(float(payload.get("diameter", area.get("diameter", 0.20))), 0.01, 2.0)
            length_squares = clamp(float(payload.get("length_squares", area.get("length_squares", 6.0))), 0.5, 60.0)
            width_squares = clamp(float(payload.get("width_squares", area.get("width_squares", 1.0))), 0.25, 20.0)
            angle = clamp(float(payload.get("angle", area.get("angle", 60.0))), 15.0, 120.0)
            rotation = float(payload.get("rotation", area.get("rotation", 0.0))) % 360.0
        except Exception:
            return jsonify(error="Invalid area size, angle, or direction."), 400
        area.update(
            name=name,
            color=color,
            shape=shape,
            diameter=diameter,
            length_squares=length_squares,
            width_squares=width_squares,
            angle=angle,
            rotation=rotation,
            visible=bool(payload.get("visible", area.get("visible", True))),
        )
        _write_state_unlocked(state)
    return jsonify(status="ok", area=area)


@app.delete("/api/areas/<area_id>")
@editor_required
def delete_area(area_id):
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        before = len(state["vtt"]["areas"])
        state["vtt"]["areas"] = [area for area in state["vtt"]["areas"] if area["id"] != area_id]
        if len(state["vtt"]["areas"]) == before:
            return jsonify(error="Area not found."), 404
        for record in state.get("maps", []):
            record.setdefault("area_visibility", {}).pop(area_id, None)
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/areas/<area_id>/move")
@editor_required
def move_area(area_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    try:
        x = clamp(float(payload.get("x")), 0.0, 1.0)
        y = clamp(float(payload.get("y")), 0.0, 1.0)
    except Exception:
        return jsonify(error="Invalid area position."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        area = find_area_by_id(state, area_id)
        if not area:
            return jsonify(error="Area not found."), 404
        area["x"] = x
        area["y"] = y
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/areas/<area_id>/rotate")
@editor_required
def rotate_area(area_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    try:
        rotation = float(payload.get("rotation")) % 360.0
    except Exception:
        return jsonify(error="Invalid area direction."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        area = find_area_by_id(state, area_id)
        if not area:
            return jsonify(error="Area not found."), 404
        if area.get("shape") not in {"cone", "line"}:
            return jsonify(error="Only cone or line areas can be rotated."), 400
        area["rotation"] = rotation
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/vision-blockers/settings")
@editor_required
def update_vision_blocker_settings():
    """Update the shared appearance used for ordinary door cues."""
    check_csrf()
    payload = request.get_json(silent=True) or {}
    color = str(payload.get("door_color") or "").strip().lower()
    if not COLOR_RE.fullmatch(color):
        return jsonify(error="Select a valid door color."), 400
    try:
        opacity = clamp(float(payload.get("door_opacity")), 0.10, 1.0)
    except Exception:
        return jsonify(error="Door opacity must be between 10% and 100%."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        target, record, is_active = map_settings_target(state, request.args.get("map_id"))
        if not target:
            return jsonify(error="Map not found."), 404
        target["door_color"] = color
        target["door_opacity"] = opacity
        _write_state_unlocked(state)
    return jsonify(status="ok", door_color=color, door_opacity=opacity)


@app.post("/api/vision-blockers")
@editor_required
def add_vision_blocker():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    blocker = normalize_vision_blocker({
        "id": secrets.token_hex(8),
        "type": payload.get("type", "wall"),
        "x1": payload.get("x1"),
        "y1": payload.get("y1"),
        "x2": payload.get("x2"),
        "y2": payload.get("y2"),
        "open": bool(payload.get("open", False)),
        "visible_to_players": bool(payload.get("visible_to_players", True)),
    })
    if not blocker:
        return jsonify(error="Draw a wall or door with two distinct endpoints."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        target, record, is_active = map_settings_target(state, request.args.get("map_id"))
        if not target:
            return jsonify(error="Map not found."), 404
        target.setdefault("vision_blockers", []).append(blocker)
        _write_state_unlocked(state)
    return jsonify(status="ok", blocker=blocker)


@app.post("/api/vision-blockers/<blocker_id>")
@editor_required
def update_vision_blocker(blocker_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    with current_runtime().lock:
        state = _load_state_unlocked()
        target, record, is_active = map_settings_target(state, request.args.get("map_id"))
        if not target:
            return jsonify(error="Map not found."), 404
        blocker = next((item for item in target.get("vision_blockers", []) if item["id"] == blocker_id), None)
        if not blocker:
            return jsonify(error="Wall or door not found."), 404
        candidate = dict(blocker)
        for key in ("type", "x1", "y1", "x2", "y2", "open", "visible_to_players"):
            if key in payload:
                candidate[key] = payload[key]
        candidate["id"] = blocker_id
        normalized = normalize_vision_blocker(candidate)
        if not normalized:
            return jsonify(error="Invalid wall or door."), 400
        blocker.clear()
        blocker.update(normalized)
        _write_state_unlocked(state)
    return jsonify(status="ok", blocker=blocker)


@app.delete("/api/vision-blockers")
@editor_required
def delete_all_vision_blockers():
    """Clear the complete GM wall/door layout in one atomic state update."""
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        target, record, is_active = map_settings_target(state, request.args.get("map_id"))
        if not target:
            return jsonify(error="Map not found."), 404
        deleted = len(target.get("vision_blockers", []))
        target["vision_blockers"] = []
        _write_state_unlocked(state)
    return jsonify(status="ok", deleted=deleted)


@app.delete("/api/vision-blockers/<blocker_id>")
@editor_required
def delete_vision_blocker(blocker_id):
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        target, record, is_active = map_settings_target(state, request.args.get("map_id"))
        if not target:
            return jsonify(error="Map not found."), 404
        before = len(target.get("vision_blockers", []))
        target["vision_blockers"] = [
            item for item in target.get("vision_blockers", []) if item["id"] != blocker_id
        ]
        if len(target["vision_blockers"]) == before:
            return jsonify(error="Wall or door not found."), 404
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.post("/api/tokens")
@editor_required
def add_token():
    check_csrf()
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()[:60]
    if not name:
        return jsonify(error="Enter a token name."), 400
    color = str(payload.get("color") or "").lower()
    if not COLOR_RE.fullmatch(color):
        return jsonify(error="Select a valid token color."), 400
    player_controlled = bool(payload.get("player_controlled", True))
    try:
        initiative = normalize_initiative(payload.get("initiative"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    with current_runtime().lock:
        state = _load_state_unlocked()
        player_key = None
        moved_by_token_id = None
        if player_controlled:
            player_key = unique_player_key(state, name)
        else:
            try:
                moved_by_token_id = validate_moved_by_token_id(state, payload.get("moved_by_token_id"))
            except ValueError as exc:
                return jsonify(error=str(exc)), 400
        token = {
            "id": secrets.token_hex(8),
            "name": name,
            "color": color,
            "x": 0.5,
            "y": 0.5,
            "player_controlled": player_controlled,
            "player_key": player_key,
            "initiative": initiative,
            "visible": bool(payload.get("visible", True)),
            "vision_enabled": bool(payload.get("vision_enabled", False)) if player_controlled else False,
            "vision_radius_feet": 60.0,
            "vision_type": "light",
            "share_vision_with_controller": False,
            "reveal_in_darkness": bool(payload.get("reveal_in_darkness", False)) if not player_controlled else False,
            "moved_by_token_id": moved_by_token_id,
        }
        state["vtt"]["tokens"].append(token)
        _write_state_unlocked(state)
        log_token_event(
            "ADD",
            actor="GM",
            token=token["name"],
            id=token["id"],
            at=f"{token['x']:.6f},{token['y']:.6f}",
            player_controlled=token["player_controlled"],
            visible=token.get("visible", True),
        )
        if token.get("moved_by_token_id"):
            log_token_event(
                "DELEGATE",
                actor="GM",
                token=token["name"],
                id=token["id"],
                before="none",
                after=token_controller_name(state, token.get("moved_by_token_id")) or token.get("moved_by_token_id"),
                after_id=token.get("moved_by_token_id"),
            )
    return jsonify(status="ok", token=token)


@app.post("/api/tokens/<token_id>")
@editor_required
def update_token(token_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    with current_runtime().lock:
        state = _load_state_unlocked()
        token = find_token_by_id(state, token_id)
        if not token:
            return jsonify(error="Token not found."), 404

        name = str(payload.get("name") or "").strip()[:60]
        if not name:
            return jsonify(error="Enter a token name."), 400
        color = str(payload.get("color") or "").lower()
        if not COLOR_RE.fullmatch(color):
            return jsonify(error="Select a valid token color."), 400
        player_controlled = bool(payload.get("player_controlled", False))
        player_key = None
        moved_by_token_id = None
        if player_controlled:
            player_key = unique_player_key(state, name, token_id)
        else:
            try:
                moved_by_token_id = validate_moved_by_token_id(state, payload.get("moved_by_token_id"), exclude_token_id=token_id)
            except ValueError as exc:
                return jsonify(error=str(exc)), 400
        try:
            initiative = normalize_initiative(payload.get("initiative"))
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

        try:
            vision_radius_feet = clamp(
                float(payload.get("vision_radius_feet", token.get("vision_radius_feet", 60.0))),
                1.0,
                300.0,
            )
        except Exception:
            return jsonify(error="Vision radius must be from 1 to 300 feet."), 400
        vision_enabled = bool(payload.get("vision_enabled", token.get("vision_enabled", False))) if player_controlled else False
        vision_type = str(payload.get("vision_type", token.get("vision_type", "light"))).strip().lower()
        if vision_type not in {"light", "nightvision"}:
            return jsonify(error="Vision type must be light or nightvision."), 400
        share_vision_with_controller = (
            bool(payload.get("share_vision_with_controller", token.get("share_vision_with_controller", False)))
            if not player_controlled and moved_by_token_id
            else False
        )

        old_visible = token.get("visible", True)
        old_reveal_in_darkness = token.get("reveal_in_darkness", False)
        old_share_vision = token.get("share_vision_with_controller", False)
        old_moved_by_token_id = token.get("moved_by_token_id")
        old_controller_name = token_controller_name(state, old_moved_by_token_id)
        new_visible = bool(payload.get("visible", token.get("visible", True)))
        reveal_in_darkness = bool(payload.get("reveal_in_darkness", token.get("reveal_in_darkness", False))) if not player_controlled else False

        token.update(
            name=name,
            color=color,
            player_controlled=player_controlled,
            player_key=player_key,
            initiative=initiative,
            visible=new_visible,
            vision_enabled=vision_enabled,
            vision_radius_feet=vision_radius_feet,
            vision_type=vision_type,
            share_vision_with_controller=share_vision_with_controller,
            reveal_in_darkness=reveal_in_darkness,
            moved_by_token_id=moved_by_token_id,
        )
        _write_state_unlocked(state)
        if old_visible != new_visible:
            log_token_event(
                "VISIBILITY",
                actor="GM",
                scope="token",
                token=token["name"],
                id=token["id"],
                before=old_visible,
                after=new_visible,
            )
        if old_reveal_in_darkness != reveal_in_darkness:
            log_token_event(
                "DARK_REVEAL",
                actor="GM",
                token=token["name"],
                id=token["id"],
                before=old_reveal_in_darkness,
                after=reveal_in_darkness,
            )
        if old_share_vision != share_vision_with_controller:
            log_token_event(
                "VISION_SHARE",
                actor="GM",
                token=token["name"],
                id=token["id"],
                before=old_share_vision,
                after=share_vision_with_controller,
            )
        if old_moved_by_token_id != moved_by_token_id:
            log_token_event(
                "DELEGATE",
                actor="GM",
                token=token["name"],
                id=token["id"],
                before=old_controller_name or old_moved_by_token_id or "none",
                before_id=old_moved_by_token_id,
                after=token_controller_name(state, moved_by_token_id) or moved_by_token_id or "none",
                after_id=moved_by_token_id,
            )
    return jsonify(status="ok", token=token)


@app.post("/api/tokens/initiative/clear")
@editor_required
def clear_token_initiative():
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        for token in state["vtt"]["tokens"]:
            token["initiative"] = None
        state["vtt"]["active_initiative_token_id"] = None
        state["vtt"]["initiative_enforced"] = False
        _write_state_unlocked(state)
    return jsonify(status="ok")


@app.delete("/api/tokens/<token_id>")
@editor_required
def delete_token(token_id):
    check_csrf()
    with current_runtime().lock:
        state = _load_state_unlocked()
        target = find_token_by_id(state, token_id)
        if not target:
            return jsonify(error="Token not found."), 404
        target_snapshot = dict(target)
        cleared_delegations = []
        for token in state["vtt"]["tokens"]:
            if token.get("moved_by_token_id") == token_id:
                cleared_delegations.append((token.get("id"), token.get("name")))
                token["moved_by_token_id"] = None
                token["share_vision_with_controller"] = False
        state["vtt"]["tokens"] = [
            token for token in state["vtt"]["tokens"] if token["id"] != token_id
        ]
        state.get("explored_masks", {}).pop(token_id, None)
        for record in state.get("maps", []):
            record.setdefault("token_visibility", {}).pop(token_id, None)
            record.setdefault("explored_masks", {}).pop(token_id, None)
        _write_state_unlocked(state)
        log_token_event(
            "DELETE",
            actor="GM",
            token=target_snapshot.get("name"),
            id=target_snapshot.get("id"),
            at=f"{target_snapshot.get('x', 0):.6f},{target_snapshot.get('y', 0):.6f}",
        )
        for delegated_id, delegated_name in cleared_delegations:
            log_token_event(
                "DELEGATE",
                actor="GM",
                token=delegated_name,
                id=delegated_id,
                before=target_snapshot.get("name") or token_id,
                before_id=token_id,
                after="none",
            )
    return jsonify(status="ok")


@app.post("/api/tokens/<token_id>/move")
@editor_required
def move_token(token_id):
    check_csrf()
    payload = request.get_json(silent=True) or {}
    try:
        x = clamp(float(payload.get("x")), 0.0, 1.0)
        y = clamp(float(payload.get("y")), 0.0, 1.0)
    except Exception:
        return jsonify(error="Invalid token position."), 400
    with current_runtime().lock:
        state = _load_state_unlocked()
        token = find_token_by_id(state, token_id)
        if not token:
            return jsonify(error="Token not found."), 404
        old_x = float(token["x"])
        old_y = float(token["y"])
        token["x"] = x
        token["y"] = y
        _write_state_unlocked(state)
        if old_x != x or old_y != y:
            log_token_event(
                "MOVE",
                actor="GM",
                token=token["name"],
                id=token["id"],
                before=f"{old_x:.6f},{old_y:.6f}",
                after=f"{x:.6f},{y:.6f}",
            )
    return jsonify(status="ok")


# Player movement is the one public write path. Recompute permissions from the
# latest state inside the lock instead of trusting the token list the browser saw.
@app.post("/api/vtt/move")
@vtt_json_required
def vtt_move(state, player):
    check_csrf()
    if not state["vtt"].get("movement_enabled"):
        return jsonify(error="Player movement is currently locked by the GM."), 423
    payload = request.get_json(silent=True) or {}
    try:
        x = clamp(float(payload.get("x")), 0.0, 1.0)
        y = clamp(float(payload.get("y")), 0.0, 1.0)
    except Exception:
        return jsonify(error="Invalid token position."), 400
    requested_token_id = str(payload.get("token_id") or "").strip()
    with current_runtime().lock:
        current = _load_state_unlocked()
        current_player = session_vtt_token(current)
        if not current_player:
            return jsonify(error="VTT authentication is required."), 401
        if not current["vtt"].get("movement_enabled"):
            return jsonify(error="Player movement is currently locked by the GM."), 423
        movable_ids = initiative_movable_token_ids_for_player(current, current_player)
        target_id = requested_token_id or current_player["id"]
        if target_id not in movable_ids:
            if current["vtt"].get("initiative_enforced", False):
                return jsonify(error="That token cannot move during the current initiative turn."), 403
            return jsonify(error="You may move only your own assigned tokens."), 403
        target = find_token_by_id(current, target_id)
        if not target:
            return jsonify(error="Token not found."), 404
        if current["vtt"].get("dark_environment", False) and target_id != current_player["id"]:
            # The active delegated NPC may move without becoming a vision source.
            active_delegated_npc = active_delegated_npc_for_player(current, current_player)
            active_delegated_id = active_delegated_npc.get("id") if active_delegated_npc else None
            if target_id != active_delegated_id:
                player_vision = player_vision_tokens_for_player(current, current_player)
                explicitly_revealed = (
                    not target.get("player_controlled")
                    and target.get("reveal_in_darkness", False)
                )
                if not explicitly_revealed and not point_in_vision(
                    current, target["x"], target["y"], player_vision
                ):
                    return jsonify(error="That assigned NPC is outside your visible area."), 403
        if not target.get("visible", True):
            return jsonify(error="That token is currently hidden by the GM."), 423
        old_x = float(target["x"])
        old_y = float(target["y"])
        try:
            movement_path = normalize_player_move_path(
                payload.get("path"), old_x, old_y, x, y
            )
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        if player_move_path_blocked(current, movement_path):
            # Do not identify which GM-only blocker rejected the move. Secret-door
            # geometry remains private even though the attempted move is refused.
            return jsonify(error="Movement is blocked."), 409
        target["x"] = x
        target["y"] = y
        _write_state_unlocked(current)
        if old_x != x or old_y != y:
            log_token_event(
                "MOVE",
                actor="PLAYER",
                player=current_player.get("name"),
                token=target["name"],
                id=target["id"],
                before=f"{old_x:.6f},{old_y:.6f}",
                after=f"{x:.6f},{y:.6f}",
            )
    return jsonify(status="ok")


# ---- Server-Sent Events ---------------------------------------------------
# SSE carries only a monotonically increasing state version. Clients fetch their
# own audience-specific JSON after an update, which keeps one event stream usable
# by the GM, players, and the public viewer without leaking state in the event.
@app.get("/events")
def events():
    # Scoped /g/<gm>/events streams are public. An unscoped stream is reserved
    # for an authenticated GM editor/wall-map session.
    if not request.environ.get("VTT_GAME_SLUG") and not current_editor_user():
        return "", 401
    try:
        last = int(request.headers.get("Last-Event-ID", "0"))
    except ValueError:
        last = 0
    runtime = current_runtime()

    def stream():
        nonlocal last
        while True:
            with runtime.condition:
                current = runtime.version
                if current <= last:
                    runtime.condition.wait(timeout=25)
                    current = runtime.version
            if current > last:
                last = current
                yield f"id: {current}\nevent: update\ndata: {current}\n\n"
            else:
                yield ": keepalive\n\n"

    resp = Response(stream(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache, no-store"
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Connection"] = "keep-alive"
    return resp


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="The uploaded file exceeds the configured size limit."), 413
