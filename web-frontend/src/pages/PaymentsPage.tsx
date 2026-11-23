import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import TextFilter from '@cloudscape-design/components/text-filter';
import type { Payment, UpcomingPayment } from '../../../shared/types';
import { api } from '../api/client';
import { AccountSelect, ConfirmModal, DateRangeFilter, EmptyState, type IsoRange } from '../components/common';
import { DueStatus } from '../components/DueStatus';
import PaymentModal from '../components/PaymentModal';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { formatMoney } from '../utils/format';
import { periodLabel } from './PayeesPage';
import { useAuth } from '../context/AuthContext';

const PAGE_SIZE = 50;

function UpcomingTab({ onPay, version }: { onPay: (payeeIdx: number) => void; version: number }) {
  const { canEdit } = useAuth();
  const upcoming = useAsync(() => api.payments.upcoming(), [version]);
  const [show, setShow] = useState<'due' | 'all'>('due');
  const items = (upcoming.data ?? []).filter((p) => show === 'all' || p.isUpcoming);
  return (
    <Table<UpcomingPayment>
      variant="borderless"
      loading={upcoming.loading}
      loadingText="Loading"
      items={items}
      trackBy="payeeIdx"
      header={
        <Header
          counter={`(${items.length})`}
          description="Next due date = last payment + the payee's frequency. Only active payees with at least one payment appear."
          actions={
            <SegmentedControl
              label="Show"
              selectedId={show}
              onChange={(e) => setShow(e.detail.selectedId as 'due' | 'all')}
              options={[
                { id: 'due', text: 'Due soon' },
                { id: 'all', text: 'All active payees' },
              ]}
            />
          }
        >
          Upcoming bills
        </Header>
      }
      empty={<EmptyState title="Nothing due" subtitle="No bills are due in the next couple of weeks." />}
      columnDefinitions={[
        { id: 'payee', header: 'Payee', cell: (p) => p.payee, isRowHeader: true },
        { id: 'category', header: 'Category', cell: (p) => p.payeeCategory || '—' },
        { id: 'due', header: 'Next due', cell: (p) => p.nextPaymentDate },
        { id: 'status', header: 'Status', cell: (p) => <DueStatus p={p} /> },
        { id: 'last', header: 'Last payment', cell: (p) => `${formatMoney(p.amount)} on ${p.lastPaymentDate}` },
        { id: 'period', header: 'Frequency', cell: (p) => periodLabel(p.paymentPeriod) },
        { id: 'from', header: 'Paid from', cell: (p) => p.payerAccountName },
        {
          id: 'pay',
          header: '',
          cell: (p) =>
            canEdit && (
              <Button variant="inline-link" onClick={() => onPay(p.payeeIdx)}>
                Record payment
              </Button>
            ),
        },
      ]}
    />
  );
}

function HistoryTab({ version, onEdit, onDelete }: { version: number; onEdit: (p: Payment) => void; onDelete: (p: Payment) => void }) {
  const { canEdit } = useAuth();
  const [payeeIdx, setPayeeIdx] = useState<number | null>(null);
  const [accountIdx, setAccountIdx] = useState<number | null>(null);
  const [range, setRange] = useState<IsoRange>({});
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<{ field: string; desc: boolean }>({ field: 'transactionDate', desc: true });
  const [selected, setSelected] = useState<Payment[]>([]);
  const payees = useAsync(() => api.payees.list(), []);

  const result = useAsync(
    () =>
      api.payments.list({
        payeeIdx: payeeIdx ?? undefined,
        accountIdx: accountIdx ?? undefined,
        from: range.from,
        to: range.to,
        q: query || undefined,
        page,
        pageSize: PAGE_SIZE,
        sort: sorting.field,
        dir: sorting.desc ? 'desc' : 'asc',
      }),
    [payeeIdx, accountIdx, range.from, range.to, query, page, sorting.field, sorting.desc, version],
  );

  const payeeOptions: SelectProps.Option[] = useMemo(
    () => [{ value: '', label: 'All payees' }, ...(payees.data ?? []).map((p) => ({ value: String(p.payeeIdx), label: p.payee, tags: p.isActive ? [] : ['Inactive'] }))],
    [payees.data],
  );

  const total = result.data?.total ?? 0;
  const resetPage = () => {
    setPage(1);
    setSelected([]);
  };
  const one = selected[0];

  return (
    <Table<Payment>
      variant="borderless"
      loading={result.loading}
      loadingText="Loading payments"
      items={result.data?.items ?? []}
      trackBy="paymentIdx"
      selectionType={canEdit ? 'single' : undefined}
      selectedItems={selected}
      onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
      sortingColumn={{ sortingField: sorting.field }}
      sortingDescending={sorting.desc}
      onSortingChange={(e) => {
        setSorting({ field: String(e.detail.sortingColumn.sortingField), desc: !!e.detail.isDescending });
        resetPage();
      }}
      header={
        <Header
          counter={`(${total.toLocaleString()})`}
          actions={
            canEdit && (
            <SpaceBetween direction="horizontal" size="xs">
              <Button disabled={!one} onClick={() => onDelete(one)}>
                Delete
              </Button>
              <Button disabled={!one} onClick={() => onEdit(one)}>
                Edit
              </Button>
            </SpaceBetween>
            )
          }
        >
          Payment history
        </Header>
      }
      filter={
        <SpaceBetween direction="horizontal" size="s">
          <TextFilter
            filteringText={text}
            filteringPlaceholder="Payee or confirmation #"
            onChange={(e) => setText(e.detail.filteringText)}
            onDelayedChange={(e) => {
              setQuery(e.detail.filteringText);
              resetPage();
            }}
          />
          <Select
            selectedOption={payeeOptions.find((o) => o.value === (payeeIdx === null ? '' : String(payeeIdx))) ?? null}
            options={payeeOptions}
            filteringType="auto"
            onChange={(e) => {
              setPayeeIdx(e.detail.selectedOption.value ? Number(e.detail.selectedOption.value) : null);
              resetPage();
            }}
          />
          <AccountSelect
            value={accountIdx}
            allowAll
            onChange={(v) => {
              setAccountIdx(v);
              resetPage();
            }}
          />
          <DateRangeFilter
            value={range}
            onChange={(r) => {
              setRange(r);
              resetPage();
            }}
          />
        </SpaceBetween>
      }
      pagination={<Pagination currentPageIndex={page} pagesCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} onChange={(e) => setPage(e.detail.currentPageIndex)} />}
      empty={<EmptyState title="No payments" subtitle="No payments match these filters." />}
      columnDefinitions={[
        { id: 'date', header: 'Date', cell: (p) => p.transactionDate, sortingField: 'transactionDate' },
        { id: 'payee', header: 'Payee', cell: (p) => p.payeeName, sortingField: 'payeeName', isRowHeader: true },
        { id: 'amount', header: 'Amount', cell: (p) => <Box textAlign="right">{formatMoney(p.amount)}</Box>, sortingField: 'amount' },
        { id: 'confirmation', header: 'Confirmation #', cell: (p) => p.confirmation ?? '—' },
        { id: 'from', header: 'Paid from', cell: (p) => p.payerAccountName, sortingField: 'payerAccountName' },
        { id: 'category', header: 'Category', cell: (p) => p.payeeCategory || '—' },
      ]}
    />
  );
}

export default function PaymentsPage() {
  const { notify, notifyError } = useApp();
  const { canEdit } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'upcoming';
  const [version, setVersion] = useState(0);
  const [modal, setModal] = useState<{ payment?: Payment; payeeIdx?: number } | null>(null);
  const [deleting, setDeleting] = useState<Payment | null>(null);
  const bump = () => setVersion((v) => v + 1);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Track bill payments and see what's due next."
          actions={
            canEdit && (
              <Button variant="primary" iconName="add-plus" onClick={() => setModal({})}>
                Record payment
              </Button>
            )
          }
        >
          Payments
        </Header>
      }
    >
      <Tabs
        variant="container"
        activeTabId={tab}
        onChange={(e) => setParams(e.detail.activeTabId === 'history' ? { tab: 'history' } : {})}
        tabs={[
          { id: 'upcoming', label: 'Upcoming', content: <UpcomingTab version={version} onPay={(payeeIdx) => setModal({ payeeIdx })} /> },
          { id: 'history', label: 'History', content: <HistoryTab version={version} onEdit={(payment) => setModal({ payment })} onDelete={setDeleting} /> },
        ]}
      />

      <PaymentModal
        visible={modal !== null}
        payment={modal?.payment ?? null}
        payeeIdx={modal?.payeeIdx ?? null}
        onDismiss={() => setModal(null)}
        onSaved={() => {
          setModal(null);
          bump();
        }}
      />

      <ConfirmModal
        visible={!!deleting}
        header="Delete payment"
        onDismiss={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.payments.remove(deleting!.paymentIdx);
            notify('success', `${deleting!.payeeName} on ${deleting!.transactionDate}`, 'Payment deleted');
            bump();
          } catch (e) {
            notifyError(e);
          }
          setDeleting(null);
        }}
      >
        Delete the {formatMoney(deleting?.amount)} payment to {deleting?.payeeName} on {deleting?.transactionDate}?
      </ConfirmModal>
    </ContentLayout>
  );
}
