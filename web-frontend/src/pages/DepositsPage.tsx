import { useEffect, useState } from 'react';
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
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import type { Deposit, Scope } from '../../../shared/types';
import { api } from '../api/client';
import { AccountSelect, ConfirmModal, EmptyState, editableColumns } from '../components/common';
import { TransactionFilters } from '../components/TransactionFilters';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks/useAsync';
import { useUrlParams } from '../hooks/useUrlParams';
import { errorMessage, formatMoney, parseNumber, pluralize, today } from '../utils/format';

const PAGE_SIZE = 50;
const DEFAULTS = { scope: 'all', accountIdx: '', reviewed: '', from: '', to: '', q: '', page: '1', sort: 'transactionDate', dir: 'desc' };

const REVIEW_OPTIONS: SelectProps.Option[] = [
  { value: '', label: 'Reviewed and unreviewed' },
  { value: 'unreviewed', label: 'Unreviewed' },
  { value: 'reviewed', label: 'Reviewed' },
];

function AddDepositModal({ visible, onDismiss, onDone }: { visible: boolean; onDismiss: () => void; onDone: () => void }) {
  const { notify } = useApp();
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [income, setIncome] = useState('');
  const [reviewed, setReviewed] = useState(true);
  const [accountIdx, setAccountIdx] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!visible) return;
    setDate(today());
    setDescription('');
    setAmount('');
    setIncome('');
    setReviewed(true);
    setComment('');
    setSubmitted(false);
    setError(undefined);
  }, [visible]);

  const amountNum = parseNumber(amount);
  const incomeNum = parseNumber(income);
  const errors = {
    amount: amountNum === null || Number.isNaN(amountNum) ? 'Enter an amount' : undefined,
    income: incomeNum !== null && Number.isNaN(incomeNum) ? 'Enter a number' : undefined,
    account: accountIdx === null ? 'Choose an account' : undefined,
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    setSaving(true);
    try {
      await api.deposits.create({
        transactionDate: date,
        description: description.trim() || null,
        amount: amountNum!,
        incomeAmount: incomeNum ?? 0,
        reviewed,
        comment: comment.trim() || null,
        accountIdx: accountIdx!,
      });
      notify('success', formatMoney(amountNum), 'Deposit added');
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
      header="Add deposit"
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
          <FormField label="Description">
            <Input value={description} onChange={(e) => setDescription(e.detail.value)} />
          </FormField>
          <FormField label="Amount" errorText={submitted ? errors.amount : undefined}>
            <Input value={amount} onChange={(e) => setAmount(e.detail.value)} inputMode="decimal" />
          </FormField>
          <FormField label="Income amount" description="The part of the deposit that counts as income. 0 for transfers." errorText={submitted ? errors.income : undefined}>
            <Input value={income} onChange={(e) => setIncome(e.detail.value)} inputMode="decimal" placeholder="0.00" />
          </FormField>
          <Checkbox checked={reviewed} onChange={(e) => setReviewed(e.detail.checked)}>
            Reviewed
          </Checkbox>
          <FormField label="Comment" constraintText="Optional">
            <Input value={comment} onChange={(e) => setComment(e.detail.value)} />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

export default function DepositsPage() {
  const { notify, notifyError } = useApp();
  const { canEdit } = useAuth();
  const [p, setP] = useUrlParams(DEFAULTS);
  const scope = p.scope as Scope;
  const page = Number(p.page) || 1;
  const [selected, setSelected] = useState<Deposit[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<Deposit[]>([]);

  const result = useAsync(
    () =>
      api.deposits.list({
        scope,
        accountIdx: p.accountIdx ? Number(p.accountIdx) : undefined,
        reviewed: (p.reviewed || undefined) as 'reviewed' | 'unreviewed' | undefined,
        from: p.from || undefined,
        to: p.to || undefined,
        q: p.q || undefined,
        page,
        pageSize: PAGE_SIZE,
        sort: p.sort,
        dir: p.dir as 'asc' | 'desc',
      }),
    [scope, p.accountIdx, p.reviewed, p.from, p.to, p.q, page, p.sort, p.dir],
  );

  useEffect(() => setSelected([]), [scope, p.accountIdx, p.reviewed, p.from, p.to, p.q, page, p.sort, p.dir]);

  const filter = (changes: Partial<Record<keyof typeof DEFAULTS, string | undefined>>) => setP({ ...changes, page: undefined });
  const total = result.data?.total ?? 0;

  const replaceItem = (d: Deposit) => result.setData((r) => (r ? { ...r, items: r.items.map((x) => (x.depositIdx === d.depositIdx ? d : x)) } : r));

  const submitEdit: TableProps.SubmitEditFunction<Deposit> = async (item, column, value) => {
    if (value === undefined) return;
    const v = String(value);
    let patch: Parameters<typeof api.deposits.patch>[1];
    if (column.id === 'income') {
      const n = parseNumber(v);
      patch = { incomeAmount: n ?? 0, reviewed: true };
    } else if (column.id === 'description') patch = { description: v.trim() || null };
    else patch = { comment: v.trim() || null };
    replaceItem(await api.deposits.patch(item.depositIdx, patch));
  };

  const bulk = async (action: 'income' | 'transfer' | 'unreviewed') => {
    try {
      const r = await api.deposits.bulk(
        selected.map((s) => s.depositIdx),
        action,
      );
      notify('success', pluralize(r.updated, 'deposit'), action === 'income' ? 'Marked as income' : action === 'transfer' ? 'Marked as transfer' : 'Marked as unreviewed');
      setSelected([]);
      result.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  const numberEditor = (label: string) => ({
    ariaLabel: label,
    editIconAriaLabel: 'editable',
    errorIconAriaLabel: `${label} error`,
    validation: (_item: Deposit, value: unknown) => {
      if (value === undefined) return undefined;
      const n = parseNumber(String(value));
      return n !== null && Number.isNaN(n) ? 'Enter a number' : undefined;
    },
    editingCell: (item: Deposit, { currentValue, setValue }: { currentValue?: string; setValue: (v: string) => void }) => (
      <Input autoFocus inputMode="decimal" value={currentValue ?? String(item.incomeAmount)} onChange={(e) => setValue(e.detail.value)} />
    ),
  });

  const textEditor = (label: string, get: (d: Deposit) => string | null) => ({
    ariaLabel: label,
    editIconAriaLabel: 'editable',
    errorIconAriaLabel: `${label} error`,
    editingCell: (item: Deposit, { currentValue, setValue }: { currentValue?: string; setValue: (v: string) => void }) => (
      <Input autoFocus value={currentValue ?? get(item) ?? ''} onChange={(e) => setValue(e.detail.value)} />
    ),
  });

  return (
    <>
      <Table<Deposit>
        variant="full-page"
        stickyHeader
        resizableColumns
        enableKeyboardNavigation
        loading={result.loading && !result.data}
        loadingText="Loading deposits"
        items={result.data?.items ?? []}
        trackBy="depositIdx"
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
              result.data
                ? `Total of filtered deposits: ${formatMoney(result.data.totalAmount ?? 0)}. Mark each deposit as income or a transfer; editing the income amount marks it reviewed.`
                : undefined
            }
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {canEdit && (
                <ButtonDropdown
                  disabled={selected.length === 0}
                  onItemClick={(e) => {
                    if (e.detail.id === 'delete') setDeleting(selected);
                    else bulk(e.detail.id as 'income' | 'transfer' | 'unreviewed');
                  }}
                  items={[
                    { id: 'income', text: 'Mark as income (full amount)' },
                    { id: 'transfer', text: 'Mark as transfer (no income)' },
                    { id: 'unreviewed', text: 'Mark as unreviewed' },
                    { id: 'delete', text: 'Delete' },
                  ]}
                >
                  Actions
                </ButtonDropdown>
                )}
                {canEdit && <Button onClick={() => setAddOpen(true)}>Add deposit</Button>}
                <Button iconName="refresh" ariaLabel="Refresh" onClick={result.reload} />
              </SpaceBetween>
            }
          >
            Deposits
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
                selectedOption={REVIEW_OPTIONS.find((o) => o.value === p.reviewed) ?? REVIEW_OPTIONS[0]}
                options={REVIEW_OPTIONS}
                onChange={(e) => filter({ reviewed: e.detail.selectedOption.value })}
              />
            }
          />
        }
        pagination={<Pagination currentPageIndex={page} pagesCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} onChange={(e) => setP({ page: String(e.detail.currentPageIndex) })} />}
        empty={<EmptyState title="No deposits" subtitle="No deposits match these filters." />}
        columnDefinitions={editableColumns(canEdit, [
          { id: 'date', header: 'Date', cell: (d) => d.transactionDate, sortingField: 'transactionDate', width: 120 },
          {
            id: 'description',
            header: 'Description',
            cell: (d) => d.description ?? '—',
            sortingField: 'description',
            isRowHeader: true,
            width: 300,
            editConfig: textEditor('Description', (d) => d.description),
          },
          { id: 'amount', header: 'Amount', cell: (d) => <Box textAlign="right">{formatMoney(d.amount)}</Box>, sortingField: 'amount', width: 120 },
          {
            id: 'income',
            header: 'Income',
            cell: (d) => <Box textAlign="right">{formatMoney(d.incomeAmount)}</Box>,
            sortingField: 'incomeAmount',
            width: 130,
            editConfig: numberEditor('Income amount'),
          },
          {
            id: 'reviewed',
            header: 'Status',
            width: 130,
            cell: (d) =>
              !d.reviewed ? (
                <StatusIndicator type="warning">Unreviewed</StatusIndicator>
              ) : d.incomeAmount === 0 ? (
                <StatusIndicator type="stopped">Transfer</StatusIndicator>
              ) : d.incomeAmount < d.amount ? (
                <StatusIndicator type="info">Partly income</StatusIndicator>
              ) : (
                <StatusIndicator type="success">Income</StatusIndicator>
              ),
          },
          { id: 'account', header: 'Account', cell: (d) => d.accountName, sortingField: 'accountName', width: 220 },
          { id: 'comment', header: 'Comment', cell: (d) => d.comment ?? '', width: 240, editConfig: textEditor('Comment', (d) => d.comment) },
        ])}
      />

      <AddDepositModal
        visible={addOpen}
        onDismiss={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          result.reload();
        }}
      />

      <ConfirmModal
        visible={deleting.length > 0}
        header={`Delete ${pluralize(deleting.length, 'deposit')}`}
        onDismiss={() => setDeleting([])}
        onConfirm={async () => {
          try {
            for (const d of deleting) await api.deposits.remove(d.depositIdx);
            notify('success', pluralize(deleting.length, 'deposit'), 'Deleted');
          } catch (e) {
            notifyError(e);
          }
          setDeleting([]);
          setSelected([]);
          result.reload();
        }}
      >
        Permanently delete {pluralize(deleting.length, 'deposit')}? This can't be undone.
      </ConfirmModal>
    </>
  );
}
