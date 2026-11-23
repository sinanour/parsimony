#!/bin/bash
#
# Lets other machines reach Parsimony on a macOS host that runs containers with Finch.
#
# Finch runs containers in a Lima VM, which by default forwards published ports to 127.0.0.1 only.
# This script adds port forwards to 0.0.0.0 for the ports Parsimony publishes (HTTP_PORT and
# HTTPS_PORT from deployment/config/.env), keeps the rest of ~/.finch/finch.yaml, and restarts the VM.
#
# Run it ON the macOS host:
#   ./configure-finch-ports.sh [HTTP_PORT] [HTTPS_PORT]      # defaults: 80 443
#
# Alternative: Docker Desktop for Mac publishes ports on all interfaces without extra setup.

set -euo pipefail

HTTP_PORT=${1:-80}
HTTPS_PORT=${2:-443}
CONFIG="$HOME/.finch/finch.yaml"

for p in "$HTTP_PORT" "$HTTPS_PORT"; do
    [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 65535 )) || { echo "Not a port number: $p" >&2; exit 1; }
done
[[ "$(uname)" == "Darwin" ]] || { echo "This script is for macOS hosts." >&2; exit 1; }
command -v finch >/dev/null || { echo "Finch is not installed (brew install --cask finch)." >&2; exit 1; }

mkdir -p "$HOME/.finch"
if [[ -f "$CONFIG" ]]; then
    backup="$CONFIG.backup.$(date +%Y%m%d-%H%M%S)"
    cp "$CONFIG" "$backup"
    echo "Backed up $CONFIG to $backup"
fi

# Keep every setting except an existing portForwards block, then append ours.
# Compose publishes HTTP_PORT/HTTPS_PORT inside the VM, so guest and host ports are the same.
tmp=$(mktemp)
if [[ -f "$CONFIG" ]]; then
    awk '
        /^portForwards:/ { skip = 1; next }
        skip && /^[^[:space:]#-]/ { skip = 0 }
        !skip { print }
    ' "$CONFIG" > "$tmp"
fi
cat >> "$tmp" <<EOF
# Added by Parsimony's configure-finch-ports.sh on $(date)
portForwards:
  - guestSocket: /var/run/docker.sock
    hostSocket: /Users/{{.User}}/.finch/finch.sock
  - guestPort: $HTTP_PORT
    hostIP: "0.0.0.0"
    hostPort: $HTTP_PORT
  - guestPort: $HTTPS_PORT
    hostIP: "0.0.0.0"
    hostPort: $HTTPS_PORT
EOF
mv "$tmp" "$CONFIG"
echo "Updated $CONFIG"

status=$(finch vm status 2>/dev/null || echo unknown)
case "$status" in
    *[Rr]unning*) echo "Restarting the Finch VM…"; finch vm stop; finch vm start ;;
    *[Ss]topped*) echo "Starting the Finch VM…"; finch vm start ;;
    *) echo "Initialising the Finch VM…"; finch vm init ;;
esac

ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo
echo "Done. Redeploy (or restart the containers) so the ports are published again, then check from"
echo "another machine:"
echo "  curl -I http://${ip:-<this-mac>}:$HTTP_PORT/health"
echo "If that still fails, restore the backup above and use Docker Desktop, or put a reverse proxy"
echo "on the Mac in front of 127.0.0.1:$HTTP_PORT."
