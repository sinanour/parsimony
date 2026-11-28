import { useMemo } from 'react';
import BarChart, { type BarChartProps } from '@cloudscape-design/components/bar-chart';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import PieChart, { type PieChartProps } from '@cloudscape-design/components/pie-chart';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { UNCATEGORIZED } from '../../../shared/types';
import { api } from '../api/client';
import { RouterLink } from '../components/common';
import { RangeEditor } from '../components/RangeEditor';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { formatMoney } from '../utils/format';

interface CategoryRow {
  category: string;
  exempt: number;
  nonExempt: number;
  uncategorized: number;
  /** The column-totals row at the bottom of the table. */
  isTotal?: boolean;
}

const right = (n: number, bold = false) => (
  <Box textAlign="right" fontWeight={bold ? 'bold' : undefined}>
    {formatMoney(n)}
  </Box>
);

/** `grouped` lists the categories folded into an "Other" slice. */
type Slice = PieChartProps.Datum & { grouped?: string[] };

/** Most category slices a chart shows, counting "Other". */
const MAX_SLICES = 7;
/** Categories below this share of the chart's total go into "Other". */
const MIN_SHARE = 0.03;

/**
 * Category slices for one exemption class, largest first; non-positive totals can't be drawn.
 * Small categories are grouped into "Other", but only when that groups at least two of them.
 */
function slicesFor(rows: CategoryRow[], key: 'exempt' | 'nonExempt'): Slice[] {
  const all = rows
    .filter((c) => c[key] > 0)
    .map((c) => ({ title: c.category, value: c[key] }))
    .sort((a, b) => b.value - a.value);
  const total = all.reduce((s, x) => s + x.value, 0);
  let keep = all.findIndex((x, i) => i >= MAX_SLICES - 1 || x.value < total * MIN_SHARE);
  if (keep === -1 || all.length - keep < 2) return all;
  keep = Math.max(keep, 1);
  const rest = all.slice(keep);
  return [
    ...all.slice(0, keep),
    { title: 'Other', value: rest.reduce((s, x) => s + x.value, 0), grouped: rest.map((x) => x.title) },
  ];
}

const share = (v: number, sum: number) => `${sum ? ((v / sum) * 100).toFixed(1) : 0}%`;

function Donut({ title, data, total, totalLabel, loading }: { title: string; data: Slice[]; total: number; totalLabel: string; loading: boolean }) {
  return (
    <Container fitHeight header={<Header variant="h2">{title}</Header>}>
      <PieChart
        variant="donut"
        size="medium"
        fitHeight
        hideFilter
        statusType={loading ? 'loading' : 'finished'}
        data={data}
        innerMetricValue={formatMoney(total)}
        innerMetricDescription={totalLabel}
        segmentDescription={(d, sum) => `${formatMoney(d.value)} (${share(d.value, sum)})`}
        detailPopoverContent={(d, sum) => [
          { key: 'Amount', value: formatMoney(d.value) },
          { key: 'Share', value: share(d.value, sum) },
          ...(d.grouped ? [{ key: `${d.grouped.length} categories`, value: d.grouped.join(', ') }] : []),
        ]}
        ariaLabel={title}
        loadingText="Loading chart"
        i18nStrings={{ chartAriaRoleDescription: 'donut chart', segmentAriaRoleDescription: 'segment' }}
        empty={
          <Box textAlign="center" color="inherit">
            No data for this period.
          </Box>
        }
      />
    </Container>
  );
}

export default function HuquqReportPage() {
  const { notify } = useApp();
  const report = useAsync(() => api.reports.huquq(), []);
  const r = report.data;

  const byCategory = useMemo(() => {
    const m = new Map<string, CategoryRow>();
    for (const s of r?.expenseSummary ?? []) {
      const key = s.category || 'Uncategorized';
      const row = m.get(key) ?? { category: key, exempt: 0, nonExempt: 0, uncategorized: 0 };
      if (s.exemptionClassification === 'Exempt') row.exempt += s.total;
      else if (s.exemptionClassification === 'Non-Exempt') row.nonExempt += s.total;
      else row.uncategorized += s.total;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => b.exempt + b.nonExempt - (a.exempt + a.nonExempt));
  }, [r]);

  const totals = useMemo<CategoryRow>(() => {
    const t: CategoryRow = { category: 'Total', exempt: 0, nonExempt: 0, uncategorized: 0, isTotal: true };
    for (const c of byCategory) {
      t.exempt += c.exempt;
      t.nonExempt += c.nonExempt;
      t.uncategorized += c.uncategorized;
    }
    return t;
  }, [byCategory]);

  const p = r?.payment;

  // Income on the left; expenses plus the estimated payment stacked on the right, so the
  // right bar standing taller than the left one means the period was overspent.
  const spendingSeries = useMemo<BarChartProps<string>['series']>(() => {
    if (!p) return [];
    const bar = (title: string, x: string, y: number) => ({ type: 'bar' as const, title, data: [{ x, y }], valueFormatter: formatMoney });
    return [
      bar('Income', 'Income', p.totalIncome),
      bar('Exempt', 'Expenses', totals.exempt),
      bar('Non-exempt', 'Expenses', totals.nonExempt),
      bar('Uncategorized', 'Expenses', totals.uncategorized),
      bar('Estimated payment', 'Expenses', p.estimatedPayment),
    ].filter((b) => b.data[0].y > 0);
  }, [p, totals]);
  const exemptSlices = useMemo(() => slicesFor(byCategory, 'exempt'), [byCategory]);
  const nonExemptSlices = useMemo(() => slicesFor(byCategory, 'nonExempt'), [byCategory]);
  const sum = (d: Slice[]) => d.reduce((s, x) => s + x.value, 0);
  const uncatHref = r ? `/expenses?scope=personal&category=${UNCATEGORIZED}&from=${r.range.startDate}&to=${r.range.endDate}` : '/expenses';
  const unrevHref = r ? `/deposits?scope=personal&reviewed=unreviewed&from=${r.range.startDate}&to=${r.range.endDate}` : '/deposits';

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="19% of income less exempt expenses, for personal accounts over the period below.">
          Huqúqu'lláh
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Period</Header>}>
          <RangeEditor
            value={r?.range}
            onSave={async (range) => {
              await api.reports.setHuquqRange(range);
              notify('success', `${range.startDate} to ${range.endDate}`, 'Period updated');
              report.reload();
            }}
          />
        </Container>

        <Container header={<Header variant="h2">Payment estimate</Header>}>
          {p ? (
            <KeyValuePairs
              columns={4}
              items={[
                { label: 'Estimated payment', value: <Box variant="h2" tagOverride="span">{formatMoney(p.estimatedPayment)}</Box> },
                { label: 'Range', value: `${formatMoney(p.minPayment)} – ${formatMoney(p.maxPayment)}` },
                { label: 'Total income', value: formatMoney(p.totalIncome) },
                { label: 'Total exemptions', value: formatMoney(p.totalExemptions) },
                { label: 'Total expenses', value: formatMoney(p.totalExpenses) },
                { label: 'Uncategorized expenses', value: p.uncategorizedExpenses ? <RouterLink href={uncatHref}>{formatMoney(p.uncategorizedExpenses)}</RouterLink> : formatMoney(0) },
                { label: 'Unreviewed income', value: p.uncategorizedIncome ? <RouterLink href={unrevHref}>{formatMoney(p.uncategorizedIncome)}</RouterLink> : formatMoney(0) },
              ]}
            />
          ) : (
            <Box color="text-status-inactive">{report.loading ? 'Loading…' : report.error ?? 'No data for this period.'}</Box>
          )}
          {p && (p.uncategorizedExpenses > 0 || p.uncategorizedIncome > 0) && (
            <Box variant="small" padding={{ top: 's' }}>
              The range assumes uncategorized expenses could all be exempt (minimum) and unreviewed deposits could all be income (maximum). Categorize them to narrow it.
            </Box>
          )}
        </Container>

        {/* One column, or three: never two. Grid breakpoints track the content width. */}
        <Grid gridDefinition={[0, 1, 2].map(() => ({ colspan: { default: 12, m: 4 } }))}>
          <Container fitHeight header={<Header variant="h2">Income and spending</Header>}>
            <BarChart
              series={spendingSeries}
              xDomain={['Income', 'Expenses']}
              xScaleType="categorical"
              stackedBars
              hideFilter
              height={250}
              fitHeight
              statusType={report.loading ? 'loading' : 'finished'}
              loadingText="Loading chart"
              ariaLabel="Income and spending"
              i18nStrings={{ yTickFormatter: (v) => formatMoney(v) }}
              empty={
                <Box textAlign="center" color="inherit">
                  No data for this period.
                </Box>
              }
            />
          </Container>
          <Donut title="Exempt expenses" data={exemptSlices} total={sum(exemptSlices)} totalLabel="Exempt" loading={report.loading} />
          <Donut title="Non-exempt expenses" data={nonExemptSlices} total={sum(nonExemptSlices)} totalLabel="Non-exempt" loading={report.loading} />
        </Grid>

        <Table<CategoryRow>
          variant="container"
          loading={report.loading}
          // Column totals go in a last row so each lines up under its column; the table isn't
          // sortable, so the row stays at the bottom.
          items={byCategory.length ? [...byCategory, totals] : []}
          trackBy={(c) => (c.isTotal ? '\u0000total' : c.category)}
          header={<Header variant="h2" counter={`(${byCategory.length})`}>Expenses by category</Header>}
          columnDefinitions={[
            { id: 'category', header: 'Category', cell: (c) => (c.isTotal ? <Box fontWeight="bold">{c.category}</Box> : c.category), isRowHeader: true },
            { id: 'exempt', header: 'Exempt', cell: (c) => right(c.exempt, c.isTotal) },
            { id: 'nonExempt', header: 'Non-exempt', cell: (c) => right(c.nonExempt, c.isTotal) },
            { id: 'uncategorized', header: 'Uncategorized', cell: (c) => (c.uncategorized || c.isTotal ? right(c.uncategorized, c.isTotal) : '') },
          ]}
        />

        <Table
          variant="container"
          loading={report.loading}
          items={r?.income ?? []}
          trackBy="description"
          header={<Header variant="h2">Income (reviewed deposits)</Header>}
          columnDefinitions={[
            { id: 'description', header: 'Description', cell: (i) => i.description, isRowHeader: true },
            { id: 'total', header: 'Income', cell: (i) => right(i.totalIncome) },
          ]}
        />

        <ExpandableSection variant="container" headerText="Exemptions by account and category" headerCounter={`(${r?.exemptionsByAccount.length ?? 0})`}>
          <Table
            variant="embedded"
            items={r?.exemptionsByAccount ?? []}
            columnDefinitions={[
              { id: 'account', header: 'Account', cell: (x) => x.accountName, isRowHeader: true },
              { id: 'category', header: 'Category', cell: (x) => x.category || 'Uncategorized' },
              { id: 'amount', header: 'Total amount', cell: (x) => right(x.totalAmount) },
              { id: 'exemption', header: 'Exempt', cell: (x) => right(x.totalExemption) },
            ]}
          />
        </ExpandableSection>
      </SpaceBetween>
    </ContentLayout>
  );
}
