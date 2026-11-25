import type { PdfLayoutInfo, StatementFormat } from '../../../shared/types';
import { createFormat, deleteFormat, getFormat, listFormats, pdfLayoutInfo, statementFormatInput, updateFormat } from '../services/statements/formats';
import { idParam, type RouteModule } from './common';

export const statementFormatRoutes: RouteModule = (r, { db }) => {
  r.get('/api/statement-formats', (): StatementFormat[] => listFormats(db));
  r.get('/api/statement-formats/pdf-layouts', (): PdfLayoutInfo[] => pdfLayoutInfo());
  r.get('/api/statement-formats/:id', ({ params }) => getFormat(db, idParam.parse(params.id)));
  // Saving compiles every date format, so writes share the per-user `heavy` budget.
  r.post('/api/statement-formats', ({ body }) => createFormat(db, statementFormatInput.parse(body)), { limit: 'heavy' });
  r.put('/api/statement-formats/:id', ({ params, body }) => updateFormat(db, idParam.parse(params.id), statementFormatInput.parse(body)), { limit: 'heavy' });
  r.delete('/api/statement-formats/:id', ({ params }) => deleteFormat(db, idParam.parse(params.id)));
};
