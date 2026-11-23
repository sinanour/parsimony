#!/bin/sh
# Writes /etc/nginx/conf.d/parsimony.conf at container start.
#   ENABLE_HTTPS=true  and a certificate/key pair in /etc/nginx/certs → HTTPS on 443, HTTP redirects to it
#   otherwise                                                           → HTTP only on 80
# Recognised pairs (in any subdirectory): fullchain.pem+privkey.pem, fullchain1.pem+privkey1.pem,
# server.crt+server.key, cert.pem+key.pem.
set -eu

conf=/etc/nginx/conf.d/parsimony.conf
server_name=${SERVER_NAME:-_}
certificate=
private_key=

if [ "${ENABLE_HTTPS:-false}" = "true" ]; then
    for cert_name in fullchain.pem fullchain1.pem server.crt cert.pem; do
        for cert in $(find /etc/nginx/certs -type f -name "$cert_name" 2>/dev/null | sort); do
            dir=$(dirname "$cert")
            for key_name in privkey.pem privkey1.pem server.key key.pem; do
                if [ -f "$dir/$key_name" ]; then
                    certificate=$cert
                    private_key=$dir/$key_name
                    break 3
                fi
            done
        done
    done
    if [ -z "$certificate" ]; then
        echo "ENABLE_HTTPS=true but no certificate/key pair was found in /etc/nginx/certs; serving HTTP only." >&2
    fi
fi

if [ -z "$certificate" ]; then
    cat > "$conf" <<CONF
server {
    listen 80;
    server_name $server_name;
    include /etc/nginx/snippets/app.conf;
}
CONF
    echo "Parsimony: HTTP only"
    exit 0
fi

port=${HTTPS_PORT:-443}
suffix=
[ "$port" = "443" ] || suffix=":$port"

if [ "${HTTPS_REDIRECT:-true}" = "true" ]; then
    http_body="    location = /health { access_log off; default_type text/plain; return 200 \"ok\\n\"; }
    location / { return 301 https://\$host$suffix\$request_uri; }"
else
    http_body="    include /etc/nginx/snippets/app.conf;"
fi

cat > "$conf" <<CONF
server {
    listen 80;
    server_name $server_name;
$http_body
}

server {
    listen 443 ssl;
    http2 on;
    server_name $server_name;

    ssl_certificate     $certificate;
    ssl_certificate_key $private_key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    include /etc/nginx/snippets/app.conf;
}
CONF
echo "Parsimony: HTTPS with $certificate"
