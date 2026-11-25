import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../http';
import { countRules, getRuleRow, listRules, matchCount, previewRule, runRules, toRule } from '../services/rules';
import { idParam, queryObject, type RouteModule } from './common';

const ruleInput = z
  .object({
    descriptionFilter: z.string().trim().min(1, 'is required'),
    minimumAmount: z.number().finite().nullable(),
    maximumAmount: z.number().finite().nullable(),
    category: z.string().trim().min(1, 'is required'),
    exemption: z.number().finite().min(0).nullable(),
    isCorporate: z.boolean(),
  })
  .refine((r) => r.minimumAmount === null || r.maximumAmount === null || r.minimumAmount <= r.maximumAmount, {
    message: 'Minimum amount must not exceed maximum amount',
    path: ['minimumAmount'],
  });

const previewInput = z.object({
  descriptionFilter: z.string().trim().min(1),
  minimumAmount: z.number().finite().nullable(),
  maximumAmount: z.number().finite().nullable(),
  isCorporate: z.boolean(),
});

const runInput = z.object({
  scope: z.enum(['personal', 'corporate']),
  dryRun: z.boolean(),
});

export const ruleRoutes: RouteModule = (r, { db, config }) => {
  const maxRules = config.limits.maxRulesPerScope;

  r.get('/api/rules', ({ query }) => {
    const { scope } = z.object({ scope: z.enum(['personal', 'corporate']).optional() }).parse(queryObject(query));
    return listRules(db, scope === undefined ? undefined : scope === 'corporate');
  });

  const fetchOne = (id: number) => {
    const row = getRuleRow(db, id);
    if (!row) throw notFound('Rule');
    return toRule(row, matchCount(db, row));
  };

  r.get('/api/rules/:id', ({ params }) => fetchOne(idParam.parse(params.id)));

  // Previews and dry runs change nothing, so any signed-in user may run them (read-only users get
  // "Preview rules" on the Rules page). A run costs one pass per rule, so runs and dry runs share the
  // per-user `heavy` budget and evaluate at most RULES_MAX_PER_SCOPE rules.
  r.post('/api/rules/preview', ({ body }) => previewRule(db, previewInput.parse(body)), { access: 'user', audit: false });

  r.post(
    '/api/rules/run',
    ({ body, user }) => {
      const { scope, dryRun } = runInput.parse(body);
      if (!dryRun && user!.role === 'READ_ONLY') throw forbidden();
      return runRules(db, scope === 'corporate', dryRun, undefined, maxRules);
    },
    { access: 'user', limit: 'heavy' },
  );

  const assertRoomFor = (isCorporate: boolean) => {
    if (countRules(db, isCorporate) >= maxRules) {
      throw badRequest(`A scope can have at most ${maxRules} rules; delete or merge some first.`);
    }
  };

  r.post('/api/rules', ({ body }) => {
    const i = ruleInput.parse(body);
    assertRoomFor(i.isCorporate);
    const { lastInsertRowid } = db.run(
      `INSERT INTO expense_categorization_rule (description_filter, minimum_amount, maximum_amount, category, exemption, is_corporate)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [i.descriptionFilter, i.minimumAmount, i.maximumAmount, i.category, i.exemption, i.isCorporate],
    );
    return fetchOne(lastInsertRowid);
  });

  r.put('/api/rules/:id', ({ params, body }) => {
    const id = idParam.parse(params.id);
    const i = ruleInput.parse(body);
    const existing = getRuleRow(db, id);
    if (!existing) throw notFound('Rule');
    if (!!existing.is_corporate !== i.isCorporate) assertRoomFor(i.isCorporate);
    db.run(
      `UPDATE expense_categorization_rule SET description_filter = ?, minimum_amount = ?, maximum_amount = ?, category = ?,
       exemption = ?, is_corporate = ? WHERE expense_categorization_rule_idx = ?`,
      [i.descriptionFilter, i.minimumAmount, i.maximumAmount, i.category, i.exemption, i.isCorporate, id],
    );
    return fetchOne(id);
  });

  r.delete('/api/rules/:id', ({ params }) => {
    const id = idParam.parse(params.id);
    if (!getRuleRow(db, id)) throw notFound('Rule');
    db.run('DELETE FROM expense_categorization_rule WHERE expense_categorization_rule_idx = ?', [id]);
  });
};
