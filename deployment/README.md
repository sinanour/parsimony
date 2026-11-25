# Deploying Parsimony

Parsimony runs on one host as two containers:

* **frontend** (nginx): serves the web app, terminates HTTPS, and proxies `/api` to the backend. It's
  the only container with published ports.
* **backend** (Node.js): the API and the statement parsers. It keeps the SQLite database,
  backups and JWT secret on a persistent volume at `/data`.

The `deploy` CLI in this directory builds versioned images, ships them over SSH, starts them, checks
their health, and rolls back automatically on failure.

## Requirements

**On your machine:** Node.js 22.13+, an SSH client, and Docker or Finch for local image builds (or use
`--build-mode remote`).

**On the host:**

* Linux with Docker 20.10+ and the Compose plugin (or `docker-compose`). The SSH user must be in the
  `docker` group, or have passwordless `sudo` for docker. With `--install-docker`, the CLI installs
  Docker on a Linux host that has none, using Docker's official convenience script.
* or macOS with [Finch](https://github.com/runfinch/finch) (`brew install --cask finch && finch vm init`)
  or Docker Desktop.
* Key-based SSH access: `ssh you@host` must work without a password prompt.

## First deployment

```bash
cd deployment
npm install
cp config/.env.example config/.env
$EDITOR config/.env
```

At minimum, choose `HTTP_PORT`/`HTTPS_PORT`, and for anything reachable from a network, enable HTTPS:

1. Copy your certificate and private key into `config/certs/`. The supported file names are in
   [config/README.md](config/README.md); a Let's Encrypt `fullchain.pem` + `privkey.pem` works as-is.
2. Set `ENABLE_HTTPS=true`.

Then:

```bash
npm run deploy -- --target you@server.example.com
```

The CLI checks your configuration and certificate first, before it touches the host. When it finishes
it prints the URL. On a first install it also prints the **setup code**: open the URL and use the code
to create the first administrator. (Or set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` before deploying.)

## Everyday commands

All commands take `--target`, plus `--port`, `--identity` and `--dir` when you need them.

| Command | What it does |
|---|---|
| `npm run deploy -- -t host` | Build and deploy a new release |
| `npm run deploy -- -t host --build-mode remote` | Build on the host instead (no local Docker needed) |
| `npm run rollback -- -t host` | Return to the previous release (run again to go further back) |
| `npm run status -- -t host` | Releases, containers, health, recent deploys |
| `npm run logs -- -t host [--service backend] [-f]` | Container logs |
| `npm run update-certs -- -t host` | Upload renewed certificates and restart nginx |
| `npm run users -- -t host -- list` | User CLI inside the container (`create`, `reset-password`, `set-role`) |

`--target local` runs any of these against this machine, without SSH.

## What's on the host

```
~/parsimony/                      # --dir (relative paths are under the SSH user's home)
  state.json                      # current release and history
  logs/deploy.log
  releases/<version>/             # last 5 releases: docker-compose.yml, .env (0600), certs/ (0700)
```

The data volume (`parsimony_parsimony-data`, or `DATA_VOLUME_PATH` if you set one) isn't in a release
directory. Deploys and rollbacks never touch it.

## Backups and restores

The API snapshots the database to `/data/backups/` on every start, so every deploy makes one. The
newest `BACKUP_KEEP` (default 10) are kept. To copy the live database off the host:

```bash
ssh you@host 'docker cp parsimony-backend:/data/parsimony.sqlite -' > parsimony.tar   # finch cp on macOS
```

To **move an existing database** onto a new deployment: deploy once, stop the backend, copy the file
in, then start it again:

```bash
ssh you@host 'docker stop parsimony-backend'
scp parsimony.sqlite you@host:/tmp/
ssh you@host 'docker cp /tmp/parsimony.sqlite parsimony-backend:/data/parsimony.sqlite && docker start parsimony-backend && rm /tmp/parsimony.sqlite'
```

With `DATA_VOLUME_PATH` set to a host directory, you can copy files to and from that directory instead.

## macOS hosts with Finch

Finch forwards published ports to `127.0.0.1` on the Mac only. To reach Parsimony from other machines,
run this **on the Mac** once, with your ports:

```bash
./scripts/configure-finch-ports.sh 80 443
```

It keeps your other Finch settings, backs up `~/.finch/finch.yaml`, and restarts the VM. Then redeploy.
If external access still fails, Docker Desktop for Mac publishes ports on all interfaces without extra
setup. The deploy CLI warns when it detects a Finch host without this configuration.

## Security notes

* Only nginx is published. The API listens on a private container network, and runs as an
  unprivileged user with all other Linux capabilities dropped.
* With HTTPS enabled, HTTP requests redirect to HTTPS, HSTS is sent, and only TLS 1.2/1.3 are accepted.
* `.env` and certificates never go into images. They're uploaded with restrictive permissions and
  mounted read-only.
* Without HTTPS, passwords cross the network unencrypted. Only do that on a trusted network, or behind
  another TLS-terminating proxy. In that case set `BIND_ADDRESS=127.0.0.1` and make sure the proxy
  sends `X-Forwarded-Proto` and `X-Real-IP`.
* The API refuses state-changing requests from other sites (`Sec-Fetch-Site` / `Origin` checks).
  nginx forwards the browser's `Host` with its port as `X-Forwarded-Host`, so a non-default
  `HTTPS_PORT` works. If another proxy sits in front and rewrites the host, keep its `Host` header
  as the browser sent it or set `PUBLIC_URL` to the address users open.

## Running Compose by hand

`config/docker-compose.yml` also works without the CLI:

```bash
cd config && cp .env.example .env
docker compose -p parsimony up -d --build
```

## Development

```bash
npm test          # unit tests for config validation, certificates, release state, host detection
npm run typecheck
```
