'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, PointerEvent, WheelEvent } from 'react';
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
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;
const MEMORY_TECHNICAL_LABELS = new Set(['MemoryRun', 'MemoryStatus', 'MemoryTool', 'MemoryEpisode']);
const CONTROL_TECHNICAL_LABELS = new Set(['EngineGraph']);

type ViewportState = {
  x: number;
  y: number;
  zoom: number;
};

type DragState = {
  pointerId: number;
  lastX: number;
  lastY: number;
};

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

function isTechnicalNode(node: GraphNode, engine: 'memory' | 'control') {
  const technicalLabels = engine === 'memory' ? MEMORY_TECHNICAL_LABELS : CONTROL_TECHNICAL_LABELS;
  return node.labels.some((label) => technicalLabels.has(label));
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [dashboardPassword, setDashboardPassword] = useState('');
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const authFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = sessionStorage.getItem('graphDashboardToken') || localStorage.getItem('authToken');
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
      if (response.status === 401 || response.status === 403) {
        sessionStorage.removeItem('graphDashboardToken');
        setRequiresPassword(true);
        setSnapshot(null);
        throw new Error(body?.error || 'Password dashboard richiesta.');
      }
      if (!response.ok) throw new Error(body?.error || 'Impossibile caricare il grafo live.');
      setRequiresPassword(false);
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
    if (requiresPassword) return undefined;
    const timer = window.setInterval(() => loadGraph(engine), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [engine, loadGraph, requiresPassword]);

  const visibleGraph = useMemo(() => {
    const visibleNodes = (snapshot?.nodes || []).filter((node) => !isTechnicalNode(node, engine));
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const visibleLinks = (snapshot?.links || []).filter((link) => (
      visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)
    ));
    return {
      nodes: visibleNodes,
      links: visibleLinks,
      hiddenNodeCount: Math.max(0, (snapshot?.nodes?.length || 0) - visibleNodes.length),
    };
  }, [engine, snapshot]);
  const nodes = useMemo(
    () => layoutGraph(visibleGraph.nodes, visibleGraph.links),
    [visibleGraph]
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) || null : null;
  const links = visibleGraph.links;

  const switchEngine = (nextEngine: 'memory' | 'control') => {
    setEngine(nextEngine);
    setSelectedNodeId(null);
    setViewport({ x: 0, y: 0, zoom: 1 });
    const url = new URL(window.location.href);
    url.searchParams.set('engine', nextEngine);
    window.history.replaceState(null, '', url.toString());
    loadGraph(nextEngine);
  };

  const unlockDashboard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsUnlocking(true);
    setError(null);
    try {
      const response = await fetch('/api/memory-engine/graph/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: dashboardPassword }),
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Password dashboard non valida.');
      sessionStorage.setItem('graphDashboardToken', body.graphDashboardToken);
      setDashboardPassword('');
      setRequiresPassword(false);
      await loadGraph(engine);
    } catch (err: any) {
      setError(err?.message || 'Accesso dashboard non riuscito.');
    } finally {
      setIsUnlocking(false);
    }
  };

  const getSvgPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: -VIEW_HALF + ((clientX - rect.left) / rect.width) * VIEW_SIZE,
      y: -VIEW_HALF + ((clientY - rect.top) / rect.height) * VIEW_SIZE,
    };
  };

  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const point = getSvgPoint(event.clientX, event.clientY);
    setViewport((current) => {
      const nextZoom = clamp(current.zoom * (event.deltaY > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM);
      const graphX = (point.x - current.x) / current.zoom;
      const graphY = (point.y - current.y) / current.zoom;
      return {
        zoom: nextZoom,
        x: point.x - graphX * nextZoom,
        y: point.y - graphY * nextZoom,
      };
    });
  };

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!drag || !rect || drag.pointerId !== event.pointerId) return;
    const dx = ((event.clientX - drag.lastX) / rect.width) * VIEW_SIZE;
    const dy = ((event.clientY - drag.lastY) / rect.height) * VIEW_SIZE;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    setViewport((current) => ({
      ...current,
      x: current.x + dx,
      y: current.y + dy,
    }));
  };

  const handlePointerEnd = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
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
            <span className="font-semibold text-white">{nodes.length}</span> nodi visibili
            <span className="mx-2 text-gray-600">/</span>
            <span className="font-semibold text-white">{links.length}</span> relazioni
            {visibleGraph.hiddenNodeCount > 0 ? (
              <span className="ml-3 text-gray-500">{visibleGraph.hiddenNodeCount} tecnici nascosti</span>
            ) : null}
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

      {requiresPassword ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 px-4">
          <form
            onSubmit={unlockDashboard}
            className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-950 p-5 shadow-2xl"
          >
            <p className="text-xs font-semibold uppercase tracking-normal text-sky-300">Graph dashboard</p>
            <h1 className="mt-2 text-xl font-semibold text-white">Accesso dashboard</h1>
            <p className="mt-2 text-sm text-gray-400">Inserisci la password dedicata alla vista live del grafo.</p>
            {error ? (
              <div className="mt-4 rounded-xl border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-sm text-rose-100">
                {error}
              </div>
            ) : null}
            <label className="mt-5 block text-sm text-gray-200">
              Password
              <input
                type="password"
                value={dashboardPassword}
                onChange={(event) => setDashboardPassword(event.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white outline-none focus:border-sky-600"
                autoFocus
              />
            </label>
            <button
              type="submit"
              disabled={isUnlocking || !dashboardPassword.trim()}
              className="mt-4 w-full rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isUnlocking ? 'Verifica...' : 'Apri dashboard'}
            </button>
          </form>
        </div>
      ) : null}

      <svg
        ref={svgRef}
        viewBox={`${-VIEW_HALF} ${-VIEW_HALF} ${VIEW_SIZE} ${VIEW_SIZE}`}
        className="h-full w-full cursor-grab bg-[radial-gradient(circle_at_center,#111827_0,#030712_55%,#000_100%)] pt-16 active:cursor-grabbing"
        role="img"
        aria-label={`Grafo live ${engine}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
      >
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
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
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedNodeId(node.id);
                }}
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
