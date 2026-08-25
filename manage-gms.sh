#!/usr/bin/env bash
set -Eeuo pipefail

# Scrying Table GM account and game-directory manager.
#
# Optional environment overrides:
#   SCRYING_GM_AUTH_FILE=/etc/nginx/.htpasswd-scrying-gm
#   SCRYING_TABLE_DIR=/srv/scrying-table
#   SCRYING_TABLE_DATA_DIR=/srv/scrying-table/data
#   SCRYING_TABLE_BACKUP_DIR=/var/backups/scrying-table
#   SCRYING_TABLE_URL=https://vtt.example.com

SCRIPT_PATH="$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
APP_DIR="${SCRYING_TABLE_DIR:-$SCRIPT_DIR}"
AUTH_FILE="${SCRYING_GM_AUTH_FILE:-/etc/nginx/.htpasswd-scrying-gm}"
DATA_DIR="${SCRYING_TABLE_DATA_DIR:-${APP_DIR}/data}"
GAMES_DIR="${DATA_DIR}/games"
BACKUP_DIR="${SCRYING_TABLE_BACKUP_DIR:-/var/backups/scrying-table}"
REMOVED_DIR="${BACKUP_DIR}/removed-games"
PUBLIC_URL="${SCRYING_TABLE_URL:-}"

SELECTED_USER=""
STAGED_GAME=""
STAGED_ORIGINAL=""

usage() {
    cat <<'USAGE'
Usage:
  manage-gms.sh                 Interactive menu
  manage-gms.sh list
  manage-gms.sh add USER
  manage-gms.sh passwd USER
  manage-gms.sh rename OLD NEW
  manage-gms.sh remove USER [--archive|--delete]

Environment overrides:
  SCRYING_GM_AUTH_FILE       Dedicated Nginx htpasswd file
  SCRYING_TABLE_DIR          Application directory if script is installed elsewhere
  SCRYING_TABLE_DATA_DIR     Application data directory
  SCRYING_TABLE_BACKUP_DIR   Backup/archive directory
  SCRYING_TABLE_URL          Optional public base URL used only for printed links

GM usernames must be lowercase and may contain a-z, 0-9, period, underscore,
or hyphen. They must start with a letter or number and be at most 32 characters.
USAGE
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

require_root() {
    [[ "$(id -u)" -eq 0 ]] || die "Run this command as root."
}

require_tools() {
    local tool
    for tool in awk cat chmod chown cp date find grep htpasswd mkdir mktemp mv readlink rm sort stat tr; do
        command -v "$tool" >/dev/null 2>&1 || die "Required command not found: $tool"
    done
}

valid_slug() {
    [[ "${1:-}" =~ ^[a-z0-9][a-z0-9_.-]{0,31}$ ]]
}

normalize_user() {
    printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

auth_user_exists() {
    local user="$1"
    [[ -s "$AUTH_FILE" ]] || return 1
    awk -F: -v wanted="$user" '$1 == wanted { found=1 } END { exit(found ? 0 : 1) }' "$AUTH_FILE"
}

list_auth_users() {
    [[ -s "$AUTH_FILE" ]] || return 0
    awk -F: 'NF >= 2 && $1 !~ /^[[:space:]]*(#|$)/ { print $1 }' "$AUTH_FILE" | sort -f
}

ensure_layout() {
    local data_existed=0 games_existed=0
    [[ -d "$DATA_DIR" ]] && data_existed=1
    [[ -d "$GAMES_DIR" ]] && games_existed=1
    mkdir -p "$DATA_DIR" "$GAMES_DIR" "$BACKUP_DIR" "$REMOVED_DIR"
    chmod 700 "$BACKUP_DIR" "$REMOVED_DIR" 2>/dev/null || true

    # Fresh application data should be writable by the container's default
    # UID/GID. Existing installations keep their current ownership.
    if ((data_existed == 0)); then
        chown 10001:10001 "$DATA_DIR" 2>/dev/null || true
    fi
    if ((games_existed == 0)); then
        chown 10001:10001 "$GAMES_DIR" 2>/dev/null || true
    fi
}

game_owner() {
    local uid gid
    uid="$(stat -c '%u' "$GAMES_DIR")"
    gid="$(stat -c '%g' "$GAMES_DIR")"
    printf '%s:%s\n' "$uid" "$gid"
}

ensure_game_dir() {
    local user="$1" owner
    owner="$(game_owner)"
    mkdir -p "$GAMES_DIR/$user"
    chown "$owner" "$GAMES_DIR/$user" 2>/dev/null || true
}

bump_auth_revision() {
    local user="$1" revision path owner
    ensure_game_dir "$user"
    path="$GAMES_DIR/$user/.auth-revision"
    revision="$(date +%s%N)-$$-${RANDOM}"
    printf '%s\n' "$revision" > "$path"
    chmod 644 "$path"
    owner="$(game_owner)"
    chown "$owner" "$path" 2>/dev/null || true
}

fix_auth_permissions() {
    [[ -e "$AUTH_FILE" ]] || return 0
    if getent group www-data >/dev/null 2>&1; then
        chown root:www-data "$AUTH_FILE"
        chmod 640 "$AUTH_FILE"
    else
        chown root:root "$AUTH_FILE"
        chmod 600 "$AUTH_FILE"
    fi
}

backup_auth_file() {
    local stamp target
    [[ -e "$AUTH_FILE" ]] || return 0
    stamp="$(date +%Y%m%d-%H%M%S)"
    target="$BACKUP_DIR/$(basename "$AUTH_FILE").${stamp}.$$.bak"
    cp -a -- "$AUTH_FILE" "$target"
    chmod 600 "$target" 2>/dev/null || true
    printf 'Auth backup: %s\n' "$target"
}

print_routes() {
    local user="$1"
    if [[ -n "$PUBLIC_URL" ]]; then
        printf 'Editor: %s/edit\n' "${PUBLIC_URL%/}"
        printf 'Viewer: %s/g/%s/viewer\n' "${PUBLIC_URL%/}" "$user"
        printf 'Player: %s/g/%s/player\n' "${PUBLIC_URL%/}" "$user"
    else
        printf 'Editor route: /edit\n'
        printf 'Viewer route: /g/%s/viewer\n' "$user"
        printf 'Player route: /g/%s/player\n' "$user"
    fi
}

status_for_user() {
    local user="$1" root="$GAMES_DIR/$user"
    if [[ -f "$root/current_state.json" ]]; then
        printf 'initialized'
    elif [[ -d "$root" ]]; then
        printf 'created'
    else
        printf 'missing data directory'
    fi
}

cmd_list() {
    local users=() user
    mapfile -t users < <(list_auth_users)
    printf 'Scrying Table GM accounts\n'
    printf 'Auth file: %s\n' "$AUTH_FILE"
    printf 'Game data: %s\n\n' "$GAMES_DIR"
    if ((${#users[@]} == 0)); then
        printf '  (none)\n'
        return 0
    fi
    for user in "${users[@]}"; do
        printf '  %-24s %s\n' "$user" "$(status_for_user "$user")"
    done
}

cmd_add() {
    local user raw new_dir=0
    require_root
    raw="${1:-}"
    [[ -n "$raw" ]] || die "add requires a username."
    user="$(normalize_user "$raw")"
    valid_slug "$user" || die "Invalid GM username: $raw"
    auth_user_exists "$user" && die "GM account already exists: $user"

    ensure_layout
    if [[ ! -d "$GAMES_DIR/$user" ]]; then
        ensure_game_dir "$user"
        new_dir=1
    elif find "$GAMES_DIR/$user" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
        printf 'Existing game data found for %s at %s\n' "$user" "$GAMES_DIR/$user"
        printf 'This account will be connected to that existing data.\n'
    fi

    bump_auth_revision "$user"
    backup_auth_file
    mkdir -p "$(dirname "$AUTH_FILE")"

    printf 'Set the password for GM "%s":\n' "$user"
    if [[ -s "$AUTH_FILE" ]]; then
        if ! htpasswd "$AUTH_FILE" "$user"; then
            ((new_dir)) && rm -rf -- "$GAMES_DIR/$user"
            die "Password creation failed."
        fi
    else
        if ! htpasswd -c "$AUTH_FILE" "$user"; then
            ((new_dir)) && rm -rf -- "$GAMES_DIR/$user"
            die "Password creation failed."
        fi
    fi
    fix_auth_permissions

    printf '\nAdded GM: %s\n' "$user"
    print_routes "$user"
    printf 'The public session chooser will list this GM after the session has saved state.\n'
}

cmd_passwd() {
    local user
    require_root
    user="$(normalize_user "${1:-}")"
    [[ -n "$user" ]] || die "passwd requires a username."
    auth_user_exists "$user" || die "Unknown GM account: $user"
    ensure_layout
    ensure_game_dir "$user"
    backup_auth_file
    printf 'Set a new password for GM "%s":\n' "$user"
    htpasswd "$AUTH_FILE" "$user" || die "Password change failed."
    fix_auth_permissions
    bump_auth_revision "$user"
    printf 'Password changed for %s. Existing signed GM sessions were invalidated.\n' "$user"
}

prepare_auth_rename() {
    local old="$1" new="$2" tmp
    tmp="$(mktemp "${AUTH_FILE}.tmp.XXXXXX")"
    awk -v old="$old" -v new="$new" '
        index($0, old ":") == 1 { print new substr($0, length(old) + 1); next }
        { print }
    ' "$AUTH_FILE" > "$tmp"
    printf '%s\n' "$tmp"
}

prepare_auth_remove() {
    local user="$1" tmp
    tmp="$(mktemp "${AUTH_FILE}.tmp.XXXXXX")"
    awk -F: -v wanted="$user" '$1 != wanted { print }' "$AUTH_FILE" > "$tmp"
    printf '%s\n' "$tmp"
}

cmd_rename() {
    local old new tmp source target created_target=0
    require_root
    old="$(normalize_user "${1:-}")"
    new="$(normalize_user "${2:-}")"
    [[ -n "$old" && -n "$new" ]] || die "rename requires OLD and NEW usernames."
    valid_slug "$new" || die "Invalid new GM username: $new"
    [[ "$old" != "$new" ]] || die "The old and new usernames are identical."
    auth_user_exists "$old" || die "Unknown GM account: $old"
    auth_user_exists "$new" && die "GM account already exists: $new"

    ensure_layout
    source="$GAMES_DIR/$old"
    target="$GAMES_DIR/$new"
    [[ ! -e "$target" ]] || die "Target game directory already exists: $target"

    tmp="$(prepare_auth_rename "$old" "$new")"
    backup_auth_file

    if [[ -d "$source" ]]; then
        mv -- "$source" "$target"
    else
        ensure_game_dir "$new"
        created_target=1
    fi

    if ! cat -- "$tmp" > "$AUTH_FILE"; then
        rm -f -- "$tmp"
        if [[ -d "$target" && $created_target -eq 0 ]]; then
            mv -- "$target" "$source" || true
        elif ((created_target)); then
            rmdir "$target" 2>/dev/null || true
        fi
        die "Could not update the GM auth file; data rollback was attempted."
    fi
    rm -f -- "$tmp"
    fix_auth_permissions
    bump_auth_revision "$new"

    printf 'Renamed GM: %s -> %s\n' "$old" "$new"
    printf 'The password hash was preserved. Existing signed GM sessions were invalidated.\n'
    print_routes "$new"
}

stage_game_removal() {
    local user="$1" source stamp
    STAGED_GAME=""
    STAGED_ORIGINAL=""
    source="$GAMES_DIR/$user"
    [[ -e "$source" ]] || return 0
    stamp="$(date +%Y%m%d-%H%M%S)"
    STAGED_GAME="$REMOVED_DIR/.pending-${user}-${stamp}-$$"
    STAGED_ORIGINAL="$source"
    mv -- "$source" "$STAGED_GAME"
}

rollback_game_removal() {
    [[ -n "$STAGED_GAME" && -e "$STAGED_GAME" ]] || return 0
    [[ -n "$STAGED_ORIGINAL" && ! -e "$STAGED_ORIGINAL" ]] || return 1
    mv -- "$STAGED_GAME" "$STAGED_ORIGINAL"
}

cmd_remove() {
    local user mode="${2:---archive}" tmp final stamp
    require_root
    user="$(normalize_user "${1:-}")"
    [[ -n "$user" ]] || die "remove requires a username."
    auth_user_exists "$user" || die "Unknown GM account: $user"
    case "$mode" in
        --archive|--delete) ;;
        *) die "remove mode must be --archive or --delete." ;;
    esac

    ensure_layout
    tmp="$(prepare_auth_remove "$user")"
    backup_auth_file
    stage_game_removal "$user"

    if ! cat -- "$tmp" > "$AUTH_FILE"; then
        rm -f -- "$tmp"
        rollback_game_removal || true
        die "Could not update the GM auth file; data rollback was attempted."
    fi
    rm -f -- "$tmp"
    fix_auth_permissions

    if [[ -n "$STAGED_GAME" && -e "$STAGED_GAME" ]]; then
        if [[ "$mode" == "--delete" ]]; then
            rm -rf -- "$STAGED_GAME"
            printf 'Removed GM %s and permanently deleted its game data.\n' "$user"
        else
            stamp="$(date +%Y%m%d-%H%M%S)"
            final="$REMOVED_DIR/${user}-${stamp}"
            mv -- "$STAGED_GAME" "$final"
            printf 'Removed GM %s. Game data archived at:\n  %s\n' "$user" "$final"
        fi
    else
        printf 'Removed GM %s. No game data directory existed.\n' "$user"
    fi
}

confirm_yes() {
    local prompt="$1" answer
    printf '%s [y/N]: ' "$prompt"
    read -r answer
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

choose_user() {
    local users=() choice i
    mapfile -t users < <(list_auth_users)
    ((${#users[@]} > 0)) || { printf 'No GM accounts exist.\n'; return 1; }
    printf '\nChoose a GM:\n'
    for i in "${!users[@]}"; do
        printf '  %d) %s\n' "$((i + 1))" "${users[$i]}"
    done
    printf '  0) Cancel\nSelection: '
    read -r choice
    [[ "$choice" =~ ^[0-9]+$ ]] || return 1
    ((choice > 0 && choice <= ${#users[@]})) || return 1
    SELECTED_USER="${users[$((choice - 1))]}"
}

interactive_menu() {
    local choice user new mode
    require_root
    while true; do
        printf '\n============================================================\n'
        cmd_list
        printf '\n1) Add GM\n2) Remove GM\n3) Rename GM\n4) Change GM password\n5) Refresh\n0) Exit\nSelection: '
        read -r choice
        case "$choice" in
            1)
                printf 'New GM username: '
                read -r user
                cmd_add "$user"
                ;;
            2)
                choose_user || continue
                user="$SELECTED_USER"
                printf 'Archive or permanently delete game data? [A/d]: '
                read -r mode
                if [[ "$mode" =~ ^[Dd]$ ]]; then
                    printf 'Type DELETE %s to confirm permanent deletion: ' "$user"
                    read -r new
                    [[ "$new" == "DELETE $user" ]] || { printf 'Cancelled.\n'; continue; }
                    cmd_remove "$user" --delete
                else
                    confirm_yes "Remove $user and archive its game data?" || continue
                    cmd_remove "$user" --archive
                fi
                ;;
            3)
                choose_user || continue
                user="$SELECTED_USER"
                printf 'New username for %s: ' "$user"
                read -r new
                confirm_yes "Rename $user to ${new,,}?" || continue
                cmd_rename "$user" "$new"
                ;;
            4)
                choose_user || continue
                cmd_passwd "$SELECTED_USER"
                ;;
            5) ;;
            0) exit 0 ;;
            *) printf 'Invalid selection.\n' ;;
        esac
    done
}

main() {
    require_tools
    case "${1:-}" in
        "") interactive_menu ;;
        -h|--help|help) usage ;;
        list) require_root; ensure_layout; cmd_list ;;
        add) cmd_add "${2:-}" ;;
        passwd|password) cmd_passwd "${2:-}" ;;
        rename) cmd_rename "${2:-}" "${3:-}" ;;
        remove) cmd_remove "${2:-}" "${3:---archive}" ;;
        *) usage >&2; exit 2 ;;
    esac
}

main "$@"
