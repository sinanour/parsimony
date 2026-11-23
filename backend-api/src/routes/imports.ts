import { z } from 'zod';
import { badRequest } from '../http';
import { commitRecords, parseStatement } from '../services/importer';
import { runRules } from '../services/rules';
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

export const importRoutes: RouteModule = (r, { db }) => {
  r.post(
    '/api/import/parse',
    async ({ req, rawBody, query }) => {
      const header = req.headers['x-file-name'];
      const fileName = decodeURIComponent(Array.isArray(header) ? header[0] : (header ?? ''));
      if (!fileName) throw badRequest('Missing X-File-Name header');
      const { accountIdx } = z.object({ accountIdx: z.coerce.number().int().positive().optional() }).parse(queryObject(query));
      return parseStatement(db, fileName, rawBody ?? Buffer.alloc(0), accountIdx);
    },
    { raw: true },
  );

  r.post('/api/import/commit', ({ body }): ImportCommitResponse => {
    const input = commitInput.parse(body);
    const counts = commitRecords(db, input.records);
    const rules = input.runRules ? [runRules(db, false, false), runRules(db, true, false)] : [];
    return { ...counts, rules };
  });
};
