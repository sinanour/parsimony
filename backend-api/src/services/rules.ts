// Port of expense_categorizer.py. Semantics and the comment format written to expense.comment are kept
// identical so rows categorized by the app and by the legacy script are indistinguishable.
import type { Db } from '../db';
import { badRequest } from '../http';
import { TEXT_LIMITS, type Rule, type RuleInput, type RuleMatch, type RulePreview, type RuleRunResponse, type RuleRunResult } from '../../../shared/types';

export const AMOUNT_FLOOR = -2000000000;
export const AMOUNT_CEIL = 2000000000;

export const RULE_PREDICATE =
  'category IS NULL AND description LIKE ? AND amount >= ? AND amount <= ? ' +
  'AND account_idx IN (SELECT account_idx FROM account WHERE is_corporate = ?)';

interface RuleRow {
  expense_categorization_rule_idx: number;
  description_filter: string;
  minimum_amount: number | null;
  maximum_amount: number | null;
  category: string | null;
  exemption: number | null;
  is_corporate: number;
}

/** Mirrors Python's str() for the values the script interpolates. */
function pyStr(v: unknown, kind: 'float' | 'int' | 'str'): string {
  if (v === null || v === undefined) return 'None';
  if (kind === 'str') return String(v);
  const n = Number(v);
  if (kind === 'int') return String(Math.trunc(n));
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : n < 0 ? '-inf' : 'nan';
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  return String(n);
}

export function likePattern(filter: string): string {
  return filter.includes('_') || filter.includes('%') ? filter : `%${filter}%`;
}

export interface CompiledRule {
  rule: RuleRow;
  bindValues: (string | number)[];
  /** Python str() of each bind value, used to build the comment. */
  bindStrings: string[];
}

export function compileRule(rule: RuleRow): CompiledRule {
  const pattern = likePattern(rule.description_filter);
  const min = rule.minimum_amount ?? AMOUNT_FLOOR;
  const max = rule.maximum_amount ?? AMOUNT_CEIL;
  const corp = rule.is_corporate ? 1 : 0;
  return {
    rule,
    bindValues: [pattern, min, max, corp],
    bindStrings: [
      pattern,
      // Defaults are Python ints; DB values are REAL → Python floats.
      rule.minimum_amount === null ? pyStr(min, 'int') : pyStr(min, 'float'),
      rule.maximum_amount === null ? pyStr(max, 'int') : pyStr(max, 'float'),
      String(corp),
    ],
  };
}

/** Replaces each "?" in turn, exactly like the Python loop (first occurrence, left to right). */
function inline(text: string, values: string[]): string {
  let out = text;
  for (const v of values) {
    const i = out.indexOf('?');
    if (i < 0) break;
    out = out.slice(0, i) + v + out.slice(i + 1);
  }
  return out;
}

export function utcTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

export function ruleComment(c: CompiledRule, now: string): string {
  const head = `Automatic Rule (${now}): Category = ${pyStr(c.rule.category, 'str')}, exemption = ${pyStr(c.rule.exemption, 'float')} where ${RULE_PREDICATE}`;
  return inline(head, c.bindStrings);
}

export function inlinedPredicate(c: CompiledRule): string {
  return inline(RULE_PREDICATE, c.bindStrings);
}

const RULE_COLUMNS =
  'expense_categorization_rule_idx, description_filter, minimum_amount, maximum_amount, category, exemption, is_corporate';

export function fetchRules(db: Db, isCorporate: boolean, limit = -1): RuleRow[] {
  return db.all<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM expense_categorization_rule WHERE is_corporate = ? ORDER BY expense_categorization_rule_idx LIMIT ?`,
    [isCorporate ? 1 : 0, limit],
  );
}

const MATCH_SELECT = `SELECT e.expense_idx AS expenseIdx, e.transaction_date AS transactionDate, e.description,
  e.amount, a.name AS accountName FROM expense e JOIN account a USING (account_idx)`;

/** Default cap on rules evaluated per scope (overridden by RULES_MAX_PER_SCOPE). */
export const DEFAULT_MAX_RULES = 2000;

export const countRules = (db: Db, isCorporate: boolean): number =>
  db.scalar<number>('SELECT COUNT(*) FROM expense_categorization_rule WHERE is_corporate = ?', [isCorporate ? 1 : 0]);

/**
 * Runs every rule of a scope in index order inside one transaction (a dry run rolls it back).
 *
 * Each rule costs one pass over the scope's uncategorized expenses (the partial index
 * expense_uncategorized_IDX keeps categorized rows out of it): the UPDATE returns the rows it changed, and
 * the drill-down list is read back by id. A scope with more than `maxRules` rules is refused rather than
 * partially applied.
 */
export function runRules(db: Db, isCorporate: boolean, dryRun: boolean, matchLimit = 500, maxRules = DEFAULT_MAX_RULES): RuleRunResponse {
  const now = utcTimestamp();
  const results: RuleRunResult[] = [];
  const rollback = new Error('dry-run rollback');

  try {
    db.tx(() => {
      const rules = fetchRules(db, isCorporate, maxRules + 1);
      if (rules.length > maxRules) {
        throw badRequest(`This scope has more than ${maxRules} rules; delete some before running them.`);
      }
      const update = db.raw.prepare(
        `UPDATE expense SET category = ?, exemption = ?, comment = ? WHERE ${RULE_PREDICATE} RETURNING expense_idx AS id`,
      );
      const matchesOf = db.raw.prepare(
        `${MATCH_SELECT} WHERE e.expense_idx IN (SELECT value FROM json_each(?))
         ORDER BY e.transaction_date DESC LIMIT ${matchLimit}`,
      );
      for (const rule of rules) {
        const c = compileRule(rule);
        const changed = update.all(rule.category, rule.exemption, ruleComment(c, now), ...c.bindValues) as { id: number }[];
        if (changed.length > 0) {
          results.push({
            ruleIdx: rule.expense_categorization_rule_idx,
            descriptionFilter: rule.description_filter,
            category: rule.category,
            exemption: rule.exemption,
            rowCount: changed.length,
            predicate: inlinedPredicate(c),
            matches: matchesOf.all(JSON.stringify(changed.map((r) => r.id))) as unknown as RuleMatch[],
          });
        }
      }
      if (dryRun) throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }

  return {
    scope: isCorporate ? 'corporate' : 'personal',
    dryRun,
    timestamp: now,
    totalRows: results.reduce((s, r) => s + r.rowCount, 0),
    results,
  };
}

/*
 * Match counts are computed on every GET /api/rules and /api/rules/:id, and a LIKE costs roughly
 * description length × filter length. The API caps both (TEXT_LIMITS), so only legacy rows written before
 * the caps can exceed them: such rules report 0 matches and such descriptions are not counted, so one
 * oversized value can't make a shared read expensive. Previews skip such descriptions too; running the
 * rules still applies them as written.
 */
const MAX_FILTER = TEXT_LIMITS.ruleFilter;
const MAX_DESCRIPTION = TEXT_LIMITS.description;

/** Per-rule match counts against currently uncategorized expenses, each rule evaluated on its own. */
export function matchCounts(db: Db): Map<number, number> {
  const rows = db.all<{ idx: number; n: number }>(
    `WITH u AS MATERIALIZED (
       SELECT e.description, e.amount, a.is_corporate FROM expense e JOIN account a USING (account_idx)
       WHERE e.category IS NULL AND length(e.description) <= ${MAX_DESCRIPTION})
     SELECT r.expense_categorization_rule_idx AS idx, COUNT(u.amount) AS n
     FROM expense_categorization_rule r
     LEFT JOIN u ON u.is_corporate = r.is_corporate
       AND length(r.description_filter) <= ${MAX_FILTER}
       AND u.description LIKE (CASE WHEN instr(r.description_filter, '%') > 0 OR instr(r.description_filter, '_') > 0
                                    THEN r.description_filter ELSE '%' || r.description_filter || '%' END)
       AND u.amount >= COALESCE(r.minimum_amount, ${AMOUNT_FLOOR})
       AND u.amount <= COALESCE(r.maximum_amount, ${AMOUNT_CEIL})
     GROUP BY 1`,
  );
  return new Map(rows.map((r) => [r.idx, r.n]));
}

/** One rule's match count against currently uncategorized expenses (what matchCounts reports for it). */
export function matchCount(db: Db, rule: RuleRow): number {
  if (rule.description_filter.length > MAX_FILTER) return 0;
  return db.scalar<number>(
    `SELECT COUNT(*) FROM expense WHERE ${RULE_PREDICATE} AND length(description) <= ${MAX_DESCRIPTION}`,
    compileRule(rule).bindValues,
  );
}

/**
 * `readOnly`: match the filter against descriptions as a READ_ONLY user sees them (long digit runs masked,
 * see redact.ts), so a preview can't be used to confirm the masked digits of a card number in a description.
 */
export function previewRule(
  db: Db,
  input: Pick<RuleInput, 'descriptionFilter' | 'minimumAmount' | 'maximumAmount' | 'isCorporate'>,
  limit = 200,
  readOnly = false,
): RulePreview {
  const c = compileRule({
    expense_categorization_rule_idx: 0,
    description_filter: input.descriptionFilter,
    minimum_amount: input.minimumAmount,
    maximum_amount: input.maximumAmount,
    category: null,
    exemption: null,
    is_corporate: input.isCorporate ? 1 : 0,
  });
  const predicate = readOnly ? RULE_PREDICATE.replace('description LIKE ?', 'redact_digits(description) LIKE ?') : RULE_PREDICATE;
  const where = `e.expense_idx IN (SELECT expense_idx FROM expense WHERE ${predicate} AND length(description) <= ${MAX_DESCRIPTION})`;
  const total = db.scalar<number>(`SELECT COUNT(*) FROM expense e WHERE ${where}`, c.bindValues);
  const items = db.all<RuleMatch>(`${MATCH_SELECT} WHERE ${where} ORDER BY e.transaction_date DESC LIMIT ${limit}`, c.bindValues);
  return { total, items };
}

export function toRule(r: RuleRow, matchCount = 0): Rule {
  return {
    ruleIdx: r.expense_categorization_rule_idx,
    descriptionFilter: r.description_filter,
    minimumAmount: r.minimum_amount,
    maximumAmount: r.maximum_amount,
    category: r.category,
    exemption: r.exemption,
    isCorporate: !!r.is_corporate,
    matchCount,
  };
}

export function listRules(db: Db, isCorporate?: boolean): Rule[] {
  const counts = matchCounts(db);
  const rows = db.all<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM expense_categorization_rule ${isCorporate === undefined ? '' : 'WHERE is_corporate = ?'}
     ORDER BY expense_categorization_rule_idx`,
    isCorporate === undefined ? [] : [isCorporate ? 1 : 0],
  );
  return rows.map((r) => toRule(r, counts.get(r.expense_categorization_rule_idx) ?? 0));
}

export function getRuleRow(db: Db, idx: number): RuleRow | undefined {
  return db.get<RuleRow>(`SELECT ${RULE_COLUMNS} FROM expense_categorization_rule WHERE expense_categorization_rule_idx = ?`, [idx]);
}
