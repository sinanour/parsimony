import Button, { type ButtonProps } from '@cloudscape-design/components/button';
import { BREAKPOINTS, useMediaQuery } from '../hooks/useMediaQuery';

export interface ResponsiveButtonProps extends Omit<ButtonProps, 'children' | 'ariaLabel'> {
  /** Button label; also used as the accessible name when the button collapses to an icon. */
  children: string;
  /** Icon shown on its own on mobile viewports. */
  mobileIcon: NonNullable<ButtonProps['iconName']>;
  /** Accessible name for the icon-only form, when the label alone is ambiguous (e.g. in a table row). */
  mobileAriaLabel?: string;
}

/**
 * A button that shows its label on desktop and tablet, and collapses to an icon-only
 * button on mobile. The label never wraps.
 */
export function ResponsiveButton({ children, mobileIcon, mobileAriaLabel, ...props }: ResponsiveButtonProps) {
  const isMobile = useMediaQuery(BREAKPOINTS.mobile);
  if (isMobile) return <Button {...props} iconName={mobileIcon} ariaLabel={mobileAriaLabel ?? children} />;
  return (
    <Button {...props} wrapText={false}>
      {children}
    </Button>
  );
}
