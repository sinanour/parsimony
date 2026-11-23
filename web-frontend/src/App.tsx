import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppLayout from '@cloudscape-design/components/app-layout';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Box from '@cloudscape-design/components/box';
import Flashbar from '@cloudscape-design/components/flashbar';
import Spinner from '@cloudscape-design/components/spinner';
import SideNavigation, { type SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import { AppProvider, useApp } from './context/AppContext';
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/auth/PasswordResetPages';
import ProfilePage from './pages/ProfilePage';
import UsersPage from './pages/admin/UsersPage';
import AuditLogPage from './pages/admin/AuditLogPage';
import { ROLE_LABELS } from './pages/admin/UsersPage';
import DashboardPage from './pages/DashboardPage';
import AccountsPage from './pages/AccountsPage';
import PayeesPage from './pages/PayeesPage';
import PaymentsPage from './pages/PaymentsPage';
import ExpensesPage from './pages/ExpensesPage';
import DepositsPage from './pages/DepositsPage';
import RulesPage from './pages/RulesPage';
import ImportPage from './pages/ImportPage';
import StatementFormatsPage from './pages/StatementFormatsPage';
import HuquqReportPage from './pages/HuquqReportPage';
import CorporateReportPage from './pages/CorporateReportPage';
import PaymentTotalsPage from './pages/PaymentTotalsPage';
import CoveragePage from './pages/CoveragePage';
import NotFoundPage from './pages/NotFoundPage';

const ADMIN_NAV: SideNavigationProps.Item = {
  type: 'section',
  text: 'Administration',
  items: [
    { type: 'link', text: 'Users', href: '/admin/users' },
    { type: 'link', text: 'Audit log', href: '/admin/audit' },
  ],
};

const NAV_ITEMS: SideNavigationProps.Item[] = [
  { type: 'link', text: 'Dashboard', href: '/' },
  {
    type: 'section',
    text: 'Bills',
    items: [
      { type: 'link', text: 'Payments', href: '/payments' },
      { type: 'link', text: 'Payees', href: '/payees' },
    ],
  },
  {
    type: 'section',
    text: 'Transactions',
    items: [
      { type: 'link', text: 'Expenses', href: '/expenses' },
      { type: 'link', text: 'Deposits', href: '/deposits' },
      { type: 'link', text: 'Categorization rules', href: '/rules' },
      { type: 'link', text: 'Import statements', href: '/import' },
      { type: 'link', text: 'Statement formats', href: '/statement-formats' },
    ],
  },
  {
    type: 'section',
    text: 'Reports',
    items: [
      { type: 'link', text: "Huqúqu'lláh", href: '/reports/huquq' },
      { type: 'link', text: 'Corporate export', href: '/reports/corporate' },
      { type: 'link', text: 'Payment totals', href: '/reports/payment-totals' },
      { type: 'link', text: 'Statement coverage', href: '/reports/coverage' },
    ],
  },
  { type: 'divider' },
  { type: 'link', text: 'Accounts', href: '/accounts' },
];

const TITLES: Record<string, string> = {
  '/payments': 'Payments',
  '/payees': 'Payees',
  '/expenses': 'Expenses',
  '/deposits': 'Deposits',
  '/rules': 'Categorization rules',
  '/import': 'Import statements',
  '/statement-formats': 'Statement formats',
  '/reports/huquq': "Huqúqu'lláh",
  '/reports/corporate': 'Corporate export',
  '/reports/payment-totals': 'Payment totals',
  '/reports/coverage': 'Statement coverage',
  '/accounts': 'Accounts',
  '/profile': 'Your profile',
  '/admin/users': 'Users',
  '/admin/audit': 'Audit log',
};

const CONTENT_TYPE: Record<string, 'table' | 'default' | 'dashboard'> = {
  '/': 'dashboard',
  '/payees': 'table',
  '/expenses': 'table',
  '/deposits': 'table',
  '/rules': 'table',
  '/statement-formats': 'table',
  '/accounts': 'table',
  '/admin/users': 'table',
  '/admin/audit': 'table',
};

/** Hides the import pages from users who can't change data, and adds administration for admins. */
const IMPORT_ONLY = ['/import', '/statement-formats'];

function navItems(canEdit: boolean, isAdmin: boolean): SideNavigationProps.Item[] {
  const items = NAV_ITEMS.map((i) =>
    !canEdit && i.type === 'section' ? { ...i, items: i.items.filter((x) => !(x.type === 'link' && IMPORT_ONLY.includes(x.href))) } : i,
  );
  return isAdmin ? [...items, ADMIN_NAV] : items;
}

function useDarkMode(): [boolean, (v: boolean) => void] {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem('parsimony.dark');
      return stored === null ? window.matchMedia('(prefers-color-scheme: dark)').matches : stored === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    applyMode(dark ? Mode.Dark : Mode.Light);
    try {
      localStorage.setItem('parsimony.dark', dark ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [dark]);
  return [dark, setDark];
}

export default function App() {
  const { status } = useAuth();
  const [dark, setDark] = useDarkMode();
  if (status === 'loading') {
    return (
      <Box textAlign="center" padding={{ top: 'xxxl' }}>
        <Spinner size="large" />
      </Box>
    );
  }
  if (status === 'signedOut') return <SignedOutShell dark={dark} setDark={setDark} />;
  return (
    <AppProvider>
      <SignedInShell dark={dark} setDark={setDark} />
    </AppProvider>
  );
}

interface ShellProps {
  dark: boolean;
  setDark: (v: boolean) => void;
}

/** Sign-in, first-run setup and password reset. Any other URL shows sign-in and is kept for afterwards. */
function SignedOutShell({ dark, setDark }: ShellProps) {
  const topNav = document.getElementById('top-nav');
  return (
    <>
      {topNav &&
        createPortal(
          <TopNavigation
            identity={{ href: '/', title: 'Parsimony' }}
            utilities={[{ type: 'button', text: dark ? 'Light mode' : 'Dark mode', onClick: () => setDark(!dark) }]}
          />,
          topNav,
        )}
      <AppLayout
        headerSelector="#top-nav"
        navigationHide
        toolsHide
        content={
          <Routes>
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="*" element={<LoginPage />} />
          </Routes>
        }
      />
    </>
  );
}

function SignedInShell({ dark, setDark }: ShellProps) {
  const { notifications } = useApp();
  const { user, canEdit, isAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(true);

  const follow = (e: { preventDefault(): void; detail: { href?: string; external?: boolean } }) => {
    if (e.detail.external || !e.detail.href) return;
    e.preventDefault();
    navigate(e.detail.href);
  };

  const title = TITLES[location.pathname];
  const topNav = document.getElementById('top-nav');

  return (
    <>
      {topNav &&
        createPortal(
          <TopNavigation
            identity={{
              href: '/',
              title: 'Parsimony',
              onFollow: (e) => {
                e.preventDefault();
                navigate('/');
              },
            }}
            utilities={[
              ...(canEdit
                ? [{ type: 'button' as const, iconName: 'upload' as const, text: 'Import', onClick: () => navigate('/import') }]
                : []),
              {
                type: 'button',
                text: dark ? 'Light mode' : 'Dark mode',
                onClick: () => setDark(!dark),
              },
              {
                type: 'menu-dropdown',
                text: user?.displayName || user?.email,
                description: user ? `${user.email} · ${ROLE_LABELS[user.role]}` : undefined,
                iconName: 'user-profile',
                items: [
                  { id: 'profile', text: 'Your profile' },
                  ...(isAdmin
                    ? [
                        { id: 'users', text: 'Users' },
                        { id: 'audit', text: 'Audit log' },
                      ]
                    : []),
                  { id: 'signout', text: 'Sign out' },
                ],
                onItemClick: (e) => {
                  if (e.detail.id === 'profile') navigate('/profile');
                  if (e.detail.id === 'users') navigate('/admin/users');
                  if (e.detail.id === 'audit') navigate('/admin/audit');
                  if (e.detail.id === 'signout') void signOut().then(() => navigate('/'));
                },
              },
            ]}
          />,
          topNav,
        )}
      <AppLayout
        headerSelector="#top-nav"
        navigationOpen={navOpen}
        onNavigationChange={(e) => setNavOpen(e.detail.open)}
        navigation={
          <SideNavigation
            header={{ href: '/', text: 'Parsimony' }}
            items={navItems(canEdit, isAdmin)}
            activeHref={location.pathname}
            onFollow={follow}
          />
        }
        notifications={<Flashbar items={notifications} stackItems={notifications.length > 2} />}
        breadcrumbs={
          title ? (
            <BreadcrumbGroup
              items={[
                { text: 'Parsimony', href: '/' },
                { text: title, href: location.pathname },
              ]}
              onFollow={follow}
            />
          ) : undefined
        }
        toolsHide
        contentType={CONTENT_TYPE[location.pathname] ?? 'default'}
        content={
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/payees" element={<PayeesPage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/deposits" element={<DepositsPage />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/statement-formats" element={<StatementFormatsPage />} />
            <Route path="/reports/huquq" element={<HuquqReportPage />} />
            <Route path="/reports/corporate" element={<CorporateReportPage />} />
            <Route path="/reports/payment-totals" element={<PaymentTotalsPage />} />
            <Route path="/reports/coverage" element={<CoveragePage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            {isAdmin && <Route path="/admin/users" element={<UsersPage />} />}
            {isAdmin && <Route path="/admin/audit" element={<AuditLogPage />} />}
            {['/login', '/forgot-password', '/reset-password'].map((p) => (
              <Route key={p} path={p} element={<Navigate to="/" replace />} />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        }
      />
    </>
  );
}
