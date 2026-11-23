import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { UpcomingPayment } from '../../../shared/types';

export function DueStatus({ p }: { p: Pick<UpcomingPayment, 'status' | 'daysUntilDue'> }) {
  const d = p.daysUntilDue;
  if (p.status === 'overdue') return <StatusIndicator type="error">{`Overdue by ${-d} day${d === -1 ? '' : 's'}`}</StatusIndicator>;
  if (p.status === 'due-soon')
    return <StatusIndicator type="warning">{d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`}</StatusIndicator>;
  return <StatusIndicator type="success">{`In ${d} days`}</StatusIndicator>;
}
