import { useMemo } from 'react';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import type { Scope } from '../../../shared/types';
import { api } from '../api/client';
import { ScopeControl } from '../components/common';
import { useAsync } from '../hooks/useAsync';
import { useUrlParams } from '../hooks/useUrlParams';
import { formatMoney } from '../utils/format';

const DEFAULTS = { scope: 'all', year: '' };

export default function PaymentTotalsPage() {
  const [p, setP] = useUrlParams(DEFAULTS);
  const scope = p.scope as Scope;
  const totals = useAsync(() => api.reports.paymentTotals(scope), [scope]);
  const years = useMemo(() => [...new Set((totals.data ?? []).map((t) => t.year))].sort().reverse(), [totals.data]);
  // Fall back to the latest year when the chosen one has no payments in this scope.
  const current = p.year && years.includes(p.year) ? p.year : (years[0] ?? null);
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
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <ScopeControl value={scope} onChange={(s) => setP({ scope: s })} />
                <Select
                  selectedOption={current ? { value: current, label: current } : null}
                  options={years.map((y) => ({ value: y, label: y }))}
                  onChange={(e) => setP({ year: e.detail.selectedOption.value })}
                  placeholder="Year"
                />
              </SpaceBetween>
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
