import { useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { ROLE_LABELS } from './admin/UsersPage';

export default function ProfilePage() {
  const { user, updateUser, applySession, signOutEverywhere } = useAuth();
  const { notify, notifyError } = useApp();
  const [name, setName] = useState(user?.displayName ?? '');
  const [savingName, setSavingName] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState<string>();

  if (!user) return null;

  const saveName = async () => {
    setSavingName(true);
    try {
      updateUser(await api.auth.updateProfile(name.trim() || null));
      notify('success', 'Your name was updated.');
    } catch (e) {
      notifyError(e);
    } finally {
      setSavingName(false);
    }
  };

  const changePassword = async () => {
    setPwError(undefined);
    if (pw.next.length < 8) return setPwError('The new password must be at least 8 characters.');
    if (pw.next !== pw.confirm) return setPwError('The new passwords do not match.');
    setSavingPw(true);
    try {
      applySession(await api.auth.changePassword({ currentPassword: pw.current, newPassword: pw.next }));
      setPw({ current: '', next: '', confirm: '' });
      notify('success', 'Your password was changed. Other devices have been signed out.');
    } catch (e) {
      setPwError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <ContentLayout header={<Header variant="h1">Your profile</Header>}>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Account</Header>}>
          <SpaceBetween size="l">
            <KeyValuePairs
              columns={2}
              items={[
                { label: 'Email', value: user.email },
                { label: 'Role', value: ROLE_LABELS[user.role] },
              ]}
            />
            <Form
              actions={
                <Button loading={savingName} disabled={(user.displayName ?? '') === name} onClick={saveName}>
                  Save name
                </Button>
              }
            >
              <FormField label="Display name">
                <Input value={name} onChange={(e) => setName(e.detail.value)} autoComplete="name" />
              </FormField>
            </Form>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2" description="Changing your password signs out your other devices.">Password</Header>}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void changePassword();
            }}
          >
            <Form
              errorText={pwError}
              actions={
                <Button formAction="submit" variant="primary" loading={savingPw} disabled={!pw.current || !pw.next}>
                  Change password
                </Button>
              }
            >
              <SpaceBetween size="m">
                <FormField label="Current password">
                  <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.detail.value })} autoComplete="current-password" />
                </FormField>
                <FormField label="New password" constraintText="At least 8 characters.">
                  <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.detail.value })} autoComplete="new-password" />
                </FormField>
                <FormField label="Confirm new password">
                  <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.detail.value })} autoComplete="new-password" />
                </FormField>
              </SpaceBetween>
            </Form>
          </form>
        </Container>

        <Container header={<Header variant="h2">Sessions</Header>}>
          <SpaceBetween size="s">
            <Box variant="p">If you signed in on a device you no longer use, or think someone else has your password, sign out everywhere.</Box>
            <Button onClick={() => void signOutEverywhere()}>Sign out everywhere</Button>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
