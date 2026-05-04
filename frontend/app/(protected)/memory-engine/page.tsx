'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowTopRightOnSquareIcon, CircleStackIcon, SparklesIcon } from '@heroicons/react/24/outline';

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

type AgentOption = {
  id: number;
  name: string;
  slug?: string;
  kind?: string;
  is_active?: boolean;
  memory_engine_enabled?: boolean;
  memory_scope?: 'shared' | 'dedicated';
};

type SettingsPayload = {
  memory_engine?: {
    neo4j_browser_url?: string;
  };
  control_engine?: {
    enabled?: boolean;
    execution_enabled?: boolean;
  };
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
  status?: 'added' | 'updated' | 'deleted' | 'unchanged';
};

type ProcessLogStep = {
  id: string;
  title: string;
  status: 'completed' | 'skipped' | 'warning' | 'error';
  description: string;
  details?: unknown;
};

type MemoryResponse = {
  action: 'getMemories' | 'setMemories';
  prompt: string;
  packet: MemoryPacket;
  items: MemoryItem[];
  process_log?: ProcessLogStep[];
  generated_answer?: {
    text?: string;
    provider?: string | null;
    model?: string | null;
    skipped_reason?: string;
    error?: string;
  };
};

type EngineTab = 'memory' | 'control';
type ControlAction = 'retrieveInfo' | 'updateSchema' | 'executeAction';
type ControlResult = {
  ok?: boolean;
  tool?: string;
  result?: any;
  error?: string;
};

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

function getItemStatusLabel(status?: MemoryItem['status']) {
  if (status === 'added') return 'aggiunta';
  if (status === 'updated') return 'modificata';
  if (status === 'deleted') return 'eliminata';
  if (status === 'unchanged') return 'immutata';
  return '';
}

function getItemStatusClass(status?: MemoryItem['status']) {
  if (status === 'added') return 'border-emerald-700/70 bg-emerald-950/40 text-emerald-200';
  if (status === 'updated') return 'border-amber-700/70 bg-amber-950/40 text-amber-200';
  if (status === 'deleted') return 'border-rose-700/70 bg-rose-950/40 text-rose-200';
  return 'border-gray-800 bg-gray-900 text-gray-300';
}

function getLogStatusLabel(status: ProcessLogStep['status']) {
  if (status === 'completed') return 'ok';
  if (status === 'skipped') return 'skip';
  if (status === 'warning') return 'warning';
  return 'error';
}

function getLogStatusClass(status: ProcessLogStep['status']) {
  if (status === 'completed') return 'border-emerald-700/70 bg-emerald-950/40 text-emerald-200';
  if (status === 'skipped') return 'border-gray-700 bg-gray-900 text-gray-300';
  if (status === 'warning') return 'border-amber-700/70 bg-amber-950/40 text-amber-200';
  return 'border-rose-700/70 bg-rose-950/40 text-rose-200';
}

function formatDetails(details: unknown) {
  if (!details) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch (_) {
    return String(details);
  }
}

export default function MemoryEnginePage() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [neo4jBrowserUrl, setNeo4jBrowserUrl] = useState('');
  const [activeEngineTab, setActiveEngineTab] = useState<EngineTab>('memory');
  const [controlEnabled, setControlEnabled] = useState(false);
  const [controlExecutionEnabled, setControlExecutionEnabled] = useState(false);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [controlPayload, setControlPayload] = useState('');
  const [controlResult, setControlResult] = useState<ControlResult | null>(null);
  const [controlAction, setControlAction] = useState<ControlAction | null>(null);
  const [memoryScope, setMemoryScope] = useState<'shared' | 'dedicated'>('shared');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [lastPacket, setLastPacket] = useState<MemoryPacket | null>(null);
  const [lastAction, setLastAction] = useState<MemoryResponse['action'] | null>(null);
  const [generatedAnswer, setGeneratedAnswer] = useState<MemoryResponse['generated_answer'] | null>(null);
  const [processLog, setProcessLog] = useState<ProcessLogStep[]>([]);
  const [isRunning, setIsRunning] = useState<MemoryResponse['action'] | null>(null);
  const [isControlRunning, setIsControlRunning] = useState<ControlAction | null>(null);
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
        if (body?.user?.is_super_admin) {
          const [agentsResponse, settingsResponse] = await Promise.all([
            authFetch('/api/agents'),
            authFetch('/api/settings'),
          ]);
          const agentsBody = await agentsResponse.json().catch(() => []);
          if (agentsResponse.ok && Array.isArray(agentsBody)) {
            const activeAgents = agentsBody.filter((agent) => agent?.id && agent?.is_active !== false);
            setAgents(activeAgents);
            if (activeAgents[0]?.id) setSelectedAgentId(String(activeAgents[0].id));
          }
          if (settingsResponse.ok) {
            const settingsBody = await settingsResponse.json().catch(() => ({})) as SettingsPayload;
            setNeo4jBrowserUrl(String(settingsBody.memory_engine?.neo4j_browser_url || '').trim());
            setControlEnabled(Boolean(settingsBody.control_engine?.enabled));
            setControlExecutionEnabled(Boolean(settingsBody.control_engine?.execution_enabled));
          }
        }
      } catch (_) {
        setAuthUser(null);
      } finally {
        setIsLoadingUser(false);
      }
    };
    fetchAuthUser();
  }, [authFetch]);

  const canRun = useMemo(
    () => Boolean(prompt.trim()) && !isRunning && (memoryScope === 'shared' || Boolean(selectedAgentId)),
    [prompt, isRunning, memoryScope, selectedAgentId]
  );
  const canRunControl = useMemo(
    () => Boolean(prompt.trim() || controlPayload.trim()) && !isControlRunning && controlEnabled,
    [prompt, controlPayload, isControlRunning, controlEnabled]
  );

  const runMemoryAction = async (action: MemoryResponse['action']) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setIsRunning(action);
    setError(null);
    try {
      const endpoint = action === 'getMemories' ? '/api/memory-engine/get' : '/api/memory-engine/set';
      const response = await authFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          prompt: cleanPrompt,
          scope: memoryScope,
          agent_id: memoryScope === 'dedicated' ? selectedAgentId : null,
        }),
      });
      const body = await response.json().catch(() => ({})) as Partial<MemoryResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(body?.error || 'Operazione Memory Engine non riuscita.');
      }
      setItems(Array.isArray(body.items) ? body.items : []);
      setLastPacket(body.packet || null);
      setGeneratedAnswer(body.generated_answer || null);
      setProcessLog(Array.isArray(body.process_log) ? body.process_log : []);
      setLastAction(action);
    } catch (err: any) {
      setError(err?.message || 'Errore durante il test Memory Engine.');
    } finally {
      setIsRunning(null);
    }
  };

  const parseControlPayload = () => {
    const cleanPayload = controlPayload.trim();
    if (!cleanPayload) return {};
    try {
      return JSON.parse(cleanPayload);
    } catch (error: any) {
      throw new Error(`JSON Control Engine non valido: ${error?.message || error}`);
    }
  };

  const runControlAction = async (action: ControlAction) => {
    setIsControlRunning(action);
    setError(null);
    setControlResult(null);
    try {
      const extraPayload = parseControlPayload();
      const endpoint = action === 'retrieveInfo'
        ? '/api/control-engine/retrieve'
        : action === 'updateSchema'
          ? '/api/control-engine/schema'
          : '/api/control-engine/execute';
      const response = await authFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          query: prompt.trim(),
          instruction: prompt.trim(),
          dry_run: false,
          ...extraPayload,
        }),
      });
      const body = await response.json().catch(() => ({})) as ControlResult;
      if (!response.ok) throw new Error(body?.error || 'Operazione Control Engine non riuscita.');
      setControlResult(body);
      setControlAction(action);
    } catch (err: any) {
      setError(err?.message || 'Errore durante il test Control Engine.');
    } finally {
      setIsControlRunning(null);
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
              <p className="text-xs font-semibold uppercase tracking-normal text-sky-300">Engine monitor</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Graph engine access</h1>
              <p className="mt-2 max-w-3xl text-sm text-gray-300">
                Console admin per recuperare, aggiornare e verificare i grafi Memory Engine e Control Engine.
              </p>
            </div>
            <a
              href={neo4jBrowserUrl || '#'}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!neo4jBrowserUrl}
              className={`inline-flex h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold ${
                neo4jBrowserUrl
                  ? 'border-sky-700/60 bg-sky-600/10 text-sky-100 hover:bg-sky-600/20'
                  : 'pointer-events-none border-gray-800 bg-gray-950/60 text-gray-500'
              }`}
              title={neo4jBrowserUrl ? 'Apri Neo4j Browser' : 'URL pagina web Neo4j non configurato'}
            >
              <ArrowTopRightOnSquareIcon className="h-5 w-5" />
              Neo4j Browser
            </a>
          </div>

          <div className="mt-5 inline-flex rounded-xl border border-gray-800 bg-gray-950 p-1">
            {[
              { id: 'memory' as const, label: 'Memory Engine' },
              { id: 'control' as const, label: 'Control Engine' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveEngineTab(tab.id)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                  activeEngineTab === tab.id
                    ? 'bg-sky-600 text-white'
                    : 'text-gray-300 hover:bg-gray-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="mt-5 space-y-3">
            {activeEngineTab === 'memory' ? (
              <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-normal text-gray-500">
                Scope
                <select
                  value={memoryScope}
                  onChange={(event) => setMemoryScope(event.target.value as 'shared' | 'dedicated')}
                  className="mt-1 h-11 w-full rounded-xl border border-gray-800 bg-gray-950 px-3 text-sm normal-case text-white outline-none focus:border-sky-600"
                >
                  <option value="shared">Memorie condivise</option>
                  <option value="dedicated">Memorie agente</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-normal text-gray-500">
                Agente
                <select
                  value={selectedAgentId}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                  disabled={memoryScope !== 'dedicated' || agents.length === 0}
                  className="mt-1 h-11 w-full rounded-xl border border-gray-800 bg-gray-950 px-3 text-sm normal-case text-white outline-none focus:border-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {agents.length === 0 ? (
                    <option value="">Nessun agente</option>
                  ) : (
                    agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              </div>
            ) : (
              <div className="grid gap-3 text-sm md:grid-cols-2">
                <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-4 py-3 text-gray-300">
                  Control Engine: {controlEnabled ? 'attivo' : 'disattivo'}
                </div>
                <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-4 py-3 text-gray-300">
                  Esecuzione azioni: {controlExecutionEnabled ? 'attiva' : 'disattiva'}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <div className="min-h-12 flex-1 rounded-2xl border border-gray-800 bg-gray-950/70 px-4 py-3 focus-within:border-sky-600">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                placeholder={activeEngineTab === 'memory'
                  ? 'Scrivi un prompt per cercare o proporre memorie...'
                  : 'Scrivi un prompt per interrogare o aggiornare il grafo control...'}
                className="min-h-16 w-full resize-y bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
              />
              </div>
              <div className="flex shrink-0 flex-col gap-3">
              {activeEngineTab === 'memory' ? (
                <>
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
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => runControlAction('retrieveInfo')}
                    disabled={!canRunControl}
                    className="inline-flex h-11 min-w-36 items-center justify-center gap-2 rounded-xl border border-sky-700/60 bg-sky-600/10 px-4 text-sm font-semibold text-sky-100 hover:bg-sky-600/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CircleStackIcon className="h-5 w-5" />
                    {isControlRunning === 'retrieveInfo' ? 'retrieve...' : 'retrieveInfo'}
                  </button>
                  <button
                    type="button"
                    onClick={() => runControlAction('updateSchema')}
                    disabled={!canRunControl}
                    className="inline-flex h-11 min-w-36 items-center justify-center gap-2 rounded-xl border border-emerald-700/60 bg-emerald-600/10 px-4 text-sm font-semibold text-emerald-100 hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <SparklesIcon className="h-5 w-5" />
                    {isControlRunning === 'updateSchema' ? 'schema...' : 'updateSchema'}
                  </button>
                  <button
                    type="button"
                    onClick={() => runControlAction('executeAction')}
                    disabled={!canRunControl || !controlExecutionEnabled}
                    className="inline-flex h-11 min-w-36 items-center justify-center gap-2 rounded-xl border border-amber-700/60 bg-amber-600/10 px-4 text-sm font-semibold text-amber-100 hover:bg-amber-600/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isControlRunning === 'executeAction' ? 'execute...' : 'executeAction'}
                  </button>
                </>
              )}
              </div>
            </div>
            {activeEngineTab === 'control' ? (
              <div className="rounded-2xl border border-gray-800 bg-gray-950/70 px-4 py-3 focus-within:border-sky-600">
                <textarea
                  value={controlPayload}
                  onChange={(event) => setControlPayload(event.target.value)}
                  rows={5}
                  placeholder={'JSON opzionale: {"device_type":"printer","intent":"monitoring"} oppure {"schema":{"building":...}}'}
                  className="min-h-28 w-full resize-y bg-transparent font-mono text-xs text-white outline-none placeholder:text-gray-500"
                />
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="mt-6 rounded-xl border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">{error}</div>
          ) : null}

          {activeEngineTab === 'control' && controlResult ? (
            <div className="mt-6 rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Control result</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">{controlAction || controlResult.tool || 'Control Engine'}</h2>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  controlResult.ok === false
                    ? 'border-rose-800 bg-rose-950/40 text-rose-200'
                    : 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
                }`}>
                  {controlResult.ok === false ? 'error' : 'ok'}
                </span>
              </div>
              {controlResult.error ? (
                <div className="mt-4 rounded-xl border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
                  {controlResult.error}
                </div>
              ) : null}
              <pre className="mt-4 max-h-[32rem] overflow-auto rounded-xl border border-gray-800 bg-gray-950 p-4 text-xs leading-relaxed text-gray-200">
                {formatDetails(controlResult.result || controlResult)}
              </pre>
            </div>
          ) : null}

          {activeEngineTab === 'memory' && lastPacket ? (
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
              {lastAction === 'getMemories' ? (
                <div className="md:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Risposta LLM generata</p>
                  <div className="mt-1 rounded-xl border border-sky-900/60 bg-sky-950/20 px-4 py-3 text-gray-100">
                    {generatedAnswer?.text ? (
                      <p className="whitespace-pre-wrap">{generatedAnswer.text}</p>
                    ) : (
                      <p className="text-gray-400">
                        {generatedAnswer?.error
                          ? `Generazione non riuscita: ${generatedAnswer.error}`
                          : generatedAnswer?.skipped_reason === 'no_memory_context'
                            ? 'Nessuna risposta generata perche non e stato recuperato contextText.'
                            : 'Nessuna risposta generata.'}
                      </p>
                    )}
                    {generatedAnswer?.provider || generatedAnswer?.model ? (
                      <p className="mt-2 text-xs text-sky-200/80">
                        {['provider', generatedAnswer.provider, 'model', generatedAnswer.model].filter(Boolean).join(' ')}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeEngineTab === 'memory' && processLog.length > 0 ? (
            <div className="mt-6 border-t border-gray-800 pt-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">Process log</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">
                    {lastAction === 'setMemories' ? 'afterMemory' : 'beforeMemory'}
                  </h2>
                </div>
                <p className="text-xs text-gray-400">{processLog.length} step</p>
              </div>
              <ol className="mt-4 space-y-3">
                {processLog.map((step, index) => {
                  const details = formatDetails(step.details);
                  return (
                    <li key={step.id} className="grid gap-3 border-b border-gray-800 pb-3 sm:grid-cols-[2rem_1fr]">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700 bg-gray-950 text-xs font-semibold text-gray-300">
                        {index + 1}
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-white">{step.title}</h3>
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-normal ${getLogStatusClass(step.status)}`}>
                            {getLogStatusLabel(step.status)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-gray-300">{step.description}</p>
                        {details ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs font-semibold text-sky-300">Dettagli</summary>
                            <pre className="mt-2 max-h-64 overflow-auto rounded-xl border border-gray-800 bg-gray-950/80 p-3 text-xs leading-relaxed text-gray-300">
                              {details}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {activeEngineTab === 'memory' ? (
          <div className="mt-6 overflow-x-auto rounded-2xl border border-gray-800 bg-gray-950/70">
            <table className="min-w-full divide-y divide-gray-800 text-sm">
              <thead className="bg-gray-950/90 text-left text-xs uppercase tracking-normal text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold">Agente</th>
                  <th className="px-4 py-3 font-semibold">Argomento</th>
                  <th className="px-4 py-3 font-semibold">Informazione</th>
                  <th className="px-4 py-3 font-semibold">Esito</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-5 text-sm text-gray-400">
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
                      <td className="px-4 py-3">
                        {getItemStatusLabel(item.status) ? (
                          <span className={`inline-flex min-w-24 justify-center rounded-full border px-3 py-1 text-xs font-semibold ${getItemStatusClass(item.status)}`}>
                            {getItemStatusLabel(item.status)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">n/d</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          ) : null}

          {activeEngineTab === 'memory' && lastPacket ? (
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
