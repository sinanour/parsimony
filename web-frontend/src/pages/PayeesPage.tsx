import { useEffect, useMemo, useState } from 'react';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import Toggle from '@cloudscape-design/components/toggle';
import type { Payee, PayeeInput } from '../../../shared/types';
import { api } from '../api/client';
import { ConfirmModal, EmptyState } from '../components/common';
import PaymentModal from '../components/PaymentModal';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks/useAsync';
import { errorMessage, formatMoney, pluralize } from '../utils/format';

const PERIODS = [
  { value: '1', label: 'Monthly' },
  { value: '2', label: 'Every 2 months' },
  { value: '3', label: 'Quarterly' },
  { value: '6', label: 'Every 6 months' },
  { value: '12', label: 'Annually' },
];

export const periodLabel = (n: number) => PERIODS.find((p) => p.value === String(n))?.label ?? `Every ${n} months`;

const blank: PayeeInput = { payee: '', accountNum: '', isActive: true, payeeCategory: '', paymentPeriod: 1 };

function PayeeModal({ payee, visible, onDismiss, onSaved }: { payee: Payee | null; visible: boolean; onDismiss: () => void; onSaved: () => void }) {
  const { meta, notify } = useApp();
  const [form, setForm] = useState<PayeeInput>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setForm(payee ? { payee: payee.payee, accountNum: payee.accountNum, isActive: payee.isActive, payeeCategory: payee.payeeCategory, paymentPeriod: payee.paymentPeriod } : blank);
    setError(undefined);
    setSubmitted(false);
  }, [visible, payee]);

  const periodOptions = PERIODS.some((p) => p.value === String(form.paymentPeriod))
    ? PERIODS
    : [...PERIODS, { value: String(form.paymentPeriod), label: periodLabel(form.paymentPeriod) }];

  const nameError = form.payee.trim() ? undefined : 'Enter a name';

  const save = async () => {
    setSubmitted(true);
    if (nameError) return;
    setSaving(true);
    try {
      const saved = payee ? await api.payees.update(payee.payeeIdx, form) : await api.payees.create(form);
      notify('success', saved.payee, payee ? 'Payee updated' : 'Payee created');
      onSaved();
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
      header={payee ? 'Edit payee' : 'Create payee'}
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
      <Form errorText={error}>
        <SpaceBetween size="m">
          <FormField label="Payee" errorText={submitted ? nameError : undefined}>
            <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.detail.value })} autoFocus />
          </FormField>
          <FormField label="Account number with payee" description="Your customer or policy number with this payee.">
            <Input value={form.accountNum} onChange={(e) => setForm({ ...form, accountNum: e.detail.value })} />
          </FormField>
          <FormField label="Category">
            <Autosuggest
              value={form.payeeCategory}
              onChange={(e) => setForm({ ...form, payeeCategory: e.detail.value })}
              options={(meta?.payeeCategories ?? []).map((c) => ({ value: c }))}
              enteredTextLabel={(v) => `Use "${v}"`}
              placeholder="e.g. Utilities"
            />
          </FormField>
          <FormField label="Payment frequency" description="Used to work out when the next payment is due.">
            <Select
              selectedOption={periodOptions.find((p) => p.value === String(form.paymentPeriod)) ?? null}
              options={periodOptions}
              onChange={(e) => setForm({ ...form, paymentPeriod: Number(e.detail.selectedOption.value) })}
            />
          </FormField>
          <Toggle checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.detail.checked })}>
            Active
          </Toggle>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

type Filter = 'active' | 'inactive' | 'all';

export default function PayeesPage() {
  const { notify, notifyError, reloadMeta } = useApp();
  const { canEdit } = useAuth();
  const payees = useAsync(() => api.payees.list(), []);
  const [filter, setFilter] = useState<Filter>('active');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Payee[]>([]);
  const [editing, setEditing] = useState<Payee | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Payee | null>(null);
  const [paying, setPaying] = useState<number | null>(null);
  const [sorting, setSorting] = useState<{ col: TableProps.SortingColumn<Payee>; desc: boolean }>({ col: { sortingField: 'payee' }, desc: false });

  const items = useMemo(() => {
    const t = text.toLowerCase();
    const f = (payees.data ?? []).filter(
      (p) => (filter === 'all' || p.isActive === (filter === 'active')) && (!t || `${p.payee} ${p.payeeCategory} ${p.accountNum}`.toLowerCase().includes(t)),
    );
    const field = sorting.col.sortingField as keyof Payee;
    return [...f].sort((a, b) => {
      const x = a[field] ?? '';
      const y = b[field] ?? '';
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sorting.desc ? -c : c;
    });
  }, [payees.data, filter, text, sorting]);

  const refresh = () => {
    setSelected([]);
    payees.reload();
    reloadMeta();
  };
  const one = selected[0];

  return (
    <>
      <Table
        variant="full-page"
        stickyHeader
        resizableColumns
        loading={payees.loading}
        loadingText="Loading payees"
        items={items}
        trackBy="payeeIdx"
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
            description="Who you pay bills to, and how often."
            actions={
              canEdit && (
              <SpaceBetween direction="horizontal" size="xs">
                <Button disabled={!one} onClick={() => setDeleting(one)}>
                  Delete
                </Button>
                <Button disabled={!one} onClick={() => setEditing(one)}>
                  Edit
                </Button>
                <Button disabled={!one || !one.isActive} onClick={() => setPaying(one.payeeIdx)}>
                  Record payment
                </Button>
                <Button variant="primary" onClick={() => setEditing(null)}>
                  Create payee
                </Button>
              </SpaceBetween>
              )
            }
          >
            Payees
          </Header>
        }
        filter={
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <TextFilter filteringText={text} onChange={(e) => setText(e.detail.filteringText)} filteringPlaceholder="Find payees" countText={pluralize(items.length, 'match', 'matches')} />
            <SegmentedControl
              label="Status"
              selectedId={filter}
              onChange={(e) => setFilter(e.detail.selectedId as Filter)}
              options={[
                { id: 'active', text: 'Active' },
                { id: 'inactive', text: 'Inactive' },
                { id: 'all', text: 'All' },
              ]}
            />
          </SpaceBetween>
        }
        empty={<EmptyState title="No payees" action={canEdit && <Button onClick={() => setEditing(null)}>Create payee</Button>} />}
        columnDefinitions={[
          { id: 'payee', header: 'Payee', cell: (p) => p.payee, sortingField: 'payee', isRowHeader: true, width: 300 },
          { id: 'category', header: 'Category', cell: (p) => p.payeeCategory || '—', sortingField: 'payeeCategory' },
          { id: 'period', header: 'Frequency', cell: (p) => periodLabel(p.paymentPeriod), sortingField: 'paymentPeriod' },
          { id: 'status', header: 'Status', cell: (p) => <StatusIndicator type={p.isActive ? 'success' : 'stopped'}>{p.isActive ? 'Active' : 'Inactive'}</StatusIndicator> },
          { id: 'last', header: 'Last payment', cell: (p) => (p.lastPaymentDate ? `${p.lastPaymentDate} · ${formatMoney(p.lastPaymentAmount)}` : '—'), sortingField: 'lastPaymentDate' },
          { id: 'next', header: 'Next due', cell: (p) => (p.isActive ? (p.nextPaymentDate ?? '—') : '—'), sortingField: 'nextPaymentDate' },
          { id: 'count', header: 'Payments', cell: (p) => p.paymentCount, sortingField: 'paymentCount' },
        ]}
      />

      <PayeeModal
        visible={editing !== undefined}
        payee={editing ?? null}
        onDismiss={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          refresh();
        }}
      />

      <PaymentModal
        visible={paying !== null}
        payeeIdx={paying}
        onDismiss={() => setPaying(null)}
        onSaved={() => {
          setPaying(null);
          refresh();
        }}
      />

      <ConfirmModal
        visible={!!deleting}
        header="Delete payee"
        onDismiss={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.payees.remove(deleting!.payeeIdx);
            notify('success', deleting!.payee, 'Payee deleted');
            refresh();
          } catch (e) {
            notifyError(e, 'Could not delete payee');
          }
          setDeleting(null);
        }}
      >
        Delete <Box variant="span" fontWeight="bold">{deleting?.payee}</Box>? Payees with payments can't be deleted; deactivate them instead.
      </ConfirmModal>
    </>
  );
}
