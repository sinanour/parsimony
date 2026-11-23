# Parsimony

Self-hosted bookkeeping for a household or a small business. It covers bank and credit-card accounts,
bills and payments, statement imports, expense and deposit categorization, auto-categorization rules,
and reports. Data stays in one SQLite file on your machine or server. Several people can share the
books with different roles, over HTTPS.

* **Accounts & bills**: accounts with their card numbers, payees with billing frequency, payment
  history, and what's due next.
* **Transactions**: fast, filterable lists of expenses and deposits with inline and bulk editing.
* **Statement import**: upload CSV/PDF statements, preview with duplicate detection, then commit.
* **Rules**: "description contains X → category Y", with a dry run before applying.
* **Reports**: monthly spending, payment totals, statement coverage, a business-account export for your
  accountant, and a Huqúqu'lláh calculation.
* **Multi-user**: Administrator / Editor / Read-only roles, sessions you can revoke, an audit log, and
  optional password reset by email.

Built with React + [Cloudscape](https://cloudscape.design/) and Node.js. Docs:
[spec](docs/SPEC.md) · [design](docs/DESIGN.md) · [deployment](deployment/README.md).

## Repository layout

```
backend-api/    API server, SQLite migrations, auth, statement parsers, tests
web-frontend/   React single-page app
deployment/     Dockerfiles, nginx, Compose, and a CLI that deploys to a host over SSH
shared/         API types used by both sides
docs/           Specification and design
```

## Run it on your computer

Requirements: **Node.js 22.13+** (24 LTS recommended).

```bash
npm install
npm run demo-data -w backend-api     # optional: load a small fictional dataset
npm start                            # builds the UI and serves everything on http://127.0.0.1:3001
```

On first start the server prints a **setup code**. Open the app, enter the code, and create the first
administrator. To skip that step, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before the first start.

For development, `npm run dev` runs the API with auto-reload on :3001 and Vite on
http://localhost:5173.

The database is created at `data/parsimony.sqlite`. A backup is written to `data/backups/` on every
start (the newest 10 are kept). To use an existing database, point `DATABASE_PATH` at it. Missing
tables are added, and existing data is left alone.

## Deploy to a server

Parsimony runs as two containers (nginx + API) on any Linux host with Docker, or a Mac with Finch:

```bash
cd deployment
npm install
cp config/.env.example config/.env      # set ports, HTTPS, etc.
# put your TLS certificate and key in config/certs/ (see config/README.md)
npm run deploy -- --target you@your-server
```

The CLI builds the images, copies them over SSH, starts them, waits for the health checks, and rolls
back automatically if they fail. See [deployment/README.md](deployment/README.md) for rollback, logs,
certificate renewal, macOS hosts and backups.

## Configuration

Settings come from environment variables. For local runs, put them in `.env` at the repository root
(see [`.env.example`](.env.example)). The most common ones:

| Variable | Default | |
|---|---|---|
| `DATABASE_PATH` | `data/parsimony.sqlite` | SQLite file |
| `DATA_DIR` | `data` | Backups and the generated JWT secret live here too |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | |
| `CURRENCY` / `LOCALE` | `CAD` / `en-CA` | Formatting in the UI |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Creates the first administrator if no users exist |
| `JWT_SECRET` | generated | ≥ 32 characters; otherwise generated into `DATA_DIR/jwt-secret` |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `15m` / `7d` | |
| `SMTP_*`, `PUBLIC_URL` | — | Enables "Forgot password?" (both are required) |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy that sets `X-Real-IP` / `X-Forwarded-Proto` |

## Users and roles

| Role | Can |
|---|---|
| Administrator | Everything, plus managing users and reading the audit log |
| Editor | View and change all data, import statements, run rules |
| Read-only | View data and reports; account numbers are masked |

Administrators manage users under **Administration → Users**. If nobody can sign in, use the CLI on
the server:

```bash
npm run users -- list
npm run users -- reset-password --email you@example.com
npm run users -- create --email you@example.com --role ADMINISTRATOR
# on a deployed host, from deployment/:
npm run users -- --target you@your-server -- reset-password --email you@example.com
```

## Statement imports

The statement format is chosen from the uploaded file's name, using the formats under **Transactions →
Statement formats**. Built in: RBC (Visa and bank, CSV and PDF), CIBC, BMO, American Express, Citi,
Capital One and Coast Capital. To add a bank that exports CSV, create a format there: give it a file-name
pattern, say whether it's a credit card or bank account export, and map the columns (by position or by
header title). A sample file can be previewed in the editor to find the column numbers. PDF formats use
one of the built-in PDF layouts; supporting another bank's PDF statements needs a new layout in
[`pdf-layouts.ts`](backend-api/src/services/statements/pdf-layouts.ts).

Many credit-card exports contain no account number. For those, either pick the account when
importing, or set **Statement file name contains** on the account (e.g. `rbc personal visa`). Uploads
whose name contains that text then go to that account.

## Tests

```bash
npm test               # backend API + auth tests (temporary databases), and deployment unit tests
npm run typecheck
```

The tests never touch your data. To also check that the rule engine matches the original Python
categorizer, set `LEGACY_CATEGORIZER=/path/to/expense_categorizer.py` and
`PARITY_DB=/path/to/a/database.sqlite`. To compare the statement parsers with the original
`statement_parser.py` on your own statements, also set `LEGACY_STATEMENT_PARSER=/path/to/statement_parser.py`
and `STATEMENT_SAMPLES=/path/to/a/folder/of/statements` (needs Python with `pdfminer.six`; the database
is copied, never modified).

## Notes

* Exemptions: values **≤ 1** are a fraction of the amount; values **> 1** are a fixed amount.
* Rules run in order, and the first match wins.
* Accounts and payees that are in use can't be deleted (the schema would cascade the delete to their
  transactions). Deactivate them instead.

## License

[MIT](LICENSE)
