import type {
  Account,
  AuditEntry,
  AuthSession,
  AuthUser,
  ChangePasswordRequest,
  LoginRequest,
  PublicConfig,
  SetupRequest,
  User,
  UserInput,
  UserPatch,
  AccountInput,
  CorporateReport,
  CoverageRow,
  DashboardData,
  DateRange,
  Deposit,
  DepositInput,
  DepositPatch,
  Expense,
  ExpenseInput,
  ExpensePatch,
  HuquqReport,
  ImportCommitRequest,
  ImportCommitResponse,
  ImportParseResponse,
  Meta,
  MonthlySpendingRow,
  Paged,
  Payee,
  PayeeInput,
  Payment,
  PaymentInput,
  PaymentTotalRow,
  Rule,
  RuleInput,
  RulePreview,
  RuleRunResponse,
  PdfLayoutInfo,
  StatementFormat,
  StatementFormatInput,
  TransactionQuery,
  UpcomingPayment,
} from '../../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly code?: string,
  ) {
    super(message);
  }
}

// ---------- session ----------
// The access token lives only in memory. The refresh token is an HttpOnly cookie the page can't read.

let accessToken: string | null = null;
let refreshing: Promise<AuthSession | null> | null = null;
const listeners = new Set<(s: AuthSession | null) => void>();

export const session = {
  get token() {
    return accessToken;
  },
  /** Called with the new session after every sign-in/refresh, and with null when the session ends. */
  subscribe(fn: (s: AuthSession | null) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(s: AuthSession | null) {
    accessToken = s?.accessToken ?? null;
    listeners.forEach((l) => l(s));
  },
  /** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
  refresh(): Promise<AuthSession | null> {
    refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (res) => (res.ok ? ((await res.json()) as AuthSession) : null))
      .catch(() => null)
      .then((s) => {
        session.set(s);
        return s;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  },
};

async function send(method: string, url: string, payload: BodyInit | undefined, init: RequestInit, headers: Headers): Promise<Response> {
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  else headers.delete('Authorization');
  return fetch(url, { ...init, method, headers, body: payload, credentials: 'same-origin' });
}

/** Endpoints whose 401 means "wrong credentials", not "access token expired". */
const PUBLIC_AUTH = ['/api/auth/login', '/api/auth/setup', '/api/auth/refresh', '/api/auth/logout', '/api/auth/forgot-password', '/api/auth/reset-password'];

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let payload: BodyInit | undefined;
  if (body instanceof Blob) {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set('Content-Type', 'application/json');
  }
  let res = await send(method, url, payload, init, headers);
  // An expired access token: refresh once and retry. Sign-in style endpoints report their own 401s.
  const isPublicAuth = PUBLIC_AUTH.includes(url);
  if (res.status === 401 && !isPublicAuth) {
    const s = await session.refresh();
    if (s) res = await send(method, url, payload, init, headers);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string; details?: unknown } | undefined;
    if (res.status === 401 && !isPublicAuth) session.set(null);
    throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.details, err?.code);
  }
  return data as T;
}

/** Fetches a file with the session's credentials and hands it to the browser as a download. */
async function download(url: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  let res = await send('GET', url, undefined, {}, headers);
  if (res.status === 401 && (await session.refresh())) res = await send('GET', url, undefined, {}, headers);
  if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface PaymentQuery {
  payeeIdx?: number;
  accountIdx?: number;
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export const api = {
  config: () => request<PublicConfig>('GET', '/api/config'),

  auth: {
    login: (r: LoginRequest) => request<AuthSession>('POST', '/api/auth/login', r),
    setup: (r: SetupRequest) => request<AuthSession>('POST', '/api/auth/setup', r),
    logout: () => request<void>('POST', '/api/auth/logout'),
    logoutAll: () => request<void>('POST', '/api/auth/logout-all'),
    updateProfile: (displayName: string | null) => request<AuthUser>('PATCH', '/api/auth/me', { displayName }),
    changePassword: (r: ChangePasswordRequest) => request<AuthSession>('POST', '/api/auth/password', r),
    forgotPassword: (email: string) => request<{ message: string }>('POST', '/api/auth/forgot-password', { email }),
    resetPassword: (token: string, newPassword: string) => request<{ message: string }>('POST', '/api/auth/reset-password', { token, newPassword }),
  },

  users: {
    list: () => request<User[]>('GET', '/api/users'),
    create: (u: UserInput) => request<User>('POST', '/api/users', u),
    update: (id: number, p: UserPatch) => request<User>('PATCH', `/api/users/${id}`, p),
    revokeSessions: (id: number) => request<void>('POST', `/api/users/${id}/revoke-sessions`),
    remove: (id: number) => request<void>('DELETE', `/api/users/${id}`),
  },

  audit: (q: { page?: number; pageSize?: number; action?: string }) => request<{ items: AuditEntry[]; total: number }>('GET', `/api/audit${qs(q)}`),

  meta: () => request<Meta>('GET', '/api/meta'),
  dashboard: () => request<DashboardData>('GET', '/api/dashboard'),

  accounts: {
    list: () => request<Account[]>('GET', '/api/accounts'),
    create: (a: AccountInput) => request<Account>('POST', '/api/accounts', a),
    update: (id: number, a: AccountInput) => request<Account>('PUT', `/api/accounts/${id}`, a),
    remove: (id: number) => request<void>('DELETE', `/api/accounts/${id}`),
  },

  payees: {
    list: () => request<Payee[]>('GET', '/api/payees'),
    create: (p: PayeeInput) => request<Payee>('POST', '/api/payees', p),
    update: (id: number, p: PayeeInput) => request<Payee>('PUT', `/api/payees/${id}`, p),
    remove: (id: number) => request<void>('DELETE', `/api/payees/${id}`),
  },

  payments: {
    list: (q: PaymentQuery) => request<Paged<Payment>>('GET', `/api/payments${qs(q)}`),
    upcoming: () => request<UpcomingPayment[]>('GET', '/api/payments/upcoming'),
    defaults: (payeeIdx: number) =>
      request<{ amount: number | null; payerAccountIdx: number | null }>('GET', `/api/payments/defaults/${payeeIdx}`),
    create: (p: PaymentInput) => request<Payment>('POST', '/api/payments', p),
    update: (id: number, p: PaymentInput) => request<Payment>('PUT', `/api/payments/${id}`, p),
    remove: (id: number) => request<void>('DELETE', `/api/payments/${id}`),
  },

  expenses: {
    list: (q: TransactionQuery) => request<Paged<Expense>>('GET', `/api/expenses${qs(q)}`),
    create: (e: ExpenseInput) => request<Expense>('POST', '/api/expenses', e),
    patch: (id: number, p: ExpensePatch) => request<Expense>('PATCH', `/api/expenses/${id}`, p),
    bulk: (ids: number[], changes: { category?: string | null; exemption?: number | null; comment?: string | null }) =>
      request<{ updated: number }>('POST', '/api/expenses/bulk', { ids, ...changes }),
    remove: (id: number) => request<void>('DELETE', `/api/expenses/${id}`),
  },

  deposits: {
    list: (q: TransactionQuery) => request<Paged<Deposit>>('GET', `/api/deposits${qs(q)}`),
    create: (d: DepositInput) => request<Deposit>('POST', '/api/deposits', d),
    patch: (id: number, p: DepositPatch) => request<Deposit>('PATCH', `/api/deposits/${id}`, p),
    bulk: (ids: number[], action: 'income' | 'transfer' | 'unreviewed') =>
      request<{ updated: number }>('POST', '/api/deposits/bulk', { ids, action }),
    remove: (id: number) => request<void>('DELETE', `/api/deposits/${id}`),
  },

  rules: {
    list: (scope: 'personal' | 'corporate') => request<Rule[]>('GET', `/api/rules${qs({ scope })}`),
    create: (r: RuleInput) => request<Rule>('POST', '/api/rules', r),
    update: (id: number, r: RuleInput) => request<Rule>('PUT', `/api/rules/${id}`, r),
    remove: (id: number) => request<void>('DELETE', `/api/rules/${id}`),
    preview: (r: Pick<RuleInput, 'descriptionFilter' | 'minimumAmount' | 'maximumAmount' | 'isCorporate'>) =>
      request<RulePreview>('POST', '/api/rules/preview', r),
    run: (scope: 'personal' | 'corporate', dryRun: boolean) => request<RuleRunResponse>('POST', '/api/rules/run', { scope, dryRun }),
  },

  imports: {
    parse: (file: File, accountIdx?: number) =>
      request<ImportParseResponse>('POST', `/api/import/parse${qs({ accountIdx })}`, file, {
        headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
      }),
    commit: (req: ImportCommitRequest) => request<ImportCommitResponse>('POST', '/api/import/commit', req),
  },

  statementFormats: {
    list: () => request<StatementFormat[]>('GET', '/api/statement-formats'),
    pdfLayouts: () => request<PdfLayoutInfo[]>('GET', '/api/statement-formats/pdf-layouts'),
    create: (f: StatementFormatInput) => request<StatementFormat>('POST', '/api/statement-formats', f),
    update: (id: number, f: StatementFormatInput) => request<StatementFormat>('PUT', `/api/statement-formats/${id}`, f),
    remove: (id: number) => request<void>('DELETE', `/api/statement-formats/${id}`),
  },

  reports: {
    huquq: () => request<HuquqReport>('GET', '/api/reports/huquq'),
    setHuquqRange: (r: DateRange) => request<DateRange>('PUT', '/api/reports/huquq/range', r),
    corporate: () => request<CorporateReport>('GET', '/api/reports/corporate'),
    setCorporateRange: (r: DateRange) => request<DateRange>('PUT', '/api/reports/corporate/range', r),
    downloadCorporateCsv: () => download('/api/reports/corporate?format=csv', 'corporate-transactions.csv'),
    paymentTotals: () => request<PaymentTotalRow[]>('GET', '/api/reports/payment-totals'),
    coverage: () => request<CoverageRow[]>('GET', '/api/reports/coverage'),
    monthlySpending: (months: number, scope: 'personal' | 'corporate') =>
      request<MonthlySpendingRow[]>('GET', `/api/reports/monthly-spending${qs({ months, scope })}`),
  },
};
