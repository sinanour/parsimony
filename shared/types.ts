// API contract shared by server and web. Dates are ISO "YYYY-MM-DD" strings.

export type Scope = 'personal' | 'corporate' | 'all';

export interface Paged<T> {
  items: T[];
  total: number;
  /** Sum of `amount` across all filtered rows (expenses and deposits only). */
  totalAmount?: number;
}

export interface Account {
  accountIdx: number;
  name: string;
  isCreditCard: boolean;
  isCorporate: boolean;
  isActive: boolean;
  accountNumbers: string[];
  /** Case-insensitive text matched against uploaded statement file names to pick this account. */
  statementFilePattern: string | null;
  firstTransactionMonth: string | null;
  lastTransactionMonth: string | null;
  missingMonthCount: number | null;
  transactionCount: number;
  paymentCount: number;
}

export interface AccountInput {
  name: string;
  isCreditCard: boolean;
  isCorporate: boolean;
  isActive: boolean;
  accountNumbers: string[];
  statementFilePattern?: string | null;
}

export interface Payee {
  payeeIdx: number;
  payee: string;
  accountNum: string;
  isActive: boolean;
  payeeCategory: string;
  paymentPeriod: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  nextPaymentDate: string | null;
  paymentCount: number;
}

export interface PayeeInput {
  payee: string;
  accountNum: string;
  isActive: boolean;
  payeeCategory: string;
  paymentPeriod: number;
}

export interface Payment {
  paymentIdx: number;
  payeeIdx: number;
  payeeName: string;
  payeeCategory: string;
  transactionDate: string;
  amount: number;
  confirmation: string | null;
  payerAccountIdx: number;
  payerAccountName: string;
}

export interface PaymentInput {
  payeeIdx: number;
  transactionDate: string;
  amount: number;
  confirmation: string | null;
  payerAccountIdx: number;
}

export type DueStatus = 'overdue' | 'due-soon' | 'scheduled';

export interface UpcomingPayment {
  paymentIdx: number;
  payeeIdx: number;
  payee: string;
  payeeCategory: string;
  lastPaymentDate: string;
  nextPaymentDate: string;
  amount: number;
  confirmation: string | null;
  payerAccountIdx: number;
  payerAccountName: string;
  paymentPeriod: number;
  daysUntilDue: number;
  status: DueStatus;
  /** Matches the legacy vw_upcoming_payments window. */
  isUpcoming: boolean;
}

export interface Expense {
  expenseIdx: number;
  transactionDate: string;
  category: string | null;
  exemption: number | null;
  exemptAmount: number;
  description: string;
  amount: number;
  accountIdx: number;
  accountName: string;
  isCorporate: boolean;
  comment: string | null;
}

export interface ExpenseInput {
  transactionDate: string;
  category: string | null;
  exemption: number | null;
  description: string;
  amount: number;
  accountIdx: number;
  comment: string | null;
}

export type ExpensePatch = Partial<ExpenseInput>;

export interface Deposit {
  depositIdx: number;
  transactionDate: string;
  description: string | null;
  amount: number;
  incomeAmount: number;
  reviewed: boolean;
  comment: string | null;
  accountIdx: number;
  accountName: string;
  isCorporate: boolean;
}

export interface DepositInput {
  transactionDate: string;
  description: string | null;
  amount: number;
  incomeAmount: number;
  reviewed: boolean;
  comment: string | null;
  accountIdx: number;
}

export type DepositPatch = Partial<DepositInput>;

export interface TransactionQuery {
  scope?: Scope;
  accountIdx?: number;
  /** Category name, or "__uncategorized__". Expenses only. */
  category?: string;
  /** Deposits only: "reviewed" | "unreviewed". */
  reviewed?: 'reviewed' | 'unreviewed';
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export const UNCATEGORIZED = '__uncategorized__';

export interface Rule {
  ruleIdx: number;
  descriptionFilter: string;
  minimumAmount: number | null;
  maximumAmount: number | null;
  category: string | null;
  exemption: number | null;
  isCorporate: boolean;
  /** Uncategorized expenses this rule matches on its own (ignores earlier rules). */
  matchCount: number;
}

export interface RuleInput {
  descriptionFilter: string;
  minimumAmount: number | null;
  maximumAmount: number | null;
  category: string;
  exemption: number | null;
  isCorporate: boolean;
}

export interface RuleMatch {
  expenseIdx: number;
  transactionDate: string;
  description: string;
  amount: number;
  accountName: string;
}

export interface RuleRunResult {
  ruleIdx: number;
  descriptionFilter: string;
  category: string | null;
  exemption: number | null;
  rowCount: number;
  /** Predicate with bind values inlined, as written to expense.comment. */
  predicate: string;
  matches: RuleMatch[];
}

export interface RuleRunResponse {
  scope: 'personal' | 'corporate';
  dryRun: boolean;
  timestamp: string;
  totalRows: number;
  results: RuleRunResult[];
}

export type ImportRecordType = 'expense' | 'deposit';

export interface ImportRecord {
  /** Client-side key, unique within one parse response. */
  key: string;
  type: ImportRecordType;
  transactionDate: string;
  description: string;
  amount: number;
  accountIdx: number;
  accountName: string;
  /** Expenses: category/exemption as set by the parser (normally null). */
  category: string | null;
  exemption: number | null;
  /** Deposits: income amount as set by the parser. */
  incomeAmount: number | null;
  isDuplicate: boolean;
}

export interface ImportParseResponse {
  fileName: string;
  /** The statement format chosen from the file name, if any. */
  formatName: string | null;
  records: ImportRecord[];
  warnings: string[];
}

export type StatementFileType = 'csv' | 'pdf';
/**
 * `card`: one account per file (credit-card exports); every row is an expense, credits are refunds.
 * `bank`: each row carries an account number; positive amounts are deposits, negative are expenses.
 */
export type StatementParserKind = 'card' | 'bank';
export type PdfLayoutId = 'rbc-bank-statement' | 'rbc-visa-statement';

/** Zero-based column positions; null when the statement has no such column. */
export interface StatementColumns {
  date: number | null;
  description: number | null;
  /** Card: the charge amount. Bank: withdrawals, or the signed amount when there's no credit column. */
  debit: number | null;
  /** Card: credits (stored as negative expenses). Bank: deposits. May equal `debit` for a signed amount. */
  credit: number | null;
  /** Bank only: the account number, matched against the accounts' numbers. */
  account: number | null;
  /** Bank only: cheque number, appended to "Cheque" descriptions. */
  cheque: number | null;
}

export interface StatementFormatSettings {
  /** Rows to skip at the top of the file. */
  headerRows: number;
  /** Rows with a different number of columns are ignored. Null: the next row is a header, and columns are found by `headerNames`. */
  columnCount: number | null;
  columns: StatementColumns;
  /** Column titles to look for when `columnCount` is null (matched ignoring case and surrounding spaces). */
  headerNames: Partial<Record<keyof StatementColumns, string>> | null;
  /** strptime-style formats (e.g. %Y-%m-%d, %m/%d/%Y, %d-%b-%Y), tried in order. */
  dateFormats: string[];
}

export interface StatementFormatInput {
  name: string;
  /** Matched case-insensitively against the uploaded file's name; the longest matching pattern wins. */
  fileNamePattern: string;
  fileType: StatementFileType;
  /** CSV formats only. */
  parser: StatementParserKind | null;
  settings: StatementFormatSettings | null;
  /** PDF formats only. */
  pdfLayout: PdfLayoutId | null;
  isActive: boolean;
}

export interface StatementFormat extends StatementFormatInput {
  statementFormatIdx: number;
}

export interface PdfLayoutInfo {
  id: PdfLayoutId;
  label: string;
  description: string;
}

export interface ImportCommitRequest {
  records: Omit<ImportRecord, 'key' | 'isDuplicate' | 'accountName'>[];
  runRules: boolean;
}

export interface ImportCommitResponse {
  expensesInserted: number;
  depositsInserted: number;
  rules: RuleRunResponse[];
}

export interface RulePreview {
  total: number;
  items: RuleMatch[];
}

export interface Meta {
  categories: { personal: string[]; corporate: string[] };
  payeeCategories: string[];
  accounts: { accountIdx: number; name: string; isActive: boolean; isCorporate: boolean; isCreditCard: boolean }[];
}

export interface DashboardData {
  uncategorizedExpenses: { personal: number; corporate: number };
  unreviewedDeposits: { personal: number; corporate: number };
  upcoming: UpcomingPayment[];
  coverage: CoverageRow[];
  lastMonth: string;
}

export interface CoverageRow {
  accountIdx: number;
  accountName: string;
  isActive: boolean;
  firstTransactionMonth: string;
  lastTransactionMonth: string;
  distinctMonthCount: number;
  missingMonthCount: number;
}

export interface MonthlySpendingRow {
  month: string;
  category: string;
  total: number;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface HuquqReport {
  range: DateRange;
  payment: {
    totalIncome: number;
    totalExpenses: number;
    totalExemptions: number;
    uncategorizedIncome: number;
    uncategorizedExpenses: number;
    minPayment: number;
    estimatedPayment: number;
    maxPayment: number;
  } | null;
  expenseSummary: { exemptionClassification: string; category: string; total: number }[];
  exemptionsByAccount: { accountName: string; category: string; totalAmount: number; totalExemption: number }[];
  income: { description: string; totalIncome: number }[];
}

export interface CorporateRow {
  category: string;
  subcategory: string | null;
  accountType: string;
  accountNum: string | null;
  transactionDate: string;
  cheque: string;
  description: string | null;
  description2: string | null;
  amount: number;
  adjustment: number | null;
}

export interface CorporateReport {
  range: DateRange;
  rows: CorporateRow[];
}

export interface PaymentTotalRow {
  year: string;
  recipient: string;
  total: number;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ---------- users & auth ----------

export type Role = 'ADMINISTRATOR' | 'EDITOR' | 'READ_ONLY';
export const ROLES: Role[] = ['ADMINISTRATOR', 'EDITOR', 'READ_ONLY'];

export interface AuthUser {
  userId: number;
  email: string;
  displayName: string | null;
  role: Role;
}

export interface User extends AuthUser {
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
}

export interface PublicConfig {
  /** True until the first administrator exists. */
  setupRequired: boolean;
  passwordResetEnabled: boolean;
  currency: string;
  locale: string;
  version: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SetupRequest {
  setupCode: string;
  email: string;
  password: string;
  displayName?: string | null;
}

/** Returned by sign-in, setup, refresh and password change. The refresh token travels in an HttpOnly cookie. */
export interface AuthSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: AuthUser;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface UserInput {
  email: string;
  displayName?: string | null;
  role: Role;
  password: string;
}

export interface UserPatch {
  displayName?: string | null;
  role?: Role;
  /** Admin password reset; revokes the user's sessions. */
  password?: string;
}

export interface AuditEntry {
  auditIdx: number;
  at: string;
  userId: number | null;
  userEmail: string | null;
  action: string;
  method: string | null;
  path: string | null;
  status: number | null;
  ip: string | null;
  details: string | null;
}
