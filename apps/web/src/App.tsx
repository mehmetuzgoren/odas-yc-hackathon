import { Component, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { api, useSession } from './api';
import { AuthPage, SignInDialog } from './auth';
import { BuildingPage, ExplorePage, RoomPage } from './marketplace';
import { BookingsPage, BookingPage } from './commerce';
import { HostPage, ListingEditorPage, RoomMonitorPage } from './operations';
import { ConciergePanel } from './concierge';
import { EmptyState, Popover, Toaster } from './ui';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="mx-auto max-w-xl px-4 py-16"><EmptyState title="We couldn't open this page." text="Please reload to try again. Your saved reservations remain in your account." action={<button onClick={() => window.location.reload()} className="rounded-full bg-forest px-5 py-2 text-sm font-medium text-white">Reload page</button>} /></main>;
  }
}

function RouteFocus() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname === '/') return;
    requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>('main h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      window.scrollTo({ top: 0 });
    });
  }, [location.pathname]);
  return null;
}

function UserMenu() {
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return <Popover label="Account menu" align="end" sideOffset={8} open={open} onOpenChange={setOpen} className="z-[1100] w-60 rounded-md bg-white p-1 shadow-lg" buttonClassName="flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1 pr-3 pl-1 text-sm hover:border-stone-400" button={<>
    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-forest text-xs font-semibold text-white">{user.name[0]}</span>
    <span className="hidden max-w-[140px] truncate font-medium sm:inline">{user.name}</span>
  </>}>
    <div className="px-2 py-1.5"><div className="truncate text-sm font-semibold">{user.email}</div><div className="eyebrow mt-1">{user.role === 'operator' ? 'host' : 'guest'}</div></div>
    <div className="-mx-1 my-1 h-px bg-stone-100" />
    <button type="button" onClick={async () => { setOpen(false); await api('/auth/logout', { method: 'POST' }); await refresh(); void navigate('/'); }} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-mist hover:text-forest"><LogOut className="h-4 w-4" aria-hidden="true" /> Sign out</button>
  </Popover>;
}

function Header() {
  const { user, isHost, loading, setSignInOpen } = useSession();
  const { pathname, search } = useLocation();
  const exploreSearch = pathname === '/' || pathname.startsWith('/rooms/') || pathname.startsWith('/buildings/') ? search : '';
  const nav = [{ to: `/${exploreSearch}`, label: 'Explore', end: true }, { to: '/bookings', label: 'My bookings' }, ...(isHost ? [{ to: '/host', label: 'Host dashboard' }] : [])];
  return <header className="sticky top-0 z-[1000] border-b border-stone-200 bg-ivory/90 backdrop-blur-md">
    <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6">
      <Link to={`/${exploreSearch}`} aria-label="Odas home" className="font-serif text-[28px] font-semibold tracking-tight text-stone-900">Odas</Link>
      <nav aria-label="Main navigation" className="hidden items-center gap-1 md:flex">
        {nav.map(item => <NavLink key={item.label} to={item.to} end={item.end} className={({ isActive }) => `rounded-full px-4 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-mist text-forest' : 'text-stone-600 hover:text-stone-900'}`}>{item.label}</NavLink>)}
      </nav>
      <div className="relative flex items-center gap-2">
        <ConciergePanel />
        {loading ? <span className="h-9 w-24" /> : user ? <UserMenu /> : <button onClick={() => setSignInOpen(true)} className="rounded-full bg-forest px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-forest-dark">Sign in</button>}
      </div>
    </div>
    <nav aria-label="Main navigation" className="flex border-t border-stone-200 md:hidden">
      {nav.map(item => <NavLink key={item.label} to={item.to} end={item.end} className={({ isActive }) => `flex-1 py-2.5 text-center text-xs font-medium ${isActive ? 'border-b-2 border-forest text-forest' : 'text-stone-500'}`}>{item.label}</NavLink>)}
    </nav>
  </header>;
}

function Redirect({ to }: { to: (id: string) => string }) {
  const { id = '' } = useParams();
  const { search } = useLocation();
  return <Navigate replace to={`${to(id)}${search}`} />;
}

export default function App() {
  return <ErrorBoundary>
    <a className="skip-link" href="#content">Skip to content</a>
    <Header />
    <div id="content">
      <RouteFocus />
      <Routes>
        <Route path="/" element={<ExplorePage />} />
        <Route path="/buildings/:id" element={<BuildingPage />} />
        <Route path="/rooms/:id" element={<RoomPage />} />
        <Route path="/bookings" element={<BookingsPage />} />
        <Route path="/bookings/:id" element={<BookingPage />} />
        <Route path="/host" element={<HostPage />} />
        <Route path="/host/listings/:id" element={<ListingEditorPage />} />
        <Route path="/host/rooms/:id/monitor" element={<RoomMonitorPage />} />
        <Route path="/demo" element={<RoomMonitorPage />} />
        <Route path="/demo/rooms/:id" element={<RoomMonitorPage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/signup" element={<AuthPage />} />
        <Route path="/offices/:id" element={<Redirect to={id => `/rooms/${id}`} />} />
        <Route path="/workspaces/:id" element={<Redirect to={id => `/buildings/${id}`} />} />
        <Route path="/reservations" element={<Navigate replace to="/bookings" />} />
        <Route path="/reservations/:id" element={<Redirect to={id => `/bookings/${id}`} />} />
        <Route path="/operator/*" element={<Navigate replace to="/host" />} />
        <Route path="*" element={<main className="mx-auto max-w-xl px-4 py-16"><EmptyState title="This room isn't here." text="We couldn't find that page." action={<Link to="/" className="rounded-full bg-forest px-5 py-2 text-sm font-medium text-white">Explore spaces</Link>} /></main>} />
      </Routes>
    </div>
    <SignInDialog />
    <Toaster />
  </ErrorBoundary>;
}
