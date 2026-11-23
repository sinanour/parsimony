import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import { RouterLink } from '../components/common';

export default function NotFoundPage() {
  return (
    <ContentLayout header={<Header variant="h1">Page not found</Header>}>
      <Box>
        <RouterLink href="/">Go to the dashboard</RouterLink>
      </Box>
    </ContentLayout>
  );
}
