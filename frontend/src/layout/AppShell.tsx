import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { listNotifications } from '../api/endpoints';
import { ROUTES } from '../app/routes';
import { useAuth, useCurrentUser } from '../auth/useAuth';
import { useApiResource } from '../lib/useApiResource';
import { Button, IconButton } from '../ui/Button';
import {
  BellIcon,
  BrandMark,
  ChevronDownIcon,
  CloseIcon,
  DocumentIcon,
  HomeIcon,
  KeyIcon,
  MenuIcon,
  PeopleIcon,
  PlusIcon,
  ReviewIcon,
  ShieldIcon,
} from './Icons';
import { buildNavigation, type NavItem } from './navigation';
import './shell.css';

const ICONS: Record<NavItem['icon'], ReactNode> = {
  home: <HomeIcon />,
  plus: <PlusIcon />,
  document: <DocumentIcon />,
  review: <ReviewIcon />,
  shield: <ShieldIcon />,
  people: <PeopleIcon />,
  key: <KeyIcon />,
};

/** The title shown in the header for the current location. */
function usePageContext(): { section: string; title: string } {
  const { pathname } = useLocation();
  if (pathname === ROUTES.home) return { section: 'Overview', title: 'Home' };
  if (pathname.startsWith(ROUTES.apply)) return { section: 'Work', title: 'Apply for permit' };
  if (pathname.startsWith('/permits/')) return { section: 'Work', title: 'Permit record' };
  if (pathname.startsWith(ROUTES.records)) return { section: 'Work', title: 'Permit records' };
  if (pathname.startsWith(ROUTES.croQueue)) return { section: 'Review', title: 'CRO review queue' };
  if (pathname.startsWith(ROUTES.hseQueue)) return { section: 'Review', title: 'HSE review queue' };
  if (pathname.startsWith(ROUTES.notifications)) return { section: 'Overview', title: 'Notifications' };
  if (pathname.startsWith(ROUTES.employeeNew)) return { section: 'Administration', title: 'Add employee' };
  if (pathname.startsWith(ROUTES.employees)) return { section: 'Administration', title: 'Employees' };
  if (pathname.startsWith(ROUTES.siteManagers)) return { section: 'Administration', title: 'Site Managers' };
  return { section: 'E-SET', title: 'Permit to Work' };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * The identity line under the user's name.
 *
 * A NORMAL employee shows their Position and Company. A PRIVILEGED
 * account shows its role title and NOTHING organizational - it has no
 * Company, Team or Position, and none is invented for display.
 */
function identityLine(capabilities: ReturnType<typeof useCurrentUser>['capabilities']): string {
  if (capabilities.isCeo) return 'Chief Executive Officer';
  if (capabilities.isSiteManager) return 'E-SET Site Manager';
  const profile = capabilities.profile;
  return profile ? `${profile.positionName} · ${profile.company.name}` : 'Employee';
}

function UserMenu() {
  const { capabilities, user } = useCurrentUser();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const profile = capabilities.profile;

  return (
    <div className="user-menu" ref={containerRef}>
      <button
        type="button"
        className="user-menu__trigger"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="user-menu__avatar" aria-hidden="true">
          {initials(capabilities.displayName)}
        </span>
        <span className="user-menu__label">
          <span className="user-menu__name">{capabilities.displayName}</span>
          <span className="user-menu__role">{identityLine(capabilities)}</span>
        </span>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--text-muted)' }}>
          <ChevronDownIcon />
        </span>
      </button>

      {open ? (
        <div className="user-menu__panel">
          <p style={{ fontWeight: 700 }}>{capabilities.displayName}</p>
          <p className="muted text-sm">{identityLine(capabilities)}</p>

          {profile ? (
            <dl className="user-menu__identity">
              <dt>Company</dt>
              <dd>{profile.company.name}</dd>
              <dt>Team</dt>
              <dd>{profile.teamName}</dd>
              <dt>Position</dt>
              <dd>{profile.positionName}</dd>
            </dl>
          ) : (
            <div className="user-menu__identity" style={{ display: 'block' }}>
              <p className="muted text-sm">
                This is a privileged system account. It has no Company, Team, or Position.
              </p>
            </div>
          )}

          <p className="muted text-sm" style={{ marginBottom: 'var(--space-3)', wordBreak: 'break-all' }}>
            {user.auth.email ?? 'No sign-in address on record'}
          </p>

          <Button variant="secondary" block onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The authenticated application frame: a persistent sidebar on desktop,
 * a dismissible drawer on narrow screens, and a header carrying page
 * context, the notification badge, and the current-user menu.
 */
export function AppShell() {
  const { capabilities } = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const { section, title } = usePageContext();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const groups = buildNavigation(capabilities);

  // Close the drawer on navigation, so a link tap doesn't leave the menu
  // covering the page it just opened.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setDrawerOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);

  // The unread count. Refreshed whenever authorization-sensitive state
  // is invalidated, like every other resource.
  const unread = useApiResource(
    (signal) => listNotifications({ unread: 'true', pageSize: 1 }, signal),
    [],
  );
  const unreadCount = unread.data?.pagination.totalCount ?? 0;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      {drawerOpen ? <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} /> : null}

      <aside className="shell__sidebar" data-open={drawerOpen} id="app-navigation">
        <NavLink to={ROUTES.home} className="brand">
          <span style={{ color: 'var(--accent)' }} aria-hidden="true">
            <BrandMark />
          </span>
          <span>
            <span className="brand__name">E-SET</span>
            <span className="brand__tag">Permit to Work</span>
          </span>
        </NavLink>

        <nav className="nav" aria-label="Main navigation">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="nav__group-label">{group.label}</p>
              <ul className="nav__list">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end ?? false}
                      className="nav__link"
                      aria-current={
                        item.matchPrefix && location.pathname.startsWith(item.matchPrefix) ? 'page' : undefined
                      }
                    >
                      <span className="nav__link-icon">{ICONS[item.icon]}</span>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div style={{ marginTop: 'auto' }}>
            <p className="nav__group-label">Alerts</p>
            <ul className="nav__list">
              <li>
                <NavLink to={ROUTES.notifications} className="nav__link">
                  <span className="nav__link-icon">
                    <BellIcon size={18} />
                  </span>
                  Notifications
                  {unreadCount > 0 ? <span className="nav__count">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
                </NavLink>
              </li>
            </ul>
          </div>
        </nav>

        <div className="sidebar__footer">
          <p>{capabilities.displayName}</p>
          <p>{identityLine(capabilities)}</p>
        </div>
      </aside>

      <header className="shell__header">
        <span className="shell__menu-button">
          <IconButton
            label={drawerOpen ? 'Close navigation menu' : 'Open navigation menu'}
            icon={drawerOpen ? <CloseIcon /> : <MenuIcon />}
            aria-expanded={drawerOpen}
            aria-controls="app-navigation"
            onClick={() => setDrawerOpen((value) => !value)}
          />
        </span>

        <div className="shell__header-context">
          <p className="breadcrumb">{section}</p>
          <p className="shell__header-title">{title}</p>
        </div>

        <div className="shell__header-actions">
          <IconButton
            label="Notifications"
            icon={<BellIcon />}
            badge={unreadCount}
            onClick={() => navigate(ROUTES.notifications)}
          />
          <UserMenu />
        </div>
      </header>

      <main className="shell__main" id="main-content">
        <div className="shell__content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
