import { z } from 'zod';
import { badRequest, payloadTooLarge } from '../http';
import { commitRecords, parseStatement } from '../services/importer';
import { countRules, runRules } from '../services/rules';
import type { ImportCommitResponse } from '../../../shared/types';
import { isoDate, money, queryObject, type RouteModule } from './common';

const commitInput = z.object({
  records: z
    .array(
      z.object({
        type: z.enum(['expense', 'deposit']),
        transactionDate: isoDate,
        description: z.string().min(1),
        amount: money,
        accountIdx: z.number().int().positive(),
        category: z.string().nullable(),
        exemption: z.number().nullable(),
        incomeAmount: z.number().nullable(),
      }),
    )
    .min(1, 'Select at least one record'),
  runRules: z.boolean().default(false),
});

const tooManyRecords = (n: number, max: number) =>
  payloadTooLarge(`${n} records are more than one import can take (at most ${max}). Import them in smaller batches.`, 'TOO_MANY_RECORDS');

export const importRoutes: RouteModule = (r, { db, config }) => {
  const maxRecords = config.limits.importMaxRecords;

  r.post(
    '/api/import/parse',
    async ({ req, rawBody, query }) => {
      const header = req.headers['x-file-name'];
      const fileName = decodeURIComponent(Array.isArray(header) ? header[0] : (header ?? ''));
      if (!fileName) throw badRequest('Missing X-File-Name header');
      const { accountIdx } = z.object({ accountIdx: z.coerce.number().int().positive().optional() }).parse(queryObject(query));
      return parseStatement(db, fileName, rawBody ?? Buffer.alloc(0), accountIdx, maxRecords);
    },
    { raw: true, limit: 'heavy' },
  );

  r.post(
    '/api/import/commit',
    ({ body }): ImportCommitResponse => {
      // Count before validating, so an oversized batch is refused without walking every record.
      const records = (body as { records?: unknown } | null)?.records;
      if (Array.isArray(records) && records.length > maxRecords) throw tooManyRecords(records.length, maxRecords);
      const input = commitInput.parse(body);
      const max = config.limits.maxRulesPerScope;
      // Refuse up front rather than insert the records and then fail the rule run.
      if (input.runRules && (countRules(db, false) > max || countRules(db, true) > max)) {
        throw badRequest(`A scope has more than ${max} rules, so rules can't run; import without running rules, or delete some rules.`);
      }
      const counts = commitRecords(db, input.records);
      const rules = input.runRules ? [runRules(db, false, false, undefined, max), runRules(db, true, false, undefined, max)] : [];
      return { ...counts, rules };
    },
    { limit: 'heavy' },
  );
};
