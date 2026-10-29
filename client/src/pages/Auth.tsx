import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, loadSession, type Session } from '../api';
import { Alert, errorText, toast } from '../ui';

export function VerifyEmail({ onSession }: { onSession: (session: Session) => void }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (token.length < 10) {
      setError('This confirmation link is missing its token.');
      return;
    }
    let cancelled = false;
    api<{ emailVerified: boolean }>('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) })
      .then(async () => {
        const stored = loadSession();
        if (stored) {
          const current = await api<{ id: string; role: string; displayName: string; emailVerified: boolean; rating: number }>('/api/me');
          onSession({ ...stored, user: { id: current.id, role: current.role, displayName: current.displayName, emailVerified: true, rating: current.rating } });
        }
        if (!cancelled) {
          toast('Email confirmed', 'ok');
          navigate('/arena');
        }
      })
      .catch((err) => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [token, navigate, onSession]);

  return (
    <div className="page narrow">
      <div className="auth-card">
        <h1>Confirm your email</h1>
        {error ? <Alert>{error}</Alert> : <p className="muted">Checking the link…</p>}
      </div>
    </div>
  );
}

export function Auth({ onSession }: { onSession: (session: Session) => void }) {
  const pending = loadSession();
  const [mode, setMode] = useState<'login' | 'register' | 'verify'>(pending?.user.emailVerified === false ? 'verify' : 'login');
  const [token, setToken] = useState('');
  const [mailed, setMailed] = useState(true);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (mode !== 'verify' || email) return;
    api<{ email: string }>('/api/me').then((me) => setEmail(me.email)).catch(() => {});
  }, [mode, email]);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/arena';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const result = await api<Session & { verifyToken?: string; mailed?: boolean }>(path, {
        method: 'POST',
        body: JSON.stringify(mode === 'login' ? { email, password } : { email, password, displayName }),
      });
      const { verifyToken: shown, mailed: didMail, ...session } = result;
      onSession(session);
      if (session.user.emailVerified === false) {
        setMailed(didMail !== false);
        setToken(didMail === false ? shown ?? '' : '');
        setMode('verify');
        toast(didMail === false ? 'Mail is not configured, so the token is shown here' : 'Check your inbox to confirm your email', 'warn');
        return;
      }
      toast(`Welcome${session.user.displayName ? `, ${session.user.displayName}` : ''}`, 'ok');
      navigate(from);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
      const current = await api<{ id: string; role: string; displayName: string; emailVerified: boolean; rating: number }>('/api/me');
      const stored = loadSession();
      if (stored) onSession({ ...stored, user: { id: current.id, role: current.role, displayName: current.displayName, emailVerified: true, rating: current.rating } });
      toast('Email confirmed', 'ok');
      navigate(from);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <div className="auth-card">
        {mode === 'verify' ? (
          <>
            <h1>Enter your code</h1>
            <p className="muted small">
              {mailed
                ? `A 6-digit code was sent to ${email || 'your email'}. It expires in 15 minutes.`
                : 'Mail could not be sent from this machine, so the code is shown here.'}
            </p>
            <form onSubmit={confirm}>
              <label htmlFor="token">Confirmation code</label>
              <input id="token" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={token} onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))} required placeholder="000000" />
              {pending ? (
                <button className="btn" type="button" disabled={busy || cooldown > 0} style={{ marginTop: 'var(--space-3)' }} onClick={() => {
                  setBusy(true);
                  api<{ mailed?: boolean; verifyToken?: string }>('/api/auth/verify/resend', { method: 'POST', body: '{}' })
                    .then((sent) => {
                      setMailed(sent.mailed !== false);
                      if (sent.mailed === false) setToken(sent.verifyToken ?? '');
                      setCooldown(60);
                      toast('Confirmation email sent again', 'ok');
                    })
                    .catch((err) => setError(errorText(err)))
                    .finally(() => setBusy(false));
                }}>{cooldown > 0 ? `resend in ${cooldown}s` : 'resend email'}</button>
              ) : null}
              {error ? <Alert>{error}</Alert> : null}
              <button className="btn primary lg" type="submit" disabled={busy || token.length !== 6} style={{ width: '100%', marginTop: 'var(--space-4)' }}>
                {busy ? 'please wait…' : 'Confirm email'} <ArrowRight size={16} />
              </button>
            </form>
          </>
        ) : null}
        {mode === 'verify' ? null : (<>
        <div className="segmented" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setError(''); }}>sign in</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setError(''); }}>create account</button>
        </div>
        <h1>{mode === 'login' ? 'Welcome back' : 'Join CodeClash'}</h1>
        <p className="muted small">{mode === 'login' ? 'Sign in to reserve seats and submit.' : 'One account, one seat per contest.'}</p>
        <form onSubmit={submit}>
          {mode === 'register' ? (
            <>
              <label htmlFor="name">Display name</label>
              <input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={40} autoComplete="nickname" placeholder="shown on the standings" />
            </>
          ) : null}
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus placeholder="you@example.com" />
          <label htmlFor="password">Password</label>
          <div className="password">
            <input
              id="password"
              type={reveal ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            <button type="button" className="btn ghost icon sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide password' : 'Show password'}>
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {mode === 'register' ? <p className="hint">At least 8 characters.</p> : null}
          <div style={{ marginTop: 'var(--space-5)' }}>{error ? <Alert>{error}</Alert> : null}</div>
          <button className="btn primary lg" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={16} />
          </button>
        </form>
        {import.meta.env.DEV ? (
          <div className="demo">
            local demo admin: <code>admin@codeclash.local</code> / <code>codeclash</code>{' '}
            <button type="button" className="btn ghost sm" onClick={() => { setMode('login'); setEmail('admin@codeclash.local'); setPassword('codeclash'); }}>fill in</button>
          </div>
        ) : null}
        </>)}
      </div>
    </div>
  );
}
