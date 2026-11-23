import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Checkbox from '@cloudscape-design/components/checkbox';
import DatePicker from '@cloudscape-design/components/date-picker';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Pagination from '@cloudscape-design/components/pagination';
import Popover from '@cloudscape-design/components/popover';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import { UNCATEGORIZED, type Expense, type Scope } from '../../../shared/types';
import { api } from '../api/client';
import { AccountSelect, CategoryInput, ConfirmModal, EmptyState, editableColumns } from '../components/common';
import { TransactionFilters } from '../components/TransactionFilters';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks/useAsync';
import { useUrlParams } from '../hooks/useUrlParams';
import { EXEMPTION_HELP, errorMessage, formatExemption, formatMoney, parseNumber, pluralize, suggestFilter, today } from '../utils/format';

const PAGE_SIZE = 50;

const DEFAULTS = { scope: 'all', accountIdx: '', category: '', from: '', to: '', q: '', page: '1', sort: 'transactionDate', dir: 'desc' };

function validateExemption(v: string): string | undefined {
  const n = parseNumber(v);
  if (n === null) return undefined;
  if (Number.isNaN(n)) return 'Enter a number';
  if (n < 0) return 'Cannot be negative';
  return undefined;
}

function BulkEditModal({ ids, scope, visible, onDismiss, onDone }: { ids: number[]; scope: Scope; visible: boolean; onDismiss: () => void; onDone: () => void }) {
  const { notify, reloadMeta } = useApp();
  const [setCat, setSetCat] = useState(true);
  const [category, setCategory] = useState('');
  const [setEx, setSetEx] = useState(false);
  const [exemption, setExemption] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (visible) {
      setCategory('');
      setExemption('');
      setSetCat(true);
      setSetEx(false);
      setError(undefined);
    }
  }, [visible]);

  const exError = setEx ? validateExemption(exemption) : undefined;

  const save = async () => {
    if (exError || (!setCat && !setEx)) return;
    setSaving(true);
    try {
      const r = await api.expenses.bulk(ids, {
        ...(setCat ? { category: category.trim() || null } : {}),
        ...(setEx ? { exemption: parseNumber(exemption) } : {}),
      });
      notify('success', pluralize(r.updated, 'expense'), 'Expenses updated');
      reloadMeta();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={`Edit ${pluralize(ids.length, 'expense')}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={!setCat && !setEx} onClick={save}>
              Apply
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={error}>
        <SpaceBetween size="m">
          <Checkbox checked={setCat} onChange={(e) => setSetCat(e.detail.checked)}>
            Set category
          </Checkbox>
          {setCat && (
            <FormField label="Category" constraintText="Leave empty to mark as uncategorized.">
              <CategoryInput value={category} onChange={setCategory} scope={scope} />
            </FormField>
          )}
          <Checkbox checked={setEx} onChange={(e) => setSetEx(e.detail.checked)}>
            Set exemption
          </Checkbox>
          {setEx && (
            <FormField label="Exemption" description={EXEMPTION_HELP} errorText={exError}>
              <Input value={exemption} onChange={(e) => setExemption(e.detail.value)} inputMode="decimal" placeholder="e.g. 1, 0.5 or 20" />
            </FormField>
          )}
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

function AddExpenseModal({ visible, onDismiss, onDone }: { visible: boolean; onDismiss: () => void; onDone: () => void }) {
  const { notify, meta } = useApp();
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [accountIdx, setAccountIdx] = useState<number | null>(null);
  const [category, setCategory] = useState('');
  const [exemption, setExemption] = useState('');
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!visible) return;
    setDate(today());
    setDescription('');
    setAmount('');
    setCategory('');
    setExemption('');
    setComment('');
    setSubmitted(false);
    setError(undefined);
    setAccountIdx(meta?.accounts.find((a) => a.name === 'Cash')?.accountIdx ?? null);
    // Only reset when the dialog opens, not when metadata refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const amountNum = parseNumber(amount);
  const isCorp = meta?.accounts.find((a) => a.accountIdx === accountIdx)?.isCorporate ?? false;
  const errors = {
    description: description.trim() ? undefined : 'Enter a description',
    amount: amountNum === null || Number.isNaN(amountNum) ? 'Enter an amount' : undefined,
    account: accountIdx === null ? 'Choose an account' : undefined,
    exemption: validateExemption(exemption),
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    setSaving(true);
    try {
      await api.expenses.create({
        transactionDate: date,
        description: description.trim(),
        amount: amountNum!,
        accountIdx: accountIdx!,
        category: category.trim() || null,
        exemption: parseNumber(exemption),
        comment: comment.trim() || null,
      });
      notify('success', description, 'Expense added');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Add expense"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Add
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={error}>
        <SpaceBetween size="m">
          <FormField label="Account" errorText={submitted ? errors.account : undefined}>
            <AccountSelect value={accountIdx} onChange={setAccountIdx} activeOnly />
          </FormField>
          <FormField label="Date">
            <DatePicker value={date} onChange={(e) => setDate(e.detail.value)} placeholder="YYYY/MM/DD" />
          </FormField>
          <FormField label="Description" errorText={submitted ? errors.description : undefined}>
            <Input value={description} onChange={(e) => setDescription(e.detail.value)} />
          </FormField>
          <FormField label="Amount" errorText={submitted ? errors.amount : undefined}>
            <Input value={amount} onChange={(e) => setAmount(e.detail.value)} inputMode="decimal" />
          </FormField>
          <FormField label="Category" constraintText="Optional">
            <CategoryInput value={category} onChange={setCategory} scope={isCorp ? 'corporate' : 'personal'} />
          </FormField>
          <FormField label="Exemption" description={EXEMPTION_HELP} errorText={submitted ? errors.exemption : undefined}>
            <Input value={exemption} onChange={(e) => setExemption(e.detail.value)} inputMode="decimal" />
          </FormField>
          <FormField label="Comment" constraintText="Optional">
            <Input value={comment} onChange={(e) => setComment(e.detail.value)} />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

export default function ExpensesPage() {
  const { meta, notify, notifyError, reloadMeta } = useApp();
  const { canEdit } = useAuth();
  const navigate = useNavigate();
  const [p, setP] = useUrlParams(DEFAULTS);
  const scope = p.scope as Scope;
  const page = Number(p.page) || 1;
  const [selected, setSelected] = useState<Expense[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<Expense[]>([]);

  const result = useAsync(
    () =>
      api.expenses.list({
        scope,
        accountIdx: p.accountIdx ? Number(p.accountIdx) : undefined,
        category: p.category || undefined,
        from: p.from || undefined,
        to: p.to || undefined,
        q: p.q || undefined,
        page,
        pageSize: PAGE_SIZE,
        sort: p.sort,
        dir: p.dir as 'asc' | 'desc',
      }),
    [scope, p.accountIdx, p.category, p.from, p.to, p.q, page, p.sort, p.dir],
  );

  // Clear the selection when the query changes (but not when an inline edit updates a row).
  useEffect(() => setSelected([]), [scope, p.accountIdx, p.category, p.from, p.to, p.q, page, p.sort, p.dir]);

  const filter = (changes: Partial<Record<keyof typeof DEFAULTS, string | undefined>>) => setP({ ...changes, page: undefined });

  const categoryOptions: SelectProps.Option[] = useMemo(() => {
    const p2 = meta?.categories.personal ?? [];
    const c = meta?.categories.corporate ?? [];
    const list = scope === 'personal' ? p2 : scope === 'corporate' ? c : [...new Set([...p2, ...c])].sort();
    return [{ value: '', label: 'All categories' }, { value: UNCATEGORIZED, label: 'Uncategorized' }, ...list.map((x) => ({ value: x, label: x }))];
  }, [meta, scope]);

  const total = result.data?.total ?? 0;

  const replaceItem = (e: Expense) =>
    result.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.expenseIdx === e.expenseIdx ? e : x)) } : d));

  const submitEdit: TableProps.SubmitEditFunction<Expense> = async (item, column, value) => {
    if (value === undefined) return; // opened and closed without changes
    const v = String(value);
    let patch: Parameters<typeof api.expenses.patch>[1];
    if (column.id === 'category') patch = { category: v.trim() || null };
    else if (column.id === 'exemption') patch = { exemption: parseNumber(v) };
    else patch = { comment: v.trim() || null };
    const updated = await api.expenses.patch(item.expenseIdx, patch);
    replaceItem(updated);
    if (column.id === 'category') reloadMeta();
  };

  const one = selected.length === 1 ? selected[0] : undefined;

  const createRule = (e: Expense) => {
    const sp = new URLSearchParams({
      new: '1',
      scope: e.isCorporate ? 'corporate' : 'personal',
      filter: suggestFilter(e.description),
      ...(e.category ? { category: e.category } : {}),
      ...(e.exemption !== null ? { exemption: String(e.exemption) } : {}),
    });
    navigate(`/rules?${sp}`);
  };

  return (
    <>
      <Table<Expense>
        variant="full-page"
        stickyHeader
        resizableColumns
        wrapLines={false}
        enableKeyboardNavigation
        loading={result.loading && !result.data}
        loadingText="Loading expenses"
        items={result.data?.items ?? []}
        trackBy="expenseIdx"
        selectionType={canEdit ? 'multi' : undefined}
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        submitEdit={canEdit ? submitEdit : undefined}
        sortingColumn={{ sortingField: p.sort }}
        sortingDescending={p.dir === 'desc'}
        onSortingChange={(e) => setP({ sort: e.detail.sortingColumn.sortingField, dir: e.detail.isDescending ? 'desc' : 'asc', page: undefined })}
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={`(${total.toLocaleString()})`}
            description={
              result.data ? `Total of filtered expenses: ${formatMoney(result.data.totalAmount ?? 0)}. Click a category, exemption or comment to edit it.` : undefined
            }
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {canEdit && (
                <ButtonDropdown
                  disabled={selected.length === 0}
                  onItemClick={(e) => {
                    if (e.detail.id === 'bulk') setBulkOpen(true);
                    if (e.detail.id === 'rule' && one) createRule(one);
                    if (e.detail.id === 'delete') setDeleting(selected);
                  }}
                  items={[
                    { id: 'bulk', text: `Edit ${pluralize(selected.length, 'expense')}` },
                    { id: 'rule', text: 'Create rule from expense', disabled: !one },
                    { id: 'delete', text: 'Delete' },
                  ]}
                >
                  Actions
                </ButtonDropdown>
                )}
                {canEdit && <Button onClick={() => setAddOpen(true)}>Add expense</Button>}
                <Button iconName="refresh" ariaLabel="Refresh" onClick={result.reload} />
              </SpaceBetween>
            }
          >
            Expenses
          </Header>
        }
        filter={
          <TransactionFilters
            values={{ scope, accountIdx: p.accountIdx ? Number(p.accountIdx) : null, from: p.from || undefined, to: p.to || undefined, q: p.q }}
            onChange={(v) =>
              filter({
                ...(v.scope !== undefined ? { scope: v.scope } : {}),
                ...('accountIdx' in v ? { accountIdx: v.accountIdx ? String(v.accountIdx) : undefined } : {}),
                ...('from' in v ? { from: v.from, to: v.to } : {}),
                ...(v.q !== undefined ? { q: v.q } : {}),
              })
            }
            countText={pluralize(total, 'match', 'matches')}
            extra={
              <Select
                selectedOption={categoryOptions.find((o) => o.value === p.category) ?? categoryOptions[0]}
                options={categoryOptions}
                filteringType="auto"
                onChange={(e) => filter({ category: e.detail.selectedOption.value })}
              />
            }
          />
        }
        pagination={
          <Pagination currentPageIndex={page} pagesCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} onChange={(e) => setP({ page: String(e.detail.currentPageIndex) })} />
        }
        empty={<EmptyState title="No expenses" subtitle="No expenses match these filters." />}
        columnDefinitions={editableColumns(canEdit, [
          { id: 'date', header: 'Date', cell: (e) => e.transactionDate, sortingField: 'transactionDate', width: 120 },
          { id: 'description', header: 'Description', cell: (e) => e.description, sortingField: 'description', isRowHeader: true, width: 320 },
          { id: 'amount', header: 'Amount', cell: (e) => <Box textAlign="right">{formatMoney(e.amount)}</Box>, sortingField: 'amount', width: 120 },
          {
            id: 'category',
            header: 'Category',
            sortingField: 'category',
            width: 200,
            cell: (e) => e.category ?? <StatusIndicator type="warning">Uncategorized</StatusIndicator>,
            editConfig: {
              ariaLabel: 'Category',
              editIconAriaLabel: 'editable',
              errorIconAriaLabel: 'Category error',
              editingCell: (item, { currentValue, setValue }) => (
                <CategoryInput value={(currentValue as string | undefined) ?? item.category ?? ''} onChange={setValue} scope={item.isCorporate ? 'corporate' : 'personal'} autoFocus />
              ),
            },
          },
          {
            id: 'exemption',
            header: 'Exemption',
            width: 130,
            cell: (e) =>
              e.exemption === null ? (
                '—'
              ) : (
                <Popover dismissButton={false} size="small" triggerType="text" content={`Exempt amount: ${formatMoney(e.exemptAmount)}`}>
                  {formatExemption(e.exemption)}
                </Popover>
              ),
            editConfig: {
              ariaLabel: 'Exemption',
              editIconAriaLabel: 'editable',
              errorIconAriaLabel: 'Exemption error',
              constraintText: '≤ 1 is a fraction, > 1 is dollars',
              validation: (_item, value) => (value === undefined ? undefined : validateExemption(String(value))),
              editingCell: (item, { currentValue, setValue }) => (
                <Input
                  autoFocus
                  inputMode="decimal"
                  value={(currentValue as string | undefined) ?? (item.exemption === null ? '' : String(item.exemption))}
                  onChange={(e) => setValue(e.detail.value)}
                />
              ),
            },
          },
          { id: 'account', header: 'Account', cell: (e) => e.accountName, sortingField: 'accountName', width: 220 },
          {
            id: 'comment',
            header: 'Comment',
            width: 260,
            cell: (e) =>
              e.comment?.startsWith('Automatic Rule') ? (
                <Popover header="Categorized by rule" size="large" triggerType="text" content={e.comment}>
                  <Box color="text-status-inactive" variant="span">Automatic rule</Box>
                </Popover>
              ) : (
                (e.comment ?? '')
              ),
            editConfig: {
              ariaLabel: 'Comment',
              editIconAriaLabel: 'editable',
              errorIconAriaLabel: 'Comment error',
              editingCell: (item, { currentValue, setValue }) => (
                <Input autoFocus value={(currentValue as string | undefined) ?? item.comment ?? ''} onChange={(e) => setValue(e.detail.value)} />
              ),
            },
          },
        ])}
      />

      <BulkEditModal
        visible={bulkOpen}
        ids={selected.map((s) => s.expenseIdx)}
        scope={selected.every((s) => s.isCorporate) ? 'corporate' : selected.every((s) => !s.isCorporate) ? 'personal' : 'all'}
        onDismiss={() => setBulkOpen(false)}
        onDone={() => {
          setBulkOpen(false);
          setSelected([]);
          result.reload();
        }}
      />

      <AddExpenseModal
        visible={addOpen}
        onDismiss={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          result.reload();
        }}
      />

      <ConfirmModal
        visible={deleting.length > 0}
        header={`Delete ${pluralize(deleting.length, 'expense')}`}
        onDismiss={() => setDeleting([])}
        onConfirm={async () => {
          try {
            for (const e of deleting) await api.expenses.remove(e.expenseIdx);
            notify('success', pluralize(deleting.length, 'expense'), 'Deleted');
          } catch (e) {
            notifyError(e);
          }
          setDeleting([]);
          setSelected([]);
          result.reload();
        }}
      >
        Permanently delete {pluralize(deleting.length, 'expense')}? This can't be undone (a backup of the database is taken each time the server starts).
      </ConfirmModal>
    </>
  );
}
