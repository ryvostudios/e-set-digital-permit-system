import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
import { FormPreviewPage } from '../features/permits/v2/FormPreviewPage';
import { MyDraftsPage } from '../features/permits/MyDraftsPage';
import { LoginPage } from '../features/auth/LoginPage';
import { HomePage } from '../features/home/HomePage';
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { ApplyPermitPage } from '../features/permits/ApplyPermitPage';
import { PermitDetailPage } from '../features/permits/PermitDetailPage';
import { RecordsPage } from '../features/permits/RecordsPage';
import { CroQueuePage } from '../features/review/CroQueuePage';
import { HseQueuePage } from '../features/review/HseQueuePage';
import { CreateEmployeePage } from '../features/admin/CreateEmployeePage';
import { EmployeeDetailPage } from '../features/admin/EmployeeDetailPage';
import { EmployeeListPage } from '../features/admin/EmployeeListPage';
import { AuditLogsPage } from '../features/admin/AuditLogsPage';
import { SiteManagersPage } from '../features/admin/SiteManagersPage';
import { AppShell } from '../layout/AppShell';
import { Button } from '../ui/Button';
import { Alert, ErrorState, LoadingState } from '../ui/Feedback';
import { PageHeader } from '../ui/Layout';
import { ROUTES } from './routes';

/**
 * Routing and the authentication gate.
 *
 * The gate has exactly three states, and they are checked in this order,
 * because each one makes the next meaningful:
 *
 *   1. No session          -> the login screen, always.
 *   2. Password outstanding -> the change-password screen, and nothing
 *                             else. This mirrors the backend, which
 *                             refuses every other route with
 *                             `password_change_required`; the redirect
 *                             is a courtesy, not the enforcement.
 *   3. Otherwise            -> the application shell.
 *
 * FRONTEND ROUTING IS NOT AUTHORIZATION. A person who types an
 * administration URL directly still reaches the screen - and that screen
 * asks the server, which answers 403, which the screen shows honestly.
 * Nothing is unlocked by arriving at a route.
 */

/** Session held, `/auth/me` unreachable. The shell cannot be trusted to render without it. */
function IdentityUnavailable() {
  const { identityError, refreshIdentity, signOut } = useAuth();
  return (
    <div className="centered-page">
      <div className="centered-page__panel centered-page__panel--wide">
        <div className="centered-page__body stack">
          <PageHeader
            title="Cannot load your account"
            description="You are signed in, but the permit service did not answer. Nothing has been changed."
          />
          {identityError ? (
            <Alert tone="danger" title="The service did not respond" requestId={identityError.requestId}>
              {identityError.message}
            </Alert>
          ) : null}
          <div className="row">
            <Button variant="primary" onClick={() => void refreshIdentity()}>
              Try again
            </Button>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="That address does not match anything in this application." />
      <ErrorState error={{ code: 'not_found' }} />
    </>
  );
}

/** Renders the authenticated tree only for a fully bootstrapped identity. */
function AuthenticatedArea() {
  const { phase, user } = useAuth();
  const location = useLocation();

  if (phase === 'initializing' || phase === 'loading-identity') {
    return <LoadingState label="Loading your account" />;
  }
  if (phase === 'identity-unavailable') return <IdentityUnavailable />;
  if (phase === 'signed-out' || !user) {
    return <Navigate to={ROUTES.login} replace state={{ from: location.pathname }} />;
  }
  if (user.mustChangePassword) return <Navigate to={ROUTES.changePassword} replace />;

  return <AppShell />;
}

function LoginRoute() {
  const { phase, user } = useAuth();
  if (phase === 'initializing') return <LoadingState label="Loading" />;
  if (user) return <Navigate to={user.mustChangePassword ? ROUTES.changePassword : ROUTES.home} replace />;
  return <LoginPage />;
}

function ChangePasswordRoute() {
  const { phase, user } = useAuth();
  if (phase === 'initializing' || phase === 'loading-identity') return <LoadingState label="Loading your account" />;
  if (phase === 'identity-unavailable') return <IdentityUnavailable />;
  if (!user) return <Navigate to={ROUTES.login} replace />;
  // Reaching this route without an outstanding change is not an error -
  // it just isn't a page that applies, so send the person home.
  if (!user.mustChangePassword) return <Navigate to={ROUTES.home} replace />;
  return <ChangePasswordPage />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path={ROUTES.login} element={<LoginRoute />} />
        <Route path={ROUTES.changePassword} element={<ChangePasswordRoute />} />

        <Route element={<AuthenticatedArea />}>
          <Route index element={<HomePage />} />
          <Route path={ROUTES.apply} element={<ApplyPermitPage />} />
          <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
          <Route path={ROUTES.myDrafts} element={<MyDraftsPage />} />
          <Route path={ROUTES.records} element={<RecordsPage />} />
          <Route path={ROUTES.croQueue} element={<CroQueuePage />} />
          <Route path={ROUTES.hseQueue} element={<HseQueuePage />} />
          <Route path={ROUTES.notifications} element={<NotificationsPage />} />
          <Route path={ROUTES.employees} element={<EmployeeListPage />} />
          <Route path={ROUTES.employeeNew} element={<CreateEmployeePage />} />
          <Route path={ROUTES.employeePattern} element={<EmployeeDetailPage />} />
          <Route path={ROUTES.siteManagers} element={<SiteManagersPage />} />
          <Route path={ROUTES.auditLogs} element={<AuditLogsPage />} />
          {/*
            Visual-QA harness for the authoritative documents, mounted ONLY
            in the e2e build. The production bundle has no such route: the
            documents are not yet wired into the live create flow, and that
            cutover is deliberately not part of this stage.
          */}
          {import.meta.env.MODE === 'e2e' ? (
            <Route path="/__forms-preview" element={<FormPreviewPage />} />
          ) : null}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
