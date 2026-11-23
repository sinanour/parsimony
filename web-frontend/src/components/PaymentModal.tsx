import { useEffect, useMemo, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import DatePicker from '@cloudscape-design/components/date-picker';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { Payee, Payment } from '../../../shared/types';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { errorMessage, formatMoney, parseNumber, today } from '../utils/format';
import { AccountSelect } from './common';

interface Props {
  visible: boolean;
  onDismiss: () => void;
  onSaved: (p: Payment) => void;
  /** Edit an existing payment. */
  payment?: Payment | null;
  /** Pre-select a payee for a new payment. */
  payeeIdx?: number | null;
}

export default function PaymentModal({ visible, onDismiss, onSaved, payment, payeeIdx: initialPayee }: Props) {
  const { notify } = useApp();
  const [payees, setPayees] = useState<Payee[]>([]);
  const [payeeIdx, setPayeeIdx] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [accountIdx, setAccountIdx] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!visible) return;
    api.payees.list().then(setPayees, (e) => setError(errorMessage(e)));
    setSubmitted(false);
    setError(undefined);
    if (payment) {
      setPayeeIdx(payment.payeeIdx);
      setDate(payment.transactionDate);
      setAmount(String(payment.amount));
      setConfirmation(payment.confirmation ?? '');
      setAccountIdx(payment.payerAccountIdx);
    } else {
      setPayeeIdx(initialPayee ?? null);
      setDate(today());
      setAmount('');
      setConfirmation('');
      setAccountIdx(null);
    }
  }, [visible, payment, initialPayee]);

  // Pre-fill amount and payer account from the payee's last payment (like payment_inserter.py's defaults).
  useEffect(() => {
    if (!visible || payment || payeeIdx === null) return;
    let cancelled = false;
    api.payments.defaults(payeeIdx).then((d) => {
      if (cancelled) return;
      if (d.amount !== null) setAmount(String(d.amount));
      if (d.payerAccountIdx !== null) setAccountIdx(d.payerAccountIdx);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, payment, payeeIdx]);

  const payeeOptions: SelectProps.Option[] = useMemo(
    () =>
      payees
        .filter((p) => p.isActive || p.payeeIdx === payeeIdx)
        .map((p) => ({
          value: String(p.payeeIdx),
          label: p.payee,
          description: p.lastPaymentDate ? `Last paid ${p.lastPaymentDate} · ${formatMoney(p.lastPaymentAmount)}` : 'No payments yet',
          tags: [p.payeeCategory].filter(Boolean),
        })),
    [payees, payeeIdx],
  );

  const amountNum = parseNumber(amount);
  const errors = {
    payee: payeeIdx === null ? 'Choose a payee' : undefined,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? undefined : 'Enter a date',
    amount: amountNum === null || Number.isNaN(amountNum) ? 'Enter an amount' : undefined,
    account: accountIdx === null ? 'Choose the account the payment came from' : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);

  const save = async () => {
    setSubmitted(true);
    if (!valid) return;
    setSaving(true);
    setError(undefined);
    try {
      const input = {
        payeeIdx: payeeIdx!,
        transactionDate: date,
        amount: amountNum!,
        confirmation: confirmation.trim() || null,
        payerAccountIdx: accountIdx!,
      };
      const saved = payment ? await api.payments.update(payment.paymentIdx, input) : await api.payments.create(input);
      notify('success', `${saved.payeeName}: ${formatMoney(saved.amount)} on ${saved.transactionDate}`, payment ? 'Payment updated' : 'Payment recorded');
      onSaved(saved);
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
      header={payment ? 'Edit payment' : 'Record payment'}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              {payment ? 'Save' : 'Record payment'}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Form errorText={error}>
          <SpaceBetween size="m">
            <FormField label="Payee" errorText={submitted ? errors.payee : undefined}>
              <Select
                selectedOption={payeeOptions.find((o) => o.value === String(payeeIdx)) ?? null}
                options={payeeOptions}
                filteringType="auto"
                placeholder="Choose a payee"
                statusType={payees.length ? 'finished' : 'loading'}
                onChange={(e) => setPayeeIdx(Number(e.detail.selectedOption.value))}
                invalid={submitted && !!errors.payee}
              />
            </FormField>
            <FormField label="Payment date" errorText={submitted ? errors.date : undefined}>
              <DatePicker value={date} onChange={(e) => setDate(e.detail.value)} placeholder="YYYY/MM/DD" />
            </FormField>
            <FormField label="Amount" errorText={submitted ? errors.amount : undefined}>
              <Input value={amount} onChange={(e) => setAmount(e.detail.value)} inputMode="decimal" placeholder="0.00" invalid={submitted && !!errors.amount} />
            </FormField>
            <FormField label="Confirmation #" constraintText="Optional">
              <Input value={confirmation} onChange={(e) => setConfirmation(e.detail.value)} />
            </FormField>
            <FormField label="Paid from" errorText={submitted ? errors.account : undefined}>
              <AccountSelect value={accountIdx} onChange={setAccountIdx} activeOnly invalid={submitted && !!errors.account} />
            </FormField>
          </SpaceBetween>
        </Form>
      </form>
    </Modal>
  );
}
