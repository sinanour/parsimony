import { useState } from 'react';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import Select from '@cloudscape-design/components/select';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api } from '../../api/client';
import { EmptyState } from '../../components/common';
import { useAsync } from '../../hooks/useAsync';

const PAGE_SIZE = 50;

const FILTERS = [
  { value: '', label: 'All events' },
  { value: 'auth.', label: 'Sign-in and passwords' },
  { value: 'auth.login_failed', label: 'Failed sign-ins' },
  { value: 'user.', label: 'User administration' },
  { value: 'api.write', label: 'Data changes' },
];

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.logout_all': 'Signed out everywhere',
  'auth.setup': 'Created first administrator',
  'auth.setup_failed': 'Wrong setup code',
  'auth.refresh_reuse': 'Reused session token (session revoked)',
  'auth.password_changed': 'Changed password',
  'auth.password_reset_requested': 'Requested password reset',
  'auth.password_reset': 'Reset password by email',
  'user.bootstrap': 'Created administrator from configuration',
  'user.create': 'Added user',
  'user.update': 'Updated user',
  'user.delete': 'Deleted user',
  'user.revoke_sessions': 'Signed a user out',
  'api.write': 'Changed data',
};

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState(FILTERS[0]);
  const log = useAsync(() => api.audit({ page, pageSize: PAGE_SIZE, action: filter.value || undefined }), [page, filter.value]);
  const pages = Math.max(1, Math.ceil((log.data?.total ?? 0) / PAGE_SIZE));

  return (
    <Table
      variant="full-page"
      loading={log.loading}
      items={log.data?.items ?? []}
      trackBy="auditIdx"
      header={
        <Header
          variant="awsui-h1-sticky"
          counter={log.data ? `(${log.data.total.toLocaleString()})` : undefined}
          description="Sign-ins, password and user changes, and every change to the data. Request bodies are never recorded."
        >
          Audit log
        </Header>
      }
      filter={
        <Select
          selectedOption={filter}
          options={FILTERS}
          onChange={(e) => {
            setFilter(FILTERS.find((f) => f.value === e.detail.selectedOption.value) ?? FILTERS[0]);
            setPage(1);
          }}
        />
      }
      pagination={<Pagination currentPageIndex={page} pagesCount={pages} onChange={(e) => setPage(e.detail.currentPageIndex)} />}
      empty={<EmptyState title="Nothing logged yet" />}
      columnDefinitions={[
        { id: 'at', header: 'Time', cell: (e) => new Date(e.at).toLocaleString(), width: 190 },
        { id: 'user', header: 'User', cell: (e) => e.userEmail ?? '—' },
        { id: 'action', header: 'Event', cell: (e) => ACTION_LABELS[e.action] ?? e.action },
        { id: 'request', header: 'Request', cell: (e) => (e.method ? `${e.method} ${e.path}` : '—') },
        {
          id: 'status',
          header: 'Result',
          cell: (e) =>
            e.status === null ? (
              '—'
            ) : (
              <StatusIndicator type={e.status < 400 ? 'success' : e.status < 500 ? 'warning' : 'error'}>{e.status}</StatusIndicator>
            ),
        },
        { id: 'details', header: 'Details', cell: (e) => e.details ?? '' },
        { id: 'ip', header: 'IP address', cell: (e) => e.ip ?? '' },
      ]}
    />
  );
}
