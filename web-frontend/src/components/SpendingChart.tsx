import { useMemo, useState } from 'react';
import BarChart, { type BarChartProps } from '@cloudscape-design/components/bar-chart';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import DateRangePicker, { type DateRangePickerProps } from '@cloudscape-design/components/date-range-picker';
import Header from '@cloudscape-design/components/header';
import Multiselect, { type MultiselectProps } from '@cloudscape-design/components/multiselect';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { colorChartsStatusNeutral } from '@cloudscape-design/design-tokens';
import { SPENDING_MAX_PERIODS, type Scope, type SpendingGrouping, type SpendingQuery, type SpendingReport } from '../../../shared/types';
import { api } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatMoney } from '../utils/format';
import { ScopeControl } from './common';

/**
 * Most legend entries. Up to this many selected categories each get a series; beyond it, the largest
 * MAX_LEGEND - 1 do and the rest are summed into an implicit "Other", which so always groups at least two.
 */
const MAX_LEGEND = 8;

const relative = (amount: number): DateRangePickerProps.RelativeOption => ({ key: `last-${amount}-months`, amount, unit: 'month', type: 'relative' });
const RELATIVE_OPTIONS = [3, 6, 12, 24].map(relative);
const DEFAULT_RANGE: DateRangePickerProps.Value = RELATIVE_OPTIONS[2];

const GROUPINGS: { id: SpendingGrouping; text: string }[] = [
  { id: 'month', text: 'Monthly' },
  { id: 'quarter', text: 'Quarterly' },
  { id: 'year', text: 'Yearly' },
];
const PERIOD_NAMES: Record<SpendingGrouping, string> = { month: 'Month', quarter: 'Quarter', year: 'Year' };

/** Months in a relative range, or null when the range isn't one the API accepts. */
function relativeMonths(r: DateRangePickerProps.RelativeValue): number | null {
  const n = r.unit === 'month' ? r.amount : r.unit === 'year' ? r.amount * 12 : NaN;
  return Number.isInteger(n) && n >= 1 && n <= SPENDING_MAX_PERIODS ? n : null;
}

function toQuery(range: DateRangePickerProps.Value, scope: Scope, grouping: SpendingGrouping): SpendingQuery {
  const s = scope === 'corporate' ? 'corporate' : 'personal';
  if (range.type === 'relative') return { scope: s, grouping, months: relativeMonths(range) ?? 12 };
  return { scope: s, grouping, startDate: range.startDate.slice(0, 10), endDate: range.endDate.slice(0, 10) };
}

const round = (n: number) => Math.round(n * 100) / 100;

interface Chart {
  /** Every category with spending in the report, largest total first. */
  ranked: { category: string; total: number }[];
  series: BarChartProps<string>['series'][number][];
  /** The implicit "Other" series and the categories it sums, when more than MAX_LEGEND are selected. */
  other: { series: BarChartProps<string>['series'][number]; grouped: string[] } | null;
  /** category → period → total, for the implicit "Other" popover. */
  byCategory: Map<string, Map<string, number>>;
}

function buildChart(report: SpendingReport | undefined, excluded: ReadonlySet<string>): Chart {
  const byCategory = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const r of report?.rows ?? []) {
    const m = byCategory.get(r.category) ?? new Map<string, number>();
    m.set(r.period, (m.get(r.period) ?? 0) + r.total);
    byCategory.set(r.category, m);
    totals.set(r.category, (totals.get(r.category) ?? 0) + r.total);
  }
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, total]) => ({ category, total: round(total) }));
  const selected = ranked.map((r) => r.category).filter((c) => !excluded.has(c));
  const own = selected.length > MAX_LEGEND ? selected.slice(0, MAX_LEGEND - 1) : selected;
  const grouped = selected.slice(own.length);
  const periods = report?.periods ?? [];
  const sumAt = (cats: string[], p: string) => round(cats.reduce((s, c) => s + (byCategory.get(c)?.get(p) ?? 0), 0));

  // A category that is literally named "Other" is an ordinary series here and takes a palette colour;
  // only the implicit grouping is gray, which is what tells the two apart.
  const series: BarChartProps<string>['series'][number][] = own.map((c) => ({
    title: c,
    type: 'bar' as const,
    data: periods.map((p) => ({ x: p, y: sumAt([c], p) })),
    valueFormatter: formatMoney,
  }));
  let other: Chart['other'] = null;
  if (grouped.length > 0) {
    const s: BarChartProps<string>['series'][number] = {
      title: 'Other',
      type: 'bar',
      color: colorChartsStatusNeutral,
      data: periods.map((p) => ({ x: p, y: sumAt(grouped, p) })),
      valueFormatter: formatMoney,
    };
    series.push(s);
    other = { series: s, grouped };
  }
  return { ranked, series, other, byCategory };
}

export default function SpendingChart() {
  const [scope, setScope] = useState<Scope>('personal');
  const [grouping, setGrouping] = useState<SpendingGrouping>('month');
  const [range, setRange] = useState<DateRangePickerProps.Value>(DEFAULT_RANGE);
  // Track what the user turned off rather than on, so categories that appear in a new range start selected.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());

  const query = toQuery(range, scope, grouping);
  const queryKey = JSON.stringify(query);
  // queryKey captures every field of query, so the request reruns exactly when the query changes.
  const report = useAsync(() => api.reports.spending(query), [queryKey]);
  const chart = useMemo(() => buildChart(report.data, excluded), [report.data, excluded]);

  const options: MultiselectProps.Option[] = chart.ranked.map((r) => ({ value: r.category, label: r.category, tags: [formatMoney(r.total)] }));
  const selectedOptions = options.filter((o) => !excluded.has(o.value!));
  const categoriesLabel =
    options.length === 0 ? 'No categories' : selectedOptions.length === options.length ? `All ${options.length} categories` : `${selectedOptions.length} of ${options.length} categories`;

  const r = report.data;
  const description = r ? `${r.startDate} to ${r.endDate}, excluding transfers` : 'Excluding transfers';
  const periodTitle = PERIOD_NAMES[grouping];

  return (
    <Container
      header={
        <Header variant="h2" description={description} actions={<ScopeControl value={scope} onChange={setScope} includeAll={false} />}>
          Spending by {periodTitle.toLowerCase()}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <SpaceBetween direction="horizontal" size="s" alignItems="center">
          <DateRangePicker
            value={range}
            onChange={(e) => setRange(e.detail.value ?? DEFAULT_RANGE)}
            relativeOptions={RELATIVE_OPTIONS}
            customRelativeRangeUnits={['month', 'year']}
            dateOnly
            showClearButton={false}
            expandToViewport
            placeholder="Choose a time horizon"
            ariaLabel="Time horizon"
            isValidRange={(v) => {
              if (v?.type === 'absolute') {
                if (!v.startDate || !v.endDate) return { valid: false, errorMessage: 'Choose a start and end date.' };
                if (v.endDate.slice(0, 10) < v.startDate.slice(0, 10)) return { valid: false, errorMessage: 'The end date must not be before the start date.' };
              }
              if (v?.type === 'relative' && relativeMonths(v) === null) {
                return { valid: false, errorMessage: `Choose between 1 and ${SPENDING_MAX_PERIODS} months.` };
              }
              return { valid: true };
            }}
          />
          <SegmentedControl label="Grouping" selectedId={grouping} options={GROUPINGS} onChange={(e) => setGrouping(e.detail.selectedId as SpendingGrouping)} />
          <Multiselect
            options={options}
            selectedOptions={selectedOptions}
            onChange={(e) => {
              const on = new Set(e.detail.selectedOptions.map((o) => o.value));
              // Keep exclusions for categories outside this report, so they stay off when they reappear.
              setExcluded(new Set([...excluded].filter((c) => !chart.byCategory.has(c)).concat(options.map((o) => o.value!).filter((c) => !on.has(c)))));
            }}
            placeholder={categoriesLabel}
            hideTokens
            enableSelectAll
            filteringType="auto"
            filteringPlaceholder="Find a category"
            statusType={report.loading ? 'loading' : 'finished'}
            loadingText="Loading categories"
            empty="No categorized spending in this range"
            expandToViewport
            ariaLabel="Categories"
            i18nStrings={{ selectAllText: 'Select all' }}
          />
        </SpaceBetween>
        <BarChart
          series={chart.series}
          xDomain={r?.periods ?? []}
          xScaleType="categorical"
          stackedBars
          height={280}
          xTitle={periodTitle}
          yTitle="Spending"
          hideFilter
          statusType={report.loading ? 'loading' : report.error ? 'error' : 'finished'}
          errorText={report.error}
          empty={
            <Box textAlign="center" color="inherit">
              {chart.ranked.length === 0 ? 'No categorized spending in this range.' : 'No categories selected.'}
            </Box>
          }
          detailPopoverSeriesContent={({ series, x, y }) => {
            if (chart.other && series === chart.other.series) {
              const items = chart.other.grouped
                .map((c) => ({ c, v: round(chart.byCategory.get(c)?.get(x) ?? 0) }))
                .filter((i) => i.v !== 0)
                .sort((a, b) => b.v - a.v);
              return { key: 'Other', value: formatMoney(y), expandable: items.length > 0, subItems: items.map((i) => ({ key: i.c, value: formatMoney(i.v) })) };
            }
            return { key: series.title, value: formatMoney(y) };
          }}
          i18nStrings={{ yTickFormatter: (v: number) => `$${Math.round(v).toLocaleString()}` }}
          ariaLabel="Spending by period"
        />
      </SpaceBetween>
    </Container>
  );
}
