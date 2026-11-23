# Deployment configuration

| File | Purpose | In git? |
|---|---|---|
| `docker-compose.yml` | The two containers, their network, health checks and the data volume. | yes |
| `.env.example` | Template for `.env`. | yes |
| `.env` | Your settings. Uploaded to the host with mode 0600. | **no** |
| `certs/` | Your TLS certificate and private key. | **no** (only `.gitkeep`) |

## Certificates

Put one certificate/key pair anywhere under `certs/`, using one of these file-name pairs:

* `fullchain.pem` + `privkey.pem` (Let's Encrypt / certbot, as in `/etc/letsencrypt/live/<domain>/`)
* `fullchain1.pem` + `privkey1.pem` (certbot's `archive/` directory)
* `server.crt` + `server.key`
* `cert.pem` + `key.pem`

Then set `ENABLE_HTTPS=true` in `.env`. Before uploading, `npm run deploy` checks that the
certificate parses, hasn't expired, and matches the key. After renewing a certificate, run
`npm run update-certs -- --target <host>`; this restarts nginx without rebuilding anything.

For a quick test you can create a self-signed pair (browsers will warn):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" \
  -keyout certs/key.pem -out certs/cert.pem
```
