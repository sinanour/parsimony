import type { ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';

/** A narrow, centred card for the signed-out pages. */
export function AuthCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Box padding={{ top: 'xxxl' }}>
      <Grid gridDefinition={[{ colspan: { default: 12, s: 8, m: 6, l: 4 }, offset: { default: 0, s: 2, m: 3, l: 4 } }]}>
        <Container header={<Header variant="h1" description={description}>{title}</Header>}>{children}</Container>
      </Grid>
    </Box>
  );
}
