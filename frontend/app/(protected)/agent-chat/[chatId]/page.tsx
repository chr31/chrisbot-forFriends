'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AiOptionsResponse, buildModelOptions, decodeModelValue, encodeModelValue, getModelLabel, ModelConfig, normalizeModelConfig, OllamaConnectionOption } from '../../../../lib/aiModels';
import { PaperAirplaneIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/solid';

type Message = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  reasoning?: string | null;
  total_tokens?: number | null;
  event_type?: string;
  metadata_json?: {
    run_id?: number | null;
    parent_run_id?: number | null;
    depth?: number | null;
    delegated_by_agent_id?: number | null;
    child_agent_id?: number | null;
    target_agent_name?: string;
    tool_name?: string;
    tool_call_id?: string | null;
    arguments?: Record<string, unknown> | null;
    guardrail_type?: string;
    blocked?: boolean;
  } | null;
  agent_id?: number | null;
  agent_name?: string | null;
  agent_kind?: 'worker' | 'orchestrator' | null;
};

const PENDING_CHAT_STORAGE_PREFIX = 'pending-agent-chat:';
const LAST_AGENT_STORAGE_PREFIX = 'last-agent-chat-agent-id:';

function getCurrentUserStorageSuffix(): string {
  try {
    const raw = localStorage.getItem('authUser');
    const user = raw ? JSON.parse(raw) : null;
    return String(user?.email || user?.name || 'default');
  } catch {
    return 'default';
  }
}

function readLastAgentId(): string | null {
  try {
    return localStorage.getItem(`${LAST_AGENT_STORAGE_PREFIX}${getCurrentUserStorageSuffix()}`);
  } catch {
    return null;
  }
}

function writeLastAgentId(agentId: string | number | null | undefined) {
  if (agentId === null || agentId === undefined || agentId === '') return;
  try {
    localStorage.setItem(`${LAST_AGENT_STORAGE_PREFIX}${getCurrentUserStorageSuffix()}`, String(agentId));
  } catch {}
}

function createClientUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

type Agent = {
  id: number;
  name: string;
  slug: string;
  kind: 'worker' | 'orchestrator';
  user_description: string;
  default_model_config: ModelConfig;
  direct_chat_enabled: boolean;
  is_active: boolean;
};

type AgentRun = {
  id: number;
  chat_id: string;
  agent_id: number;
  agent_name?: string | null;
  agent_kind?: 'worker' | 'orchestrator' | null;
  parent_run_id?: number | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  model_name: string;
  model_provider?: 'openai' | 'ollama' | null;
  depth: number;
  started_at: string;
  finished_at?: string | null;
  last_error?: string | null;
  guardrail_result_json?: {
    memory_events?: MemoryRunEvent[];
  } | string | null;
};

type FetchExistingChatResult = {
  loaded: boolean;
  messages: Message[];
  runs: AgentRun[];
};

type MemoryRunEvent = {
  type?: string;
  label?: string;
  content?: string;
  status?: string;
  scope?: string | null;
  details?: MemoryRunEventDetails | null;
};

function hasActiveRuns(chatRuns: AgentRun[]): boolean {
  return chatRuns.some((run) => run.status === 'running');
}

function hasTerminalRuns(chatRuns: AgentRun[]): boolean {
  return chatRuns.some((run) => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
}

function hasVisibleAssistantReply(chatMessages: Message[]): boolean {
  return chatMessages.some((message) =>
    isTopLevelAssistantReply(message)
    && !isStandaloneRunMarkerMessage(message)
    && String(message.content || '').trim()
  );
}

function hasVisibleAssistantReplyAfterLatestUser(chatMessages: Message[]): boolean {
  const latestUserIndex = [...chatMessages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === 'user')?.index;
  if (latestUserIndex === undefined) return hasVisibleAssistantReply(chatMessages);
  return chatMessages.slice(latestUserIndex + 1).some((message) =>
    isTopLevelAssistantReply(message)
    && !isStandaloneRunMarkerMessage(message)
    && String(message.content || '').trim()
  );
}

function isChatAwaitingLatestReply(result: FetchExistingChatResult): boolean {
  if (!result.loaded) return true;
  if (hasActiveRuns(result.runs)) return true;
  if (hasVisibleAssistantReplyAfterLatestUser(result.messages)) return false;
  return !hasTerminalRuns(result.runs);
}

type MemoryTraceItem = {
  section?: string;
  topic?: string;
  information?: string;
};

type MemoryRunEventDetails = {
  phase?: 'before' | 'after' | string;
  request_summary?: string;
  topics?: string[];
  contextText?: string;
  items?: MemoryTraceItem[];
  reusable_info?: string[];
  retrieval?: Record<string, unknown> | null;
  embedding?: Record<string, unknown> | null;
  episodes?: Record<string, unknown> | null;
  warnings?: string[];
};

type IndexedMessage = {
  message: Message;
  index: number;
};

type RunDetailItem = {
  key: string;
  order: number;
  label: string;
  subtitle?: string | null;
  content: string;
  tokenCount?: number | null;
  tone?: 'default' | 'memory';
  memoryDetails?: MemoryRunEventDetails | null;
};

function isAxiosTimeoutError(error: unknown): boolean {
  return Boolean(
    axios.isAxiosError(error)
      && (
        error.code === 'ECONNABORTED'
        || String(error.message || '').toLowerCase().includes('timeout')
      )
  );
}

function normalizeParentRunId(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildRunsFromMessages(messages: Message[]): AgentRun[] {
  const runMap = new Map<number, AgentRun>();

  for (const message of messages) {
    const runId = Number(message.metadata_json?.run_id);
    if (!Number.isFinite(runId) || runId <= 0) continue;

    const existing = runMap.get(runId);
    const nextRun: AgentRun = existing || {
      id: runId,
      chat_id: '',
      agent_id: Number(message.agent_id || 0),
      agent_name: message.agent_name || null,
      agent_kind: message.agent_kind || null,
      parent_run_id: Number.isFinite(Number(message.metadata_json?.parent_run_id))
        ? Number(message.metadata_json?.parent_run_id)
        : null,
      status: 'completed',
      model_name: 'n/d',
      model_provider: null,
      depth: Number.isFinite(Number(message.metadata_json?.depth)) ? Number(message.metadata_json?.depth) : 0,
      started_at: '',
      finished_at: null,
      last_error: null,
    };

    nextRun.agent_id = Number(message.agent_id || nextRun.agent_id || 0);
    nextRun.agent_name = message.agent_name || nextRun.agent_name || null;
    nextRun.agent_kind = message.agent_kind || nextRun.agent_kind || null;
    nextRun.parent_run_id = Number.isFinite(Number(message.metadata_json?.parent_run_id))
      ? Number(message.metadata_json?.parent_run_id)
      : nextRun.parent_run_id ?? null;
    nextRun.depth = Number.isFinite(Number(message.metadata_json?.depth))
      ? Number(message.metadata_json?.depth)
      : nextRun.depth;

    runMap.set(runId, nextRun);
  }

  return Array.from(runMap.values()).sort((a, b) => a.id - b.id);
}

function ToolMessage({
  content,
  eventType,
  detailMessages = [],
}: {
  content: string;
  eventType?: string;
  detailMessages?: Message[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const hasDetails = detailMessages.length > 0;
  return (
    <div className="flex justify-start items-center my-4">
      <div className="text-xs text-emerald-100 border border-dashed border-emerald-800 bg-emerald-950/40 rounded-md max-w-full sm:max-w-xl w-full">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between p-2 text-left font-semibold"
        >
          <span className="flex items-center">
            {isOpen ? <ChevronDownIcon className="h-4 w-4 mr-2" /> : <ChevronRightIcon className="h-4 w-4 mr-2" />}
            {eventType === 'delegation_result' ? 'Risultato delega' : 'Risultato tool'}
          </span>
          {hasDetails ? (
            <span className="text-[11px] uppercase tracking-[0.16em] text-emerald-300/80">Dettagli lavoro</span>
          ) : null}
        </button>
        {isOpen && (
          <div className="border-t border-emerald-800">
            <div className="p-2 whitespace-pre-wrap break-all">{content}</div>
            {hasDetails ? (
              <div className="border-t border-emerald-900/70 bg-emerald-950/30 px-3 py-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300">
                  Cronologia tecnica del worker
                </div>
                <div className="space-y-2">
                  {detailMessages.map((detail, index) => (
                    <div key={`${detail.event_type}-${detail.metadata_json?.run_id || 'run'}-${index}`} className="rounded-lg border border-emerald-900/60 bg-black/20 px-3 py-2">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-emerald-300/80">
                        <span>{detail.event_type === 'tool_result' ? 'Tool' : detail.event_type}</span>
                        {detail.metadata_json?.tool_name ? <span>{detail.metadata_json.tool_name}</span> : null}
                        {typeof detail.metadata_json?.run_id === 'number' ? <span>run {detail.metadata_json.run_id}</span> : null}
                      </div>
                      <div className="whitespace-pre-wrap break-all text-emerald-50">{detail.content}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingBubble({
  label = 'L’agente sta elaborando',
  status = 'In corso',
}: {
  label?: string;
  status?: string;
}) {
  return (
    <div className="flex justify-start">
      <div className="inline-flex max-w-xs items-center gap-3 rounded-2xl border border-emerald-500/20 bg-gray-900/90 px-4 py-3 text-gray-100 shadow-[0_0_0_1px_rgba(16,185,129,0.05)]">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:-0.3s]" />
          <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-emerald-300 [animation-delay:-0.15s]" />
          <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-emerald-200" />
        </div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300/80">{status}</div>
        </div>
      </div>
    </div>
  );
}

function CollapsibleCard({
  title,
  subtitle,
  content,
  tone = 'amber',
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string | null;
  content?: string;
  tone?: 'amber' | 'rose' | 'slate';
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const tones = {
    amber: {
      border: 'border-amber-700/50',
      bg: 'bg-amber-950/30',
      text: 'text-amber-100',
      label: 'text-amber-300',
    },
    rose: {
      border: 'border-rose-700/50',
      bg: 'bg-rose-950/30',
      text: 'text-rose-100',
      label: 'text-rose-300',
    },
    slate: {
      border: 'border-gray-700/60',
      bg: 'bg-gray-900/70',
      text: 'text-gray-100',
      label: 'text-gray-300',
    },
  }[tone];

  return (
    <div className={`max-w-full sm:max-w-2xl rounded-xl border ${tones.border} ${tones.bg} ${tones.text}`}>
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div>
          <div className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${tones.label}`}>
            {title}
            {subtitle ? ` · ${subtitle}` : ''}
          </div>
        </div>
        {isOpen ? <ChevronDownIcon className="h-4 w-4 shrink-0" /> : <ChevronRightIcon className="h-4 w-4 shrink-0" />}
      </button>
      {isOpen ? (
        <div className={`border-t px-4 py-3 ${tones.border}`}>
          {content ? <div className="whitespace-pre-wrap text-sm">{content}</div> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

function DelegationMessage({ content, agentName }: { content: string; agentName?: string | null }) {
  return (
    <div className="flex justify-start">
      <CollapsibleCard title="Delega" subtitle={agentName} content={content} tone="amber" />
    </div>
  );
}

function GuardrailMessage({ content, metadata }: { content: string; metadata?: Message['metadata_json'] }) {
  return (
    <div className="flex justify-start">
      <CollapsibleCard
        title="Guardrail"
        subtitle={[
          metadata?.guardrail_type || null,
          metadata?.blocked ? 'blocked' : null,
        ].filter(Boolean).join(' · ')}
        content={content}
        tone="rose"
      />
    </div>
  );
}

function TimelineMeta({ msg }: { msg: Message }) {
  const depth = Math.max(0, Number(msg.metadata_json?.depth || 0));
  const runId = msg.metadata_json?.run_id;
  const parentRunId = msg.metadata_json?.parent_run_id;
  const tokenLabel = formatTokenCount(msg.total_tokens);
  if (!msg.agent_name && !msg.agent_kind && !runId && !parentRunId && depth === 0 && !tokenLabel) {
    return null;
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-gray-400">
      {msg.agent_name ? <span>{msg.agent_name}</span> : null}
      {msg.agent_kind ? <span className="rounded-full border border-white/10 px-2 py-0.5">{msg.agent_kind}</span> : null}
      {tokenLabel ? <span className="rounded-full border border-emerald-800/50 px-2 py-0.5 normal-case tracking-normal">{tokenLabel}</span> : null}
      {typeof parentRunId === 'number' ? <span className="rounded-full border border-gray-700 px-2 py-0.5">parent {parentRunId}</span> : null}
      {depth > 0 ? <span className="rounded-full border border-amber-700/50 px-2 py-0.5">depth {depth}</span> : null}
    </div>
  );
}

function isChildAssistantMessage(msg: Message) {
  return msg.role === 'assistant' && (Number(msg.metadata_json?.depth || 0) > 0 || Boolean(msg.metadata_json?.delegated_by_agent_id));
}

function isHiddenWorkerTool(msg: Message) {
  return msg.role === 'tool' && msg.event_type === 'tool_result' && Number(msg.metadata_json?.depth || 0) > 0;
}

function isTopLevelAssistantReply(msg: Message) {
  return msg.role === 'assistant' && !isChildAssistantMessage(msg) && msg.event_type === 'message';
}

function isStandaloneRunMarkerMessage(msg: Message) {
  if (!isTopLevelAssistantReply(msg)) return false;
  const content = String(msg.content || '').trim();
  return !content && typeof msg.total_tokens === 'number';
}

function formatTokenCount(value: unknown): string | null {
  const count = Number(value);
  if (!Number.isFinite(count)) return null;
  return `${Math.trunc(count).toLocaleString('it-IT')} token`;
}

function formatDelegationResultContent(content: string): string {
  const text = String(content || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
    const parts = [];
    if (parsed.result) parts.push(String(parsed.result));
    if (Array.isArray(parsed.missing_info) && parsed.missing_info.length > 0) {
      parts.push(`Informazioni mancanti: ${parsed.missing_info.map((entry: unknown) => String(entry)).join(', ')}`);
    }
    if (parts.length > 0) {
      return parsed.status ? `[${String(parsed.status)}] ${parts.join('\n')}` : parts.join('\n');
    }
  } catch {}
  return text;
}

function formatToolContent(message: Message): string {
  const toolName = String(message.metadata_json?.tool_name || '').trim();
  const args = message.metadata_json?.arguments;
  const sections = [];
  if (toolName) {
    sections.push(`Tool: ${toolName}`);
  }
  if (args && typeof args === 'object') {
    sections.push(`Proprieta:\n${JSON.stringify(args, null, 2)}`);
  }
  const result = String(message.content || '').trim();
  if (result) {
    sections.push(`Risultato:\n${result}`);
  }
  return sections.join('\n\n');
}

function getRunMemoryEvents(run: AgentRun): MemoryRunEvent[] {
  const raw = run.guardrail_result_json;
  const parsed = typeof raw === 'string'
    ? (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })()
    : raw;
  return Array.isArray(parsed?.memory_events) ? parsed.memory_events : [];
}

function hasRunningMemoryEvents(chatRuns: AgentRun[]): boolean {
  return chatRuns.some((run) =>
    getRunMemoryEvents(run).some((event) =>
      String(event.type || '').toLowerCase() === 'memory_after'
      && String(event.status || '').toLowerCase() === 'running'
    )
  );
}

function formatAgentActivityName(name?: string | null) {
  return String(name || 'Agente').trim() || 'Agente';
}

function getMessageActivityLabel(message: Message): string | null {
  const agentName = formatAgentActivityName(message.agent_name);
  if (message.event_type === 'delegation') {
    return `Contatta agente ${message.metadata_json?.target_agent_name || 'worker'}`;
  }
  if (message.event_type === 'delegation_result') {
    return `${agentName}: risponde`;
  }
  if (message.role === 'tool') {
    return `${agentName}: tool ${message.metadata_json?.tool_name || 'in esecuzione'}`;
  }
  if (String(message.reasoning || '').trim()) {
    return `${agentName}: thinking`;
  }
  if (message.role === 'assistant' && message.event_type === 'message' && String(message.content || '').trim()) {
    return `${agentName}: risponde`;
  }
  return null;
}

function getMemoryActivityLabel(run: AgentRun): string | null {
  const memoryEvents = getRunMemoryEvents(run);
  const lastMemoryEvent = memoryEvents.at(-1);
  if (!lastMemoryEvent) return null;
  const rawType = String(lastMemoryEvent.type || lastMemoryEvent.label || '').toLowerCase();
  if (rawType.includes('after') || rawType.includes('salvataggio') || rawType.includes('save')) {
    return 'Salvo memorie';
  }
  return 'Cerco memorie';
}

function formatMemoryDetailValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasMemoryDetails(details?: MemoryRunEventDetails | null) {
  if (!details) return false;
  return Boolean(
    String(details.request_summary || '').trim()
      || String(details.contextText || '').trim()
      || (Array.isArray(details.topics) && details.topics.length > 0)
      || (Array.isArray(details.items) && details.items.length > 0)
      || (Array.isArray(details.reusable_info) && details.reusable_info.length > 0)
      || (Array.isArray(details.warnings) && details.warnings.length > 0)
      || details.retrieval
      || details.embedding
      || details.episodes
  );
}

function MemoryDetailsPanel({ details }: { details: MemoryRunEventDetails }) {
  const metricRows = [
    ['Retrieval', details.retrieval],
    ['Embedding', details.embedding],
    ['Episodi', details.episodes],
  ].filter(([, value]) => Boolean(value));

  return (
    <details className="mt-3 rounded-md border border-pink-800/60 bg-black/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-pink-200 marker:hidden">
        <ChevronRightIcon className="h-3.5 w-3.5 details-closed:inline group-open:hidden" />
        <span>Valori memoria</span>
      </summary>
      <div className="space-y-3 border-t border-pink-900/60 px-3 py-3 text-xs text-pink-50">
        {String(details.request_summary || '').trim() || (details.topics?.length || 0) > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {String(details.request_summary || '').trim() ? (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-pink-200/70">Richiesta</div>
                <div className="whitespace-pre-wrap break-words">{details.request_summary}</div>
              </div>
            ) : null}
            {(details.topics?.length || 0) > 0 ? (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-pink-200/70">Argomenti</div>
                <div className="whitespace-pre-wrap break-words">{details.topics?.join(', ')}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        {(details.items?.length || 0) > 0 ? (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-pink-200/70">
              {details.phase === 'after' ? 'Memorie salvate/aggiornate' : 'Memorie recuperate'}
            </div>
            {details.items?.map((item, index) => (
              <div key={`${item.section || 'memory'}-${item.topic || index}-${index}`} className="rounded-md border border-pink-900/60 bg-pink-950/20 px-3 py-2">
                <div className="mb-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-pink-200/70">
                  {item.section ? <span>{item.section}</span> : null}
                  {item.topic ? <span>{item.topic}</span> : null}
                </div>
                <div className="whitespace-pre-wrap break-words">{item.information}</div>
              </div>
            ))}
          </div>
        ) : null}

        {String(details.contextText || '').trim() ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-pink-200/70">ContextText iniettato</div>
            <div className="whitespace-pre-wrap break-words rounded-md border border-pink-900/60 bg-pink-950/20 px-3 py-2">{details.contextText}</div>
          </div>
        ) : null}

        {(details.reusable_info?.length || 0) > 0 ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-pink-200/70">Info riutilizzabili</div>
            <div className="whitespace-pre-wrap break-words">{details.reusable_info?.join('\n')}</div>
          </div>
        ) : null}

        {metricRows.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {metricRows.map(([label, value]) => (
              <div key={String(label)} className="rounded-md border border-pink-900/60 bg-black/20 px-2 py-2">
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-pink-200/70">{String(label)}</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{formatMemoryDetailValue(value)}</pre>
              </div>
            ))}
          </div>
        ) : null}

        {(details.warnings?.length || 0) > 0 ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-pink-200/70">Warning</div>
            <div className="whitespace-pre-wrap break-words text-pink-100">{details.warnings?.join('\n')}</div>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function RunEventBlock({
  label,
  subtitle,
  content,
  tokenCount,
  tone = 'default',
  memoryDetails = null,
}: {
  label: string;
  subtitle?: string | null;
  content: string;
  tokenCount?: number | null;
  tone?: 'default' | 'memory';
  memoryDetails?: MemoryRunEventDetails | null;
}) {
  const tokenLabel = formatTokenCount(tokenCount);
  const toneClasses = tone === 'memory'
    ? 'border-pink-700/50 bg-pink-950/25 text-pink-50'
    : 'border-gray-800 bg-black/20 text-gray-100';
  const metaClasses = tone === 'memory' ? 'text-pink-200/80' : 'text-gray-400';
  const tokenClasses = tone === 'memory' ? 'border-pink-700/60 text-pink-200' : 'border-gray-700';
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClasses}`}>
      <div className={`mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] ${metaClasses}`}>
        <span>{label}</span>
        {subtitle ? <span>{subtitle}</span> : null}
        {tokenLabel ? <span className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${tokenClasses}`}>{tokenLabel}</span> : null}
      </div>
      <div className="whitespace-pre-wrap break-words text-sm">{content}</div>
      {tone === 'memory' && hasMemoryDetails(memoryDetails) ? (
        <MemoryDetailsPanel details={memoryDetails as MemoryRunEventDetails} />
      ) : null}
    </div>
  );
}

export default function AgentChatPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatId = params.chatId as string;
  const agentId = searchParams.get('agentId');
  const isPendingRoute = searchParams.get('pending') === '1';

  const [messages, setMessages] = useState<Message[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedModelConfig, setSelectedModelConfig] = useState<ModelConfig>({ provider: 'ollama', model: 'qwen3.5', ollama_server_id: null });
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [showRunTree, setShowRunTree] = useState(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const [aiOptions, setAiOptions] = useState<AiOptionsResponse | null>(null);
  const [ollamaOptions, setOllamaOptions] = useState<OllamaConnectionOption[]>([]);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const selectedAgentRef = useRef<Agent | null>(null);
  const aiDefaultSelectionRef = useRef<ModelConfig | null>(null);
  const hasInitializedMessagesRef = useRef(false);
  const shouldStickToBottomRef = useRef(false);
  const forceAutoScrollRef = useRef(false);
  const previousMessageCountRef = useRef(0);

  const isNewChat = chatId === 'new';

  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  const readPendingMessages = useCallback((targetChatId: string): Message[] => {
    try {
      const raw = sessionStorage.getItem(`${PENDING_CHAT_STORAGE_PREFIX}${targetChatId}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.messages) ? parsed.messages : [];
    } catch {
      return [];
    }
  }, []);

  const writePendingMessages = useCallback((targetChatId: string, pendingMessages: Message[]) => {
    try {
      sessionStorage.setItem(
        `${PENDING_CHAT_STORAGE_PREFIX}${targetChatId}`,
        JSON.stringify({ messages: pendingMessages })
      );
    } catch {}
  }, []);

  const clearPendingMessages = useCallback((targetChatId: string) => {
    try {
      sessionStorage.removeItem(`${PENDING_CHAT_STORAGE_PREFIX}${targetChatId}`);
    } catch {}
  }, []);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    const nextCount = messages.length;
    const hasNewMessages = nextCount > previousCount;

    previousMessageCountRef.current = nextCount;

    if (!hasInitializedMessagesRef.current) {
      hasInitializedMessagesRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({
          behavior: 'auto',
          block: 'end',
        });
        shouldStickToBottomRef.current = true;
      });
      forceAutoScrollRef.current = false;
      return;
    }

    if (!hasNewMessages) {
      forceAutoScrollRef.current = false;
      return;
    }

    if (!forceAutoScrollRef.current && !shouldStickToBottomRef.current) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: forceAutoScrollRef.current ? 'smooth' : 'auto',
      block: 'end',
    });
    forceAutoScrollRef.current = false;
  }, [messages]);

  const handleConversationScroll = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 80;
  }, []);

  const fetchAgents = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }
    const response = await fetch('/api/agents/catalog', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Impossibile caricare il catalogo agenti.');
    }
    const data = await response.json();
    const nextAgents = Array.isArray(data) ? data : [];
    setAgents(nextAgents);
    return nextAgents;
  }, [router]);

  const fetchAiOptions = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    const response = await fetch('/api/settings/ai/options', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const data = await response.json() as AiOptionsResponse;
    setAiOptions(data);
    setOllamaOptions(Array.isArray(data?.ollama?.connections) ? data.ollama.connections : []);
    aiDefaultSelectionRef.current = data?.default_selection || null;
    setSelectedModelConfig((current) => normalizeModelConfig(current, data?.default_selection));
  }, []);

  const fetchChatMeta = useCallback(async (targetChatId: string) => {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    const response = await fetch(`/api/agent-chats/meta/${targetChatId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const data = await response.json();
    setSelectedModelConfig((current) => normalizeModelConfig(data?.config_json?.model_config || {}, current));
    return data;
  }, []);

  const fetchExistingChat = useCallback(async (
    targetChatId: string,
    options: { markRead?: boolean; tolerateNotFound?: boolean } = {}
  ): Promise<FetchExistingChatResult> => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return { loaded: false, messages: [], runs: [] };
    }

    const [response, runsResponse] = await Promise.all([
      fetch(`/api/agent-chats/${targetChatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(`/api/agent-chats/runs/${targetChatId}?tree=true`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    if (!response.ok) {
      if (options.tolerateNotFound && response.status === 404) {
        return { loaded: false, messages: [], runs: [] };
      }
      throw new Error('Impossibile caricare la chat agente.');
    }

    const data = await response.json();
    const nextMessages = Array.isArray(data) ? data : [];
    let nextRuns: AgentRun[] = [];
    setMessages(nextMessages);
    clearPendingMessages(targetChatId);

    if (runsResponse.ok) {
      const runsData = await runsResponse.json();
      nextRuns = Array.isArray(runsData) ? runsData : [];
      setRuns(nextRuns);
    } else {
      setRuns([]);
    }

    if (options.markRead) {
      await fetch(`/api/agent-chats/${targetChatId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    return { loaded: true, messages: nextMessages, runs: nextRuns };
  }, [clearPendingMessages, router]);

  const fetchChat = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }

    let keepLoading = false;
    try {
      const loadedAgents = await fetchAgents();
      await fetchAiOptions();

      if (isNewChat) {
        const storedAgentId = readLastAgentId();
        const nextSelected = loadedAgents.find((agent) => String(agent.id) === String(agentId))
          || loadedAgents.find((agent) => String(agent.id) === String(storedAgentId))
          || selectedAgentRef.current
          || loadedAgents[0]
          || null;
        setSelectedAgent(nextSelected);
        writeLastAgentId(nextSelected?.id);
        if (nextSelected?.default_model_config) {
          setSelectedModelConfig(normalizeModelConfig(nextSelected.default_model_config, aiDefaultSelectionRef.current));
        }
        setMessages([{
          role: 'assistant',
          content: nextSelected
            ? `Chat pronta con ${nextSelected.name}. Invia una richiesta per iniziare.`
            : 'Seleziona un agente disponibile per iniziare una nuova conversazione.',
        }]);
        setRuns([]);
        setIsLoading(false);
        return;
      }

      const existingChat = await fetchExistingChat(chatId, {
        markRead: true,
        tolerateNotFound: isPendingRoute,
      });
      if (existingChat.loaded) {
        keepLoading = isPendingRoute ? isChatAwaitingLatestReply(existingChat) : hasActiveRuns(existingChat.runs);
        const meta = await fetchChatMeta(chatId);
        writeLastAgentId(meta?.agent_id);
      }

      if (!existingChat.loaded && isPendingRoute) {
        keepLoading = true;
        const pendingMessages = readPendingMessages(chatId);
        setMessages([{
          role: 'assistant',
          content: 'Sto preparando la nuova chat. I messaggi compariranno qui appena il backend completa l\'inizializzazione.',
        }, ...pendingMessages]);
        setRuns([]);
        return;
      }

      if (existingChat.loaded && isPendingRoute && !isChatAwaitingLatestReply(existingChat)) {
        router.replace(`/agent-chat/${chatId}`);
      }
    } catch (error) {
      setMessages([{ role: 'assistant', content: 'Errore nel caricamento della chat agente.' }]);
    } finally {
      setIsLoading(keepLoading);
    }
  }, [agentId, chatId, fetchAgents, fetchAiOptions, fetchChatMeta, fetchExistingChat, isNewChat, isPendingRoute, readPendingMessages, router]);

  useEffect(() => {
    fetchChat();
  }, [fetchChat]);

  useEffect(() => {
    const targetChatId = isNewChat ? pendingChatId : chatId;
    if (!targetChatId) return;
    const shouldPoll = isLoading || isPendingRoute || hasActiveRuns(runs) || hasRunningMemoryEvents(runs);
    if (!shouldPoll) return;

    const intervalId = window.setInterval(() => {
      fetchExistingChat(targetChatId, {
        markRead: false,
        tolerateNotFound: isNewChat || isPendingRoute,
      }).then((result) => {
        if (!result.loaded) return;
        const hasRunningRun = hasActiveRuns(result.runs);
        const shouldKeepWaiting = isPendingRoute || isLoading ? isChatAwaitingLatestReply(result) : hasRunningRun;
        setIsLoading(shouldKeepWaiting);
        if (!isNewChat && isPendingRoute && !shouldKeepWaiting) {
          router.replace(`/agent-chat/${targetChatId}`);
        }
      }).catch(() => {});
    }, 1500);

    return () => window.clearInterval(intervalId);
  }, [chatId, fetchExistingChat, isLoading, isNewChat, isPendingRoute, pendingChatId, router, runs]);

  const hasRunningRun = hasActiveRuns(runs);
  const isBusy = isLoading || hasRunningRun;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || isBusy) return;
    const targetAgent = selectedAgent || agents.find((agent) => String(agent.id) === String(agentId)) || null;
    if (isNewChat && !targetAgent) return;
    writeLastAgentId(targetAgent?.id);

    const submittedInput = input;
    const userMessage: Message = { role: 'user', content: submittedInput };
    forceAutoScrollRef.current = true;
    shouldStickToBottomRef.current = true;
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setIsLoading(true);
    const requestChatId = isNewChat ? createClientUuid() : chatId;
    if (isNewChat) {
      setPendingChatId(requestChatId);
      writePendingMessages(requestChatId, [userMessage]);
      router.replace(`/agent-chat/${requestChatId}?pending=1`);
    }
    let keepWaiting = false;
    try {
      const token = localStorage.getItem('authToken');
      const response = await axios.post('/api/agent-chats', {
        chat_id: requestChatId,
        agent_id: isNewChat ? Number(targetAgent?.id) : undefined,
        model_config: selectedModelConfig,
        messages: [userMessage],
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        timeout: 30000,
      });
      if (isNewChat && response.data?.chat_id) {
        const completedChatId = String(response.data.chat_id);
        setPendingChatId(null);
        clearPendingMessages(completedChatId);
        await fetchExistingChat(completedChatId, {
          markRead: true,
          tolerateNotFound: false,
        });
        const meta = await fetchChatMeta(completedChatId);
        writeLastAgentId(meta?.agent_id);
        router.replace(`/agent-chat/${completedChatId}`);
        window.dispatchEvent(new CustomEvent('agentChatCreated'));
        return;
      }
      window.dispatchEvent(new CustomEvent('agentChatUpdated'));
      await fetchChat();
    } catch (error) {
      if (isAxiosTimeoutError(error)) {
        keepWaiting = true;
        let pendingResult: FetchExistingChatResult | null = null;
        try {
          pendingResult = await fetchExistingChat(requestChatId, {
            markRead: false,
            tolerateNotFound: true,
          });
        } catch {}
        keepWaiting = pendingResult ? isChatAwaitingLatestReply(pendingResult) : true;
      } else {
        setMessages((current) => [...current, { role: 'assistant', content: 'Errore durante l\'esecuzione della chat agente.' }]);
        setPendingChatId(null);
        clearPendingMessages(requestChatId);
      }
    } finally {
      setIsLoading(keepWaiting);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.metaKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (!form) return;
      const submitButton = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      submitButton?.click();
    }
  };

  const fallbackRuns = buildRunsFromMessages(messages);
  const activeRuns = runs.length > 0 ? runs : fallbackRuns;
  const loadingStatus = (() => {
    const runningRuns = activeRuns.filter((run) => run.status === 'running');
    const latestRunningRun = runningRuns.at(-1);
    if (latestRunningRun) {
      const memoryStatus = getMemoryActivityLabel(latestRunningRun);
      if (memoryStatus) return memoryStatus;
    }

    const latestMessageStatus = [...messages]
      .reverse()
      .map((message) => getMessageActivityLabel(message))
      .find(Boolean);
    if (latestMessageStatus) return latestMessageStatus;

    if (latestRunningRun) return `${formatAgentActivityName(latestRunningRun.agent_name)}: thinking`;
    return 'In corso';
  })();
  const modelOptions = useMemo(
    () => buildModelOptions(aiOptions?.catalog, selectedModelConfig),
    [aiOptions?.catalog, selectedModelConfig]
  );
  const agentSelectOptions = useMemo(() => {
    if (!selectedAgent) return agents;
    return agents.some((agent) => agent.id === selectedAgent.id)
      ? agents
      : [selectedAgent, ...agents];
  }, [agents, selectedAgent]);
  const activeRunsByParent = activeRuns.reduce<Record<string, AgentRun[]>>((acc, run) => {
    const key = String(normalizeParentRunId(run.parent_run_id) ?? 'root');
    if (!acc[key]) acc[key] = [];
    acc[key].push(run);
    return acc;
  }, {});
  const activeRunIds = new Set(activeRuns.map((run) => Number(run.id)));
  const rootRuns = activeRuns.filter((run) => {
    const parentRunId = normalizeParentRunId(run.parent_run_id);
    return parentRunId === null || !activeRunIds.has(parentRunId);
  });

  const getDelegationDetailMessages = useCallback((message: Message, index: number) => {
    if (message.event_type !== 'delegation_result') return [];
    const childRunId = message.metadata_json?.run_id;
    if (!Number.isFinite(childRunId)) return [];
    return messages.filter((candidate, candidateIndex) => {
      if (candidateIndex === index) return false;
      if (candidate.role === 'assistant') return false;
      if (candidate.event_type === 'delegation_result') return false;
      if (candidate.event_type === 'delegation') return false;
      return Number(candidate.metadata_json?.run_id) === Number(childRunId);
    });
  }, [messages]);

  const buildPromptDetailForRun = (run: AgentRun, indexedMessages: IndexedMessage[], runIndexedMessages: IndexedMessage[]): RunDetailItem | null => {
    const parentRunId = normalizeParentRunId(run.parent_run_id);
    if (parentRunId === null) {
      const firstRunIndex = runIndexedMessages[0]?.index ?? messages.length;
      const userMessage = [...indexedMessages]
        .reverse()
        .find((entry) => entry.index < firstRunIndex && entry.message.role === 'user');
      if (!userMessage) return null;
      return {
        key: `run-${run.id}-user-message-${userMessage.index}`,
        order: userMessage.index - 0.2,
        label: 'Messaggio utente',
        subtitle: run.agent_name || null,
        content: userMessage.message.content,
      };
    }

    const childResult = runIndexedMessages.find((entry) => entry.message.event_type === 'delegation_result');
    const toolCallId = childResult?.message.metadata_json?.tool_call_id || null;
    const delegatedPrompt = indexedMessages.find((entry) => (
      entry.message.event_type === 'delegation'
      && (
        (toolCallId && entry.message.metadata_json?.tool_call_id === toolCallId)
        || (
          Number(entry.message.metadata_json?.child_agent_id) === Number(run.agent_id)
          && normalizeParentRunId(entry.message.metadata_json?.run_id) === parentRunId
        )
      )
    ));
    if (!delegatedPrompt) return null;
    return {
      key: `run-${run.id}-orchestrator-prompt-${delegatedPrompt.index}`,
      order: delegatedPrompt.index - 0.1,
      label: 'Prompt orchestratore',
      subtitle: delegatedPrompt.message.metadata_json?.target_agent_name || run.agent_name || null,
      content: delegatedPrompt.message.content,
    };
  };

  const buildRunDetailItems = (run: AgentRun): RunDetailItem[] => {
    const indexedMessages = messages.map((message, index) => ({ message, index }));
    const runIndexedMessages = indexedMessages.filter(({ message }) => Number(message.metadata_json?.run_id) === Number(run.id));
    const detailItems: RunDetailItem[] = [];
    const promptDetail = buildPromptDetailForRun(run, indexedMessages, runIndexedMessages);
    if (promptDetail) detailItems.push(promptDetail);

    for (const { message, index } of runIndexedMessages) {
      const content = String(message.content || '').trim();
      const hasReasoning = Boolean(String(message.reasoning || '').trim());

      if (hasReasoning) {
        detailItems.push({
          key: `run-${run.id}-thinking-${index}`,
          order: index,
          label: 'Thinking',
          subtitle: message.agent_name || null,
          content: message.reasoning || '',
          tokenCount: message.event_type === 'model_debug' || !content ? message.total_tokens : null,
        });
      }

      if (message.event_type === 'delegation') {
        detailItems.push({
          key: `run-${run.id}-delegation-${index}`,
          order: index + 0.1,
          label: 'Delega worker',
          subtitle: message.metadata_json?.target_agent_name || message.agent_name || null,
          content,
        });
        continue;
      }

      if (message.event_type === 'delegation_result') {
        detailItems.push({
          key: `run-${run.id}-delegation-result-${index}`,
          order: index + 0.1,
          label: 'Risposta del worker',
          subtitle: message.agent_name || null,
          content: formatDelegationResultContent(content),
        });
        continue;
      }

      if (message.role === 'tool') {
        detailItems.push({
          key: `run-${run.id}-tool-${index}`,
          order: index + 0.1,
          label: 'Tool eseguito',
          subtitle: message.metadata_json?.tool_name || null,
          content: formatToolContent(message),
        });
        continue;
      }

      if (message.role === 'assistant' && message.event_type === 'message' && content) {
        detailItems.push({
          key: `run-${run.id}-assistant-message-${index}`,
          order: index + 0.2,
          label: run.agent_kind === 'worker' ? 'Risposta del worker' : 'Risposta agente',
          subtitle: message.agent_name || null,
          content,
          tokenCount: message.total_tokens,
        });
      }
    }

    const orderedItems = detailItems
      .filter((item) => String(item.content || '').trim())
      .sort((a, b) => a.order - b.order);

    const firstPromptOrder = orderedItems.find((item) => item.label === 'Messaggio utente' || item.label === 'Prompt orchestratore')?.order ?? -1;
    const lastReplyOrder = [...orderedItems]
      .reverse()
      .find((item) => item.label === 'Risposta agente' || item.label === 'Risposta del worker')?.order ?? orderedItems.at(-1)?.order ?? firstPromptOrder;

    const memoryItems = getRunMemoryEvents(run)
      .map((event, index): RunDetailItem => {
        const rawType = String(event.type || event.label || '').toLowerCase();
        const isAfterMemory = rawType.includes('after') || rawType.includes('salvataggio') || rawType.includes('save');
        return {
          key: `run-${run.id}-memory-${event.type || index}`,
          order: isAfterMemory ? lastReplyOrder + 0.3 + index / 100 : firstPromptOrder - 0.3 + index / 100,
          label: event.label || (isAfterMemory ? 'Memory salvataggio' : 'Memory retrieve'),
          subtitle: [event.scope || null, event.status || null].filter(Boolean).join(' · '),
          content: String(event.content || '').trim(),
          tone: 'memory',
          memoryDetails: event.details || null,
        };
      })
      .filter((item) => String(item.content || '').trim());

    return [...orderedItems, ...memoryItems].sort((a, b) => a.order - b.order);
  };

  const renderRunNode = (run: AgentRun, level = 0): React.ReactNode => {
    const children = activeRunsByParent[String(run.id)] || [];
    const detailItems = buildRunDetailItems(run);
    const hasDetails = detailItems.length > 0 || Boolean(run.last_error) || children.length > 0;
    const statusClasses = run.status === 'completed'
      ? 'border-emerald-700/50 text-emerald-300'
      : run.status === 'running'
        ? 'border-amber-700/50 text-amber-300'
        : run.status === 'failed'
          ? 'border-rose-700/50 text-rose-300'
          : 'border-gray-700 text-gray-300';
    const modelLabel = getModelLabel({ provider: run.model_provider || 'ollama', model: run.model_name });
    const startedAt = run.started_at ? new Date(run.started_at).toLocaleString('it-IT') : null;
    const finishedAt = run.finished_at ? new Date(run.finished_at).toLocaleString('it-IT') : null;
    return (
      <div key={run.id} className={level > 0 ? 'ml-4 border-l border-gray-800 pl-3' : ''}>
        <details className="group text-sm text-gray-200">
          <summary className="flex cursor-pointer list-none items-center gap-2 border-y border-gray-800/80 py-2 marker:hidden">
            <span className="text-gray-500 group-open:hidden">
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </span>
            <span className="hidden text-gray-500 group-open:inline-flex">
              <ChevronDownIcon className="h-3.5 w-3.5" />
            </span>
            <span className="font-semibold text-gray-100">{run.agent_name || `Agent ${run.agent_id}`}</span>
            {run.agent_kind ? (
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-gray-400">
                {run.agent_kind}
              </span>
            ) : null}
            <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${statusClasses}`}>
              {run.status}
            </span>
            <span className="min-w-0 truncate text-xs text-gray-500">
              run {run.id} · depth {run.depth} · {modelLabel}
            </span>
          </summary>
          {hasDetails ? (
            <div className="space-y-2 border-b border-gray-800/80 py-2 lg:w-[60vw] lg:max-w-full">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                {typeof run.parent_run_id === 'number' ? <span>parent {run.parent_run_id}</span> : null}
                {startedAt ? <span>start {startedAt}</span> : null}
                {finishedAt ? <span>end {finishedAt}</span> : null}
              </div>
              {run.last_error ? (
                <div className="rounded-md border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                  {run.last_error}
                </div>
              ) : null}
              {detailItems.length > 0 ? (
                <div className="space-y-2">
                  {detailItems.map((item) => (
                    <RunEventBlock
                      key={item.key}
                      label={item.label}
                      subtitle={item.subtitle}
                      content={item.content}
                      tokenCount={item.tokenCount}
                      tone={item.tone}
                      memoryDetails={item.memoryDetails}
                    />
                  ))}
                </div>
              ) : null}
              {children.length > 0 ? (
                <div className="space-y-2">
                  {children.map((child) => renderRunNode(child, level + 1))}
                </div>
              ) : null}
            </div>
          ) : null}
        </details>
      </div>
    );
  };

  const getRunPlacementIndex = (run: AgentRun) => {
    const indexedMessages = messages.map((message, index) => ({ message, index }));
    const runIndexedMessages = indexedMessages.filter(({ message }) => Number(message.metadata_json?.run_id) === Number(run.id));
    const topLevelReply = [...runIndexedMessages]
      .reverse()
      .find(({ message }) => isTopLevelAssistantReply(message) && !isStandaloneRunMarkerMessage(message) && String(message.content || '').trim());
    if (topLevelReply) return topLevelReply.index;

    const firstRunIndex = runIndexedMessages[0]?.index ?? messages.length - 1;
    const previousUserMessage = [...indexedMessages]
      .reverse()
      .find(({ message, index }) => index <= firstRunIndex && message.role === 'user');
    return previousUserMessage?.index ?? Math.max(0, firstRunIndex);
  };

  const runsByConversationIndex = rootRuns.reduce<Map<number, AgentRun[]>>((acc, run) => {
    const index = getRunPlacementIndex(run);
    const current = acc.get(index) || [];
    current.push(run);
    acc.set(index, current);
    return acc;
  }, new Map<number, AgentRun[]>());

  const renderedConversation = (() => {
    const items: React.ReactNode[] = [];

    const pushInlineRuns = (index: number) => {
      if (!showRunTree) return;
      const runsAtIndex = runsByConversationIndex.get(index) || [];
      if (runsAtIndex.length === 0) return;
      items.push(
        <div key={`runs-${index}`} className="flex justify-start">
          <div className="w-full space-y-2">
            {runsAtIndex.map((run) => renderRunNode(run))}
          </div>
        </div>
      );
    };

    messages.forEach((msg, index) => {
      if (msg.role === 'system') return;
      if (isChildAssistantMessage(msg)) return;
      if (isHiddenWorkerTool(msg)) return;

      if (msg.role === 'user') {
        items.push(
          <div key={`user-${index}`} className="flex justify-end">
            <div className="max-w-xs whitespace-pre-wrap rounded-xl bg-sky-600 px-4 py-2 text-white sm:max-w-md lg:max-w-xl">
              {msg.content}
            </div>
          </div>
        );
        pushInlineRuns(index);
        return;
      }

      if (isTopLevelAssistantReply(msg)) {
        if (isStandaloneRunMarkerMessage(msg)) return;
        const hasVisibleReply = Boolean(String(msg.content || '').trim());
        if (!hasVisibleReply) return;
        items.push(
          <div key={`assistant-${index}`} className="flex justify-start">
            <div className="max-w-xs rounded-xl bg-gray-800 px-4 py-3 text-gray-100 sm:max-w-md lg:max-w-2xl">
              <TimelineMeta msg={msg} />
              <div className="markdown-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              </div>
            </div>
          </div>
        );
        pushInlineRuns(index);
      }
    });

    return items;
  })();

  return (
    <div className="flex h-full flex-col bg-gray-900 -mx-4 sm:-mx-6 lg:-mx-8">
      <div className="border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-emerald-300">Agent Chat</p>
            <h1 className="mt-1 text-lg font-semibold text-white">
              {selectedAgent ? `Chat con ${selectedAgent.name}` : 'Chat con agente'}
            </h1>
          </div>
          <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center">
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:w-auto lg:items-center">
              {isNewChat ? (
                <select
                  value={selectedAgent?.id || ''}
                  onChange={(e) => {
                    const nextAgent = agents.find((agent) => String(agent.id) === e.target.value);
                    if (!nextAgent) return;
                    setSelectedAgent(nextAgent);
                    writeLastAgentId(nextAgent.id);
                    if (nextAgent.default_model_config) {
                      setSelectedModelConfig(normalizeModelConfig(nextAgent.default_model_config, aiOptions?.default_selection));
                    }
                  }}
                  disabled={agents.length === 0}
                  className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  {agentSelectOptions.length === 0 ? (
                    <option value="">Nessun agente disponibile</option>
                  ) : null}
                  {agentSelectOptions.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.kind === 'orchestrator' ? 'Orchestrator' : 'Worker'}
                    </option>
                  ))}
                </select>
              ) : null}
              <select
                value={encodeModelValue(selectedModelConfig)}
                onChange={(e) => setSelectedModelConfig((current) => normalizeModelConfig({
                  ...decodeModelValue(e.target.value, current),
                  ollama_server_id: current.ollama_server_id,
                }, current))}
                className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white"
              >
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                value={selectedModelConfig.ollama_server_id || ''}
                onChange={(e) => setSelectedModelConfig((current) => ({
                  ...current,
                  ollama_server_id: e.target.value || null,
                }))}
                disabled={selectedModelConfig.provider !== 'ollama' || ollamaOptions.length === 0}
                className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                <option value="">Server Ollama di default</option>
                {ollamaOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </div>
            {!isNewChat ? (
              <button
                type="button"
                onClick={() => setShowRunTree((current) => !current)}
                className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                {showRunTree ? 'Nascondi dettagli run' : 'Mostra dettagli run'}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          ref={conversationRef}
          onScroll={handleConversationScroll}
          className="min-w-0 flex-1 overflow-y-auto p-4 space-y-4"
        >
          {renderedConversation}
          {isBusy && (
            <LoadingBubble status={loadingStatus} />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-white/10 p-4">
        <form onSubmit={handleSubmit} className="flex items-stretch gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isNewChat && !selectedAgent ? 'Seleziona un agente per iniziare.' : 'Scrivi il tuo messaggio...'}
            disabled={isBusy || (isNewChat && !selectedAgent)}
            className="min-h-12 w-full rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-white"
          />
          <button
            type="submit"
            disabled={!input.trim() || isBusy || (isNewChat && !selectedAgent)}
            className="rounded-xl bg-emerald-600 px-3 text-white disabled:opacity-60"
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        </form>
      </div>
    </div>
  );
}
