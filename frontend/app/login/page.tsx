'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

function decodeJwtPayload(token: string) {
  try {
    const part = token.split('.')[1] || '';
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [showLocalLogin, setShowLocalLogin] = useState(false);
  const [azureLoginEnabled, setAzureLoginEnabled] = useState(false);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmittingLocal, setIsSubmittingLocal] = useState(false);

  useEffect(() => {
    const query = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
    const authError = String(query.get('auth_error') || '').trim();
    const hash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
    if (!hash) {
      if (authError) {
        setError(decodeURIComponent(authError));
      }
      return;
    }

    const params = new URLSearchParams(hash);
    const accessToken = params.get('accessToken');
    if (!accessToken) return;

    localStorage.setItem('authToken', accessToken);
    const payload = decodeJwtPayload(accessToken);
    if (payload) {
      localStorage.setItem('authUser', JSON.stringify({
        name: payload.name || null,
        email: payload.email || null,
        groups: Array.isArray(payload.groups) ? payload.groups : [],
        is_super_admin: Boolean(payload.is_super_admin),
        auth_provider: payload.auth_provider || 'azure',
      }));
    }
    window.history.replaceState(null, '', '/login');
    router.replace('/agent-chat/new');
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      try {
        const response = await fetch('/api/auth/providers', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json();
        if (cancelled) return;
        setAzureLoginEnabled(Boolean(payload?.azure));
        setLocalLoginEnabled(Boolean(payload?.local));
        setSetupRequired(Boolean(payload?.setup_required));
        setShowLocalLogin(Boolean(payload?.setup_required));
      } catch {
        if (cancelled) return;
        setAzureLoginEnabled(false);
        setLocalLoginEnabled(false);
        setSetupRequired(false);
      }
    };

    loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAzureLogin = () => {
    window.location.href = '/api/auth/azure/start';
  };

  const handleLocalLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setIsSubmittingLocal(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Credenziali locali non valide.');
      }
      localStorage.setItem('authToken', body.accessToken);
      if (body.user) {
        localStorage.setItem('authUser', JSON.stringify(body.user));
      }
      router.replace('/agent-chat/new');
    } catch (err: any) {
      setError(err?.message || 'Errore durante il login locale.');
    } finally {
      setIsSubmittingLocal(false);
    }
  };

  const handleInitialSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setIsSubmittingLocal(true);
    try {
      const response = await fetch('/api/auth/setup-local-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Creazione account locale fallita.');
      }
      localStorage.setItem('authToken', body.accessToken);
      if (body.user) {
        localStorage.setItem('authUser', JSON.stringify(body.user));
      }
      router.replace('/agent-chat/new');
    } catch (err: any) {
      setError(err?.message || 'Errore durante la creazione dell’account locale.');
    } finally {
      setIsSubmittingLocal(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900 px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-gray-800 p-8 shadow-xl">
        <h1 className="text-center text-2xl font-bold text-white">Login</h1>
        {azureLoginEnabled ? (
          <div className="mt-8">
            <button
              type="button"
              onClick={handleAzureLogin}
              className="w-full rounded-xl bg-red-600 px-4 py-3 text-base font-bold text-white hover:bg-red-500"
            >
              Accedi con H-ACCOUNT
            </button>
          </div>
        ) : null}
        {localLoginEnabled ? (
          <div className={`${azureLoginEnabled ? 'mt-4' : 'mt-8'} text-center`}>
            <button
              type="button"
              onClick={() => setShowLocalLogin((current) => !current)}
              className="text-sm text-gray-400 underline-offset-4 hover:text-white hover:underline"
            >
              {showLocalLogin ? 'Nascondi login' : 'Login'}
            </button>
          </div>
        ) : null}
        {setupRequired ? (
          <div className="mt-8">
            <p className="text-center text-sm text-gray-300">
              Microsoft non e configurato e non esiste ancora un account locale. Crea ora l&apos;utente amministratore locale.
            </p>
          </div>
        ) : null}
        {(showLocalLogin && (localLoginEnabled || setupRequired)) ? (
          <form onSubmit={setupRequired ? handleInitialSetup : handleLocalLogin} className="mt-6 space-y-4">
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username"
              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-white"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-white"
              required
            />
            <button
              type="submit"
              disabled={isSubmittingLocal}
              className="w-full rounded-xl border border-gray-600 px-4 py-3 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-60"
            >
              {isSubmittingLocal ? (setupRequired ? 'Creazione...' : 'Accesso...') : (setupRequired ? 'Crea account locale' : 'Accedi localmente')}
            </button>
          </form>
        ) : null}
        {!azureLoginEnabled && !localLoginEnabled && !setupRequired ? (
          <p className="mt-8 text-center text-sm text-gray-400">
            Nessun metodo di accesso disponibile.
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 text-center text-sm text-red-300">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
