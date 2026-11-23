#!/bin/sh
# Starts the API as the unprivileged "parsimony" user. When started as root (the default), first
# gives that user ownership of anything in /data it doesn't own — a fresh host directory, or a
# database copied in with `docker cp`, is usually owned by root.
set -eu

if [ "$(id -u)" = "0" ]; then
    if ! find /data ! -user parsimony -exec chown parsimony:parsimony {} + 2>/dev/null; then
        echo "warning: could not change ownership of files in /data; the API may not be able to write to them" >&2
    fi
    exec su-exec parsimony "$@"
fi
exec "$@"
