import { useEffect, useState, type ReactNode } from 'react';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TextFilter from '@cloudscape-design/components/text-filter';
import { TEXT_LIMITS, type Scope } from '../../../shared/types';
import { AccountSelect, DateRangeFilter, ScopeControl } from './common';

export interface FilterValues {
  scope: Scope;
  accountIdx: number | null;
  from?: string;
  to?: string;
  q: string;
}

/** Filter bar shared by the expense and deposit tables. `extra` renders page-specific controls. */
export function TransactionFilters({
  values,
  onChange,
  countText,
  extra,
}: {
  values: FilterValues;
  onChange: (v: Partial<FilterValues>) => void;
  countText?: string;
  extra?: ReactNode;
}) {
  const [text, setText] = useState(values.q);
  useEffect(() => setText(values.q), [values.q]);

  return (
    <SpaceBetween direction="horizontal" size="s" alignItems="center">
      <TextFilter
        filteringText={text}
        filteringPlaceholder="Description or comment"
        countText={values.q ? countText : undefined}
        onChange={(e) => setText(e.detail.filteringText.slice(0, TEXT_LIMITS.search))}
        onDelayedChange={(e) => onChange({ q: e.detail.filteringText })}
      />
      <ScopeControl value={values.scope} onChange={(scope) => onChange({ scope, accountIdx: null })} />
      <AccountSelect value={values.accountIdx} allowAll scope={values.scope} onChange={(accountIdx) => onChange({ accountIdx })} />
      {extra}
      <DateRangeFilter value={{ from: values.from, to: values.to }} onChange={(r) => onChange({ from: r.from, to: r.to })} />
    </SpaceBetween>
  );
}
