import { useMemo, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import Table from '@cloudscape-design/components/table';
import { api } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatMoney } from '../utils/format';

export default function PaymentTotalsPage() {
  const totals = useAsync(() => api.reports.paymentTotals(), []);
  const years = useMemo(() => [...new Set((totals.data ?? []).map((t) => t.year))].sort().reverse(), [totals.data]);
  const [year, setYear] = useState<string | null>(null);
  const current = year ?? years[0] ?? null;
  const rows = useMemo(() => (totals.data ?? []).filter((t) => t.year === current).sort((a, b) => b.total - a.total), [totals.data, current]);
  const sum = rows.reduce((s, r) => s + r.total, 0);

  return (
    <ContentLayout header={<Header variant="h1" description="Total paid to each payee per calendar year.">Payment totals</Header>}>
      <Table
        variant="container"
        loading={totals.loading}
        items={rows}
        trackBy="recipient"
        header={
          <Header
            variant="h2"
            counter={`(${rows.length})`}
            actions={
              <Select
                selectedOption={current ? { value: current, label: current } : null}
                options={years.map((y) => ({ value: y, label: y }))}
                onChange={(e) => setYear(e.detail.selectedOption.value ?? null)}
                placeholder="Year"
              />
            }
          >
            {current ?? 'Payments'}
          </Header>
        }
        footer={rows.length > 0 && <Box textAlign="right" fontWeight="bold">Total {formatMoney(sum)}</Box>}
        columnDefinitions={[
          { id: 'recipient', header: 'Payee', cell: (r) => r.recipient, isRowHeader: true },
          { id: 'total', header: 'Total paid', cell: (r) => <Box textAlign="right">{formatMoney(r.total)}</Box> },
        ]}
      />
    </ContentLayout>
  );
}
