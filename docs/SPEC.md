# Parsimony — Specification

Parsimony is a self-hosted web app for household and small-business bookkeeping. It covers bank and
credit-card accounts, bill payees and payments, statement imports, expense and deposit categorization,
rule-based auto-categorization, and reports. It keeps its data in a single SQLite file, runs on
one machine with `npm start`, and can be deployed to any SSH-reachable Linux or macOS host as Docker
(or Finch) containers behind HTTPS with multi-user authentication.

This document covers *what* the system does. [`DESIGN.md`](DESIGN.md) covers *how*.

## 1. Goals and non-goals

Goals

* G1 — One tool for the bookkeeping workflow: import statements, categorize, track bills, report.
* G2 — Data stays with whoever runs it: one SQLite file, no external services needed (email is optional).
* G3 — Safe to expose on a network: authenticated, role-based, HTTPS, rate-limited and audited.
* G4 — Easy to run: `npm install && npm start` locally, or one `deploy` command to a remote host.
* G5 — Nothing machine- or person-specific in the repository. Paths, account numbers, credentials,
  hosts, currency and locale all come from configuration or the database.

Non-goals (v1)

* Separate, isolated ledgers per user (multi-tenancy). All users of one installation share one
  dataset, as a household or a small team does. Roles control what each user may do.
* Bank connections or automatic statement downloads.
* Offline or mobile apps. The web UI is responsive enough for a tablet.

## 2. Repository layout

The repository has three modules, plus types shared by two of them:

| Module | Contents |
|---|---|
| `backend-api/` | Node.js + TypeScript API server, SQLite access and migrations, auth, statement-parser bridge, CLI for user administration, tests. |
| `web-frontend/` | React + Vite + TypeScript single-page app built with the Cloudscape design system. |
| `deployment/` | Dockerfiles, nginx config, Docker Compose file, environment template, and a TypeScript CLI that deploys to, rolls back and inspects remote hosts over SSH. |
| `shared/` | API request/response types used by both `backend-api` and `web-frontend`. |
| `docs/` | This spec and the design. |

The root `package.json` is an npm workspace covering `backend-api` and `web-frontend`. `deployment`
is a separate package because only operators need it.

## 3. Users and environments

* E1 — **Local, single machine.** `npm start` builds the UI and serves UI and API from one process on
  `127.0.0.1:3001`. Auth still applies, so the same data can later be exposed remotely without changes.
* E2 — **Remote host.** Containers run on a Linux server (Docker) or a Mac (Finch). Only nginx is
  published on the host network (HTTP, and HTTPS when certificates are present). The API and the
  database file are reachable only through nginx.
* E3 — **Development.** `npm run dev` runs the API with reload and Vite with hot module replacement.
  Vite proxies `/api` to the API server.

## 4. Domain model

| Concept | Table / view | Notes |
|---|---|---|
| Account | `account`, `account_num` | Bank, credit-card or cash accounts. Flags: `is_credit_card`, `is_corporate` (business account), `is_active`. An account can have several account numbers (card reissues). Statement imports match on them through `vw_account`. `statement_file_pattern` (optional) is matched against uploaded file names to choose the account for formats that don't contain account numbers. |
| Payee | `payee` | A bill recipient. `payment_period` is the number of months between payments (1, 2, 3, 12…). `payee_category` is free text. |
| Payment | `payment` | A bill payment from a payer account to a payee. Next due date = last payment + `payment_period` months (`vw_last_payment`). "Due soon" = within 15 days, or 30 days for periods of 6 months or more (`vw_upcoming_payments`). |
| Expense | `expense` | A debit from a statement. `category` NULL = uncategorized. `exemption`: **≤ 1 is a fraction of the amount; > 1 is a fixed amount** (see `vw_expense`). `comment` records which automatic rule categorized it. |
| Deposit | `deposit` | A credit from a statement. `income_amount` is the part that counts as income (0 for transfers). `reviewed` = 1 once classified. |
| Categorization rule | `expense_categorization_rule` | `description_filter` is a SQL LIKE pattern, wrapped in `%…%` unless it already contains `%`/`_`. Optional inclusive `minimum_amount`/`maximum_amount`. Sets `category` + `exemption`, scoped to personal or business accounts. Rules apply in ascending index order, and the first match wins. |
| Huqúqu'lláh period | `huquq_date_range` | Single row. Drives `vw_huquq_*` and `vw_expense_summary_for_date_range` (19% of income less exemptions). |
| Business (corporate) period | `corporate_date_range` | Single row. Drives `vw_corporate_transactions_for_date_range` (accountant export). |
| User | `app_user` | Email (unique, case-insensitive), display name, password hash, role, revocation instant (`revoked_at_ms`, plus legacy `tokens_invalid_before` in seconds), timestamps. User ids are never reused after a deletion. |
| Session | `user_session` | One row per signed-in browser: hashed refresh token, creation instant (ms), expiry, last use, IP and user agent. |
| Audit entry | `audit_log` | Who did what and when: auth events, user administration and every data-changing API call. |
| Schema version | `schema_migrations` | Migrations that have been applied. |

## 5. Functional requirements — bookkeeping

### 5.1 Dashboard
* D1 — Counts of uncategorized expenses and unreviewed deposits (personal and business), each linking to a pre-filtered list.
* D2 — Bills due soon, with a one-click "Record payment" pre-filled from the last payment.
* D3 — Spending by month for the last 12 months (personal), stacked by top categories.
* D4 — Statement coverage: active accounts whose last transaction month is before last month, or that have missing months.

### 5.2 Accounts
* A1 — List accounts with flags, number of account numbers, first/last transaction month and missing-month count. Filter by active / personal / business / credit card.
* A2 — Create and edit an account: name, credit card, business, active, its account numbers and an optional statement file-name pattern.
* A3 — Account numbers are masked (last 4 digits) by default and can be revealed by editors and administrators. Read-only users only ever receive masked numbers from the API.
* A4 — Delete only when the account has no expenses, deposits or payments. Otherwise the user is told to deactivate it.

### 5.3 Payees
* P1 — List payees with category, period, active flag, last payment date/amount and next due date.
* P2 — Create / edit / deactivate. Category is free text with suggestions from existing values.
* P3 — Delete only when the payee has no payments.

### 5.4 Payments
* M1 — "Upcoming" view: each active payee's last payment and next due date, with status *Overdue / Due soon / Scheduled*.
* M2 — "History" view: paginated, filterable by payee, payer account, date range and text (confirmation #), sortable by date/amount.
* M3 — Record a payment: payee (active only), date (default today), amount, confirmation #, payer account. Amount and payer account are pre-filled from the payee's last payment.
* M4 — Edit and delete payments.

### 5.5 Transactions
* T1 — Expenses list with server-side pagination. Filters: scope (personal/business/all), account, category (incl. *Uncategorized*), date range, description text. Sort by date/amount/description.
* T2 — Inline edit of category (suggestions from existing categories for the scope) and exemption; edit of comment.
* T3 — Bulk edit: select rows → set category and/or exemption.
* T4 — "Create rule from transaction": opens the rule editor pre-filled with a filter derived from the description.
* T5 — Deposits list with the same filters. Edit income amount, reviewed flag, description and comment. Bulk actions: *Mark as income* (income = amount, reviewed) and *Mark as transfer* (income = 0, reviewed, comment "Transfer").
* T6 — Manual entry of an expense or deposit (cash, corrections), and delete.
* T7 — Exemptions shown in human form (e.g. "100%", "90%", "$20.00") along with the exempt amount.

### 5.6 Categorization rules
* R1 — List rules for the selected scope, with the number of uncategorized expenses each would match.
* R2 — Create / edit / delete rules. The editor shows a live preview of matching uncategorized expenses.
* R3 — Run rules: a dry run shows, per rule, how many rows it would categorize (first match wins) and lets the user drill into them. *Apply* performs the update in one transaction and writes an `Automatic Rule (…)` comment on each row. Read-only users may dry-run ("Preview rules") but not apply. A scope holds at most `RULES_MAX_PER_SCOPE` rules (default 2,000).
* R4 — Rule semantics: LIKE wrapping, inclusive min/max, scope by `account.is_corporate`, ordering by index, `category IS NULL`. A cleared category is always stored as NULL, never `''`.

### 5.7 Statement import
* I1 — Upload one or more CSV/PDF statements. The file name selects the **statement format** (e.g. "RBC Personal Visa … .pdf"): the active format of the same file type whose pattern occurs in the name (case-insensitive; the longest pattern wins). A file no format matches produces a warning pointing to the Statement formats page.
* I2 — Statements are parsed by the API server itself (TypeScript; PDFs with pdfjs). No external interpreter is needed. The target account comes from one of these, in order:
  1. the account the user picked in the UI,
  2. account numbers contained in the statement itself, matched against `account_num` (bank statements),
  3. the account whose `statement_file_pattern` occurs in the file name (case-insensitive; the longest match wins; card statements).
  If none of these yields an account, the file produces a warning asking the user to pick one.
* I3 — Preview every parsed record with account, date, description, amount and type. Records that already exist (same account, date, amount and description, counting multiplicity) are flagged as duplicates and unselected by default. Parser warnings (e.g. totals that don't reconcile) are shown prominently.
* I4 — Commit selected records in one transaction, optionally running categorization rules afterwards.
* I5 — One statement parse may yield, and one commit may insert, at most `IMPORT_MAX_RECORDS` records (default 10,000); larger files or batches are refused (413 `TOO_MANY_RECORDS`) and must be split.

### 5.8 Statement formats
* F1 — List formats with name, file-name pattern, file type, statement kind, column mapping, date formats and status; filter by text and file type. Editors and administrators manage them; the page is hidden from read-only users, like Import.
* F2 — Create, edit, duplicate, deactivate and delete formats. A pattern can be used once per file type.
* F3 — **CSV formats** are entirely data: statement kind (*credit card*: one account per file, credits are refunds, card payments skipped; *bank account*: an account number on each row, money in is a deposit), rows to skip, and either fixed column positions with a column count or column titles read from a header row, plus date formats tried in order (Python `strptime` directives, each at most once per format; date cells longer than 40 characters never match). A sample file can be previewed in the editor with numbered columns; it never leaves the browser.
* F4 — **PDF formats** pick one of the built-in PDF layouts (RBC bank account statement, RBC Visa statement). Layouts are code because they locate periods, account numbers and totals; a statement whose transactions don't add up to its totals produces a warning.
* F5 — The built-in formats are seeded by a migration and can be edited like any other.

### 5.9 Reports
* G1 — Huqúqu'lláh: edit the date range; show the payment estimate, expense summary by category and exemption class, and income by description.
* G2 — Business: edit the date range; table of business transactions with CSV download for the accountant.
* G3 — Payment totals by year and payee, filterable by year.
* G4 — Statement coverage per account.

## 6. Functional requirements — users, authentication and authorization

### 6.1 Roles

| Role | Read data | Create / edit / delete data, import, run rules, change report periods | Manage users, view audit log |
|---|---|---|---|
| `ADMINISTRATOR` | ✓ | ✓ | ✓ |
| `EDITOR` | ✓ | ✓ | — |
| `READ_ONLY` | ✓ (account numbers masked) | — | — |

* U1 — The server enforces roles on every endpoint. The UI hides or disables actions the user's role doesn't allow. That is a convenience only; the server is what enforces access.
* U2 — There is always at least one administrator. The API refuses to delete or demote the last one, including when several such changes are made at the same time.

### 6.2 First run
* U3 — If no users exist at startup and `ADMIN_EMAIL` + `ADMIN_PASSWORD` are set, that administrator is created. The variables are ignored once any user exists.
* U4 — Otherwise the server generates a one-time **setup code** and prints it to its log. The sign-in page then offers "Create the first administrator", which requires the setup code. A remote installation therefore can't be claimed by whoever reaches it first.
* U5 — A command-line tool (`npm run users -w backend-api -- …`, also available inside the container) can list users, create a user and reset a password, for recovery when no administrator can sign in.

### 6.3 Sign-in and sessions
* U6 — Users sign in with email and password. A failed sign-in gets the same error whether the email exists or not.
* U7 — A successful sign-in creates a session: a short-lived **access token** (JWT, 15 minutes by default) returned to the page and kept in memory only, plus a long-lived **refresh token** (7 days by default, rotated on every use) in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`, marked `Secure` whenever the request arrived over HTTPS.
* U8 — The page silently refreshes the access token before it expires and after a reload. If a refresh token is presented that has already been rotated away (possible theft), the whole session is revoked.
* U9 — Sign out revokes the current session. "Sign out everywhere" revokes all of the user's sessions and invalidates their outstanding access tokens.
* U10 — Changing a password, changing a role, or an administrator resetting a password revokes all of that user's sessions.
* U10a — Concurrent changes to one user's credentials take effect in the order they were made: an administrator's "sign out all sessions", password reset or deletion always wins over a password change that was already in progress (the session that change handed out is revoked too), and a change never lands on a different account.
* U10b — A sign-in that is in progress when the account is deleted, its password reset, its role changed or its sessions revoked fails (401) and leaves no session; a sign-in never issues a session that such a change made before it completed would have revoked.
* U11 — Every authenticated request and every refresh re-checks that the user still exists and that the session was created strictly after the user's last revocation (millisecond precision, so a token minted in the same second as a revocation is rejected).

### 6.4 Password management
* U12 — Passwords are 8–128 characters and stored only as salted, memory-hard hashes (scrypt).
* U13 — Users can change their own password (current password required) and display name on a Profile page.
* U14 — Administrators can create users with an initial password, change roles and display names, reset passwords and delete users.
* U15 — **Forgot password (optional).** When SMTP **and** `PUBLIC_URL` are configured, the sign-in page offers "Forgot password?". Reset links are always built from `PUBLIC_URL`, never from the request's Host header. The API always replies with the same message whether or not the email exists. Reset links expire after 30 minutes and stop working once the password has been changed. Without SMTP the link is hidden and an administrator resets passwords instead.

### 6.5 Abuse protection and audit
* U16 — Abuse limits, none of which one caller can spend on another's behalf. Exceeding a limit returns 429 with `Retry-After`; throttled attempts are audited (at most one row per key per minute).
  * Sign-in: after 5 consecutive failures for an email (registered or not, so a lock reveals nothing) it is locked for 1 minute, doubling with each further failure up to 15 minutes; a successful sign-in clears the streak. Separately, each client IP may fail at most 100 sign-ins per minute; successful sign-ins never count. Failed sign-ins for a registered email are audited against that user.
  * Refresh: limited per session (default 30/minute); requests without the refresh cookie are rejected before any limit is counted. Sign-out is not rate-limited.
  * Setup and password-reset endpoints: per client IP (default 10 requests/minute); password change: per user.
  * Other API calls are rate-limited per user (default 600/minute). Expensive ones — statement parse and commit, rule runs and dry runs, statement-format writes — also share a smaller per-user budget (default 30/minute).
* U17 — The audit log records sign-in success and failure, sign-out, password changes and resets, user administration, and every data-changing request (user, method, path, status, IP, time). Administrators can browse it in the UI. Entries older than `AUDIT_RETENTION_DAYS` (default 365) are pruned at startup.

## 7. Non-functional requirements

### 7.1 Data
* N1 — **SQLite is the only database.** The file path is configurable. Its default is `data/parsimony.sqlite` in the repository for local runs, and `/data/parsimony.sqlite` on a persistent volume in containers.
* N2 — **Schema migrations** run automatically at startup, in order, each in a transaction, and are recorded in `schema_migrations`. The baseline migration creates the bookkeeping schema if it is missing and leaves an existing database untouched, so databases created by earlier versions or by the original Python scripts upgrade in place. Later migrations only add things (new tables, new nullable columns).
* N3 — A timestamped backup (`VACUUM INTO`) is written at every startup **before** migrations run. The newest `BACKUP_KEEP` (default 10) are kept.
* N4 — All multi-row writes are atomic. SQL is always parameterized. Inputs are validated on the server.
* N5 — Foreign-key enforcement stays off (the schema declares `ON DELETE CASCADE`). Referential checks are explicit, so deleting a record can never silently delete transactions.
* N6 — Tests run against a freshly migrated temporary database seeded with synthetic data and never touch a real database.

### 7.2 Security
* S1 — No secrets in the repository or in images. `.env` files, certificates and data are git- and docker-ignored. Templates (`.env.example`) use obvious placeholders.
* S2 — The JWT signing secret comes from `JWT_SECRET` (at least 32 characters) if set. Otherwise a random secret is generated on first start and stored next to the database with mode `0600`.
* S3 — In containers, TLS terminates at nginx with TLS 1.2/1.3 only. When HTTPS is enabled, HTTP redirects to HTTPS (except the health check), and HSTS is sent.
* S4 — Security headers on every response: `Content-Security-Policy` (scripts from self only), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors 'none'`. API responses are `Cache-Control: no-store` so no proxy or browser cache keeps one user's data.
* S5 — The API and UI are served from one origin, so CORS stays disabled. API calls carry the access token in the `Authorization` header (not a cookie), which makes them immune to CSRF. The refresh cookie is `SameSite=Strict`.
* S5a — State-changing API requests (anything but GET/HEAD/OPTIONS) from another site are refused with 403 `CROSS_SITE_REQUEST`: `Sec-Fetch-Site` must be `same-origin` (or `none`), and an `Origin` header, when sent, must be this server's (`PUBLIC_URL`, or the scheme and host the browser connected to). `Origin: null` is refused. Clients that send neither header (curl, scripts) are not affected. Routes that take a JSON body accept only `application/json` (parameters and `+json` types allowed); any other or missing content type on a non-empty body is 415 `UNSUPPORTED_MEDIA_TYPE`, so an HTML form can't submit to them. This closes login CSRF: an off-site page can't sign a visitor into another account by planting its refresh cookie.
* S6 — The API container runs as a non-root user with all other Linux capabilities dropped, and is not published on the host network. In the nginx container only the master process runs as root (to read the TLS key and bind ports); workers run unprivileged.
* S7 — Statements are parsed in memory from size-limited uploads and never written to disk. PDFs are read with pdfjs, which runs no code from the document.

### 7.3 Packaging and deployment
* K1 — **Containers.** A backend image (Node + the API) and a frontend image (nginx serving the built SPA and proxying `/api` to the backend) are orchestrated by one Docker Compose file. Both images have health checks. Container logs are rotated.
* K2 — **Persistent data.** The SQLite file, its backups and the generated JWT secret live on one volume mounted at `/data`. This is a named volume by default, or a host directory via `DATA_VOLUME_PATH`. Removing or replacing containers never removes data.
* K3 — **HTTPS.** Certificates placed in `deployment/config/certs/` (any of `fullchain.pem`/`privkey.pem`, `fullchain1.pem`/`privkey1.pem`, `server.crt`/`server.key`, `cert.pem`/`key.pem`, in any subdirectory) are copied to the host, mounted read-only, validated, and used when `ENABLE_HTTPS=true`. Renewing a certificate needs a redeploy or an nginx restart, not an image rebuild.
* K4 — **Deploy CLI** (`deployment/`): `deploy`, `rollback`, `status` and `logs` against a target given as `[user@]host`, using the operator's own `ssh` (keys, agent and `~/.ssh/config` all work). `deploy`:
  1. checks SSH connectivity, the remote OS and CPU architecture, and the container runtime and compose command (Docker + `docker compose`/`docker-compose`, or Finch + `finch compose` on macOS, starting the Finch VM if needed; `sudo` is used when the user can't reach the Docker socket);
  2. optionally installs Docker on Linux hosts when `--install-docker` is given;
  3. builds versioned images locally for the remote architecture and streams them over SSH (`--build-mode local`, default), or uploads the source and builds on the host (`--build-mode remote`);
  4. validates the configuration and certificates, then uploads the Compose file, environment and certificates into a new release directory;
  5. starts the release, waits for both health checks, and **automatically rolls back** to the previous release if they don't pass, printing the container logs;
  6. records the release history on the host, keeps the last 5 releases, and prunes older images.
* K5 — `rollback` restarts the previous release and verifies its health. `status` shows releases and container health. `logs` shows (or follows) container logs, which is also where the first-run setup code appears. `update-certs` uploads renewed certificates and restarts nginx. `users` runs the user-administration CLI inside the API container. `--target local` runs any command on the current machine without SSH.
* K6 — On macOS hosts the CLI warns when Finch only forwards ports to localhost, and the repository includes a script that configures Finch for external access.
* K7 — Static assets have content-hashed names and are served with a one-year immutable cache. `index.html` is never cached.
* K8 — Nothing in the deployment depends on a particular host: the remote path, ports, hostnames and data location are all configuration.

### 7.4 UI and configuration
* N7 — The UI uses Cloudscape components exclusively, with no custom CSS beyond what Cloudscape requires.
* N8 — Currency and locale for formatting are configurable (`CURRENCY`, default `CAD`; `LOCALE`, default `en-CA`) and are delivered to the UI by the API.
* N9 — `npm install && npm run dev` for development. `npm start` for single-process production. `npm test` passes on a clean checkout with no database present.
