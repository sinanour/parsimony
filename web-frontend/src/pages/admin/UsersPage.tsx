import { useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import type { Role, User } from '../../../../shared/types';
import { api } from '../../api/client';
import { ConfirmModal, EmptyState } from '../../components/common';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { errorMessage } from '../../utils/format';

export const ROLE_LABELS: Record<Role, string> = {
  ADMINISTRATOR: 'Administrator',
  EDITOR: 'Editor',
  READ_ONLY: 'Read-only',
};

const ROLE_HELP: Record<Role, string> = {
  ADMINISTRATOR: 'Everything, including managing users and viewing the audit log.',
  EDITOR: 'View and change all bookkeeping data, import statements and run rules.',
  READ_ONLY: 'View data and reports. Account numbers are masked.',
};

const roleOptions = (Object.keys(ROLE_LABELS) as Role[]).map((r) => ({ value: r, label: ROLE_LABELS[r], description: ROLE_HELP[r] }));

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

type Editing = { mode: 'create' } | { mode: 'edit'; user: User } | { mode: 'password'; user: User };

export default function UsersPage() {
  const { user: me } = useAuth();
  const { notify, notifyError } = useApp();
  const users = useAsync(() => api.users.list(), []);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      notify('success', success);
      users.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <Table
        variant="full-page"
        loading={users.loading}
        items={users.data ?? []}
        trackBy="userId"
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={users.data ? `(${users.data.length})` : undefined}
            description="Everyone shares the same books. Roles decide who can change them."
            actions={
              <Button variant="primary" onClick={() => setEditing({ mode: 'create' })}>
                Add user
              </Button>
            }
          >
            Users
          </Header>
        }
        empty={<EmptyState title="No users" />}
        columnDefinitions={[
          { id: 'email', header: 'Email', cell: (u) => u.email + (u.userId === me?.userId ? ' (you)' : ''), isRowHeader: true },
          { id: 'name', header: 'Name', cell: (u) => u.displayName ?? '—' },
          { id: 'role', header: 'Role', cell: (u) => ROLE_LABELS[u.role] },
          { id: 'lastLogin', header: 'Last sign-in', cell: (u) => when(u.lastLoginAt) },
          { id: 'sessions', header: 'Active sessions', cell: (u) => u.activeSessions },
          {
            id: 'actions',
            header: 'Actions',
            cell: (u) => (
              <ButtonDropdown
                variant="inline-icon"
                ariaLabel={`Actions for ${u.email}`}
                expandToViewport
                items={[
                  { id: 'edit', text: 'Edit name and role' },
                  { id: 'password', text: 'Set a new password' },
                  { id: 'revoke', text: 'Sign out of all sessions', disabled: u.activeSessions === 0 },
                  { id: 'delete', text: 'Delete', disabled: u.userId === me?.userId },
                ]}
                onItemClick={(e) => {
                  if (e.detail.id === 'edit') setEditing({ mode: 'edit', user: u });
                  if (e.detail.id === 'password') setEditing({ mode: 'password', user: u });
                  if (e.detail.id === 'revoke') void act(() => api.users.revokeSessions(u.userId), `${u.email} was signed out everywhere.`);
                  if (e.detail.id === 'delete') setDeleting(u);
                }}
              />
            ),
          },
        ]}
      />
      {editing && (
        <UserModal
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            notify('success', msg);
            users.reload();
          }}
        />
      )}
      <ConfirmModal
        visible={!!deleting}
        header="Delete user"
        onDismiss={() => setDeleting(null)}
        onConfirm={async () => {
          const u = deleting!;
          setDeleting(null);
          await act(() => api.users.remove(u.userId), `${u.email} was deleted.`);
        }}
      >
        Delete{' '}
        <Box variant="span" fontWeight="bold">
          {deleting?.email}
        </Box>
        ? They are signed out immediately. Their past changes stay in the audit log.
      </ConfirmModal>
    </>
  );
}

function UserModal({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: (message: string) => void }) {
  const existing = editing.mode === 'create' ? null : editing.user;
  const [email, setEmail] = useState(existing?.email ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [role, setRole] = useState<Role>(existing?.role ?? 'EDITOR');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const showIdentity = editing.mode !== 'password';
  const showPassword = editing.mode !== 'edit';

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (editing.mode === 'create') {
        await api.users.create({ email, displayName: displayName || null, role, password });
        onSaved(`${email} can now sign in.`);
      } else if (editing.mode === 'edit') {
        await api.users.update(editing.user.userId, { displayName: displayName || null, role });
        onSaved(`${editing.user.email} was updated.`);
      } else {
        await api.users.update(editing.user.userId, { password });
        onSaved(`${editing.user.email}'s password was changed and their sessions were signed out.`);
      }
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const title = editing.mode === 'create' ? 'Add user' : editing.mode === 'edit' ? `Edit ${existing!.email}` : `New password for ${existing!.email}`;

  return (
    <Modal
      visible
      header={title}
      onDismiss={onClose}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={showPassword && password.length < 8} onClick={save}>
              {editing.mode === 'create' ? 'Add user' : 'Save'}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={error}>
        <SpaceBetween size="m">
          {editing.mode === 'create' && (
            <FormField label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.detail.value)} autoFocus />
            </FormField>
          )}
          {showIdentity && (
            <>
              <FormField label="Display name" constraintText="Optional">
                <Input value={displayName} onChange={(e) => setDisplayName(e.detail.value)} />
              </FormField>
              <FormField label="Role" description={ROLE_HELP[role]}>
                <Select
                  selectedOption={roleOptions.find((o) => o.value === role) ?? null}
                  options={roleOptions}
                  onChange={(e) => setRole(e.detail.selectedOption.value as Role)}
                />
              </FormField>
            </>
          )}
          {showPassword && (
            <FormField
              label={editing.mode === 'create' ? 'Initial password' : 'New password'}
              constraintText="At least 8 characters. Share it with them securely; they can change it on their profile page."
            >
              <Input type="password" value={password} onChange={(e) => setPassword(e.detail.value)} autoComplete="new-password" />
            </FormField>
          )}
        </SpaceBetween>
      </Form>
    </Modal>
  );
}
