'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleStackIcon,
  SparklesIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';

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
    enabled?: boolean;
    neo4j_url?: string;
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
    agent_tool_calls?: number;
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
    agent_tool_calls?: number;
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

type GraphNode = {
  id: string;
  labels: string[];
  title: string;
  kind: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
};

type GraphLink = {
  id: string;
  source: string;
  target: string;
  type: string;
};

type GraphSnapshot = {
  engine: 'memory' | 'control';
  nodes: GraphNode[];
  links: GraphLink[];
};

type GraphPreview = {
  engine: 'memory' | 'control';
  title: string;
  nodes: GraphNode[];
  links: GraphLink[];
};

type StatusTone = 'green' | 'yellow' | 'red';

type StatusInfo = {
  tone: StatusTone;
  label: string;
  description: string;
};

type ActivatedGraphSource = {
  engine: 'memory' | 'control';
  title: string;
  ids: Set<string>;
  terms: string[];
};

const GRAPH_ID_KEYS = new Set([
  'id',
  'key',
  'canonical_key',
  'subject_key',
  'request_key',
  'topic_key',
  'run_key',
  'memory_id',
  'item_id',
  'device_id',
  'action_id',
  'building_id',
  'room_id',
  'capability_key',
  'adapter_key',
  'device_type',
  'adapter_type',
  'from',
  'to',
]);

const GRAPH_TERM_KEYS = new Set([
  'topic',
  'information',
  'summary',
  'request_summary',
  'name',
  'device',
  'action',
  'building',
  'room',
  'capability',
  'description',
]);

const GRAPH_GENERIC_TOKENS = new Set([
  'true',
  'false',
  'null',
  'none',
  'shared',
  'dedicated',
  'memory',
  'control',
  'device',
  'action',
  'building',
  'room',
  'location',
  'capability',
  'adapter',
  'created',
  'updated',
  'unchanged',
]);

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
    typeof packet.retrieval?.agent_tool_calls === 'number' ? `tool ${packet.retrieval.agent_tool_calls}` : '',
    typeof packet.embedding?.agent_tool_calls === 'number' ? `tool ${packet.embedding.agent_tool_calls}` : '',
    typeof packet.embedding?.saved_items === 'number' ? `salvate ${packet.embedding.saved_items}` : '',
    typeof packet.embedding?.updated_items === 'number' ? `aggiornate ${packet.embedding.updated_items}` : '',
    typeof packet.embedding?.unchanged_items === 'number' ? `immutate ${packet.embedding.unchanged_items}` : '',
    typeof packet.episodes?.saved === 'number' ? `persistite ${packet.episodes.saved}` : '',
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

function getStatusToneClass(tone: StatusTone) {
  if (tone === 'green') return 'border-emerald-700/60 bg-emerald-600/10 text-emerald-200';
  if (tone === 'yellow') return 'border-amber-700/60 bg-amber-600/10 text-amber-200';
  return 'border-rose-800/70 bg-rose-950/40 text-rose-200';
}

function normalizeGraphToken(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function addGraphId(ids: Set<string>, value: unknown) {
  if (value == null || typeof value === 'object') return;
  const token = String(value).trim();
  if (token && !GRAPH_GENERIC_TOKENS.has(normalizeGraphToken(token))) ids.add(token);
}

function addGraphTerm(terms: string[], value: unknown) {
  if (value == null || typeof value === 'object') return;
  const text = String(value).trim();
  const normalized = normalizeGraphToken(text);
  if (text.length > 3 && text.length < 220 && !GRAPH_GENERIC_TOKENS.has(normalized)) terms.push(text);
}

function collectGraphIds(value: unknown, ids = new Set<string>(), terms: string[] = []) {
  if (value == null) return { ids, terms };
  if (Array.isArray(value)) {
    value.forEach((entry) => collectGraphIds(entry, ids, terms));
    return { ids, terms };
  }
  if (typeof value !== 'object') {
    return { ids, terms };
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (GRAPH_ID_KEYS.has(normalizedKey) || normalizedKey.endsWith('_id')) addGraphId(ids, entry);
    if (GRAPH_TERM_KEYS.has(normalizedKey)) addGraphTerm(terms, entry);
    collectGraphIds(entry, ids, terms);
  }
  return { ids, terms };
}

function nodeMatchesActivatedSource(node: GraphNode, source: ActivatedGraphSource) {
  const idValues = [
    node.id,
    node.properties?.id,
    node.properties?.key,
    node.properties?.canonical_key,
    node.properties?.subject_key,
    node.properties?.request_key,
    node.properties?.device_type,
    node.properties?.adapter_type,
  ].map(normalizeGraphToken).filter(Boolean);
  const textValues = [
    node.title,
    node.properties?.name,
    node.properties?.topic,
    node.properties?.information,
    node.properties?.summary,
    node.properties?.description,
    ...(Array.isArray(node.properties?.aliases) ? node.properties.aliases : []),
  ].map(normalizeGraphToken).filter(Boolean);
  for (const id of source.ids) {
    const token = normalizeGraphToken(id);
    if (token && idValues.some((value) => value === token)) return true;
  }
  for (const term of source.terms.slice(0, 20)) {
    const token = normalizeGraphToken(term);
    if (token.length > 3 && !GRAPH_GENERIC_TOKENS.has(token) && textValues.some((value) => value.includes(token))) return true;
  }
  return false;
}

function buildActivatedGraphPreview(snapshot: GraphSnapshot, source: ActivatedGraphSource): GraphPreview {
  const directNodeIds = new Set(
    snapshot.nodes
      .filter((node) => nodeMatchesActivatedSource(node, source))
      .map((node) => node.id)
  );
  const links = snapshot.links.filter((link) => directNodeIds.has(link.source) && directNodeIds.has(link.target));
  const linkedNodeIds = new Set<string>();
  links.forEach((link) => {
    linkedNodeIds.add(link.source);
    linkedNodeIds.add(link.target);
  });
  const nodes = snapshot.nodes.filter((node) => directNodeIds.has(node.id) || linkedNodeIds.has(node.id));
  return {
    engine: source.engine,
    title: source.title,
    nodes,
    links,
  };
}

function layoutPreviewGraph(nodes: GraphNode[]) {
  return nodes.map((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    const ring = nodes.length < 6 ? 145 : 120 + Math.floor(index / 12) * 72;
    return {
      ...node,
      x: Math.cos(angle) * ring,
      y: Math.sin(angle) * ring,
    };
  });
}

function getPreviewNodeColor(node: GraphNode, engine: 'memory' | 'control') {
  const labels = node.labels.join(' ');
  if (engine === 'memory') {
    if (labels.includes('MemoryItem')) return '#38bdf8';
    if (labels.includes('MemoryTopic')) return '#22c55e';
    if (labels.includes('MemoryAgent')) return '#f59e0b';
    return '#94a3b8';
  }
  if (labels.includes('ControlDevice')) return '#f59e0b';
  if (labels.includes('ControlAction')) return '#ef4444';
  if (labels.includes('ControlLocation')) return '#22c55e';
  if (labels.includes('ControlCapability')) return '#a78bfa';
  return '#94a3b8';
}

export default function MemoryEnginePage() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [neo4jUrl, setNeo4jUrl] = useState('');
  const [neo4jBrowserUrl, setNeo4jBrowserUrl] = useState('');
  const [activeEngineTab, setActiveEngineTab] = useState<EngineTab>('memory');
  const [controlEnabled, setControlEnabled] = useState(false);
  const [controlExecutionEnabled, setControlExecutionEnabled] = useState(false);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [prompt, setPrompt] = useState('');
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
  const [activatedGraphSource, setActivatedGraphSource] = useState<ActivatedGraphSource | null>(null);
  const [graphPreview, setGraphPreview] = useState<GraphPreview | null>(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
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
            setMemoryEnabled(Boolean(settingsBody.memory_engine?.enabled));
            setNeo4jUrl(String(settingsBody.memory_engine?.neo4j_url || '').trim());
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
    () => Boolean(prompt.trim()) && !isControlRunning && controlEnabled,
    [prompt, isControlRunning, controlEnabled]
  );
  const memoryTargetValue = memoryScope === 'shared' ? 'shared' : `agent:${selectedAgentId}`;

  const memoryStatus = useMemo<StatusInfo>(() => {
    if (!memoryEnabled) {
      return {
        tone: 'red',
        label: 'Memorie disattive',
        description: 'Memory Engine disattivo: gli agenti non recuperano ne aggiornano memorie.',
      };
    }
    if (!neo4jUrl) {
      return {
        tone: 'yellow',
        label: 'Memorie da verificare',
        description: 'Memory Engine attivo, ma la configurazione Neo4j sembra incompleta.',
      };
    }
    return {
      tone: 'green',
      label: 'Memorie attive',
      description: 'Memory Engine attivo: gli agenti possono recuperare e aggiornare memorie secondo scope.',
    };
  }, [memoryEnabled, neo4jUrl]);

  const controlStatus = useMemo<StatusInfo>(() => (
    controlEnabled
      ? {
          tone: 'green',
          label: 'Control attivo',
          description: 'Control Engine attivo: gli agenti possono vedere retrieveInfo e updateSchema.',
        }
      : {
          tone: 'red',
          label: 'Control disattivo',
          description: 'Control Engine disattivo: retrieveInfo e updateSchema non sono esposti agli agenti.',
        }
  ), [controlEnabled]);

  const controlExecutionStatus = useMemo<StatusInfo>(() => {
    if (controlExecutionEnabled && !controlEnabled) {
      return {
        tone: 'yellow',
        label: 'Azioni da verificare',
        description: 'Esecuzione azioni abilitata, ma Control Engine e disattivo.',
      };
    }
    if (controlExecutionEnabled) {
      return {
        tone: 'green',
        label: 'Azioni attive',
        description: 'Esecuzione azioni attiva: executeAction e le azioni reali sui device sono abilitate.',
      };
    }
    return {
      tone: 'red',
      label: 'Azioni disattive',
      description: 'Esecuzione azioni disattiva: executeAction resta bloccato e non esegue comandi sui device.',
    };
  }, [controlEnabled, controlExecutionEnabled]);

  const handleMemoryTargetChange = (value: string) => {
    if (value === 'shared') {
      setMemoryScope('shared');
      return;
    }
    if (value.startsWith('agent:')) {
      setMemoryScope('dedicated');
      setSelectedAgentId(value.slice('agent:'.length));
    }
  };

  const buildMemoryGraphSource = (action: MemoryResponse['action'], packet: MemoryPacket | null, responseItems: MemoryItem[]) => {
    const ids = new Set<string>();
    const terms: string[] = [];
    (packet?.retrieval?.selected_ids || []).forEach((id) => ids.add(String(id)));
    collectGraphIds(packet, ids, terms);
    responseItems.forEach((item) => {
      if (item.id) ids.add(item.id);
      terms.push(item.topic, item.information);
    });
    return {
      engine: 'memory' as const,
      title: action === 'getMemories' ? 'Grafo beforeMemory' : 'Grafo afterMemory',
      ids,
      terms: terms.filter(Boolean),
    };
  };

  const buildControlGraphSource = (action: ControlAction, result: ControlResult) => {
    const ids = new Set<string>();
    const terms: string[] = [];
    collectGraphIds(result?.result || result, ids, terms);
    return {
      engine: 'control' as const,
      title: `Grafo ${action}`,
      ids,
      terms: terms.filter(Boolean),
    };
  };

  const openActivatedGraph = async () => {
    if (!activatedGraphSource) return;
    setIsGraphLoading(true);
    setError(null);
    try {
      const response = await authFetch(`/api/memory-engine/graph/live?engine=${activatedGraphSource.engine}&limit=900`);
      const snapshot = await response.json().catch(() => ({})) as GraphSnapshot & { error?: string };
      if (!response.ok) throw new Error(snapshot?.error || 'Impossibile caricare il sotto-grafo.');
      setGraphPreview(buildActivatedGraphPreview(snapshot, activatedGraphSource));
    } catch (err: any) {
      setError(err?.message || 'Errore durante il caricamento del sotto-grafo.');
    } finally {
      setIsGraphLoading(false);
    }
  };

  const runMemoryAction = async (action: MemoryResponse['action']) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setIsRunning(action);
    setError(null);
    setActivatedGraphSource(null);
    setGraphPreview(null);
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
      setActivatedGraphSource(buildMemoryGraphSource(action, body.packet || null, Array.isArray(body.items) ? body.items : []));
    } catch (err: any) {
      setError(err?.message || 'Errore durante il test Memory Engine.');
    } finally {
      setIsRunning(null);
    }
  };

  const parseControlPayload = () => {
    return {};
  };

  const runControlAction = async (action: ControlAction) => {
    setIsControlRunning(action);
    setError(null);
    setControlResult(null);
    setActivatedGraphSource(null);
    setGraphPreview(null);
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
      setActivatedGraphSource(buildControlGraphSource(action, body));
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
                Console admin per testare beforeMemory, afterMemory e le funzioni Control Engine sui grafi dedicati.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <details className="group relative">
                <summary className="inline-flex h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-xl border border-sky-700/60 bg-sky-600/10 px-4 text-sm font-semibold text-sky-100 hover:bg-sky-600/20">
                  <CircleStackIcon className="h-5 w-5" />
                  Live Dashboard
                  <ChevronDownIcon className="h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="absolute right-0 top-full z-30 mt-2 w-48 overflow-hidden rounded-xl border border-gray-800 bg-gray-950 py-1 shadow-2xl">
                  <a
                    href={neo4jBrowserUrl || '#'}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={!neo4jBrowserUrl}
                    className={`flex items-center gap-2 px-3 py-2 text-sm font-semibold ${
                      neo4jBrowserUrl
                        ? 'text-gray-100 hover:bg-gray-900'
                        : 'pointer-events-none text-gray-500'
                    }`}
                    title={neo4jBrowserUrl ? 'Apri Neo4j Browser' : 'URL pagina web Neo4j non configurato'}
                  >
                    <ArrowTopRightOnSquareIcon className="h-5 w-5" />
                    DB
                  </a>
                  <a
                    href="/graph-live?engine=memory"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-100 hover:bg-gray-900"
                    title="Apri Live Dashboard"
                  >
                    <CircleStackIcon className="h-5 w-5" />
                    Dashboard
                  </a>
                </div>
              </details>
              <span className="group relative inline-flex">
                <span
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border ${getStatusToneClass(memoryStatus.tone)}`}
                  title={memoryStatus.label}
                  aria-label={memoryStatus.label}
                >
                  {memoryStatus.tone === 'red' ? <XCircleIcon className="h-5 w-5" /> : <CheckCircleIcon className="h-5 w-5" />}
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-left text-xs font-medium leading-relaxed text-gray-100 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
                  {memoryStatus.description}
                </span>
              </span>
              <span className="group relative inline-flex">
                <span
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border ${getStatusToneClass(controlStatus.tone)}`}
                  title={controlStatus.label}
                  aria-label={controlStatus.label}
                >
                  {controlStatus.tone === 'red' ? <XCircleIcon className="h-5 w-5" /> : <CheckCircleIcon className="h-5 w-5" />}
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-left text-xs font-medium leading-relaxed text-gray-100 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
                  {controlStatus.description}
                </span>
              </span>
              <span className="group relative inline-flex">
                <span
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border ${getStatusToneClass(controlExecutionStatus.tone)}`}
                  title={controlExecutionStatus.label}
                  aria-label={controlExecutionStatus.label}
                >
                  <BoltIcon className="h-5 w-5" />
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-left text-xs font-medium leading-relaxed text-gray-100 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
                  {controlExecutionStatus.description}
                </span>
              </span>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-xl border border-gray-800 bg-gray-950 p-1">
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
            {activatedGraphSource ? (
              <button
                type="button"
                onClick={openActivatedGraph}
                disabled={isGraphLoading}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-sky-700/60 bg-sky-600/10 px-4 text-sm font-semibold text-sky-100 hover:bg-sky-600/20 disabled:cursor-wait disabled:opacity-60"
              >
                <CircleStackIcon className={`h-5 w-5 ${isGraphLoading ? 'animate-pulse' : ''}`} />
                Graph
              </button>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            {activeEngineTab === 'memory' ? (
              <label className="block max-w-sm text-xs font-semibold uppercase tracking-normal text-gray-500">
                Scope
                <select
                  value={memoryTargetValue}
                  onChange={(event) => handleMemoryTargetChange(event.target.value)}
                  className="mt-1 h-11 w-full rounded-xl border border-gray-800 bg-gray-950 px-3 text-sm normal-case text-white outline-none focus:border-sky-600"
                >
                  <option value="shared">Memorie condivise</option>
                  <optgroup label="Memorie agente">
                    {agents.length === 0 ? (
                      <option value="" disabled>Nessun agente</option>
                    ) : (
                      agents.map((agent) => (
                        <option key={agent.id} value={`agent:${agent.id}`}>
                          {agent.name}
                        </option>
                      ))
                    )}
                  </optgroup>
                </select>
              </label>
            ) : null}

            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <div className={`flex-1 rounded-2xl border border-gray-800 bg-gray-950/70 px-4 py-3 focus-within:border-sky-600 ${
                activeEngineTab === 'control' ? 'lg:min-h-[9.75rem]' : 'lg:min-h-[6.25rem]'
              }`}>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={activeEngineTab === 'control' ? 6 : 4}
                placeholder={activeEngineTab === 'memory'
                  ? 'Scrivi il contesto di test per beforeMemory o afterMemory...'
                  : 'Scrivi un prompt per interrogare o aggiornare il grafo control...'}
                className={`w-full resize-y bg-transparent text-sm text-white outline-none placeholder:text-gray-500 ${
                  activeEngineTab === 'control' ? 'min-h-[8.25rem]' : 'min-h-[4.75rem]'
                }`}
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
                    {isRunning === 'getMemories' ? 'before...' : 'beforeMemory'}
                  </button>
                  <button
                    type="button"
                    onClick={() => runMemoryAction('setMemories')}
                    disabled={!canRun}
                    className="inline-flex h-11 min-w-32 items-center justify-center gap-2 rounded-xl border border-emerald-700/60 bg-emerald-600/10 px-4 text-sm font-semibold text-emerald-100 hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <SparklesIcon className="h-5 w-5" />
                    {isRunning === 'setMemories' ? 'after...' : 'afterMemory'}
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
                    <BoltIcon className="h-5 w-5" />
                    {isControlRunning === 'executeAction' ? 'execute...' : 'executeAction'}
                  </button>
                </>
              )}
              </div>
            </div>
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
                  <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">
                    {lastAction === 'setMemories' ? 'memoryStatus' : 'availableMemories'}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-gray-200">{String(lastPacket.contextText).trim()}</p>
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
      {graphPreview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6">
          <div className="flex h-full max-h-[46rem] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-sky-900/70 bg-gray-950 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-normal text-sky-300">Graph preview</p>
                <h2 className="mt-1 text-lg font-semibold text-white">{graphPreview.title}</h2>
                <p className="mt-1 text-xs text-gray-400">
                  {graphPreview.nodes.length} nodi / {graphPreview.links.length} relazioni
                </p>
              </div>
              <button
                type="button"
                onClick={() => setGraphPreview(null)}
                className="inline-flex h-10 items-center justify-center rounded-xl border border-gray-700 px-4 text-sm font-semibold text-gray-100 hover:bg-gray-900"
              >
                Chiudi
              </button>
            </div>
            <div className="relative min-h-0 flex-1 bg-[radial-gradient(circle_at_center,#111827_0,#030712_55%,#000_100%)]">
              {graphPreview.nodes.length > 0 ? (() => {
                const nodes = layoutPreviewGraph(graphPreview.nodes);
                const byId = new Map(nodes.map((node) => [node.id, node]));
                return (
                  <svg viewBox="-420 -300 840 600" className="h-full w-full" role="img" aria-label={graphPreview.title}>
                    <g>
                      {graphPreview.links.map((link) => {
                        const source = byId.get(link.source);
                        const target = byId.get(link.target);
                        if (!source || !target) return null;
                        return (
                          <g key={link.id}>
                            <line
                              x1={source.x || 0}
                              y1={source.y || 0}
                              x2={target.x || 0}
                              y2={target.y || 0}
                              stroke="#38bdf8"
                              strokeOpacity="0.58"
                              strokeWidth="2.5"
                            />
                            <text
                              x={((source.x || 0) + (target.x || 0)) / 2}
                              y={((source.y || 0) + (target.y || 0)) / 2}
                              fill="#cbd5e1"
                              fontSize="10"
                              fontWeight="700"
                              textAnchor="middle"
                            >
                              {link.type}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                    <g>
                      {nodes.map((node) => (
                        <g key={node.id} transform={`translate(${node.x || 0} ${node.y || 0})`}>
                          <circle
                            r="15"
                            fill={getPreviewNodeColor(node, graphPreview.engine)}
                            stroke="#bae6fd"
                            strokeWidth="2"
                          />
                          <g transform="translate(0 30)">
                            <rect
                              x={-(Math.min(node.title.length, 32) * 3.8 + 12)}
                              y="-11"
                              width={Math.min(node.title.length, 32) * 7.6 + 24}
                              height="22"
                              rx="7"
                              fill="#020617"
                              fillOpacity="0.9"
                              stroke="#1e3a5f"
                            />
                            <text fill="#f8fafc" fontSize="11" fontWeight="700" textAnchor="middle" dominantBaseline="middle">
                              {node.title.length > 32 ? `${node.title.slice(0, 31)}...` : node.title}
                            </text>
                          </g>
                        </g>
                      ))}
                    </g>
                  </svg>
                );
              })() : (
                <div className="flex h-full items-center justify-center p-8 text-center text-sm text-gray-400">
                  Nessun nodo del grafo live corrisponde ai dati restituiti dall&apos;ultima funzione.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
