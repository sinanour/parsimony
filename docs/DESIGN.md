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
match route → same-origin check (non-GET/HEAD/OPTIONS) → authenticate (Bearer JWT, optional)
            → authorize (route.access vs role) → rate-limit → content-type check (JSON routes)
            → read body (size-limited; only after auth) → handler
            → JSON / Reply → audit (non-GET routes with audit: true)
```

**Same-origin check** (`checkSameOrigin`, every state-changing route including bodyless ones such as
refresh and logout, and the raw statement upload). 403 `CROSS_SITE_REQUEST` when:

1. `Sec-Fetch-Site` is present and not `same-origin` or `none` (`same-site` is refused too). Browsers set
   this header and pages can't forge it, so `same-origin` is accepted without looking further.
2. Otherwise `Origin` is present and is `null`, unparsable, or not this server: it must equal the
   `PUBLIC_URL` origin, or `scheme://host` where scheme comes from `isSecure()` and host from
   `X-Forwarded-Host` (with `TRUST_PROXY=true`) or `Host`. Behind a trusted proxy the scheme isn't
   compared (an outer TLS hop may talk HTTP to nginx), and when the forwarded host has no port (nginx's
   `$host` strips it) only the host name is compared. nginx sends `X-Forwarded-Host $http_host`, which keeps
   the port, so deployments on a non-default port (`https://host:19100`) compare host and port exactly.

Requests with neither header are not from a browser, so they can't carry a victim's cookie, and pass.

**Content type.** Non-raw routes parse JSON only when the body is labelled `application/json` (with
optional parameters) or `application/*+json`; any other type on a declared body, or a non-empty body with
no type, is 415 `UNSUPPORTED_MEDIA_TYPE` before the body is buffered. A cross-site `<form>` can only send
`text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data`, so it can't reach a JSON route
even in a browser without Fetch Metadata or Origin. Raw routes (`{ raw: true }`, statement upload) take
their body as is. Bodyless POSTs need no type.

Not adopted: refusing sign-in while a valid refresh cookie is present (the cookie is `SameSite=Strict`, so
a cross-site login never carries it, and it would block switching accounts), a double-submit token (the
checks above already cover it), and the `__Host-` cookie prefix (it needs `Path=/` and `Secure`, which
conflicts with scoping the cookie to `/api/auth` and with HTTP-only deployments).

Access levels: `public`, `user` (any role), `editor` (EDITOR, ADMINISTRATOR), `admin`. The default is
`user` for GET and `editor` for everything else, so a new write route is protected unless someone opts
out explicitly. Read-only operations that happen to be POSTs (rule preview, dry run) declare
`access: 'user'`. A test walks `router.list()` and asserts every non-public route returns 401 without a token.

**Read-only masking.** Read-only users never receive a full card or bank number (SPEC A3). Numbers hide
in account names ("Visa (4505 …)"), payee account numbers, statement descriptions and confirmations, so
masking is a property of the response, not of individual routes: when the caller is `READ_ONLY` the router
passes every JSON body (and error body) through `redactValue` (`src/redact.ts`). Fields that are account
numbers (`accountNum`, `accountNumbers`, …) are cut to `••••` + their last four characters; in every other
string, any run of at least 7 digits — single spaces or dashes may separate the groups, as in
`0812 3456-789` — becomes `••••` + its last four digits. ISO dates and timestamps, round numbers (the rule
engine's `2000000000` bounds) and JSON numbers (amounts, ids) are left alone. Text `Reply` bodies are
redacted the same way unless the handler did it itself (`Reply.redacted`; the corporate CSV redacts its
cells so amounts stay intact). Only the auth routes, which return the caller's own tokens and no
bookkeeping data, opt out (`redact: false`). So that searches can't confirm masked digits, `q` searches,
the expense category filter, text sorts and rule previews match a read-only user against the redacted text
(`visibleSql()` wraps the column in the `redact_digits()` SQL function `Db` registers). Stored data is never
changed. A test crawls every GET route in `router.list()` as a read-only user and fails on any leaked digits.

Error bodies are `{ error, code, details? }`. Unexpected errors return a generic 500, and the details
go to the server log only.

**Text lengths.** Every persisted free-text field is capped (`TEXT_LIMITS` in `shared/types.ts`, used by
the zod schemas through `requiredText` / `text` / `trimmedOrNull(max)` in `routes/common.ts`, and by the
frontend as input `maxLength`). The caps leave wide headroom over real bank data (longest observed
description 83, category 66, comment 331 characters; rule-written comments are at most ~550). Without them
one editor could store megabyte categories that every user then downloads in `/api/meta`, or long
descriptions and filters that make each rule match count a description-length × filter-length LIKE.
Legacy rows written before the caps are never altered; instead the shared reads ignore them:
`/api/meta` leaves out categories and payee categories longer than the cap and returns account names cut
to it, and match counts (`GET /api/rules`, `/api/rules/:id`) and previews skip rules whose filter, and
expenses whose description, is longer than the cap (such a rule reports 0 matches). Running the rules
still applies them as stored. To find such rows (nothing deletes them automatically):

```sql
SELECT 'expense', expense_idx, length(description), length(category), length(comment) FROM expense
 WHERE length(description) > 500 OR length(category) > 100 OR length(comment) > 2000;
SELECT 'deposit', deposit_idx, length(description), length(comment) FROM deposit
 WHERE length(description) > 500 OR length(comment) > 2000;
SELECT 'rule', expense_categorization_rule_idx, length(description_filter), length(category)
  FROM expense_categorization_rule WHERE length(description_filter) > 200 OR length(category) > 100;
SELECT 'account', account_idx, length(name) FROM account WHERE length(name) > 100;
SELECT 'payee', payee_idx, length(payee), length(payee_category) FROM payee
 WHERE length(payee) > 200 OR length(payee_category) > 100 OR length(account_num) > 64;
```

### 2.4 Authentication

**Tokens.** The access token is an HS256 JWT `{ sub: userId, sk: accessKey, typ: 'access', iat, exp }`
(15 minutes by default). The refresh token is opaque: `<sessionId>.<secret>`. Only `SHA-256(secret)` is
stored, in `user_session.token_hash`. `sk` is the session's `user_session.access_key`, a random value
unrelated to the session id, so an access token (even a leaked, expired one) never reveals any part of the
refresh cookie. Tokens from before migration 007 carried the raw session id as `sid`; they are refused as
`TOKEN_EXPIRED`, which the SPA answers by refreshing with its cookie (sessions without an access key get one
on that refresh).

**Every authenticated request** checks the JWT signature and expiry, that the user exists, and that the
session whose `access_key` is `sk` still exists for that user, hasn't expired and was created strictly after the user's
revocation instant (`user_session.created_ms > app_user.revoked_at_ms`, both epoch milliseconds; the JWT's
whole-second `iat` is too coarse). Revoking a session therefore takes effect immediately, not when the
access token expires. Refresh applies the same session checks and deletes a session that fails them.

**Refresh** (`POST /api/auth/refresh`, cookie only):

| Presented secret matches… | Result |
|---|---|
| `token_hash` | Rotate: new secret, `prev_token_hash ← token_hash`, old hash added to `user_session_superseded` (last 50 kept per session), extend expiry, new cookie + access token. |
| `prev_token_hash`, rotated ≤ 30 s ago | Another tab just rotated: new access token, cookie left alone. |
| `prev_token_hash` rotated longer ago, or a hash in `user_session_superseded` | A copy of an old cookie is in use — treated as token theft: session deleted, `auth.refresh_reuse` audited, 401 `SESSION_REVOKED`. |
| nothing (or no such session) | 401 `SESSION_EXPIRED`; the session is left untouched and nothing is audited. |

Only a matching secret counts against the per-session refresh limit, and only then are expiry and
revocation checked (a dead session is then deleted, 401 `SESSION_EXPIRED`). So the session id alone — the
part of the cookie before the dot — can't end a session, write audit rows in its owner's name, spend its
refresh budget, or tell whether it exists: an unknown id, a wrong secret and an expired or revoked session
all get the same response.

**Sign-out** (`POST /api/auth/logout`) deletes the session (and audits `auth.logout`) only when the cookie's
secret is the session's current one, or its previous one within the 30-second grace window; otherwise it
does nothing. It always answers 204. Sign-out and a failed refresh clear the cookie (`Max-Age=0`) only when
the request carried one.

**Cookie**: `parsimony_refresh`, `HttpOnly; SameSite=Strict; Path=/api/auth`, plus `Secure` when the
request was HTTPS. With `COOKIE_SECURE=auto`, that means the socket is TLS, or `TRUST_PROXY=true` and
`X-Forwarded-Proto: https`.

**Revocation** — `revokeAll(user)` deletes the user's sessions and moves `revoked_at_ms` to now, but
strictly past its previous value and every deleted session's `created_ms`, so nothing created up to that
point is accepted even within the same millisecond. A new session is stamped
`created_ms = max(now, revoked_at_ms + 1)`, so the fresh session a password change (or first-run setup)
issues right after its own revocation works. The legacy `tokens_invalid_before` (seconds) is still written
for older code after a rollback. `revokeAll` is used by sign-out-everywhere, password change and reset,
role change and admin password reset; admin edits and deletion sweep the user's sessions once more after
committing. A new account's `revoked_at_ms` starts at its creation instant, and startup deletes sessions
whose user is gone or that predate its revocation.

**Sign-in** — the account is read, the password verified (scrypt, which yields the event loop), and then,
in one transaction, the account is re-read and the session inserted only if it still exists with the same
`user_id`/`created_at`, the same `password_hash` that was verified and an unchanged `revoked_at_ms`.
Otherwise the sign-in is a 401 (audited as `auth.login_failed`, not counted towards the lockout). A
deletion, password reset or role change therefore either lands first and the sign-in fails, or lands
after and removes the new session. Sign-in doesn't take the per-user lock, so a slow sign-in never delays
an administrator's action.

**Credential writes** — password change, password reset, admin edits (role/password/name), user deletion
and session revocation for one user are serialised by an in-process per-user lock (`auth/locks.ts`) held
across the precondition check, the scrypt hash (which yields the event loop) and the write. Because the
`users` CLI runs in another process, each writer also re-checks inside its write transaction: the row still
exists with the same `user_id` *and* `created_at`; the password hash is still the one that was verified
(`UPDATE … WHERE password_hash = ?`, else 409); a password change refuses (401) if `revoked_at_ms`
moved since the request arrived, and inserts its replacement session in the same transaction so a later
revocation removes it; the last-administrator guard is re-evaluated; and duplicate emails (including a
UNIQUE violation) are 409. `app_user.user_id` is `AUTOINCREMENT` (migration 004), seeded past every id seen
in `app_user`, `user_session` and `audit_log`, so a deleted user's id is never given to someone else.

**First run** — the setup code is 10 characters from a 32-symbol alphabet (~50 bits). It's held in
memory only, compared in constant time, and only accepted while `app_user` is empty.

**Password reset** — a JWT `{ typ: 'reset', sub, pwh }`, where `pwh` is a fingerprint of the current
password hash. Changing the password invalidates every outstanding link. Links use `PUBLIC_URL`, never
the request's Host header, so a forged Host can't redirect a link to an attacker. The feature is
disabled unless both SMTP and `PUBLIC_URL` are configured. The mail is sent asynchronously, so response
time doesn't reveal whether an account exists.

**Rate limits** — per `route.pattern + client IP` for routes marked `limit: 'auth'` (sign-in, setup,
refresh, logout, password endpoints), and per user for everything else. Routes marked `limit: 'heavy'`
(statement parse and commit, rule runs and dry runs, statement-format writes) also count against a much
smaller per-user budget. The client IP is `X-Real-IP`
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
back, which gives exact first-match-wins counts. Each `UPDATE … RETURNING expense_idx` is the rule's only
pass over the data (the partial index `expense_uncategorized_IDX` limits it to uncategorized rows); the
drill-down list is read back by id. A scope may hold at most `RULES_MAX_PER_SCOPE` rules (default 2,000):
creating one more is refused, and a run over a scope that already holds more is refused rather than half
applied. Runs and dry runs draw on the per-user `heavy` rate limit. An optional test checks byte-for-byte parity with the
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
"already has rows in this date range" warning is also given per account. Both are computed with one query
per record type for the whole statement (the distinct keys are passed as a JSON array), not per record.

**Bounds.** One request can only do a bounded amount of work, because the server is a single thread:

* A parse producing more than `IMPORT_MAX_RECORDS` records (default 10,000; years of one account) is
  refused with 413 `TOO_MANY_RECORDS`, and parsing stops as soon as the cap is passed. A commit with more
  records than that is refused the same way before any record is validated.
* Date formats: every directive (except `%%`) may appear once, as in Python. Together with the anchored
  pattern and bounded-width fields, this keeps the number of ways a cell can be split small and constant,
  so no format can backtrack exponentially (the pentest's `%Y` + 29 × `%H` + `Z` took 15 s on a 62-character
  cell). Date cells longer than 40 characters are rejected before any matching. A stored format that no
  longer compiles (saved before this rule) is skipped with a warning, never run.
* Parsed descriptions longer than `TEXT_LIMITS.description` (500) are cut to it, with one warning per
  file, so a commit of the parse result always validates; a commit carrying a longer description or
  category (only possible from a hand-built request) is refused with 400, and nothing is inserted.
* Parse, commit, rule runs (including dry runs) and statement-format writes share a per-user `heavy` rate
  limit (`HEAVY_RATE_LIMIT_PER_MINUTE`, default 30) on top of the general per-user limit.

### 2.7 Migrations

* `001_baseline.sql` — the complete bookkeeping schema (tables, indexes, 22 views), every statement
  `IF NOT EXISTS`. It seeds the two report-period rows only when they're empty. On an existing database
  it changes nothing.
* `002_users_and_audit.sql` — `app_user`, `user_session`, `audit_log`, and
  `account.statement_file_pattern`.
* `003_statement_formats.sql` — `statement_format`, seeded with the formats previously hard-coded in
  the Python parser.
* `004_user_id_autoincrement.sql` — rebuilds `app_user` with `AUTOINCREMENT` ids (never reused).
* `005_revocation_ms.sql` — adds `app_user.revoked_at_ms` and `user_session.created_ms` (converted from
  the existing second/ISO values) and drops sessions that are orphaned or not after their revocation.
* `006_uncategorized_expense_index.sql` — partial index `expense_uncategorized_IDX` on
  `expense(account_idx) WHERE category IS NULL`, so rule runs and match counts only visit uncategorized rows.
* `007_session_access_key.sql` — `user_session.access_key` (unique; what access tokens carry instead of the
  session id; null for existing sessions until their next refresh) and `user_session_superseded` (hashes of
  rotated-away refresh secrets, backfilled from `prev_token_hash`, deleted with their session by a trigger).

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
