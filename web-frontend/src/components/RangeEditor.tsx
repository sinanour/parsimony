import { useEffect, useState } from 'react';
import Button from '@cloudscape-design/components/button';
import DatePicker from '@cloudscape-design/components/date-picker';
import FormField from '@cloudscape-design/components/form-field';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { DateRange } from '../../../shared/types';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';

/** Edits a single-row date range table (huquq_date_range / corporate_date_range). End date is exclusive. */
export function RangeEditor({ value, onSave }: { value: DateRange | undefined; onSave: (r: DateRange) => Promise<void> }) {
  const { notifyError } = useApp();
  const { canEdit } = useAuth();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (value) {
      setStart(value.startDate);
      setEnd(value.endDate);
    }
  }, [value]);

  const dirty = !!value && (start !== value.startDate || end !== value.endDate);
  const invalid = !start || !end || start >= end;

  return (
    <SpaceBetween direction="horizontal" size="s" alignItems="end">
      <FormField label="Start date">
        <DatePicker value={start} readOnly={!canEdit} onChange={(e) => setStart(e.detail.value)} placeholder="YYYY/MM/DD" />
      </FormField>
      <FormField label="End date (exclusive)" errorText={start && end && start >= end ? 'Must be after the start date' : undefined}>
        <DatePicker value={end} readOnly={!canEdit} onChange={(e) => setEnd(e.detail.value)} placeholder="YYYY/MM/DD" />
      </FormField>
      {canEdit && (
      <Button
        disabled={!dirty || invalid}
        loading={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave({ startDate: start, endDate: end });
          } catch (e) {
            notifyError(e, 'Could not save the date range');
          } finally {
            setSaving(false);
          }
        }}
      >
        Apply
      </Button>
      )}
    </SpaceBetween>
  );
}
