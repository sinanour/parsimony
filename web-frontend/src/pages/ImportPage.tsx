import { useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FileUpload from '@cloudscape-design/components/file-upload';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { UNCATEGORIZED, type ImportCommitResponse, type ImportParseResponse, type ImportRecord } from '../../../shared/types';
import { api } from '../api/client';
import { AccountSelect, RouterLink } from '../components/common';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { errorMessage, formatMoney, pluralize } from '../utils/format';

interface ParsedFile extends ImportParseResponse {
  /** Unique across files. */
  id: string;
  error?: string;
}

const recordKey = (fileId: string, r: ImportRecord) => `${fileId}:${r.key}`;

export default function ImportPage() {
  const { canEdit } = useAuth();
  return canEdit ? <ImportStatements /> : <Alert type="info" header="Read-only access">Importing statements needs the Editor or Administrator role.</Alert>;
}

function ImportStatements() {
  const { notifyError, reloadMeta } = useApp();
  const [files, setFiles] = useState<File[]>([]);
  const [accountIdx, setAccountIdx] = useState<number | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runRules, setRunRules] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ImportCommitResponse | null>(null);

  const parse = async () => {
    setParsing(true);
    setResult(null);
    const out: ParsedFile[] = [];
    for (const [i, f] of files.entries()) {
      try {
        const r = await api.imports.parse(f, accountIdx ?? undefined);
        out.push({ ...r, id: `${i}` });
      } catch (e) {
        out.push({ id: `${i}`, fileName: f.name, formatName: null, records: [], warnings: [], error: errorMessage(e) });
      }
    }
    setParsed(out);
    setSelected(new Set(out.flatMap((p) => p.records.filter((r) => !r.isDuplicate).map((r) => recordKey(p.id, r)))));
    setParsing(false);
  };

  const chosen = useMemo(() => parsed.flatMap((p) => p.records.filter((r) => selected.has(recordKey(p.id, r)))), [parsed, selected]);

  const commit = async () => {
    setCommitting(true);
    try {
      const res = await api.imports.commit({
        runRules,
        records: chosen.map((r) => ({
          type: r.type,
          transactionDate: r.transactionDate,
          description: r.description,
          amount: r.amount,
          accountIdx: r.accountIdx,
          category: r.category,
          exemption: r.exemption,
          incomeAmount: r.incomeAmount,
        })),
      });
      setResult(res);
      setParsed([]);
      setFiles([]);
      setSelected(new Set());
      reloadMeta();
    } catch (e) {
      notifyError(e, 'Import failed — nothing was saved');
    } finally {
      setCommitting(false);
    }
  };

  const categorized = result?.rules.reduce((s, r) => s + r.totalRows, 0) ?? 0;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            <>
              Upload CSV or PDF statements. The file name picks the <RouterLink href="/statement-formats">statement format</RouterLink> (e.g. “RBC Personal Visa
              2026-02.pdf”).
            </>
          }
        >
          Import statements
        </Header>
      }
    >
      <SpaceBetween size="l">
        {result && (
          <Alert type="success" header="Import complete" dismissible onDismiss={() => setResult(null)}>
            <SpaceBetween size="xs">
              <Box>
                Added {pluralize(result.expensesInserted, 'expense')} and {pluralize(result.depositsInserted, 'deposit')}
                {result.rules.length > 0 && `; categorization rules categorized ${pluralize(categorized, 'expense')}`}.
              </Box>
              <SpaceBetween direction="horizontal" size="m">
                <RouterLink href={`/expenses?category=${UNCATEGORIZED}`}>Review uncategorized expenses</RouterLink>
                <RouterLink href="/deposits?reviewed=unreviewed">Review unreviewed deposits</RouterLink>
              </SpaceBetween>
            </SpaceBetween>
          </Alert>
        )}

        <Container header={<Header variant="h2">1. Choose statements</Header>}>
          <Form
            actions={
              <Button variant="primary" loading={parsing} disabled={files.length === 0} onClick={parse}>
                Preview
              </Button>
            }
          >
            <SpaceBetween size="m">
              <FormField label="Statement files" description="Nothing is written to the database until you confirm the preview.">
                <FileUpload
                  value={files}
                  onChange={(e) => {
                    setFiles(e.detail.value);
                    setParsed([]);
                  }}
                  multiple
                  accept=".csv,.pdf"
                  showFileSize
                  showFileLastModified
                  constraintText="CSV or PDF, up to 50 MB each"
                />
              </FormField>
              <FormField
                label="Account override"
                description="Only needed when the account can't be worked out from the statement: bank statements match on the account number, card statements on the account's statement file pattern."
              >
                <AccountSelect value={accountIdx} onChange={setAccountIdx} allowAll placeholder="Detect from statement" />
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>

        {parsed.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                description="Records that already exist in the database are flagged as duplicates and left unselected."
                actions={
                  <SpaceBetween direction="horizontal" size="m" alignItems="center">
                    <Checkbox checked={runRules} onChange={(e) => setRunRules(e.detail.checked)}>
                      Run categorization rules afterwards
                    </Checkbox>
                    <Button variant="primary" loading={committing} disabled={chosen.length === 0} onClick={commit}>
                      Import {pluralize(chosen.length, 'record')}
                    </Button>
                  </SpaceBetween>
                }
              >
                2. Review and import
              </Header>
            }
          >
            <SpaceBetween size="l">
              {parsed.map((p) => {
                const dupes = p.records.filter((r) => r.isDuplicate).length;
                const exp = p.records.filter((r) => r.type === 'expense');
                const dep = p.records.filter((r) => r.type === 'deposit');
                const fileSelected = p.records.filter((r) => selected.has(recordKey(p.id, r)));
                return (
                  <ExpandableSection
                    key={p.id}
                    variant="container"
                    defaultExpanded
                    headerText={p.fileName}
                    headerCounter={`(${p.records.length})`}
                    headerDescription={
                      p.error
                        ? 'Could not be parsed'
                        : `${p.formatName ? `${p.formatName} · ` : ''}${pluralize(exp.length, 'expense')}, ${pluralize(dep.length, 'deposit')}, ${pluralize(dupes, 'duplicate')}`
                    }
                  >
                    <SpaceBetween size="m">
                      {p.error && (
                        <Alert type="error" header="Parser error">
                          {p.error}
                        </Alert>
                      )}
                      {!p.error && !p.formatName && (
                        <Alert type="info" header="Unrecognised file name">
                          Create a <RouterLink href="/statement-formats">statement format</RouterLink> whose pattern appears in this file's name, or rename the file to match an existing one.
                        </Alert>
                      )}
                      {p.formatName && p.warnings.length > 0 && (
                        <Alert type="warning" header="Check these before importing">
                          <SpaceBetween size="xxs">
                            {p.warnings.map((w, i) => (
                              <Box key={i}>{w}</Box>
                            ))}
                          </SpaceBetween>
                        </Alert>
                      )}
                      {p.records.length > 0 && (
                        <KeyValuePairs
                          columns={3}
                          items={[
                            { label: 'Expenses total', value: formatMoney(exp.reduce((s, r) => s + r.amount, 0)) },
                            { label: 'Deposits total', value: formatMoney(dep.reduce((s, r) => s + r.amount, 0)) },
                            { label: 'Date range', value: `${p.records.map((r) => r.transactionDate).sort()[0]} – ${p.records.map((r) => r.transactionDate).sort().at(-1)}` },
                          ]}
                        />
                      )}
                      {p.records.length > 0 && (
                        <Table<ImportRecord>
                          variant="embedded"
                          items={p.records}
                          trackBy="key"
                          selectionType="multi"
                          selectedItems={fileSelected}
                          onSelectionChange={(e) => {
                            const next = new Set(selected);
                            p.records.forEach((r) => next.delete(recordKey(p.id, r)));
                            e.detail.selectedItems.forEach((r) => next.add(recordKey(p.id, r)));
                            setSelected(next);
                          }}
                          columnDefinitions={[
                            { id: 'type', header: 'Type', cell: (r) => <Badge color={r.type === 'expense' ? 'grey' : 'green'}>{r.type === 'expense' ? 'Expense' : 'Deposit'}</Badge>, width: 110 },
                            { id: 'date', header: 'Date', cell: (r) => r.transactionDate, width: 120 },
                            { id: 'description', header: 'Description', cell: (r) => r.description, isRowHeader: true },
                            { id: 'amount', header: 'Amount', cell: (r) => <Box textAlign="right">{formatMoney(r.amount)}</Box>, width: 120 },
                            { id: 'income', header: 'Income', cell: (r) => (r.type === 'deposit' ? formatMoney(r.incomeAmount) : ''), width: 110 },
                            { id: 'account', header: 'Account', cell: (r) => r.accountName },
                            {
                              id: 'status',
                              header: 'Status',
                              cell: (r) => (r.isDuplicate ? <StatusIndicator type="stopped">Already imported</StatusIndicator> : <StatusIndicator type="success">New</StatusIndicator>),
                              width: 160,
                            },
                          ]}
                        />
                      )}
                    </SpaceBetween>
                  </ExpandableSection>
                );
              })}
            </SpaceBetween>
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
