import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import DateRangePicker, { type DateRangePickerProps } from '@cloudscape-design/components/date-range-picker';
import Link, { type LinkProps } from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { TEXT_LIMITS, type Scope } from '../../../shared/types';
import { useApp } from '../context/AppContext';

/** Cloudscape link that navigates client-side. */
export function RouterLink({ href, children, ...rest }: Omit<LinkProps, 'onFollow'> & { href: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Link
      {...rest}
      href={href}
      onFollow={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </Link>
  );
}

export function ScopeControl({ value, onChange, includeAll = true }: { value: Scope; onChange: (s: Scope) => void; includeAll?: boolean }) {
  const options = [
    { id: 'personal', text: 'Personal' },
    { id: 'corporate', text: 'Corporate' },
    ...(includeAll ? [{ id: 'all', text: 'All' }] : []),
  ];
  return <SegmentedControl selectedId={value} options={options} onChange={(e) => onChange(e.detail.selectedId as Scope)} />;
}

interface AccountSelectProps {
  value: number | null;
  onChange: (accountIdx: number | null) => void;
  /** Adds an "All accounts" option that maps to null. */
  allowAll?: boolean;
  activeOnly?: boolean;
  scope?: Scope;
  invalid?: boolean;
  placeholder?: string;
}

export function AccountSelect({ value, onChange, allowAll, activeOnly, scope = 'all', invalid, placeholder = 'Choose an account' }: AccountSelectProps) {
  const { meta } = useApp();
  const options: SelectProps.Options = useMemo(() => {
    const accounts = (meta?.accounts ?? []).filter(
      (a) => (!activeOnly || a.isActive || a.accountIdx === value) && (scope === 'all' || a.isCorporate === (scope === 'corporate')),
    );
    const toOpt = (a: (typeof accounts)[number]): SelectProps.Option => ({
      value: String(a.accountIdx),
      label: a.name,
      tags: [a.isCorporate ? 'Corporate' : 'Personal', ...(a.isCreditCard ? ['Credit card'] : []), ...(a.isActive ? [] : ['Inactive'])],
    });
    const active = accounts.filter((a) => a.isActive).map(toOpt);
    const inactive = accounts.filter((a) => !a.isActive).map(toOpt);
    const all: SelectProps.Option[] = allowAll ? [{ value: '', label: 'All accounts' }] : [];
    return inactive.length
      ? [...all, { label: 'Active', options: active }, { label: 'Inactive', options: inactive }]
      : [...all, ...active];
  }, [meta, activeOnly, scope, allowAll, value]);

  const flat: SelectProps.Option[] = options.flatMap((o) => ('options' in o ? [...o.options] : [o]));
  const selected = flat.find((o) => o.value === (value === null ? '' : String(value))) ?? null;

  return (
    <Select
      selectedOption={selected}
      options={options}
      filteringType="auto"
      placeholder={placeholder}
      invalid={invalid}
      statusType={meta ? 'finished' : 'loading'}
      onChange={(e) => onChange(e.detail.selectedOption.value ? Number(e.detail.selectedOption.value) : null)}
    />
  );
}

export function CategoryInput({
  value,
  onChange,
  scope,
  placeholder = 'Category',
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  scope: Scope;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { meta } = useApp();
  const options = useMemo(() => {
    const p = meta?.categories.personal ?? [];
    const c = meta?.categories.corporate ?? [];
    const list = scope === 'personal' ? p : scope === 'corporate' ? c : [...new Set([...p, ...c])].sort();
    return list.map((v) => ({ value: v }));
  }, [meta, scope]);
  return (
    <Autosuggest
      value={value}
      onChange={(e) => onChange(e.detail.value)}
      options={options}
      placeholder={placeholder}
      enteredTextLabel={(v) => `Use "${v}"`}
      empty="No matching categories"
      autoFocus={autoFocus}
      expandToViewport
      nativeInputAttributes={{ maxLength: TEXT_LIMITS.category }}
    />
  );
}

export interface IsoRange {
  from?: string;
  to?: string;
}

export function DateRangeFilter({ value, onChange, placeholder = 'Filter by date' }: { value: IsoRange; onChange: (r: IsoRange) => void; placeholder?: string }) {
  const v: DateRangePickerProps.Value | null = value.from && value.to ? { type: 'absolute', startDate: value.from, endDate: value.to } : null;
  return (
    <DateRangePicker
      value={v}
      dateOnly
      rangeSelectorMode="absolute-only"
      placeholder={placeholder}
      relativeOptions={[]}
      expandToViewport
      isValidRange={(r) => {
        if (r?.type === 'absolute' && (!r.startDate || !r.endDate)) return { valid: false, errorMessage: 'Choose a start and end date.' };
        return { valid: true };
      }}
      onChange={(e) => {
        const d = e.detail.value;
        if (d?.type === 'absolute') onChange({ from: d.startDate.slice(0, 10), to: d.endDate.slice(0, 10) });
        else onChange({});
      }}
    />
  );
}

export function ConfirmModal({
  visible,
  header,
  children,
  confirmText = 'Delete',
  onConfirm,
  onDismiss,
}: {
  visible: boolean;
  header: string;
  children: ReactNode;
  confirmText?: string;
  onConfirm: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={header}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmText}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {children}
    </Modal>
  );
}

export function EmptyState({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <Box textAlign="center" color="inherit">
      <Box variant="strong" textAlign="center" color="inherit">
        {title}
      </Box>
      {subtitle && (
        <Box variant="p" padding={{ bottom: 's' }} color="inherit">
          {subtitle}
        </Box>
      )}
      {action}
    </Box>
  );
}

/** Removes inline-edit affordances from table columns for users who can't change data. */
export function editableColumns<T extends { editConfig?: unknown }>(canEdit: boolean, columns: T[]): T[] {
  return canEdit ? columns : columns.map(({ editConfig: _omit, ...rest }) => rest as T);
}
