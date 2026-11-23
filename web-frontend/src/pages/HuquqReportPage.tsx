import { useMemo } from 'react';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
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
}

const right = (n: number) => <Box textAlign="right">{formatMoney(n)}</Box>;

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

  const p = r?.payment;
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

        <Table<CategoryRow>
          variant="container"
          loading={report.loading}
          items={byCategory}
          trackBy="category"
          header={<Header variant="h2" counter={`(${byCategory.length})`}>Expenses by category</Header>}
          columnDefinitions={[
            { id: 'category', header: 'Category', cell: (c) => c.category, isRowHeader: true },
            { id: 'exempt', header: 'Exempt', cell: (c) => right(c.exempt) },
            { id: 'nonExempt', header: 'Non-exempt', cell: (c) => right(c.nonExempt) },
            { id: 'uncategorized', header: 'Uncategorized', cell: (c) => (c.uncategorized ? right(c.uncategorized) : '') },
          ]}
          footer={
            byCategory.length > 0 && (
              <Box textAlign="right">
                Exempt {formatMoney(byCategory.reduce((s, c) => s + c.exempt, 0))} · Non-exempt {formatMoney(byCategory.reduce((s, c) => s + c.nonExempt, 0))}
              </Box>
            )
          }
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
