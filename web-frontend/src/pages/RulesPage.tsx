import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { TEXT_LIMITS, type Rule, type RuleInput, type RuleMatch, type RulePreview, type RuleRunResponse } from '../../../shared/types';
import { api } from '../api/client';
import { CategoryInput, ConfirmModal, EmptyState, ScopeControl } from '../components/common';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks/useAsync';
import { EXEMPTION_HELP, errorMessage, formatExemption, formatMoney, parseNumber, pluralize } from '../utils/format';

type RuleScope = 'personal' | 'corporate';

interface Draft {
  descriptionFilter: string;
  minimumAmount: string;
  maximumAmount: string;
  category: string;
  exemption: string;
}

const toDraft = (r?: Partial<Rule>): Draft => ({
  descriptionFilter: r?.descriptionFilter ?? '',
  minimumAmount: r?.minimumAmount == null ? '' : String(r.minimumAmount),
  maximumAmount: r?.maximumAmount == null ? '' : String(r.maximumAmount),
  category: r?.category ?? '',
  exemption: r?.exemption == null ? '' : String(r.exemption),
});

export function describeAmountRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'Any amount';
  if (min === null) return `≤ ${formatMoney(max)}`;
  if (max === null) return `≥ ${formatMoney(min)}`;
  return `${formatMoney(min)} – ${formatMoney(max)}`;
}

function MatchTable({ items, total, loading, header }: { items: RuleMatch[]; total?: number; loading?: boolean; header?: string }) {
  return (
    <Table<RuleMatch>
      variant="embedded"
      loading={loading}
      loadingText="Finding matches"
      items={items}
      trackBy="expenseIdx"
      header={header ? <Header variant="h3" counter={total !== undefined ? `(${total})` : undefined}>{header}</Header> : undefined}
      empty={<Box textAlign="center" color="inherit">No uncategorized expenses match.</Box>}
      columnDefinitions={[
        { id: 'date', header: 'Date', cell: (m) => m.transactionDate, width: 120 },
        { id: 'description', header: 'Description', cell: (m) => m.description, isRowHeader: true },
        { id: 'amount', header: 'Amount', cell: (m) => <Box textAlign="right">{formatMoney(m.amount)}</Box>, width: 120 },
        { id: 'account', header: 'Account', cell: (m) => m.accountName },
      ]}
    />
  );
}

function RuleModal({
  visible,
  scope,
  rule,
  initial,
  onDismiss,
  onSaved,
}: {
  visible: boolean;
  scope: RuleScope;
  rule: Rule | null;
  initial?: Partial<Draft>;
  onDismiss: () => void;
  onSaved: () => void;
}) {
  const { notify, reloadMeta } = useApp();
  const [d, setD] = useState<Draft>(toDraft());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<RulePreview>();
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setD({ ...toDraft(rule ?? undefined), ...initial });
    setSubmitted(false);
    setError(undefined);
    setPreview(undefined);
  }, [visible, rule, initial]);

  const min = parseNumber(d.minimumAmount);
  const max = parseNumber(d.maximumAmount);
  const ex = parseNumber(d.exemption);
  const errors = {
    descriptionFilter: d.descriptionFilter.trim() ? undefined : 'Enter text to match',
    minimumAmount: Number.isNaN(min) ? 'Enter a number' : undefined,
    maximumAmount: Number.isNaN(max) ? 'Enter a number' : min !== null && max !== null && min > max ? 'Must be at least the minimum' : undefined,
    category: d.category.trim() ? undefined : 'Enter a category',
    exemption: Number.isNaN(ex) ? 'Enter a number' : ex !== null && ex < 0 ? 'Cannot be negative' : undefined,
  };

  // Live preview of the uncategorized expenses this rule would match.
  useEffect(() => {
    if (!visible || !d.descriptionFilter.trim() || Number.isNaN(min) || Number.isNaN(max)) {
      setPreview(undefined);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(() => {
      api.rules
        .preview({ descriptionFilter: d.descriptionFilter.trim(), minimumAmount: min, maximumAmount: max, isCorporate: scope === 'corporate' })
        .then((p) => !cancelled && setPreview(p))
        .catch(() => !cancelled && setPreview(undefined))
        .finally(() => !cancelled && setPreviewLoading(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [visible, d.descriptionFilter, min, max, scope]);

  const save = async () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    const input: RuleInput = {
      descriptionFilter: d.descriptionFilter.trim(),
      minimumAmount: min,
      maximumAmount: max,
      category: d.category.trim(),
      exemption: ex,
      isCorporate: scope === 'corporate',
    };
    setSaving(true);
    try {
      if (rule) await api.rules.update(rule.ruleIdx, input);
      else await api.rules.create(input);
      notify('success', `"${input.descriptionFilter}" → ${input.category}`, rule ? 'Rule updated' : 'Rule created');
      reloadMeta();
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const wildcard = /[%_]/.test(d.descriptionFilter);

  return (
    <Modal
      visible={visible}
      size="large"
      onDismiss={onDismiss}
      header={rule ? `Edit rule #${rule.ruleIdx}` : `Create ${scope} rule`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save rule
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        <Form errorText={error}>
          <SpaceBetween size="m">
            <FormField
              label="Description contains"
              description={
                wildcard
                  ? 'Contains % or _, so it is used as a SQL LIKE pattern as-is (% = any text, _ = one character).'
                  : 'Matched anywhere in the description, ignoring case. Use % or _ for a custom LIKE pattern, e.g. "a&w%" to match only at the start.'
              }
              errorText={submitted ? errors.descriptionFilter : undefined}
            >
              <Input
                value={d.descriptionFilter}
                onChange={(e) => setD({ ...d, descriptionFilter: e.detail.value })}
                autoFocus
                nativeInputAttributes={{ maxLength: TEXT_LIMITS.ruleFilter }}
              />
            </FormField>
            <ColumnLayout columns={2}>
              <FormField label="Minimum amount" constraintText="Optional, inclusive" errorText={submitted ? errors.minimumAmount : undefined}>
                <Input value={d.minimumAmount} onChange={(e) => setD({ ...d, minimumAmount: e.detail.value })} inputMode="decimal" />
              </FormField>
              <FormField label="Maximum amount" constraintText="Optional, inclusive" errorText={submitted ? errors.maximumAmount : undefined}>
                <Input value={d.maximumAmount} onChange={(e) => setD({ ...d, maximumAmount: e.detail.value })} inputMode="decimal" />
              </FormField>
              <FormField label="Category" errorText={submitted ? errors.category : undefined}>
                <CategoryInput value={d.category} onChange={(category) => setD({ ...d, category })} scope={scope} />
              </FormField>
              <FormField label="Exemption" description={EXEMPTION_HELP} errorText={submitted ? errors.exemption : undefined}>
                <Input value={d.exemption} onChange={(e) => setD({ ...d, exemption: e.detail.value })} inputMode="decimal" />
              </FormField>
            </ColumnLayout>
          </SpaceBetween>
        </Form>
        <MatchTable header="Currently uncategorized matches" items={preview?.items ?? []} total={preview?.total} loading={previewLoading} />
      </SpaceBetween>
    </Modal>
  );
}

function RunResults({ run, onApply, applying, onClose }: { run: RuleRunResponse; onApply: () => void; applying: boolean; onClose: () => void }) {
  const { canEdit } = useAuth();
  return (
    <Modal
      visible
      size="max"
      onDismiss={onClose}
      header={run.dryRun ? 'Dry run results' : 'Rules applied'}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>
              {run.dryRun ? 'Cancel' : 'Close'}
            </Button>
            {run.dryRun && canEdit && (
              <Button variant="primary" loading={applying} disabled={run.totalRows === 0} onClick={onApply}>
                Apply to {pluralize(run.totalRows, 'expense')}
              </Button>
            )}
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type={run.dryRun ? 'info' : 'success'}>
          {run.dryRun
            ? `${pluralize(run.results.length, 'rule')} would categorize ${pluralize(run.totalRows, 'expense')}. Rules run in order and each expense is categorized by the first rule that matches. Nothing has been changed yet.`
            : `${pluralize(run.results.length, 'rule')} categorized ${pluralize(run.totalRows, 'expense')}.`}
        </Alert>
        {run.results.map((r) => (
          <ExpandableSection
            key={r.ruleIdx}
            variant="container"
            headerText={`#${r.ruleIdx} "${r.descriptionFilter}" → ${r.category ?? '—'} (${formatExemption(r.exemption)})`}
            headerCounter={`(${r.rowCount})`}
          >
            <MatchTable items={r.matches} />
          </ExpandableSection>
        ))}
      </SpaceBetween>
    </Modal>
  );
}

export default function RulesPage() {
  const { notify, notifyError } = useApp();
  const { canEdit } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope: RuleScope = params.get('scope') === 'corporate' ? 'corporate' : 'personal';
  const rules = useAsync(() => api.rules.list(scope), [scope]);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Rule[]>([]);
  const [editing, setEditing] = useState<{ rule: Rule | null; initial?: Partial<Draft> } | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [run, setRun] = useState<RuleRunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [sorting, setSorting] = useState<{ col: TableProps.SortingColumn<Rule>; desc: boolean }>({ col: { sortingField: 'ruleIdx' }, desc: false });

  // "Create rule from expense" links here with ?new=1&filter=…
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setEditing({
      rule: null,
      initial: { descriptionFilter: params.get('filter') ?? '', category: params.get('category') ?? '', exemption: params.get('exemption') ?? '' },
    });
    const next = new URLSearchParams(params);
    ['new', 'filter', 'category', 'exemption'].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  }, [params, setParams]);

  const items = useMemo(() => {
    const t = text.toLowerCase();
    const f = (rules.data ?? []).filter((r) => !t || r.descriptionFilter.toLowerCase().includes(t) || (r.category ?? '').toLowerCase().includes(t));
    const field = sorting.col.sortingField as keyof Rule;
    return [...f].sort((a, b) => {
      const x = a[field] ?? '';
      const y = b[field] ?? '';
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sorting.desc ? -c : c;
    });
  }, [rules.data, text, sorting]);

  const totalMatches = (rules.data ?? []).filter((r) => r.matchCount > 0).length;
  const one = selected[0];

  const doRun = async (dryRun: boolean) => {
    setRunning(true);
    try {
      const r = await api.rules.run(scope, dryRun);
      setRun(r);
      if (!dryRun) {
        notify('success', `${pluralize(r.totalRows, 'expense')} categorized`, 'Rules applied');
        rules.reload();
      }
    } catch (e) {
      notifyError(e, 'Could not run rules');
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Table<Rule>
        variant="full-page"
        stickyHeader
        resizableColumns
        loading={rules.loading}
        loadingText="Loading rules"
        items={items}
        trackBy="ruleIdx"
        selectionType={canEdit ? 'single' : undefined}
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        onRowClick={(e) => canEdit && setSelected([e.detail.item])}
        sortingColumn={sorting.col}
        sortingDescending={sorting.desc}
        onSortingChange={(e) => setSorting({ col: e.detail.sortingColumn, desc: !!e.detail.isDescending })}
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={`(${items.length})`}
            description="Rules set the category and exemption of uncategorized expenses whose description matches. They run in # order; the first matching rule wins."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {canEdit && (
                  <>
                    <Button disabled={!one} onClick={() => setDeleting(one)}>
                      Delete
                    </Button>
                    <Button disabled={!one} onClick={() => setEditing({ rule: one })}>
                      Edit
                    </Button>
                    <Button onClick={() => setEditing({ rule: null })}>Create rule</Button>
                  </>
                )}
                <Button variant="primary" iconName="caret-right-filled" loading={running} onClick={() => doRun(true)}>
                  {canEdit ? 'Run rules' : 'Preview rules'}
                </Button>
              </SpaceBetween>
            }
          >
            Categorization rules
          </Header>
        }
        filter={
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <TextFilter filteringText={text} onChange={(e) => setText(e.detail.filteringText)} filteringPlaceholder="Find by text or category" countText={pluralize(items.length, 'match', 'matches')} />
            <ScopeControl
              value={scope}
              includeAll={false}
              onChange={(s) => {
                setSelected([]);
                setParams(s === 'corporate' ? { scope: 'corporate' } : {});
              }}
            />
            {rules.data && (
              <Box color="text-body-secondary">
                {totalMatches > 0 ? `${pluralize(totalMatches, 'rule')} match uncategorized expenses.` : 'No rule matches an uncategorized expense.'}
              </Box>
            )}
          </SpaceBetween>
        }
        empty={<EmptyState title="No rules" action={canEdit && <Button onClick={() => setEditing({ rule: null })}>Create rule</Button>} />}
        columnDefinitions={[
          { id: 'idx', header: '#', cell: (r) => r.ruleIdx, sortingField: 'ruleIdx', width: 80 },
          { id: 'filter', header: 'Description filter', cell: (r) => r.descriptionFilter, sortingField: 'descriptionFilter', isRowHeader: true, width: 260 },
          { id: 'amount', header: 'Amount', cell: (r) => describeAmountRange(r.minimumAmount, r.maximumAmount) },
          { id: 'category', header: 'Category', cell: (r) => r.category ?? '—', sortingField: 'category' },
          { id: 'exemption', header: 'Exemption', cell: (r) => formatExemption(r.exemption), sortingField: 'exemption' },
          {
            id: 'matches',
            header: 'Uncategorized matches',
            cell: (r) => (r.matchCount ? <Box fontWeight="bold">{r.matchCount}</Box> : '0'),
            sortingField: 'matchCount',
          },
        ]}
      />

      <RuleModal
        visible={editing !== null}
        scope={scope}
        rule={editing?.rule ?? null}
        initial={editing?.initial}
        onDismiss={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setSelected([]);
          rules.reload();
        }}
      />

      {run && <RunResults run={run} applying={running} onApply={() => doRun(false)} onClose={() => setRun(null)} />}

      <ConfirmModal
        visible={!!deleting}
        header="Delete rule"
        onDismiss={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.rules.remove(deleting!.ruleIdx);
            notify('success', `Rule #${deleting!.ruleIdx}`, 'Rule deleted');
            setSelected([]);
            rules.reload();
          } catch (e) {
            notifyError(e);
          }
          setDeleting(null);
        }}
      >
        Delete rule #{deleting?.ruleIdx} ("{deleting?.descriptionFilter}" → {deleting?.category})? Expenses it already categorized keep their category.
      </ConfirmModal>
    </>
  );
}
