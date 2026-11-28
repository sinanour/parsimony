import { useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { UNCATEGORIZED } from '../../../shared/types';
import { api } from '../api/client';
import { RouterLink } from '../components/common';
import { DueStatus } from '../components/DueStatus';
import { ResponsiveButton } from '../components/ResponsiveButton';
import PaymentModal from '../components/PaymentModal';
import SpendingChart from '../components/SpendingChart';
import { useAsync } from '../hooks/useAsync';
import { formatMoney } from '../utils/format';
import { useAuth } from '../context/AuthContext';

export default function DashboardPage() {
  const { canEdit } = useAuth();
  const dash = useAsync(() => api.dashboard(), []);
  const [payFor, setPayFor] = useState<number | null>(null);
  const d = dash.data;

  const countLink = (n: number | undefined, href: string) =>
    n === undefined ? '—' : n === 0 ? <StatusIndicator type="success">0</StatusIndicator> : <RouterLink href={href} variant="primary" fontSize="display-l">{n.toLocaleString()}</RouterLink>;

  return (
    <ContentLayout header={<Header variant="h1">Dashboard</Header>}>
      <SpaceBetween size="l">
        <Grid gridDefinition={[{ colspan: { default: 12, m: 6 } }, { colspan: { default: 12, m: 6 } }]}>
          <Container header={<Header variant="h2" description="Expenses without a category">Uncategorized expenses</Header>}>
            <KeyValuePairs
              columns={2}
              items={[
                { label: 'Personal', value: countLink(d?.uncategorizedExpenses.personal, `/expenses?scope=personal&category=${UNCATEGORIZED}`) },
                { label: 'Corporate', value: countLink(d?.uncategorizedExpenses.corporate, `/expenses?scope=corporate&category=${UNCATEGORIZED}`) },
              ]}
            />
          </Container>
          <Container header={<Header variant="h2" description="Deposits not yet classified as income or transfer">Unreviewed deposits</Header>}>
            <KeyValuePairs
              columns={2}
              items={[
                { label: 'Personal', value: countLink(d?.unreviewedDeposits.personal, '/deposits?scope=personal&reviewed=unreviewed') },
                { label: 'Corporate', value: countLink(d?.unreviewedDeposits.corporate, '/deposits?scope=corporate&reviewed=unreviewed') },
              ]}
            />
          </Container>
        </Grid>

        <Table
          header={
            <Header variant="h2" counter={d ? `(${d.upcoming.length})` : undefined} description="Bills due within 15 days (30 for annual bills), and overdue bills" actions={<RouterLink href="/payments">All payments</RouterLink>}>
              Bills due
            </Header>
          }
          loading={dash.loading}
          loadingText="Loading bills"
          items={d?.upcoming ?? []}
          trackBy="payeeIdx"
          variant="container"
          empty={<Box textAlign="center" color="inherit">Nothing due soon.</Box>}
          columnDefinitions={[
            { id: 'payee', header: 'Payee', cell: (p) => p.payee, isRowHeader: true },
            { id: 'due', header: 'Due', cell: (p) => p.nextPaymentDate },
            { id: 'status', header: 'Status', cell: (p) => <DueStatus p={p} /> },
            { id: 'last', header: 'Last payment', cell: (p) => `${formatMoney(p.amount)} on ${p.lastPaymentDate}` },
            { id: 'from', header: 'Paid from', cell: (p) => p.payerAccountName },
            {
              id: 'actions',
              header: 'Actions',
              cell: (p) =>
                canEdit && (
                  <ResponsiveButton
                    iconName="add-plus"
                    mobileIcon="add-plus"
                    mobileAriaLabel={`Record payment to ${p.payee}`}
                    onClick={() => setPayFor(p.payeeIdx)}
                  >
                    Record payment
                  </ResponsiveButton>
                ),
            },
          ]}
        />

        <SpendingChart />

        <Table
          header={
            <Header variant="h2" description={d ? `Active accounts with no transactions since ${d.lastMonth}, or with gaps` : undefined} actions={<RouterLink href="/import">Import statements</RouterLink>}>
              Statements to import
            </Header>
          }
          loading={dash.loading}
          items={d?.coverage ?? []}
          variant="container"
          trackBy="accountIdx"
          empty={<Box textAlign="center" color="inherit">All active accounts are up to date.</Box>}
          columnDefinitions={[
            { id: 'name', header: 'Account', cell: (c) => c.accountName, isRowHeader: true },
            { id: 'last', header: 'Last transaction month', cell: (c) => c.lastTransactionMonth },
            {
              id: 'missing',
              header: 'Missing months',
              cell: (c) => (c.missingMonthCount > 0 ? <StatusIndicator type="warning">{c.missingMonthCount}</StatusIndicator> : '0'),
            },
          ]}
        />
      </SpaceBetween>

      <PaymentModal
        visible={payFor !== null}
        payeeIdx={payFor}
        onDismiss={() => setPayFor(null)}
        onSaved={() => {
          setPayFor(null);
          dash.reload();
        }}
      />
    </ContentLayout>
  );
}
