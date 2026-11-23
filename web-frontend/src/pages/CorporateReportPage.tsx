import { useMemo, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Pagination from '@cloudscape-design/components/pagination';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import type { CorporateRow } from '../../../shared/types';
import { api } from '../api/client';
import { RangeEditor } from '../components/RangeEditor';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { formatMoney, pluralize } from '../utils/format';

const PAGE_SIZE = 100;

export default function CorporateReportPage() {
  const { notify, notifyError } = useApp();
  const [downloading, setDownloading] = useState(false);
  const report = useAsync(() => api.reports.corporate(), []);
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const t = text.toLowerCase();
    return (report.data?.rows ?? []).filter((r) => !t || `${r.description} ${r.description2} ${r.subcategory} ${r.category}`.toLowerCase().includes(t));
  }, [report.data, text]);

  const totals = useMemo(() => {
    const sum = (f: (r: CorporateRow) => boolean) => rows.filter(f).reduce((s, r) => s + r.amount, 0);
    return { revenue: sum((r) => r.category === 'Revenue'), expense: sum((r) => r.category === 'Expense'), transfer: sum((r) => r.category === 'Transfer') };
  }, [rows]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="All transactions on corporate accounts for the fiscal period, in the layout the accountant expects."
          actions={
            <Button
              iconName="download"
              loading={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  await api.reports.downloadCorporateCsv();
                } catch (e) {
                  notifyError(e, 'Download failed');
                } finally {
                  setDownloading(false);
                }
              }}
            >
              Download CSV
            </Button>
          }
        >
          Corporate export
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Fiscal period</Header>}>
          <SpaceBetween size="l">
            <RangeEditor
              value={report.data?.range}
              onSave={async (range) => {
                await api.reports.setCorporateRange(range);
                notify('success', `${range.startDate} to ${range.endDate}`, 'Period updated');
                setPage(1);
                report.reload();
              }}
            />
            <KeyValuePairs
              columns={3}
              items={[
                { label: 'Revenue', value: formatMoney(totals.revenue) },
                { label: 'Expenses', value: formatMoney(totals.expense) },
                { label: 'Transfers', value: formatMoney(totals.transfer) },
              ]}
            />
          </SpaceBetween>
        </Container>

        <Table<CorporateRow>
          variant="container"
          loading={report.loading}
          items={rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
          header={<Header variant="h2" counter={`(${rows.length})`}>Transactions</Header>}
          filter={
            <TextFilter
              filteringText={text}
              filteringPlaceholder="Find transactions"
              countText={pluralize(rows.length, 'match', 'matches')}
              onChange={(e) => {
                setText(e.detail.filteringText);
                setPage(1);
              }}
            />
          }
          pagination={<Pagination currentPageIndex={page} pagesCount={Math.max(1, Math.ceil(rows.length / PAGE_SIZE))} onChange={(e) => setPage(e.detail.currentPageIndex)} />}
          empty={<Box textAlign="center" color="inherit">No corporate transactions in this period.</Box>}
          columnDefinitions={[
            { id: 'date', header: 'Date', cell: (r) => r.transactionDate, width: 120 },
            { id: 'category', header: 'Category', cell: (r) => r.category },
            { id: 'subcategory', header: 'Subcategory', cell: (r) => r.subcategory ?? '—' },
            { id: 'account', header: 'Account', cell: (r) => r.accountType },
            { id: 'cheque', header: 'Cheque', cell: (r) => r.cheque },
            { id: 'description', header: 'Description', cell: (r) => r.description ?? '', isRowHeader: true },
            { id: 'description2', header: 'Note', cell: (r) => r.description2 ?? '' },
            { id: 'amount', header: 'Amount', cell: (r) => <Box textAlign="right">{formatMoney(r.amount)}</Box> },
            { id: 'adjustment', header: 'Adjustment', cell: (r) => (r.adjustment === null ? '—' : r.adjustment.toFixed(2)) },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
