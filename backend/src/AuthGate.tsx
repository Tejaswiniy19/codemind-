import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import './AuthGate.css';

type AuthMode = 'checking' | 'setup' | 'login' | 'authenticated' | 'unavailable';

type AuthGateProps = {
  children: (session: { csrfToken: string; logout: () => Promise<void>; username: string }) => React.ReactNode;
};

const API_ROOT = '/api/auth';

export default function AuthGate({ children }: AuthGateProps) {
  const [mode, setMode] = useState<AuthMode>('checking');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function restoreSession() {
      try {
        const statusResponse = await fetch(`${API_ROOT}/status`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        const status = await readJson(statusResponse);
        if (!statusResponse.ok) throw new Error(detailMessage(status, 'Could not read the authentication status.'));
        if (typeof status.setup_required !== 'boolean') {
          throw new Error('The authentication status response is incomplete.');
        }

        const sessionResponse = await fetch(`${API_ROOT}/session`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (sessionResponse.ok) {
          const sessionData = await readJson(sessionResponse);
          const token = readCsrfToken(sessionData);
          if (token) {
            setUsername(typeof sessionData.username === 'string' ? sessionData.username : '');
            setCsrfToken(token);
            setMode('authenticated');
            return;
          }
        }

        if (status.setup_required) {
          setMode('setup');
          return;
        }

        if (typeof status.admin_username === 'string' && status.admin_username) {
          setUsername(status.admin_username);
        }
        setMode('login');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Could not connect to the authentication service.');
        setMode('unavailable');
      }
    }
    void restoreSession();
    return () => controller.abort();
  }, []);

  const logout = useCallback(async () => {
    if (!csrfToken) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_ROOT}/logout`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
      });
      if (!response.ok) {
        const payload = await readJson(response);
        throw new Error(detailMessage(payload, 'Could not sign out.'));
      }
      setCsrfToken(null);
      setPassword('');
      setConfirmPassword('');
      setMode('login');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign out.');
    } finally {
      setBusy(false);
    }
  }, [csrfToken]);

  async function quickLaunch() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_ROOT}/quick-demo`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(detailMessage(payload, 'Could not start workspace session.'));
      const token = readCsrfToken(payload);
      if (!token) throw new Error('The session response did not include a CSRF token.');
      setCsrfToken(token);
      setUsername(typeof payload.username === 'string' ? payload.username : 'workspace-admin');
      setPassword('');
      setConfirmPassword('');
      setMode('authenticated');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not launch workspace.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'setup') {
      if (username.trim().length < 3) {
        setError('Choose an admin name with at least 3 characters.');
        return;
      }
      if (password.length < 8) {
        setError('Choose a password with at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('The passwords do not match.');
        return;
      }
    }
    setBusy(true);
    try {
      const setup = mode === 'setup';
      const response = await fetch(`${API_ROOT}/${setup ? 'setup' : 'login'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(detailMessage(payload, setup ? 'Could not finish the initial setup.' : 'Sign-in failed.'));
      }
      const token = readCsrfToken(payload);
      if (!token) throw new Error('The authentication response did not include a CSRF token.');
      setCsrfToken(token);
      setUsername(typeof payload.username === 'string' ? payload.username : username.trim());
      setPassword('');
      setConfirmPassword('');
      setMode('authenticated');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed. Check the API and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'authenticated' && csrfToken) {
    return <>{children({ csrfToken, logout, username })}</>;
  }

  return (
    <main className="content-wrap auth-gate" aria-busy={mode === 'checking' || busy}>
      <div className="eyebrow">
        <span className="eyebrow-line" /> PRIVATE WORKSPACE <span className="eyebrow-line" />
      </div>
      <header className="hero-title-wrap">
        <h1>
          CodeMind<span className="auth-title-accent"> AI</span>
        </h1>
        <p>Sign in to your self-hosted software intelligence workspace.</p>
      </header>

      {mode === 'checking' && (
        <section className="setup-card" role="status" aria-live="polite">
          <div className="feedback notice">
            <span className="spinner" /> Checking your workspace session…
          </div>
        </section>
      )}

      {mode === 'unavailable' && (
        <section className="setup-card" aria-labelledby="auth-unavailable-title">
          <div className="setup-header">
            <div>
              <div className="section-kicker">WORKSPACE CONNECTION</div>
              <h2 id="auth-unavailable-title">Authentication is unavailable</h2>
              <p>Check that the CodeMind API is running and try again.</p>
            </div>
          </div>
          <div className="feedback error" role="alert">
            <X size={15} />
            {error}
          </div>
          <button className="button secondary" type="button" onClick={() => window.location.reload()}>
            Try again <ArrowRight size={15} />
          </button>
        </section>
      )}

      {(mode === 'setup' || mode === 'login') && (
        <section className="setup-card" aria-labelledby="auth-form-title">
          <div className="setup-header">
            <div>
              <div className="section-kicker">
                {mode === 'setup' ? 'FIRST-RUN ADMIN SETUP' : 'ADMINISTRATOR SIGN-IN'}
              </div>
              <h2 id="auth-form-title">{mode === 'setup' ? 'Secure your workspace' : 'Welcome back'}</h2>
              <p>
                {mode === 'setup'
                  ? 'Create a local administrator account or quick-launch the workspace.'
                  : 'Use your local administrator credentials or quick-launch.'}
              </p>
            </div>
            <div className="step-mark">
              <LockKeyhole size={15} /> PRIVATE
            </div>
          </div>

          <form onSubmit={submit} noValidate>
            <div className="auth-field">
              <label htmlFor="auth-username">ADMIN NAME</label>
              <div className="auth-input-wrap">
                <UserRound size={15} aria-hidden="true" />
                <input
                  id="auth-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="workspace-admin"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  minLength={3}
                  maxLength={64}
                  required
                />
              </div>
            </div>
            <div className="auth-field">
              <label htmlFor="auth-password">PASSWORD</label>
              <div className="auth-input-wrap">
                <LockKeyhole size={15} aria-hidden="true" />
                <input
                  id="auth-password"
                  name="password"
                  type="password"
                  autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                  placeholder={mode === 'setup' ? 'At least 8 characters' : 'Enter password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={mode === 'setup' ? 8 : 1}
                  maxLength={1024}
                  required
                />
              </div>
            </div>
            {mode === 'setup' && (
              <div className="auth-field">
                <label htmlFor="auth-confirm-password">CONFIRM PASSWORD</label>
                <div className="auth-input-wrap">
                  <LockKeyhole size={15} aria-hidden="true" />
                  <input
                    id="auth-confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Repeat password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    minLength={8}
                    maxLength={1024}
                    required
                  />
                </div>
              </div>
            )}
            {error && (
              <div className="feedback error" role="alert">
                <X size={15} />
                {error}
              </div>
            )}
            <button
              className="button primary auth-submit"
              type="submit"
              disabled={busy || !username.trim() || !password || (mode === 'setup' && !confirmPassword)}
            >
              {busy ? (
                <>
                  <span className="spinner" /> {mode === 'setup' ? 'Setting up…' : 'Signing in…'}
                </>
              ) : (
                <>
                  {mode === 'setup' ? 'Create administrator account' : 'Sign in'} <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          <div className="auth-divider">OR</div>
          <button
            className="button secondary auth-quick-btn"
            type="button"
            disabled={busy}
            onClick={() => void quickLaunch()}
          >
            <Sparkles size={15} /> Quick Launch Local Workspace
          </button>

          <div className="auth-privacy">
            <ShieldCheck size={15} />
            <span>
              Your credentials stay on this server. Session protection is handled by a signed HttpOnly cookie and CSRF
              token.
            </span>
          </div>
        </section>
      )}
    </main>
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function detailMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.detail === 'string' ? payload.detail : fallback;
}

function readCsrfToken(payload: Record<string, unknown>): string | null {
  return typeof payload.csrf_token === 'string' && payload.csrf_token.length >= 32 ? payload.csrf_token : null;
}
