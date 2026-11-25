import { useEffect, useMemo, useState } from 'react';
import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import Toggle from '@cloudscape-design/components/toggle';
import { TEXT_LIMITS, type Account, type AccountInput } from '../../../shared/types';
import { api } from '../api/client';
import { ConfirmModal, EmptyState } from '../components/common';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks/useAsync';
import { errorMessage, maskAccountNumber, pluralize } from '../utils/format';

type Filter = 'active' | 'inactive' | 'all';

const blank: AccountInput = { name: '', isCreditCard: false, isCorporate: false, isActive: true, accountNumbers: [], statementFilePattern: null };

function AccountModal({ account, visible, onDismiss, onSaved }: { account: Account | null; visible: boolean; onDismiss: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const [form, setForm] = useState<AccountInput>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setForm(
      account
        ? {
            name: account.name,
            isCreditCard: account.isCreditCard,
            isCorporate: account.isCorporate,
            isActive: account.isActive,
            accountNumbers: account.accountNumbers,
            statementFilePattern: account.statementFilePattern,
          }
        : blank,
    );
    setError(undefined);
    setSubmitted(false);
  }, [visible, account]);

  const nameError = form.name.trim() ? undefined : 'Enter a name';

  const save = async () => {
    setSubmitted(true);
    if (nameError) return;
    setSaving(true);
    try {
      const saved = account ? await api.accounts.update(account.accountIdx, form) : await api.accounts.create(form);
      notify('success', saved.name, account ? 'Account updated' : 'Account created');
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
      header={account ? 'Edit account' : 'Create account'}
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
          <FormField label="Name" errorText={submitted ? nameError : undefined}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.detail.value })} autoFocus nativeInputAttributes={{ maxLength: TEXT_LIMITS.accountName }} />
          </FormField>
          <ColumnLayout columns={3}>
            <Checkbox checked={form.isCreditCard} onChange={(e) => setForm({ ...form, isCreditCard: e.detail.checked })}>
              Credit card
            </Checkbox>
            <Checkbox checked={form.isCorporate} onChange={(e) => setForm({ ...form, isCorporate: e.detail.checked })}>
              Corporate
            </Checkbox>
            <Toggle checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.detail.checked })}>
              Active
            </Toggle>
          </ColumnLayout>
          <FormField label="Account numbers" description="Statement imports match the account by these numbers. Add one per card or reissue.">
            <AttributeEditor
              items={form.accountNumbers.map((n) => ({ n }))}
              definition={[
                {
                  label: 'Account number',
                  control: (item, i) => (
                    <Input
                      value={item.n}
                      nativeInputAttributes={{ maxLength: TEXT_LIMITS.accountNumber }}
                      onChange={(e) => {
                        const next = [...form.accountNumbers];
                        next[i] = e.detail.value;
                        setForm({ ...form, accountNumbers: next });
                      }}
                    />
                  ),
                },
              ]}
              onAddButtonClick={() => setForm({ ...form, accountNumbers: [...form.accountNumbers, ''] })}
              onRemoveButtonClick={(e) => setForm({ ...form, accountNumbers: form.accountNumbers.filter((_, i) => i !== e.detail.itemIndex) })}
              addButtonText="Add account number"
              removeButtonText="Remove"
              empty="No account numbers"
            />
          </FormField>
          <FormField
            label="Statement file name contains"
            constraintText="Optional"
            description='For statements that contain no account number (e.g. most credit-card CSVs): uploads whose file name includes this text are imported into this account. Example: "rbc personal visa".'
          >
            <Input
              value={form.statementFilePattern ?? ''}
              onChange={(e) => setForm({ ...form, statementFilePattern: e.detail.value || null })}
              placeholder="e.g. rbc personal visa"
              nativeInputAttributes={{ maxLength: TEXT_LIMITS.statementFilePattern }}
            />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

export default function AccountsPage() {
  const { notify, notifyError, reloadMeta } = useApp();
  const { canEdit } = useAuth();
  const accounts = useAsync(() => api.accounts.list(), []);
  const [filter, setFilter] = useState<Filter>('active');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Account[]>([]);
  const [editing, setEditing] = useState<Account | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [reveal, setReveal] = useState(false);

  const items = useMemo(() => {
    const t = text.toLowerCase();
    return (accounts.data ?? []).filter(
      (a) =>
        (filter === 'all' || a.isActive === (filter === 'active')) &&
        (!t || a.name.toLowerCase().includes(t) || a.accountNumbers.some((n) => n.toLowerCase().includes(t))),
    );
  }, [accounts.data, filter, text]);

  const refresh = () => {
    setSelected([]);
    accounts.reload();
    reloadMeta();
  };

  const one = selected[0];

  return (
    <>
      <Table
        variant="full-page"
        stickyHeader
        resizableColumns
        loading={accounts.loading}
        loadingText="Loading accounts"
        items={items}
        trackBy="accountIdx"
        selectionType={canEdit ? 'single' : undefined}
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        onRowClick={(e) => canEdit && setSelected([e.detail.item])}
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={`(${items.length})`}
            description="Bank accounts, credit cards and cash. Statement imports find accounts by their account numbers or file-name pattern."
            actions={
              canEdit && (
                <SpaceBetween direction="horizontal" size="xs">
                  <Toggle checked={reveal} onChange={(e) => setReveal(e.detail.checked)}>
                    Show numbers
                  </Toggle>
                  <Button disabled={!one} onClick={() => setDeleting(one)}>
                    Delete
                  </Button>
                  <Button disabled={!one} onClick={() => setEditing(one)}>
                    Edit
                  </Button>
                  <Button variant="primary" onClick={() => setEditing(null)}>
                    Create account
                  </Button>
                </SpaceBetween>
              )
            }
          >
            Accounts
          </Header>
        }
        filter={
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <TextFilter filteringText={text} onChange={(e) => setText(e.detail.filteringText)} filteringPlaceholder="Find accounts" countText={pluralize(items.length, 'match', 'matches')} />
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
        empty={<EmptyState title="No accounts" action={canEdit && <Button onClick={() => setEditing(null)}>Create account</Button>} />}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: (a) => a.name, isRowHeader: true, width: 320 },
          {
            id: 'type',
            header: 'Type',
            cell: (a) => (
              <SpaceBetween direction="horizontal" size="xxs">
                <Badge color={a.isCorporate ? 'blue' : 'grey'}>{a.isCorporate ? 'Corporate' : 'Personal'}</Badge>
                {a.isCreditCard && <Badge>Credit card</Badge>}
              </SpaceBetween>
            ),
          },
          { id: 'status', header: 'Status', cell: (a) => <StatusIndicator type={a.isActive ? 'success' : 'stopped'}>{a.isActive ? 'Active' : 'Inactive'}</StatusIndicator> },
          { id: 'numbers', header: 'Account numbers', cell: (a) => a.accountNumbers.map((n) => (reveal ? n : maskAccountNumber(n))).join(', ') || '—' },
          { id: 'pattern', header: 'Statement file pattern', cell: (a) => a.statementFilePattern ?? '—' },
          { id: 'first', header: 'First month', cell: (a) => a.firstTransactionMonth ?? '—' },
          { id: 'last', header: 'Last month', cell: (a) => a.lastTransactionMonth ?? '—' },
          {
            id: 'missing',
            header: 'Missing months',
            cell: (a) => (a.missingMonthCount ? <StatusIndicator type="warning">{a.missingMonthCount}</StatusIndicator> : a.missingMonthCount === null ? '—' : '0'),
          },
          { id: 'txns', header: 'Transactions', cell: (a) => a.transactionCount.toLocaleString() },
        ]}
      />

      <AccountModal
        visible={editing !== undefined}
        account={editing ?? null}
        onDismiss={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          refresh();
        }}
      />

      <ConfirmModal
        visible={!!deleting}
        header="Delete account"
        onDismiss={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.accounts.remove(deleting!.accountIdx);
            notify('success', deleting!.name, 'Account deleted');
            setDeleting(null);
            refresh();
          } catch (e) {
            notifyError(e, 'Could not delete account');
            setDeleting(null);
          }
        }}
      >
        Delete <Box variant="span" fontWeight="bold">{deleting?.name}</Box>? Accounts with transactions or payments can't be deleted; deactivate them instead.
      </ConfirmModal>
    </>
  );
}
