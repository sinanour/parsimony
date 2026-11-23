import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useAuth } from '../../context/AuthContext';
import { RouterLink } from '../../components/common';
import { errorMessage } from '../../utils/format';
import { AuthCard } from './AuthCard';

export default function LoginPage() {
  const { config } = useAuth();
  return config?.setupRequired ? <SetupForm /> : <SignInForm />;
}

function SignInForm() {
  const { signIn, config } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in to Parsimony">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Form
          actions={
            <Button variant="primary" formAction="submit" loading={busy} disabled={!email || !password}>
              Sign in
            </Button>
          }
          errorText={error}
        >
          <SpaceBetween size="m">
            <FormField label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.detail.value)} autoComplete="username" autoFocus />
            </FormField>
            <FormField
              label="Password"
              info={config?.passwordResetEnabled ? <RouterLink href="/forgot-password" variant="info">Forgot password?</RouterLink> : undefined}
            >
              <Input type="password" value={password} onChange={(e) => setPassword(e.detail.value)} autoComplete="current-password" />
            </FormField>
          </SpaceBetween>
        </Form>
      </form>
      {!config?.passwordResetEnabled && (
        <Box variant="small" color="text-body-secondary" padding={{ top: 'm' }}>
          Forgot your password? Ask an administrator to reset it.
        </Box>
      )}
    </AuthCard>
  );
}

function SetupForm() {
  const { setup } = useAuth();
  const [form, setForm] = useState({ setupCode: '', displayName: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const set = (k: keyof typeof form) => (e: { detail: { value: string } }) => setForm((f) => ({ ...f, [k]: e.detail.value }));

  const errors = {
    setupCode: form.setupCode.trim() ? undefined : 'Enter the setup code from the server log',
    email: /^\S+@\S+\.\S+$/.test(form.email) ? undefined : 'Enter a valid email address',
    password: form.password.length >= 8 ? undefined : 'Use at least 8 characters',
    confirm: form.confirm === form.password ? undefined : 'The passwords do not match',
  };

  const submit = async () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      await setup({ setupCode: form.setupCode, email: form.email, password: form.password, displayName: form.displayName || null });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const err = (k: keyof typeof errors) => (submitted ? errors[k] : undefined);

  return (
    <AuthCard title="Welcome to Parsimony" description="Create the first administrator account.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Form
          actions={
            <Button variant="primary" formAction="submit" loading={busy}>
              Create administrator
            </Button>
          }
          errorText={error}
        >
          <SpaceBetween size="m">
            <Alert type="info">
              The server printed a one-time setup code in its log when it started. On a deployed host, run{' '}
              <Box variant="code">npm run logs -- --target your-host</Box> from <Box variant="code">deployment/</Box> to see it.
            </Alert>
            <FormField label="Setup code" errorText={err('setupCode')}>
              <Input value={form.setupCode} onChange={set('setupCode')} autoFocus autoComplete="off" />
            </FormField>
            <FormField label="Your name" constraintText="Optional">
              <Input value={form.displayName} onChange={set('displayName')} autoComplete="name" />
            </FormField>
            <FormField label="Email" errorText={err('email')}>
              <Input type="email" value={form.email} onChange={set('email')} autoComplete="username" />
            </FormField>
            <FormField label="Password" constraintText="At least 8 characters. A passphrase of several words is easiest to remember." errorText={err('password')}>
              <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
            </FormField>
            <FormField label="Confirm password" errorText={err('confirm')}>
              <Input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
            </FormField>
          </SpaceBetween>
        </Form>
      </form>
    </AuthCard>
  );
}
