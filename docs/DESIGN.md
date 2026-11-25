# Parsimony — Design

How the system in [`SPEC.md`](SPEC.md) is built.

## 1. Architecture

```
                        ┌──────────────── target host (Docker or Finch) ────────────────┐
 browser ──HTTPS──▶     │ frontend: nginx                 backend: Node ≥ 22             │
  (SPA, access token    │  • TLS, HTTP→HTTPS redirect     • node:http router + zod       │
   in memory; refresh   │  • static SPA (hashed assets)   • node:sqlite ─▶ /data/*.sqlite │
   token in HttpOnly    │  • /api/* ──proxy──────────────▶• JWT auth, roles, audit        │
   cookie)              │  • security headers             • statement parsers (pdfjs)    │
                        │  published: HTTP/HTTPS ports    not published                   │
                        └────────────────────────────────────────────────────────────────┘
```

Without containers (`npm start`), the backend serves the built SPA itself, on `127.0.0.1:3001`.

| Module | Stack |
|---|---|
| `backend-api/` | Node.js (TypeScript run by `tsx`), `node:http` with a small router, `node:sqlite`, `zod`, `jose` (JWT), `nodemailer` (optional), `pdfjs-dist` for reading PDF statements. |
| `web-frontend/` | React 18, Vite, TypeScript, Cloudscape, React Router. |
| `deployment/` | Dockerfiles, nginx config, Compose file; a TypeScript CLI that uses the system `ssh` and `docker`/`finch`. |
| `shared/types.ts` | API types imported by both backend and frontend. |

Why these choices:

* **SQLite via `node:sqlite`** means no native module builds, works the same on macOS, Linux and in Alpine, and keeps the whole dataset in one copyable file.
* **No web framework.** The API surface is small. The ~250-line router in `http.ts` gives per-route access levels, rate-limit buckets and audit hooks in one place, which makes "every route is protected" checkable in a test.
* **scrypt (`node:crypto`) for passwords** rather than bcrypt, again to avoid native modules. Parameters are stored with each hash, so they can be raised later.
* **System `ssh` for deployment**, so operators' keys, agents, jump hosts and `~/.ssh/config` all work, and there's no SSH library to keep patched.

## 2. Backend

### 2.1 Modules

| Path | Responsibility |
|---|---|
| `config.ts` | All settings from the environment, with defaults. Relative paths resolve against the repository root. |
| `db.ts` | `Db` wrapper: `all/get/run/scalar`, boolean→0/1 binding, `tx()` with nested savepoints. FK enforcement off (see SPEC N5). |
| `migrations/NNN_*.sql`, `migrations/index.ts` | Ordered SQL migrations recorded in `schema_migrations`. Each runs in a transaction. |
| `http.ts` | Router, `Ctx` (params, query, body, user, client IP, `secure`), error mapping, security headers, static files. |
| `app.ts` | Startup sequence and wiring (below). |
| `auth/passwords.ts` | scrypt hashing (N=2¹⁷, r=8, p=1), timing-safe verification, dummy hash for unknown emails. |
| `auth/tokens.ts` | JWT signing/verification (HS256), secret loading/generation, reset-token fingerprints. |
| `auth/service.ts` | Users, sessions, sign-in, refresh rotation, revocation, setup code, password change/reset, audit log. |
| `auth/rate-limit.ts` | Fixed-window in-memory limiter, and the per-account escalating sign-in lockout. |
| `auth/mailer.ts` | Optional SMTP via nodemailer. |
| `routes/*.ts` | One module per resource. `routes/auth.ts` also holds user administration and the audit log. |
| `services/rules.ts` | The rule engine (§2.5). |
| `services/importer.ts` | Runs the parser, picks the account, flags duplicates, commits. |
| `services/backup.ts` | `VACUUM INTO` snapshots with pruning. |
| `services/demo-data.ts` | The fictional dataset used by tests and `npm run demo-data`. |
| `cli/users.ts` | `list`, `create`, `reset-password` and `set-role` from a shell. |
| `services/statements/` | Statement parsing (§2.6): `formats.ts` (the `statement_format` table, validation, matching), `parsers.ts` (card and bank row parsers), `csv.ts`, `pdf-text.ts` + `pdf-layouts.ts` (PDF layouts), `python-compat.ts`. |

### 2.2 Startup

1. Load config; a bad value aborts with a one-line message.
2. Open (or create) the database file.
3. If the file already existed, write a backup. **If the backup fails, startup stops before migrating.**
4. Apply pending migrations.
5. Load or generate the JWT secret.
6. Bootstrap: prune expired sessions and old audit entries. If there are no users, create the administrator from `ADMIN_EMAIL`/`ADMIN_PASSWORD`, or generate a setup code and print it.
7. Register routes and listen.

### 2.3 Request pipeline

```
match route → authenticate (Bearer JWT, optional) → authorize (route.access vs role)
            → rate-limit → read body (size-limited; only after auth) → handler
            → JSON / Reply → audit (non-GET routes with audit: true)
```

Access levels: `public`, `user` (any role), `editor` (EDITOR, ADMINISTRATOR), `admin`. The default is
`user` for GET and `editor` for everything else, so a new write route is protected unless someone opts
out explicitly. Read-only operations that happen to be POSTs (rule preview, dry run) declare
`access: 'user'`. A test walks `router.list()` and asserts every non-public route returns 401 without a token.

Error bodies are `{ error, code, details? }`. Unexpected errors return a generic 500, and the details
go to the server log only.

### 2.4 Authentication

**Tokens.** The access token is an HS256 JWT `{ sub: userId, sid: sessionId, typ: 'access', iat, exp }`
(15 minutes by default). The refresh token is opaque: `<sessionId>.<secret>`. Only `SHA-256(secret)` is
stored, in `user_session.token_hash`.

**Every authenticated request** checks the JWT signature and expiry, that the user exists, that
`iat ≥ tokens_invalid_before`, and that the session in `sid` still exists and hasn't expired. Revoking
a session therefore takes effect immediately, not when the access token expires.

**Refresh** (`POST /api/auth/refresh`, cookie only):

| Presented secret matches… | Result |
|---|---|
| `token_hash` | Rotate: new secret, `prev_token_hash ← token_hash`, extend expiry, new cookie + access token. |
| `prev_token_hash`, rotated ≤ 30 s ago | Another tab just rotated: new access token, cookie left alone. |
| anything else | Treated as token theft: session deleted, `auth.refresh_reuse` audited, 401. |

**Cookie**: `parsimony_refresh`, `HttpOnly; SameSite=Strict; Path=/api/auth`, plus `Secure` when the
request was HTTPS. With `COOKIE_SECURE=auto`, that means the socket is TLS, or `TRUST_PROXY=true` and
`X-Forwarded-Proto: https`.

**Revocation** — `revokeAll(user)` deletes the user's sessions and sets `tokens_invalid_before = now`.
It's used by sign-out-everywhere, password change and reset, role change, and admin password reset. A
password change then issues a fresh session for the current browser.

**First run** — the setup code is 10 characters from a 32-symbol alphabet (~50 bits). It's held in
memory only, compared in constant time, and only accepted while `app_user` is empty.

**Password reset** — a JWT `{ typ: 'reset', sub, pwh }`, where `pwh` is a fingerprint of the current
password hash. Changing the password invalidates every outstanding link. Links use `PUBLIC_URL`, never
the request's Host header, so a forged Host can't redirect a link to an attacker. The feature is
disabled unless both SMTP and `PUBLIC_URL` are configured. The mail is sent asynchronously, so response
time doesn't reveal whether an account exists.

**Rate limits** — per `route.pattern + client IP` for routes marked `limit: 'auth'` (sign-in, setup,
refresh, logout, password endpoints), and per user for everything else. The client IP is `X-Real-IP`
(set by nginx) when `TRUST_PROXY=true`, otherwise the socket address.

### 2.5 Rule engine

For each rule (ordered by index, filtered by scope):

```sql
UPDATE expense SET category = ?, exemption = ?, comment = ?
WHERE category IS NULL AND description LIKE ? AND amount >= ? AND amount <= ?
  AND account_idx IN (SELECT account_idx FROM account WHERE is_corporate = ?)
```

The filter is wrapped as `%filter%` unless it already contains `%` or `_`. Missing bounds become
±2,000,000,000. The comment is `Automatic Rule (<UTC timestamp>): Category = …, exemption = … where
<predicate with values inlined>`. A dry run executes the same statements inside a transaction and rolls
back, which gives exact first-match-wins counts. An optional test checks byte-for-byte parity with the
original Python categorizer (`LEGACY_CATEGORIZER` + `PARITY_DB`).

### 2.6 Statement import

Statements are parsed in-process from the uploaded bytes; nothing is written to disk.

**Choosing a format.** The `statement_format` table (migration 003, managed on the Statement formats
page) holds one row per file-name pattern and file type. The active format whose pattern occurs in the
file name (case-insensitive) is used; the longest pattern wins. Formats are data:

* **CSV** formats name a row parser and its settings (JSON): rows to skip, the column count (or `null`
  to read a header row and find columns by `headerNames`), zero-based column positions, and strptime
  date formats tried in order.
  * `card`: every row is an expense on one account. A separate credit column becomes negative
    expenses, and negative rows mentioning "payment" (card payments) are skipped.
  * `bank`: each row's account number is looked up in `account_num` (spaces removed). Positive amounts
    are deposits, negative are expenses; with separate columns, debits are withdrawals and credits
    deposits. "Payroll Deposit" and "Interest Paid" deposits count as income. "Cheque" descriptions get
    the cheque number. Unknown account numbers produce a warning (last 4 digits only).
* **PDF** formats name a built-in layout (`pdf-layouts.ts`): code that finds the statement period,
  account number and totals, emits rows, and reconciles them against the statement's totals (a mismatch
  is a warning). Its rows are then read by a fixed card or bank parser. `pdf-text.ts` rebuilds the text
  grid the layouts expect: pdfjs text runs are grouped into lines with pdfminer's rules (line overlap
  0.5, char margin 2.0, word margin 0.1), placed into columns by per-layout tab stops (odd/even pages),
  and into rows by snapping the line bottom to a band. Text that isn't upright is ignored.

**Accounts.** The account the user chose applies to every row. Otherwise card statements use the
account whose `statement_file_pattern` occurs in the file name (longest wins), and bank statements route
each row by its account number.

The parsers are a port of the original `statement_parser.py`. `python-compat.ts` and `csv.ts`
reproduce the Python behaviour they relied on (`strptime`, `float()`, `string.capwords`, the `csv`
module's quoting), and an optional test compares both parsers on real statements
(`LEGACY_STATEMENT_PARSER` + `STATEMENT_SAMPLES` + `PARITY_DB`). Deliberate differences: dates may have
surrounding spaces; a UTF-8 BOM is ignored; PDF pages are separated by a line break (the original joined
the last line of one page to the first of the next); a Visa statement period without a start year can
span a year end; and the period line itself is never read as a transaction.

Duplicate detection: an expense is a duplicate if a row with the same account, date, amount (to the
cent) and description exists, counting multiplicity. Deposits match on account, date and amount. An
"already has rows in this date range" warning is also given per account.

### 2.7 Migrations

* `001_baseline.sql` — the complete bookkeeping schema (tables, indexes, 22 views), every statement
  `IF NOT EXISTS`. It seeds the two report-period rows only when they're empty. On an existing database
  it changes nothing.
* `002_users_and_audit.sql` — `app_user`, `user_session`, `audit_log`, and
  `account.statement_file_pattern`.
* `003_statement_formats.sql` — `statement_format`, seeded with the formats previously hard-coded in
  the Python parser.

New migrations are new files; applied files are never edited. Rolling back a deployment doesn't undo
migrations, so migrations must stay additive: older code must keep working on the newer schema.

## 3. Web frontend

* **`AuthProvider`** (`context/AuthContext.tsx`) loads `/api/config` (setup required? reset enabled?
  currency/locale), then tries `POST /api/auth/refresh`. It schedules the next refresh a minute before
  the access token expires, and a `BroadcastChannel` signs out the other tabs.
* **`api/client.ts`** keeps the access token in a module variable (never in storage) and attaches it to
  every call. After a 401 it does a single shared refresh and retries once. The CSV export is fetched
  with the token and saved as a Blob, since a plain link can't carry an `Authorization` header.
* **Shells**: signed out → sign-in / setup / forgot / reset pages; signed in → `AppProvider` (meta,
  notifications) plus the full layout. Admin routes only exist for administrators.
* **Role-aware UI**: `useAuth().canEdit` hides create/edit/delete buttons, bulk actions, selection
  checkboxes, inline editing (`editableColumns()`), the import page and report-period editors from
  read-only users. Rule previews and dry runs stay available.
* Pages: Dashboard, Payments, Payees, Expenses, Deposits, Rules, Import, four reports, Accounts,
  Profile, Users, Audit log.

## 4. Deployment

### 4.1 Images

| Image | Base | Contents |
|---|---|---|
| `parsimony-backend` | `node:24-alpine` | Production npm deps for the backend only, `tini`, `su-exec`. The entrypoint fixes `/data` ownership, then runs as uid 1001. |
| `parsimony-frontend` | `nginx:1.27-alpine` | The built SPA (source maps removed) and Parsimony's nginx config. |

`/docker-entrypoint.d/40-configure-parsimony.sh` writes the server blocks at container start. That's
how HTTPS, the redirect and `SERVER_NAME` follow `.env` and the mounted certificates without a rebuild.

### 4.2 Compose

* `backend`: no published ports; `env_file: .env`; `/data` on `${DATA_VOLUME_PATH:-parsimony-data}`;
  health check `GET /api/health`; `cap_drop: ALL` with only what the entrypoint needs; log rotation.
* `frontend`: waits for a healthy backend; publishes `${BIND_ADDRESS}:${HTTP_PORT}:80` and `:443`;
  mounts `./certs` read-only; health check `GET /health`.
* Project name is always `parsimony`, so the named data volume stays the same across releases.

### 4.3 Deploy CLI

```
deployment/src/
  cli.ts        argument parsing, command dispatch
  commands.ts   deploy / rollback / status / logs / update-certs / users
  host.ts       one-shot host probe → Docker vs Finch, sudo, compose flavour, platform
  release.ts    .env parsing & validation, certificate checks, compose rendering, release state
  ssh.ts        system ssh with ControlMaster multiplexing, BatchMode
  local.ts      the Shell interface, and LocalShell for --target local
```

On the host:

```
~/parsimony/                       (--dir)
  state.json                       { current, releases (newest first, max 5), history }
  logs/deploy.log                  transcript of every deploy
  releases/<version>/
    docker-compose.yml             build: sections stripped
    .env                           mode 0600, IMAGE_TAG=<version>
    certs/                         mode 0700
```

`deploy`: validate `.env` and certificates locally → connect → probe and prepare the host → build
images (local: `build --platform <host arch>`, then `save | gzip | ssh … load`; remote: upload the
source as a tar and build there) → upload the release directory → `compose -p parsimony up -d` → poll
until `parsimony-frontend` answers `/health` **and** reaches `backend:3001/api/health`, failing fast
if a container exits. On success: record the release, prune old releases and their images, and print
the URL (and the setup code on a first install). On failure: print container logs, record the failure,
and restart the previous release (or `down` on a first install).

Version tags are `YYYYMMDD-HHMMSS[-gitsha]` in UTC.
