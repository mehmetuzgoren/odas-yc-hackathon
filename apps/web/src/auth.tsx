import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { api, useSession } from './api';
import { Loading, Modal, Notice } from './ui';

const input = 'h-11 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-900 outline-none transition-colors focus:border-forest';

export function AuthForm({ initial = 'login', onDone }: { initial?: 'login' | 'signup'; onDone?: () => void }) {
  const { refresh } = useSession();
  const [mode, setMode] = useState(initial);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signup = mode === 'signup';
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify({ email, password, ...(signup ? { name } : {}) }) });
      await refresh();
      onDone?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-4">
    {error && <Notice tone="error">{error}</Notice>}
    {signup && <label className="flex flex-col gap-1"><span className="eyebrow">Your name</span><input name="name" autoComplete="name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} className={input} /></label>}
    <label className="flex flex-col gap-1"><span className="eyebrow">Email</span><input name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} className={input} /></label>
    <label className="flex flex-col gap-1"><span className="eyebrow">Password</span><input name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 12 : undefined} maxLength={200} required value={password} onChange={event => setPassword(event.target.value)} className={input} />{signup && <span className="text-xs text-stone-500">Use at least 12 characters.</span>}</label>
    <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-forest px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-forest-dark disabled:opacity-50">
      {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}{signup ? 'Create account' : 'Sign in'}
    </button>
    <p className="text-xs text-stone-500">{signup ? 'Already have an account?' : 'New to Odas?'} <button type="button" onClick={() => { setMode(signup ? 'login' : 'signup'); setError(''); }} className="font-medium text-forest underline underline-offset-4">{signup ? 'Sign in' : 'Create an account'}</button></p>
  </form>;
}

export function SignInDialog() {
  const { signInOpen, setSignInOpen } = useSession();
  return <Modal open={signInOpen} onClose={() => setSignInOpen(false)} className="max-w-md" title="Sign in to Odas" description="Reserve rooms by the hour or manage your spaces.">
    {signInOpen && <AuthForm onDone={() => setSignInOpen(false)} />}
  </Modal>;
}

export function RequireAuth({ title = 'Sign in to continue', children }: { title?: string; children: ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <Loading />;
  if (user) return <>{children}</>;
  return <div className="mx-auto max-w-md px-4 py-16">
    <h1 className="font-serif text-3xl text-stone-900">{title}</h1>
    <p className="mt-2 mb-6 text-sm text-stone-500">Use your Odas email and password.</p>
    <AuthForm />
  </div>;
}

export function AuthPage() {
  const { user } = useSession();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const proposed = params.get('returnTo') || params.get('next') || '/bookings';
  const returnTo = proposed.startsWith('/') && !proposed.startsWith('//') && !proposed.includes('\\') ? proposed : '/bookings';
  useEffect(() => { if (user) void navigate(returnTo, { replace: true }); }, [user, navigate, returnTo]);
  return <main className="mx-auto max-w-md px-4 py-16">
    <h1 className="font-serif text-3xl text-stone-900">{pathname === '/signup' ? 'Create your account' : 'Sign in to Odas'}</h1>
    <p className="mt-2 mb-6 text-sm text-stone-500">Reserve rooms by the hour or manage your spaces.</p>
    <AuthForm initial={pathname === '/signup' ? 'signup' : 'login'} />
  </main>;
}
