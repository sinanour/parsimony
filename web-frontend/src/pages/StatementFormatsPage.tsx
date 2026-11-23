import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FileUpload from '@cloudscape-design/components/file-upload';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import TextFilter from '@cloudscape-design/components/text-filter';
import Tiles from '@cloudscape-design/components/tiles';
import Toggle from '@cloudscape-design/components/toggle';
import type { PdfLayoutId, PdfLayoutInfo, StatementColumns, StatementFormat, StatementFormatInput, StatementParserKind } from '../../../shared/types';
import { ApiError, api } from '../api/client';
import { ConfirmModal, EmptyState, RouterLink } from '../components/common';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks/useAsync';
import { errorMessage, pluralize } from '../utils/format';

type ColumnKey = keyof StatementColumns;
const COLUMN_KEYS: ColumnKey[] = ['date', 'description', 'debit', 'credit', 'account', 'cheque'];

const COLUMN_FIELDS: Record<ColumnKey, { label: string; card?: string; bank?: string; bankOnly?: boolean }> = {
  date: { label: 'Date' },
  description: { label: 'Description' },
  debit: { label: 'Amount / debit', card: 'Charges. For a single signed amount column, use it for both amount and credit.', bank: 'Withdrawals, or the signed amount (positive = deposit) when there is no credit column.' },
  credit: { label: 'Credit', card: 'Credits, when they are in their own column. They are stored as negative expenses.', bank: 'Deposits, when they are in their own column.' },
  account: { label: 'Account number', bankOnly: true, bank: 'Matched against the numbers on your accounts.' },
  cheque: { label: 'Cheque number', bankOnly: true, bank: 'Optional. Added to "Cheque" descriptions.' },
};

const PARSER_LABELS: Record<StatementParserKind, string> = { card: 'Credit card', bank: 'Bank account' };

interface Draft {
  name: string;
  fileNamePattern: string;
  fileType: 'csv' | 'pdf';
  isActive: boolean;
  pdfLayout: PdfLayoutId | null;
  parser: StatementParserKind;
  headerRows: string;
  byHeader: boolean;
  columnCount: string;
  /** One-based column numbers, as people count spreadsheet columns. */
  columns: Record<ColumnKey, string>;
  headerNames: Record<ColumnKey, string>;
  /** One per line. */
  dateFormats: string;
}

function toDraft(f?: StatementFormat | null): Draft {
  const s = f?.settings;
  return {
    name: f?.name ?? '',
    fileNamePattern: f?.fileNamePattern ?? '',
    fileType: f?.fileType ?? 'csv',
    isActive: f?.isActive ?? true,
    pdfLayout: f?.pdfLayout ?? null,
    parser: f?.parser ?? 'card',
    headerRows: String(s?.headerRows ?? 0),
    byHeader: !!s && s.columnCount === null,
    columnCount: s?.columnCount == null ? '' : String(s.columnCount),
    columns: Object.fromEntries(COLUMN_KEYS.map((k) => [k, s?.columns[k] == null ? '' : String(s.columns[k]! + 1)])) as Record<ColumnKey, string>,
    headerNames: Object.fromEntries(COLUMN_KEYS.map((k) => [k, s?.headerNames?.[k] ?? ''])) as Record<ColumnKey, string>,
    dateFormats: (s?.dateFormats ?? ['%Y-%m-%d']).join('\n'),
  };
}

const wholeNumber = (v: string, min: number) => (/^\d+$/.test(v.trim()) && Number(v) >= min ? Number(v) : null);

/** Client-side checks; the server validates again and its errors are shown on the same fields. */
function validate(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = 'Enter a name';
  if (d.fileNamePattern.trim().length < 2) e.fileNamePattern = 'Enter at least 2 characters of the file name';
  if (d.fileType === 'pdf') {
    if (!d.pdfLayout) e.pdfLayout = 'Choose a layout';
    return e;
  }
  if (wholeNumber(d.headerRows, 0) === null) e['settings.headerRows'] = 'Enter 0 or more';
  if (!d.dateFormats.trim()) e['settings.dateFormats'] = 'Enter at least one date format';
  const needed: ColumnKey[] = ['date', 'description', ...(d.parser === 'bank' ? (['account'] as const) : [])];
  if (d.byHeader) {
    for (const k of needed) if (!d.headerNames[k].trim()) e[`settings.headerNames.${k}`] = 'Enter the column title';
    if (!d.headerNames.debit.trim() && !d.headerNames.credit.trim()) e['settings.headerNames.debit'] = 'Enter the amount column title';
    return e;
  }
  const count = wholeNumber(d.columnCount, 1);
  if (count === null) e['settings.columnCount'] = 'Enter the number of columns';
  for (const k of COLUMN_KEYS) {
    if (COLUMN_FIELDS[k].bankOnly && d.parser !== 'bank') continue;
    const v = d.columns[k].trim();
    if (!v) {
      if (needed.includes(k)) e[`settings.columns.${k}`] = 'Enter a column number';
      continue;
    }
    const n = wholeNumber(v, 1);
    if (n === null) e[`settings.columns.${k}`] = 'Enter a column number (1 or more)';
    else if (count !== null && n > count) e[`settings.columns.${k}`] = `The format has ${count} columns`;
  }
  if (!d.columns.debit.trim() && !d.columns.credit.trim()) e['settings.columns.debit'] = 'Enter the amount column';
  return e;
}

function toInput(d: Draft): StatementFormatInput {
  const base = { name: d.name.trim(), fileNamePattern: d.fileNamePattern.trim(), fileType: d.fileType, isActive: d.isActive };
  if (d.fileType === 'pdf') return { ...base, parser: null, settings: null, pdfLayout: d.pdfLayout };
  const col = (k: ColumnKey) => (d.byHeader || (COLUMN_FIELDS[k].bankOnly && d.parser !== 'bank') || !d.columns[k].trim() ? null : Number(d.columns[k]) - 1);
  return {
    ...base,
    pdfLayout: null,
    parser: d.parser,
    settings: {
      headerRows: Number(d.headerRows),
      columnCount: d.byHeader ? null : Number(d.columnCount),
      columns: { date: col('date'), description: col('description'), debit: col('debit'), credit: col('credit'), account: col('account'), cheque: col('cheque') },
      headerNames: d.byHeader
        ? Object.fromEntries(COLUMN_KEYS.filter((k) => d.headerNames[k].trim() && !(COLUMN_FIELDS[k].bankOnly && d.parser !== 'bank')).map((k) => [k, d.headerNames[k].trim()]))
        : null,
      dateFormats: d.dateFormats
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    },
  };
}

/** Field errors from a server validation response, keyed by path (e.g. "settings.columns.date"). */
function serverFieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return {};
  return Object.fromEntries((e.details as { path?: (string | number)[]; message?: string }[]).filter((i) => i.path?.length).map((i) => [i.path!.join('.'), i.message ?? 'is invalid']));
}

/** A quick, quote-aware split of the first lines of a sample file, only for previewing columns. */
function previewRows(text: string, limit = 8): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines.slice(0, limit)) {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"' && cur === '') quoted = true;
      else if (c === ',') cells.push(cur), (cur = '');
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function SamplePreview({ draft, onColumnCount }: { draft: Draft; onColumnCount: (n: number) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  useEffect(() => {
    const f = files[0];
    if (!f) return setRows([]);
    void f
      .slice(0, 64 * 1024)
      .text()
      .then((t) => setRows(previewRows(t)));
  }, [files]);

  const skip = wholeNumber(draft.headerRows, 0) ?? 0;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const titles = (rows[skip] ?? []).map((t) => t.trim().toLowerCase());
  const isColumn = (k: ColumnKey, i: number) =>
    draft.byHeader ? !!draft.headerNames[k].trim() && titles[i] === draft.headerNames[k].trim().toLowerCase() : draft.columns[k].trim() === String(i + 1);
  const roleOf = (i: number) =>
    COLUMN_KEYS.filter((k) => isColumn(k, i) && !(COLUMN_FIELDS[k].bankOnly && draft.parser !== 'bank'))
      .map((k) => COLUMN_FIELDS[k].label)
      .join(', ');
  const counts = [...new Set(rows.slice(skip).map((r) => r.length))];

  return (
    <SpaceBetween size="s">
      <FormField label="Sample statement (optional)" description="Shows the first rows with their column numbers. It stays in your browser and isn't imported.">
        <FileUpload value={files} onChange={(e) => setFiles(e.detail.value)} accept=".csv,text/csv" showFileSize />
      </FormField>
      {rows.length > 0 && (
        <>
          <Table
            variant="embedded"
            wrapLines={false}
            items={rows.map((cells, i) => ({ i, cells }))}
            trackBy="i"
            columnDefinitions={[
              { id: 'row', header: 'Row', cell: (r) => (r.i < skip ? <Box color="text-status-inactive">{r.i + 1} (skipped)</Box> : r.i + 1), width: 110 },
              ...Array.from({ length: width }, (_, c) => ({
                id: `c${c}`,
                header: (
                  <span>
                    {c + 1}
                    {roleOf(c) && (
                      <Box variant="small" display="block">
                        {roleOf(c)}
                      </Box>
                    )}
                  </span>
                ),
                cell: (r: { i: number; cells: string[] }) => (r.i < skip ? <Box color="text-status-inactive">{r.cells[c] ?? ''}</Box> : (r.cells[c] ?? '')),
              })),
            ]}
          />
          {!draft.byHeader && counts.length === 1 && String(counts[0]) !== draft.columnCount.trim() && (
            <Box>
              The data rows have {pluralize(counts[0], 'column')}.{' '}
              <Button variant="inline-link" onClick={() => onColumnCount(counts[0])}>
                Use {counts[0]} as the column count
              </Button>
            </Box>
          )}
        </>
      )}
    </SpaceBetween>
  );
}

function FormatModal({
  initial,
  editingId,
  layouts,
  visible,
  onDismiss,
  onSaved,
}: {
  initial: StatementFormat | null;
  editingId: number | null;
  layouts: PdfLayoutInfo[];
  visible: boolean;
  onDismiss: () => void;
  onSaved: () => void;
}) {
  const { notify } = useApp();
  const [d, setD] = useState<Draft>(toDraft());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setD(toDraft(initial));
    setSubmitted(false);
    setServerErrors({});
    setFormError(undefined);
  }, [visible, initial]);

  const set = (patch: Partial<Draft>) => {
    setD((prev) => ({ ...prev, ...patch }));
    setServerErrors({});
  };
  const clientErrors = validate(d);
  const err = (path: string) => (submitted ? (clientErrors[path] ?? serverErrors[path]) : serverErrors[path]);

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(clientErrors).length) return;
    setSaving(true);
    setFormError(undefined);
    try {
      const input = toInput(d);
      const saved = editingId !== null ? await api.statementFormats.update(editingId, input) : await api.statementFormats.create(input);
      notify('success', saved.name, editingId !== null ? 'Statement format updated' : 'Statement format created');
      onSaved();
    } catch (e) {
      const fields = serverFieldErrors(e);
      setServerErrors(fields);
      setFormError(Object.keys(fields).length ? 'Check the highlighted fields.' : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const layout = layouts.find((l) => l.id === d.pdfLayout);
  const columnField = (k: ColumnKey) => {
    const f = COLUMN_FIELDS[k];
    const required = k === 'date' || k === 'description' || (k === 'account' && d.parser === 'bank');
    const description = d.parser === 'bank' ? f.bank : f.card;
    const constraint = required ? undefined : k === 'debit' || k === 'credit' ? 'Amount or credit is required' : 'Optional';
    return d.byHeader ? (
      <FormField key={k} label={f.label} description={description} constraintText={constraint} errorText={err(`settings.headerNames.${k}`)}>
        <Input value={d.headerNames[k]} onChange={(e) => set({ headerNames: { ...d.headerNames, [k]: e.detail.value } })} placeholder="Column title" />
      </FormField>
    ) : (
      <FormField key={k} label={f.label} description={description} constraintText={constraint} errorText={err(`settings.columns.${k}`)}>
        <Input type="number" inputMode="numeric" value={d.columns[k]} onChange={(e) => set({ columns: { ...d.columns, [k]: e.detail.value } })} placeholder="Column number" />
      </FormField>
    );
  };

  return (
    <Modal
      visible={visible}
      size="large"
      onDismiss={onDismiss}
      header={editingId !== null ? 'Edit statement format' : 'Create statement format'}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={formError}>
        <SpaceBetween size="l">
          <ColumnLayout columns={2}>
            <FormField label="Name" errorText={err('name')}>
              <Input value={d.name} onChange={(e) => set({ name: e.detail.value })} placeholder="e.g. Example Bank Visa" autoFocus />
            </FormField>
            <FormField
              label="File name contains"
              description="Case-insensitive. When several formats match a file, the longest pattern wins."
              errorText={err('fileNamePattern')}
            >
              <Input value={d.fileNamePattern} onChange={(e) => set({ fileNamePattern: e.detail.value })} placeholder="e.g. example visa" />
            </FormField>
          </ColumnLayout>
          <FormField label="File type">
            <SegmentedControl
              selectedId={d.fileType}
              onChange={(e) => set({ fileType: e.detail.selectedId as Draft['fileType'] })}
              options={[
                { id: 'csv', text: 'CSV' },
                { id: 'pdf', text: 'PDF' },
              ]}
            />
          </FormField>

          {d.fileType === 'pdf' ? (
            <FormField
              label="PDF layout"
              description="Reading a PDF statement needs code written for that bank's layout. Choose one of the built-in layouts."
              errorText={err('pdfLayout')}
            >
              <Select
                selectedOption={layout ? { value: layout.id, label: layout.label, description: layout.description } : null}
                options={layouts.map((l) => ({ value: l.id, label: l.label, description: l.description }))}
                onChange={(e) => set({ pdfLayout: e.detail.selectedOption.value as PdfLayoutId })}
                placeholder="Choose a layout"
              />
            </FormField>
          ) : (
            <>
              <FormField label="Statement kind">
                <Tiles
                  value={d.parser}
                  onChange={(e) => set({ parser: e.detail.value as StatementParserKind })}
                  columns={2}
                  items={[
                    {
                      value: 'card',
                      label: 'Credit card',
                      description: 'One account per file. Rows are expenses, credits are refunds, and card payments are skipped. The account is chosen when importing or by its statement file pattern.',
                    },
                    {
                      value: 'bank',
                      label: 'Bank account',
                      description: 'Each row has an account number. Money in becomes a deposit and money out an expense; payroll and interest count as income.',
                    },
                  ]}
                />
              </FormField>
              <ColumnLayout columns={3}>
                <FormField label="Rows to skip" description="Title or notes above the data." errorText={err('settings.headerRows')}>
                  <Input type="number" inputMode="numeric" value={d.headerRows} onChange={(e) => set({ headerRows: e.detail.value })} />
                </FormField>
                <FormField label="Find columns by" stretch>
                  <RadioGroup
                    value={d.byHeader ? 'header' : 'position'}
                    onChange={(e) => set({ byHeader: e.detail.value === 'header' })}
                    items={[
                      { value: 'position', label: 'Position', description: 'Fixed column numbers' },
                      { value: 'header', label: 'Header titles', description: 'The first row after the skipped ones names the columns' },
                    ]}
                  />
                </FormField>
                {!d.byHeader && (
                  <FormField label="Number of columns" description="Rows with a different count are ignored." errorText={err('settings.columnCount')}>
                    <Input type="number" inputMode="numeric" value={d.columnCount} onChange={(e) => set({ columnCount: e.detail.value })} />
                  </FormField>
                )}
              </ColumnLayout>
              <Container header={<Header variant="h3" description={d.byHeader ? 'Titles are matched ignoring case.' : 'Count columns from 1.'}>Columns</Header>}>
                <ColumnLayout columns={2}>{COLUMN_KEYS.filter((k) => !COLUMN_FIELDS[k].bankOnly || d.parser === 'bank').map(columnField)}</ColumnLayout>
              </Container>
              <FormField
                label="Date formats"
                description="One per line, tried in order. %Y year, %m month number, %d day, %b month name (Jan), %B full month name, %y two-digit year."
                errorText={err('settings.dateFormats') ?? Object.entries(serverErrors).find(([k]) => k.startsWith('settings.dateFormats.'))?.[1]}
              >
                <Textarea value={d.dateFormats} onChange={(e) => set({ dateFormats: e.detail.value })} rows={3} placeholder={'%Y-%m-%d\n%m/%d/%Y'} />
              </FormField>
              {/* Mounted only while open, so a previous sample doesn't linger. */}
              {visible && <SamplePreview draft={d} onColumnCount={(n) => set({ columnCount: String(n) })} />}
            </>
          )}
          <Toggle checked={d.isActive} onChange={(e) => set({ isActive: e.detail.checked })}>
            Active
          </Toggle>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

function describeColumns(f: StatementFormat, layouts: PdfLayoutInfo[]): string {
  if (f.fileType === 'pdf') return layouts.find((l) => l.id === f.pdfLayout)?.label ?? f.pdfLayout ?? '';
  const s = f.settings!;
  const keys = COLUMN_KEYS.filter((k) => !COLUMN_FIELDS[k].bankOnly || f.parser === 'bank');
  if (s.columnCount === null) {
    return keys.filter((k) => s.headerNames?.[k]).map((k) => `${COLUMN_FIELDS[k].label}: "${s.headerNames![k]}"`).join(' · ');
  }
  return keys.filter((k) => s.columns[k] !== null).map((k) => `${COLUMN_FIELDS[k].label} ${s.columns[k]! + 1}`).join(' · ');
}

type TypeFilter = 'all' | 'csv' | 'pdf';

export default function StatementFormatsPage() {
  const { notify, notifyError } = useApp();
  const { canEdit } = useAuth();
  const formats = useAsync(() => api.statementFormats.list(), []);
  const layouts = useAsync(() => api.statementFormats.pdfLayouts(), []);
  const [text, setText] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [selected, setSelected] = useState<StatementFormat[]>([]);
  /** undefined: closed. null initial: create. */
  const [modal, setModal] = useState<{ initial: StatementFormat | null; editingId: number | null } | undefined>();
  const [deleting, setDeleting] = useState<StatementFormat | null>(null);

  const items = useMemo(() => {
    const t = text.toLowerCase();
    return (formats.data ?? []).filter((f) => (type === 'all' || f.fileType === type) && (!t || `${f.name} ${f.fileNamePattern}`.toLowerCase().includes(t)));
  }, [formats.data, text, type]);
  const one = selected[0];
  const refresh = () => {
    setSelected([]);
    formats.reload();
  };

  return (
    <>
      <Table
        variant="full-page"
        stickyHeader
        resizableColumns
        loading={formats.loading}
        loadingText="Loading statement formats"
        items={items}
        trackBy="statementFormatIdx"
        selectionType={canEdit ? 'single' : undefined}
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        onRowClick={(e) => canEdit && setSelected([e.detail.item])}
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={`(${items.length})`}
            description={
              <>
                How uploaded statements are read. The format is chosen from the file name when you <RouterLink href="/import">import statements</RouterLink>.
              </>
            }
            actions={
              canEdit && (
                <SpaceBetween direction="horizontal" size="xs">
                  <Button disabled={!one} onClick={() => setDeleting(one)}>
                    Delete
                  </Button>
                  <Button disabled={!one} onClick={() => setModal({ initial: { ...one, name: `${one.name} (copy)`, fileNamePattern: '' }, editingId: null })}>
                    Duplicate
                  </Button>
                  <Button disabled={!one} onClick={() => setModal({ initial: one, editingId: one.statementFormatIdx })}>
                    Edit
                  </Button>
                  <Button variant="primary" onClick={() => setModal({ initial: null, editingId: null })}>
                    Create format
                  </Button>
                </SpaceBetween>
              )
            }
          >
            Statement formats
          </Header>
        }
        filter={
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <TextFilter filteringText={text} onChange={(e) => setText(e.detail.filteringText)} filteringPlaceholder="Find formats" countText={pluralize(items.length, 'match', 'matches')} />
            <SegmentedControl
              label="File type"
              selectedId={type}
              onChange={(e) => setType(e.detail.selectedId as TypeFilter)}
              options={[
                { id: 'all', text: 'All' },
                { id: 'csv', text: 'CSV' },
                { id: 'pdf', text: 'PDF' },
              ]}
            />
          </SpaceBetween>
        }
        empty={<EmptyState title="No statement formats" action={canEdit && <Button onClick={() => setModal({ initial: null, editingId: null })}>Create format</Button>} />}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: (f) => f.name, isRowHeader: true, width: 230 },
          { id: 'pattern', header: 'File name contains', cell: (f) => <Box variant="code">{f.fileNamePattern}</Box>, width: 230 },
          { id: 'type', header: 'Type', cell: (f) => f.fileType.toUpperCase(), width: 80 },
          { id: 'kind', header: 'Statement kind', cell: (f) => (f.fileType === 'pdf' ? 'PDF layout' : PARSER_LABELS[f.parser!]), width: 150 },
          { id: 'columns', header: 'Columns', cell: (f) => describeColumns(f, layouts.data ?? []), width: 420 },
          { id: 'dates', header: 'Date formats', cell: (f) => f.settings?.dateFormats.join(', ') ?? '—' },
          { id: 'status', header: 'Status', cell: (f) => <StatusIndicator type={f.isActive ? 'success' : 'stopped'}>{f.isActive ? 'Active' : 'Inactive'}</StatusIndicator>, width: 120 },
        ]}
      />

      {layouts.error && <Alert type="error">{layouts.error}</Alert>}

      <FormatModal
        visible={modal !== undefined}
        initial={modal?.initial ?? null}
        editingId={modal?.editingId ?? null}
        layouts={layouts.data ?? []}
        onDismiss={() => setModal(undefined)}
        onSaved={() => {
          setModal(undefined);
          refresh();
        }}
      />

      <ConfirmModal
        visible={!!deleting}
        header="Delete statement format"
        onDismiss={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.statementFormats.remove(deleting!.statementFormatIdx);
            notify('success', deleting!.name, 'Statement format deleted');
            refresh();
          } catch (e) {
            notifyError(e, 'Could not delete the statement format');
          }
          setDeleting(null);
        }}
      >
        Delete <Box variant="span" fontWeight="bold">{deleting?.name}</Box>? Files whose names match it will no longer be recognised. To keep it for later, edit it and turn
        off “Active” instead.
      </ConfirmModal>
    </>
  );
}
