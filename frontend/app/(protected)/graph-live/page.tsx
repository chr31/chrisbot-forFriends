'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowPathIcon, BoltIcon, CircleStackIcon, XMarkIcon } from '@heroicons/react/24/outline';

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
  properties: Record<string, unknown>;
};

type GraphSnapshot = {
  engine: 'memory' | 'control';
  refreshed_at: string;
  node_count: number;
  link_count: number;
  nodes: GraphNode[];
  links: GraphLink[];
};

const VIEW_SIZE = 1600;
const VIEW_HALF = VIEW_SIZE / 2;
const REFRESH_MS = 5000;

function getInitialEngine() {
  if (typeof window === 'undefined') return 'memory';
  return new URLSearchParams(window.location.search).get('engine') === 'control' ? 'control' : 'memory';
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function getNodeColor(node: GraphNode, engine: 'memory' | 'control') {
  const labels = node.labels.join(' ');
  if (engine === 'memory') {
    if (labels.includes('MemoryItem')) return '#38bdf8';
    if (labels.includes('MemoryTopic')) return '#22c55e';
    if (labels.includes('MemoryRun')) return '#a78bfa';
    if (labels.includes('MemoryAgent')) return '#f59e0b';
    if (labels.includes('MemoryRequest')) return '#f472b6';
    return '#94a3b8';
  }
  if (labels.includes('EngineGraph')) return '#38bdf8';
  if (labels.includes('ControlDevice')) return '#f59e0b';
  if (labels.includes('ControlAction')) return '#ef4444';
  if (labels.includes('ControlLocation')) return '#22c55e';
  if (labels.includes('ControlCapability')) return '#a78bfa';
  return '#94a3b8';
}

function getNodeRadius(node: GraphNode) {
  const labels = node.labels.join(' ');
  if (labels.includes('EngineGraph')) return 22;
  if (labels.includes('MemoryRun') || labels.includes('ControlDevice')) return 17;
  if (labels.includes('MemoryItem') || labels.includes('ControlAction')) return 15;
  return 12;
}

function truncate(value: string, limit = 32) {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function formatValue(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function layoutGraph(nodes: GraphNode[], links: GraphLink[]) {
  const positioned = nodes.map((node, index) => {
    const seed = hashText(node.id);
    const angle = ((index / Math.max(nodes.length, 1)) * Math.PI * 2) + ((seed % 90) / 360);
    const ring = 180 + ((seed % 5) * 95) + Math.floor(index / 36) * 45;
    return {
      ...node,
      x: Math.cos(angle) * ring,
      y: Math.sin(angle) * ring,
    };
  });
  const byId = new Map(positioned.map((node) => [node.id, node]));

  for (let tick = 0; tick < 90; tick += 1) {
    for (let i = 0; i < positioned.length; i += 1) {
      for (let j = i + 1; j < positioned.length; j += 1) {
        const a = positioned[i];
        const b = positioned[j];
        const dx = (a.x || 0) - (b.x || 0);
        const dy = (a.y || 0) - (b.y || 0);
        const distance = Math.max(Math.sqrt((dx * dx) + (dy * dy)), 1);
        const force = Math.min(3600 / (distance * distance), 2.8);
        const moveX = (dx / distance) * force;
        const moveY = (dy / distance) * force;
        a.x = (a.x || 0) + moveX;
        a.y = (a.y || 0) + moveY;
        b.x = (b.x || 0) - moveX;
        b.y = (b.y || 0) - moveY;
      }
    }

    for (const link of links) {
      const source = byId.get(link.source);
      const target = byId.get(link.target);
      if (!source || !target) continue;
      const dx = (target.x || 0) - (source.x || 0);
      const dy = (target.y || 0) - (source.y || 0);
      const distance = Math.max(Math.sqrt((dx * dx) + (dy * dy)), 1);
      const desired = 155;
      const force = (distance - desired) * 0.012;
      const moveX = (dx / distance) * force;
      const moveY = (dy / distance) * force;
      source.x = (source.x || 0) + moveX;
      source.y = (source.y || 0) + moveY;
      target.x = (target.x || 0) - moveX;
      target.y = (target.y || 0) - moveY;
    }

    for (const node of positioned) {
      node.x = Math.max(-720, Math.min(720, (node.x || 0) * 0.998));
      node.y = Math.max(-650, Math.min(650, (node.y || 0) * 0.998));
    }
  }

  return positioned;
}

export default function GraphLivePage() {
  const [engine, setEngine] = useState<'memory' | 'control'>(() => getInitialEngine() as 'memory' | 'control');
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = localStorage.getItem('authToken');
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers, cache: 'no-store' });
  }, []);

  const loadGraph = useCallback(async (nextEngine = engine) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await authFetch(`/api/memory-engine/graph/live?engine=${nextEngine}&limit=900`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Impossibile caricare il grafo live.');
      setSnapshot(body as GraphSnapshot);
      setSelectedNodeId((current) => {
        if (!current) return null;
        return Array.isArray(body?.nodes) && body.nodes.some((node: GraphNode) => node.id === current) ? current : null;
      });
    } catch (err: any) {
      setError(err?.message || 'Errore durante il caricamento del grafo live.');
    } finally {
      setIsLoading(false);
    }
  }, [authFetch, engine]);

  useEffect(() => {
    const nextEngine = getInitialEngine() as 'memory' | 'control';
    setEngine(nextEngine);
    loadGraph(nextEngine);
  }, [loadGraph]);

  useEffect(() => {
    const timer = window.setInterval(() => loadGraph(engine), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [engine, loadGraph]);

  const nodes = useMemo(
    () => layoutGraph(snapshot?.nodes || [], snapshot?.links || []),
    [snapshot]
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) || null : null;
  const links = snapshot?.links || [];

  const switchEngine = (nextEngine: 'memory' | 'control') => {
    setEngine(nextEngine);
    setSelectedNodeId(null);
    const url = new URL(window.location.href);
    url.searchParams.set('engine', nextEngine);
    window.history.replaceState(null, '', url.toString());
    loadGraph(nextEngine);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black text-white">
      <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 bg-gray-950/95 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-xl border border-gray-800 bg-gray-950 p-1">
            <button
              type="button"
              onClick={() => switchEngine('memory')}
              className={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold ${engine === 'memory' ? 'bg-sky-600 text-white' : 'text-gray-300 hover:bg-gray-900'}`}
            >
              <CircleStackIcon className="h-5 w-5" />
              Memory
            </button>
            <button
              type="button"
              onClick={() => switchEngine('control')}
              className={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold ${engine === 'control' ? 'bg-sky-600 text-white' : 'text-gray-300 hover:bg-gray-900'}`}
            >
              <BoltIcon className="h-5 w-5" />
              Control
            </button>
          </div>
          <div className="text-sm text-gray-300">
            <span className="font-semibold text-white">{snapshot?.node_count || 0}</span> nodi
            <span className="mx-2 text-gray-600">/</span>
            <span className="font-semibold text-white">{snapshot?.link_count || 0}</span> relazioni
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">
            {snapshot?.refreshed_at ? `Aggiornato ${new Date(snapshot.refreshed_at).toLocaleTimeString('it-IT')}` : 'In attesa dati'}
          </span>
          <button
            type="button"
            onClick={() => loadGraph(engine)}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-gray-700 px-3 text-sm font-semibold text-gray-100 hover:bg-gray-900"
          >
            <ArrowPathIcon className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-700 text-gray-100 hover:bg-gray-900"
            aria-label="Chiudi"
            title="Chiudi"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="absolute left-5 right-5 top-20 z-30 rounded-xl border border-rose-800/60 bg-rose-950/80 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      <svg
        viewBox={`${-VIEW_HALF} ${-VIEW_HALF} ${VIEW_SIZE} ${VIEW_SIZE}`}
        className="h-full w-full bg-[radial-gradient(circle_at_center,#111827_0,#030712_55%,#000_100%)] pt-16"
        role="img"
        aria-label={`Grafo live ${engine}`}
      >
        <g>
          {links.map((link) => {
            const source = nodeById.get(link.source);
            const target = nodeById.get(link.target);
            if (!source || !target) return null;
            return (
              <g key={link.id}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="#334155"
                  strokeWidth="2"
                  strokeOpacity="0.75"
                />
                <text
                  x={((source.x || 0) + (target.x || 0)) / 2}
                  y={((source.y || 0) + (target.y || 0)) / 2}
                  fill="#64748b"
                  fontSize="14"
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {truncate(link.type, 18)}
                </text>
              </g>
            );
          })}
        </g>
        <g>
          {nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            return (
              <g
                key={node.id}
                transform={`translate(${node.x || 0} ${node.y || 0})`}
                onClick={() => setSelectedNodeId(node.id)}
                className="cursor-pointer"
              >
                <circle
                  r={getNodeRadius(node) + (selected ? 5 : 0)}
                  fill={getNodeColor(node, engine)}
                  fillOpacity={selected ? 1 : 0.86}
                  stroke={selected ? '#ffffff' : '#0f172a'}
                  strokeWidth={selected ? 4 : 2}
                />
                <text
                  y={getNodeRadius(node) + 20}
                  fill="#e5e7eb"
                  fontSize="18"
                  fontWeight={selected ? 700 : 600}
                  textAnchor="middle"
                  paintOrder="stroke"
                  stroke="#020617"
                  strokeWidth="5"
                  strokeLinejoin="round"
                >
                  {truncate(node.title, 28)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <aside className="absolute bottom-5 right-5 top-20 z-20 w-full max-w-sm overflow-hidden rounded-2xl border border-gray-800 bg-gray-950/92 shadow-2xl backdrop-blur">
        {selectedNode ? (
          <div className="flex h-full flex-col">
            <div className="border-b border-gray-800 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-normal text-sky-300">{selectedNode.kind}</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">{selectedNode.title}</h2>
                  <p className="mt-1 text-xs text-gray-500">{selectedNode.labels.join(', ')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(null)}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-800 text-gray-300 hover:bg-gray-900"
                  aria-label="Chiudi dettagli"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-3">
                {Object.entries(selectedNode.properties || {}).map(([key, value]) => (
                  <div key={key} className="rounded-xl border border-gray-800 bg-gray-900/70 p-3">
                    <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">{key}</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-100">{formatValue(value)}</pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
            Seleziona un nodo per vedere le proprietà principali.
          </div>
        )}
      </aside>
    </div>
  );
}
