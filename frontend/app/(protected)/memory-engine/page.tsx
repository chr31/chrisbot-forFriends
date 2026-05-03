'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleStackIcon, SparklesIcon } from '@heroicons/react/24/outline';

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

type MemoryPacket = {
  enabled?: boolean;
  scope?: string;
  agent_id?: number | null;
  skipped_reason?: string | null;
  contextText?: string;
  warnings?: string[];
  request?: {
    summary?: string;
    topics?: Array<string | { name?: string; key?: string; category?: string }>;
  };
  process?: {
    user_key?: string | null;
    agent?: string | number | null;
    request?: string;
    request_summary?: string;
    topics?: Array<string | { name?: string; key?: string; category?: string }>;
    tool_sequence?: string[];
    status?: string;
    reusable_info?: string[];
  };
  retrieval?: {
    request_summary?: string | null;
    topics?: Array<string | { name?: string; key?: string; category?: string }>;
    candidate_count?: number;
    selected_ids?: string[];
    embedding_provider?: string | null;
    embedding_model?: string | null;
    embedding_error?: string | null;
  };
  embedding?: {
    provider?: string;
    model?: string;
    saved_items?: number;
    unchanged_items?: number;
    updated_items?: number;
  };
  episodes?: {
    saved?: number;
    tools?: number;
  };
};

type MemoryItem = {
  id: string;
  user: string;
  agent: string;
  topic: string;
  information: string;
};

type MemoryResponse = {
  action: 'getMemories' | 'setMemories';
  prompt: string;
  packet: MemoryPacket;
  items: MemoryItem[];
};

function getStatusLabel(packet: MemoryPacket | null) {
  if (!packet) return 'In attesa';
  if (packet.enabled === false) return `Non eseguito: ${packet.skipped_reason || 'disabilitato'}`;
  if (packet.skipped_reason) return `Eseguito: ${packet.skipped_reason}`;
  return 'Eseguito';
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function getPacketRequestSummary(packet: MemoryPacket | null) {
  return displayValue(
    packet?.request?.summary
      || packet?.retrieval?.request_summary
      || packet?.process?.request_summary
      || ''
  );
}

function getPacketTopics(packet: MemoryPacket | null) {
  const topics = packet?.request?.topics || packet?.retrieval?.topics || packet?.process?.topics || [];
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => (typeof topic === 'string' ? topic : topic?.name || topic?.key || topic?.category || ''))
    .map((topic) => topic.trim())
    .filter(Boolean)
    .join(', ');
}

function getPacketMetric(packet: MemoryPacket | null) {
  if (!packet) return '';
  const parts = [
    typeof packet.retrieval?.candidate_count === 'number' ? `candidate ${packet.retrieval.candidate_count}` : '',
    typeof packet.embedding?.saved_items === 'number' ? `salvate ${packet.embedding.saved_items}` : '',
    typeof packet.embedding?.updated_items === 'number' ? `aggiornate ${packet.embedding.updated_items}` : '',
    typeof packet.embedding?.unchanged_items === 'number' ? `immutate ${packet.embedding.unchanged_items}` : '',
    typeof packet.episodes?.saved === 'number' ? `episodi ${packet.episodes.saved}` : '',
  ].filter(Boolean);
  return parts.join(' - ');
}

export default function MemoryEnginePage() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [lastPacket, setLastPacket] = useState<MemoryPacket | null>(null);
  const [lastAction, setLastAction] = useState<MemoryResponse['action'] | null>(null);
  const [isRunning, setIsRunning] = useState<MemoryResponse['action'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const authFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = localStorage.getItem('authToken');
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(input, { ...init, headers });
  }, []);

  useEffect(() => {
    const fetchAuthUser = async () => {
      try {
        const response = await authFetch('/api/auth/me');
        const body = await response.json().catch(() => ({}));
        setAuthUser(body?.user || null);
      } catch (_) {
        setAuthUser(null);
      } finally {
        setIsLoadingUser(false);
      }
    };
    fetchAuthUser();
  }, [authFetch]);

  const canRun = useMemo(() => Boolean(prompt.trim()) && !isRunning, [prompt, isRunning]);

  const runMemoryAction = async (action: MemoryResponse['action']) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setIsRunning(action);
    setError(null);
    try {
      const endpoint = action === 'getMemories' ? '/api/memory-engine/get' : '/api/memory-engine/set';
      const response = await authFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ prompt: cleanPrompt }),
      });
      const body = await response.json().catch(() => ({})) as Partial<MemoryResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(body?.error || 'Operazione Memory Engine non riuscita.');
      }
      setItems(Array.isArray(body.items) ? body.items : []);
      setLastPacket(body.packet || null);
      setLastAction(action);
    } catch (err: any) {
      setError(err?.message || 'Errore durante il test Memory Engine.');
    } finally {
      setIsRunning(null);
    }
  };

  if (!isLoadingUser && authUser && !authUser.is_super_admin) {
    return <div className="p-8 text-white">Accesso riservato agli amministratori.</div>;
  }

  return (
    <div className="py-6 sm:py-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-normal text-sky-300">Memory Engine</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Memory engine access</h1>
              <p className="mt-2 max-w-3xl text-sm text-gray-300">
                Console admin per verificare utente, agente, argomento e informazione salvata o recuperata.
              </p>
            </div>
            <div className="rounded-2xl border border-gray-800 bg-gray-950/70 px-4 py-3 text-sm text-gray-300">
              <div className="flex items-center gap-2">
                <CircleStackIcon className="h-5 w-5 text-sky-300" />
                <span>{getStatusLabel(lastPacket)}</span>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-start">
            <div className="min-h-12 flex-1 rounded-2xl border border-gray-800 bg-gray-950/70 px-4 py-3 focus-within:border-sky-600">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                placeholder="Scrivi un prompt per cercare o proporre memorie..."
                className="min-h-16 w-full resize-y bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
              />
            </div>
            <div className="flex shrink-0 flex-row gap-3 lg:flex-col">
              <button
                type="button"
                onClick={() => runMemoryAction('getMemories')}
                disabled={!canRun}
                className="inline-flex h-11 min-w-32 items-center justify-center gap-2 rounded-xl border border-sky-700/60 bg-sky-600/10 px-4 text-sm font-semibold text-sky-100 hover:bg-sky-600/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CircleStackIcon className="h-5 w-5" />
                {isRunning === 'getMemories' ? 'get...' : 'getMemories'}
              </button>
              <button
                type="button"
                onClick={() => runMemoryAction('setMemories')}
                disabled={!canRun}
                className="inline-flex h-11 min-w-32 items-center justify-center gap-2 rounded-xl border border-emerald-700/60 bg-emerald-600/10 px-4 text-sm font-semibold text-emerald-100 hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SparklesIcon className="h-5 w-5" />
                {isRunning === 'setMemories' ? 'set...' : 'setMemories'}
              </button>
            </div>
          </div>

          {error ? (
            <div className="mt-6 rounded-xl border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">{error}</div>
          ) : null}

          {lastPacket ? (
            <div className="mt-6 grid gap-3 text-sm md:grid-cols-2">
              <div className="border-b border-gray-800 pb-3">
                <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Richiesta</p>
                <p className="mt-1 text-gray-200">{getPacketRequestSummary(lastPacket) || 'n/d'}</p>
              </div>
              <div className="border-b border-gray-800 pb-3">
                <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Argomenti</p>
                <p className="mt-1 text-gray-200">{getPacketTopics(lastPacket) || 'n/d'}</p>
              </div>
              <div className="border-b border-gray-800 pb-3">
                <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Metriche</p>
                <p className="mt-1 text-gray-200">{getPacketMetric(lastPacket) || 'n/d'}</p>
              </div>
              <div className="border-b border-gray-800 pb-3">
                <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Warning</p>
                <p className="mt-1 whitespace-pre-wrap text-gray-200">
                  {Array.isArray(lastPacket.warnings) && lastPacket.warnings.length > 0
                    ? lastPacket.warnings.join('\n')
                    : 'nessuno'}
                </p>
              </div>
              {String(lastPacket.contextText || '').trim() ? (
                <div className="md:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">ContextText iniettato</p>
                  <p className="mt-1 whitespace-pre-wrap text-gray-200">{String(lastPacket.contextText).trim()}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 overflow-x-auto rounded-2xl border border-gray-800 bg-gray-950/70">
            <table className="min-w-full divide-y divide-gray-800 text-sm">
              <thead className="bg-gray-950/90 text-left text-xs uppercase tracking-normal text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold">Agente</th>
                  <th className="px-4 py-3 font-semibold">Argomento</th>
                  <th className="px-4 py-3 font-semibold">Informazione</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-5 text-sm text-gray-400">
                      Nessuna memoria da mostrare.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="align-top text-gray-200">
                      <td className="px-4 py-3">
                        <input
                          readOnly
                          value={item.user}
                          className="w-40 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-200 outline-none"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          readOnly
                          value={item.agent}
                          className="w-44 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-200 outline-none"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          readOnly
                          value={item.topic}
                          className="w-52 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-200 outline-none"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <textarea
                          readOnly
                          value={item.information}
                          rows={2}
                          className="min-h-12 w-[34rem] resize-y rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-200 outline-none"
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {lastPacket ? (
            <div className="mt-4 grid gap-3 text-xs text-gray-400 sm:grid-cols-3">
              <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
                Enabled: {String(Boolean(lastPacket.enabled))}
              </div>
              <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
                Scope: {lastPacket.scope || 'shared'}
              </div>
              <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
                Skipped: {lastPacket.skipped_reason || 'no'}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
