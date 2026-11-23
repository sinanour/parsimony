import { useMemo, useState } from 'react';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api } from '../api/client';
import { RouterLink } from '../components/common';
import { useAsync } from '../hooks/useAsync';

export default function CoveragePage() {
  const coverage = useAsync(() => api.reports.coverage(), []);
  const [show, setShow] = useState<'active' | 'all'>('active');
  const rows = useMemo(() => (coverage.data ?? []).filter((c) => show === 'all' || c.isActive), [coverage.data, show]);

  return (
    <ContentLayout header={<Header variant="h1" description="First and last month with transactions for each account, and months with no transactions in between.">Statement coverage</Header>}>
      <Table
        variant="container"
        loading={coverage.loading}
        items={rows}
        trackBy="accountIdx"
        header={
          <Header
            variant="h2"
            counter={`(${rows.length})`}
            actions={
              <SegmentedControl
                label="Show"
                selectedId={show}
                onChange={(e) => setShow(e.detail.selectedId as 'active' | 'all')}
                options={[
                  { id: 'active', text: 'Active accounts' },
                  { id: 'all', text: 'All accounts' },
                ]}
              />
            }
          >
            Accounts
          </Header>
        }
        columnDefinitions={[
          { id: 'name', header: 'Account', cell: (c) => <RouterLink href={`/expenses?accountIdx=${c.accountIdx}`}>{c.accountName}</RouterLink>, isRowHeader: true },
          { id: 'first', header: 'First month', cell: (c) => c.firstTransactionMonth },
          { id: 'last', header: 'Last month', cell: (c) => c.lastTransactionMonth },
          { id: 'months', header: 'Months with transactions', cell: (c) => c.distinctMonthCount },
          {
            id: 'missing',
            header: 'Missing months',
            cell: (c) => (c.missingMonthCount > 0 ? <StatusIndicator type="warning">{c.missingMonthCount}</StatusIndicator> : <StatusIndicator type="success">None</StatusIndicator>),
          },
        ]}
      />
    </ContentLayout>
  );
}
