import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { api } from '../../api/client';
import { RouterLink } from '../../components/common';
import { errorMessage } from '../../utils/format';
import { AuthCard } from './AuthCard';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setSent((await api.auth.forgotPassword(email)).message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Reset your password" description="We'll email you a link to choose a new password.">
      {sent ? (
        <SpaceBetween size="m">
          <Alert type="success">{sent}</Alert>
          <RouterLink href="/login">Back to sign in</RouterLink>
        </SpaceBetween>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Form
            errorText={error}
            secondaryActions={<RouterLink href="/login">Back to sign in</RouterLink>}
            actions={
              <Button variant="primary" formAction="submit" loading={busy} disabled={!email}>
                Send reset link
              </Button>
            }
          >
            <FormField label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.detail.value)} autoComplete="username" autoFocus />
            </FormField>
          </Form>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const mismatch = confirm !== '' && confirm !== password;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setDone((await api.auth.resetPassword(token, password)).message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthCard title="Reset your password">
        <SpaceBetween size="m">
          <Alert type="error">This link is incomplete. Open the link from the email again, or request a new one.</Alert>
          <RouterLink href="/forgot-password">Request a new link</RouterLink>
        </SpaceBetween>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      {done ? (
        <SpaceBetween size="m">
          <Alert type="success">{done}</Alert>
          <RouterLink href="/login">Sign in</RouterLink>
        </SpaceBetween>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Form
            errorText={error}
            actions={
              <Button variant="primary" formAction="submit" loading={busy} disabled={password.length < 8 || password !== confirm}>
                Change password
              </Button>
            }
          >
            <SpaceBetween size="m">
              <FormField label="New password" constraintText="At least 8 characters.">
                <Input type="password" value={password} onChange={(e) => setPassword(e.detail.value)} autoComplete="new-password" autoFocus />
              </FormField>
              <FormField label="Confirm new password" errorText={mismatch ? 'The passwords do not match' : undefined}>
                <Input type="password" value={confirm} onChange={(e) => setConfirm(e.detail.value)} autoComplete="new-password" />
              </FormField>
            </SpaceBetween>
          </Form>
        </form>
      )}
    </AuthCard>
  );
}
