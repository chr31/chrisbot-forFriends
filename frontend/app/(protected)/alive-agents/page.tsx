'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AiOptionsResponse,
  buildModelOptions,
  decodeModelValue,
  encodeModelValue,
  getModelLabel,
  ModelConfig,
  normalizeModelConfig,
  OllamaConnectionOption,
} from '../../../lib/aiModels';
import {
  PaperAirplaneIcon,
  PlayIcon,
  PauseIcon,
  TrashIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/solid';

type Agent = {
  id: number;
  name: string;
  slug: string;
  kind: 'worker' | 'orchestrator';
  user_description: string;
  system_prompt?: string;
  goals?: string;
  alive_include_goals?: boolean;
  default_model_config: ModelConfig;
  loop_status?: 'play' | 'pause';
  is_processing?: boolean;
  last_error?: string | null;
  last_message_at?: string | null;
};

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
  } | null;
  agent_id?: number | null;
  agent_name?: string | null;
  agent_kind?: 'worker' | 'orchestrator' | null;
  created_at?: string;
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
};

type AliveDetail = {
  agent: Agent;
  chat: {
    chat_id: string;
    config_json?: {
      model_config?: ModelConfig;
    } | null;
    loop_status: 'play' | 'pause';
    is_processing: boolean;
    next_loop_at?: string | null;
    last_error?: string | null;
  };
  messages: Message[];
  runs: AgentRun[];
};

const LAST_ALIVE_AGENT_STORAGE_PREFIX = 'last-alive-agent-id:';

function getCurrentUserStorageSuffix(): string {
  try {
    const raw = localStorage.getItem('authUser');
    const user = raw ? JSON.parse(raw) : null;
    return String(user?.email || user?.name || 'default');
  } catch {
    return 'default';
  }
}

function readLastAliveAgentId(): string | null {
  try {
    return localStorage.getItem(`${LAST_ALIVE_AGENT_STORAGE_PREFIX}${getCurrentUserStorageSuffix()}`);
  } catch {
    return null;
  }
}

function writeLastAliveAgentId(agentId: string | number | null | undefined) {
  if (agentId === null || agentId === undefined || agentId === '') return;
  try {
    localStorage.setItem(`${LAST_ALIVE_AGENT_STORAGE_PREFIX}${getCurrentUserStorageSuffix()}`, String(agentId));
  } catch {}
}

function normalizeParentRunId(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function LoadingBubble({ label = 'L’agente sta elaborando' }: { label?: string }) {
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
          <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300/80">In corso</div>
        </div>
      </div>
    </div>
  );
}

function TimelineMeta({ msg }: { msg: Message }) {
  const depth = Math.max(0, Number(msg.metadata_json?.depth || 0));
  const runId = msg.metadata_json?.run_id;
  if (!msg.agent_name && !msg.agent_kind && !runId && depth === 0) {
    return null;
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-gray-400">
      {msg.agent_name ? <span>{msg.agent_name}</span> : null}
      {msg.agent_kind ? <span className="rounded-full border border-white/10 px-2 py-0.5">{msg.agent_kind}</span> : null}
      {typeof runId === 'number' ? <span className="rounded-full border border-emerald-800/50 px-2 py-0.5">run {runId}</span> : null}
      {depth > 0 ? <span className="rounded-full border border-amber-700/50 px-2 py-0.5">depth {depth}</span> : null}
    </div>
  );
}

function isStandaloneRunMarkerMessage(msg: Message) {
  const content = String(msg.content || '').trim();
  return msg.role === 'assistant' && msg.event_type === 'message' && !content && typeof msg.total_tokens === 'number';
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

function CollapsibleCard({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900/70 text-gray-100">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-300">{title}</div>
        {isOpen ? <ChevronDownIcon className="h-4 w-4 shrink-0" /> : <ChevronRightIcon className="h-4 w-4 shrink-0" />}
      </button>
      {isOpen ? <div className="border-t border-gray-700/60 px-4 py-3">{children}</div> : null}
    </div>
  );
}

function RunEventBlock({
  label,
  subtitle,
  content,
  tokenCount,
}: {
  label: string;
  subtitle?: string | null;
  content: string;
  tokenCount?: number | null;
}) {
  const tokenLabel = formatTokenCount(tokenCount);
  return (
    <div className="rounded-lg border border-gray-800 bg-black/20 px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-gray-400">
        <span>{label}</span>
        {subtitle ? <span>{subtitle}</span> : null}
        {tokenLabel ? <span className="rounded-full border border-gray-700 px-2 py-0.5 normal-case tracking-normal">{tokenLabel}</span> : null}
      </div>
      <div className="whitespace-pre-wrap break-words text-sm text-gray-100">{content}</div>
    </div>
  );
}

export default function AliveAgentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedAgentId = searchParams.get('agentId');

  const [agents, setAgents] = useState<Agent[]>([]);
  const [detail, setDetail] = useState<AliveDetail | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRunTree, setShowRunTree] = useState(false);
  const [aiOptions, setAiOptions] = useState<AiOptionsResponse | null>(null);
  const [selectedModelConfig, setSelectedModelConfig] = useState<ModelConfig>({ provider: 'ollama', model: 'qwen3.5', ollama_server_id: null });
  const [ollamaOptions, setOllamaOptions] = useState<OllamaConnectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const aiDefaultSelectionRef = useRef<ModelConfig | null>(null);
  const hasInitializedMessagesRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const forceAutoScrollRef = useRef(false);
  const previousMessageCountRef = useRef(0);

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
  }, []);

  const fetchCatalog = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return [];
    }
    const response = await fetch('/api/alive-agents', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Impossibile caricare il catalogo alive agents.');
    }
    const data = await response.json();
    const nextAgents = Array.isArray(data) ? data : [];
    setAgents(nextAgents);
    return nextAgents;
  }, [router]);

  const fetchDetail = useCallback(async (agentId: string | number, options: { preferAgentDefault?: boolean } = {}) => {
    const token = localStorage.getItem('authToken');
    if (!token) return null;
    const response = await fetch(`/api/alive-agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Impossibile caricare la chat alive.');
    }
    const data = await response.json() as AliveDetail;
    setDetail(data);
    setOptimisticMessages([]);
    setSelectedModelConfig((current) => options.preferAgentDefault
      ? normalizeModelConfig(data?.agent?.default_model_config || {}, aiDefaultSelectionRef.current || current)
      : normalizeModelConfig(data?.chat?.config_json?.model_config || {}, data?.agent?.default_model_config || current));
    return data;
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [catalog] = await Promise.all([fetchCatalog(), fetchAiOptions()]);
      const storedAgentId = readLastAliveAgentId();
      const fallbackAgentId = selectedAgentId
        || String(catalog?.find((agent) => String(agent.id) === String(storedAgentId))?.id || '')
        || String(catalog?.[0]?.id || '');
      if (fallbackAgentId) {
        await fetchDetail(fallbackAgentId, { preferAgentDefault: true });
        writeLastAliveAgentId(fallbackAgentId);
        if (selectedAgentId !== fallbackAgentId) {
          router.replace(`/alive-agents?agentId=${fallbackAgentId}`);
        }
      } else {
        setDetail(null);
      }
    } catch (err: any) {
      setError(err?.message || 'Errore inatteso.');
    } finally {
      setIsLoading(false);
    }
  }, [fetchAiOptions, fetchCatalog, fetchDetail, router, selectedAgentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedAgentId || !detail?.chat) return;
    const shouldPoll = detail.chat.loop_status === 'play' || detail.chat.is_processing;
    if (!shouldPoll) return;
    const intervalId = window.setInterval(() => {
      fetchDetail(selectedAgentId).catch(() => undefined);
      fetchCatalog().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(intervalId);
  }, [detail?.chat, fetchCatalog, fetchDetail, selectedAgentId]);

  const visibleMessages = useMemo(
    () => [...(detail?.messages || []), ...optimisticMessages],
    [detail?.messages, optimisticMessages]
  );

  useEffect(() => {
    const nextCount = visibleMessages.length;
    const previousCount = previousMessageCountRef.current;
    const hasNewMessages = nextCount > previousCount;
    previousMessageCountRef.current = nextCount;

    if (!hasInitializedMessagesRef.current) {
      hasInitializedMessagesRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
        shouldStickToBottomRef.current = true;
      });
      return;
    }
    if (!hasNewMessages) return;
    if (!forceAutoScrollRef.current && !shouldStickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({
      behavior: forceAutoScrollRef.current ? 'smooth' : 'auto',
      block: 'end',
    });
    forceAutoScrollRef.current = false;
  }, [visibleMessages]);

  const selectedAgentOption = useMemo(() => {
    if (!detail?.agent) return null;
    return agents.find((agent) => agent.id === detail.agent.id) || detail.agent;
  }, [agents, detail?.agent]);
  const agentSelectOptions = useMemo(() => {
    if (!selectedAgentOption) return agents;
    return agents.some((agent) => agent.id === selectedAgentOption.id)
      ? agents
      : [selectedAgentOption, ...agents];
  }, [agents, selectedAgentOption]);

  const modelOptions = useMemo(
    () => buildModelOptions(aiOptions?.catalog, selectedModelConfig),
    [aiOptions?.catalog, selectedModelConfig]
  );

  const handleSelectAgent = (agent: Agent) => {
    writeLastAliveAgentId(agent.id);
    setSelectedModelConfig(normalizeModelConfig(agent.default_model_config, aiDefaultSelectionRef.current));
    setOptimisticMessages([]);
    router.replace(`/alive-agents?agentId=${agent.id}`);
    fetchDetail(agent.id, { preferAgentDefault: true }).catch(() => undefined);
  };

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail?.agent || !input.trim() || isSubmitting) return;
    const submittedInput = input;
    setIsSubmitting(true);
    setError(null);
    forceAutoScrollRef.current = true;
    shouldStickToBottomRef.current = true;
    setOptimisticMessages((current) => [...current, { role: 'user', content: submittedInput }]);
    setInput('');
    try {
      const token = localStorage.getItem('authToken');
      await axios.post(`/api/alive-agents/${detail.agent.id}/messages`, {
        user_message: submittedInput,
        model_config: selectedModelConfig,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchDetail(detail.agent.id);
      await fetchCatalog();
    } catch (err: any) {
      setOptimisticMessages([]);
      setError(err?.response?.data?.error || err?.message || 'Errore invio messaggio.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMessageKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !event.metaKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const handleTogglePlay = async () => {
    if (!detail?.agent) return;
    const isPlaying = detail.chat.loop_status === 'play';
    const confirmed = window.confirm(
      isPlaying
        ? `Mettere in pausa l'alive agent ${detail.agent.name}?`
        : `Avviare l'alive agent ${detail.agent.name}?`
    );
    if (!confirmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const token = localStorage.getItem('authToken');
      if (isPlaying) {
        await axios.post(`/api/alive-agents/${detail.agent.id}/pause`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } else {
        await axios.post(`/api/alive-agents/${detail.agent.id}/play`, {
          model_config: selectedModelConfig,
        }, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      await fetchDetail(detail.agent.id);
      await fetchCatalog();
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Errore cambio stato play/pause.';
      window.alert(message);
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClear = async () => {
    if (!detail?.agent) return;
    const confirmed = window.confirm(`Eliminare tutto lo storico alive di ${detail.agent.name}?`);
    if (!confirmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const token = localStorage.getItem('authToken');
      await axios.delete(`/api/alive-agents/${detail.agent.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchDetail(detail.agent.id);
      await fetchCatalog();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Errore eliminazione storico.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeRuns = detail?.runs || [];
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
  const handleConversationScroll = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 80;
  }, []);

  const buildPromptDetailForRun = (run: AgentRun, indexedMessages: IndexedMessage[], runIndexedMessages: IndexedMessage[]): RunDetailItem | null => {
    const parentRunId = normalizeParentRunId(run.parent_run_id);
    if (parentRunId === null) {
      const firstRunIndex = runIndexedMessages[0]?.index ?? indexedMessages.length;
      const promptMessage = [...indexedMessages]
        .reverse()
        .find((entry) => (
          entry.index < firstRunIndex
          && (
            entry.message.role === 'user'
            || entry.message.event_type === 'alive_prompt'
          )
        ));
      if (!promptMessage) return null;
      return {
        key: `run-${run.id}-input-message-${promptMessage.index}`,
        order: promptMessage.index - 0.2,
        label: promptMessage.message.event_type === 'alive_prompt' ? 'Prompt alive' : 'Messaggio utente',
        subtitle: run.agent_name || null,
        content: promptMessage.message.content,
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
    const indexedMessages = (detail?.messages || []).map((message, index) => ({ message, index }));
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

    return detailItems
      .filter((item) => String(item.content || '').trim())
      .sort((a, b) => a.order - b.order);
  };

  const renderRunNode = (run: AgentRun): React.ReactNode => {
    const children = activeRunsByParent[String(run.id)] || [];
    const detailItems = buildRunDetailItems(run);
    const hasDetails = detailItems.length > 0;
    return (
      <div key={run.id}>
        <div className="rounded-xl border border-gray-800 bg-gray-950/70 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">{run.agent_name || `Agent ${run.agent_id}`}</span>
            {run.agent_kind ? (
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-gray-300">
                {run.agent_kind}
              </span>
            ) : null}
            <span className="rounded-full border border-emerald-700/50 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-emerald-300">
              {run.status}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-400">
            <span>run {run.id}</span>
            <span>depth {run.depth}</span>
            <span>model {getModelLabel({ provider: run.model_provider || 'ollama', model: run.model_name })}</span>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            start {new Date(run.started_at).toLocaleString('it-IT')}
            {run.finished_at ? ` · end ${new Date(run.finished_at).toLocaleString('it-IT')}` : ''}
          </div>
          {run.last_error ? (
            <div className="mt-2 rounded-lg border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
              {run.last_error}
            </div>
          ) : null}
          {hasDetails ? (
            <div className="mt-3">
              <CollapsibleCard title="Dettagli run">
                <div className="space-y-3">
                  {detailItems.map((item) => (
                    <RunEventBlock
                      key={item.key}
                      label={item.label}
                      subtitle={item.subtitle}
                      content={item.content}
                      tokenCount={item.tokenCount}
                    />
                  ))}
                </div>
              </CollapsibleCard>
            </div>
          ) : null}
        </div>
        {children.length > 0 ? (
          <div className="mt-3 ml-3 space-y-3 border-l border-gray-800 pl-3">
            {children.map((child) => renderRunNode(child))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-gray-900 -mx-4 sm:-mx-6 lg:-mx-8">
      <div className="border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-emerald-300">Alive Agents</p>
            <h1 className="mt-1 text-lg font-semibold text-white">
              {detail?.agent ? `Chat alive con ${detail.agent.name}` : 'Alive agents'}
            </h1>
          </div>
          <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center">
            <select
              value={detail?.agent?.id || ''}
              onChange={(e) => {
                const nextAgent = agents.find((agent) => String(agent.id) === e.target.value);
                if (nextAgent) handleSelectAgent(nextAgent);
              }}
              disabled={agents.length === 0}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {agentSelectOptions.length === 0 ? (
                <option value="">Nessun agent disponibile</option>
              ) : null}
              {agentSelectOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.kind === 'orchestrator' ? 'Orchestrator' : 'Worker'}
                </option>
              ))}
            </select>
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
            <button
              type="button"
              onClick={() => setShowRunTree((current) => !current)}
              className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
            >
              {showRunTree ? 'Nascondi run tree' : 'Mostra run tree'}
            </button>
            {detail?.agent ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  disabled={isSubmitting}
                  aria-label={detail.chat.loop_status === 'play' ? 'Metti in pausa alive agent' : 'Avvia alive agent'}
                  title={detail.chat.loop_status === 'play' ? 'Metti in pausa' : 'Avvia'}
                  className="rounded-lg border border-emerald-700 bg-emerald-600/10 px-3 py-2 text-emerald-100 hover:bg-emerald-600/20 disabled:opacity-50"
                >
                  {detail.chat.loop_status === 'play' ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={isSubmitting}
                  aria-label="Elimina storico alive agent"
                  title="Elimina storico"
                  className="rounded-lg border border-rose-800 px-3 py-2 text-rose-300 hover:bg-rose-950/60 disabled:opacity-50"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div ref={conversationRef} onScroll={handleConversationScroll} className="min-w-0 flex-1 overflow-y-auto p-4 space-y-4">
          {error ? (
            <div className="rounded-xl border border-rose-800/50 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">{error}</div>
          ) : null}
          {detail?.agent?.system_prompt ? (
            <CollapsibleCard title={detail.agent.goals ? 'System Prompt + Goals' : 'System Prompt'}>
              <div className="space-y-3 text-sm text-gray-100">
                <div className="whitespace-pre-wrap">{detail.agent.system_prompt}</div>
                {detail.agent.goals ? (
                  <div className="border-t border-gray-700/60 pt-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300">Goals</div>
                    <div className="whitespace-pre-wrap">{detail.agent.goals}</div>
                  </div>
                ) : null}
              </div>
            </CollapsibleCard>
          ) : null}
          {visibleMessages.filter((msg) => (
            msg.role !== 'system'
            && (msg.role === 'user' || msg.role === 'assistant')
            && !isStandaloneRunMarkerMessage(msg)
          )).map((msg, index) => (
            msg.role === 'user' ? (
              <div key={`user-${index}`} className="flex justify-end">
                <div className="max-w-xs sm:max-w-md lg:max-w-xl rounded-xl bg-sky-600 px-4 py-2 text-white whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={`assistant-${index}`} className="flex justify-start">
                <div className="max-w-xs sm:max-w-md lg:max-w-2xl rounded-xl bg-gray-800 px-4 py-3 text-gray-100">
                  <TimelineMeta msg={msg} />
                  <div className="markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                  {typeof msg.total_tokens === 'number' ? (
                    <div className="mt-2 border-t border-white/10 pt-2 text-[11px] text-gray-400">
                      Token totali: {msg.total_tokens.toLocaleString('it-IT')}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          ))}
          {(isSubmitting || detail?.chat?.is_processing) ? <LoadingBubble /> : null}
          <div ref={messagesEndRef} />
        </div>

        {showRunTree ? (
          <aside className="flex w-full max-w-md shrink-0 flex-col overflow-hidden border-l border-white/10 bg-gray-950/40">
            <div className="border-b border-white/10 px-4 py-3">
              <p className="text-sm font-semibold text-white">Run Tree</p>
              <p className="mt-1 text-xs text-gray-400">Vista tecnica dei run generati dalla chat alive.</p>
            </div>
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
              <div className="space-y-3">
                {rootRuns.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-800 px-3 py-3 text-sm text-gray-500">
                    Nessun run disponibile.
                  </div>
                ) : rootRuns.map((run) => renderRunNode(run))}
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      <div className="border-t border-white/10 p-4">
        <form onSubmit={handleSend} className="flex items-stretch gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleMessageKeyDown}
            placeholder={detail?.agent ? 'Scrivi il tuo messaggio...' : 'Seleziona un alive agent.'}
            disabled={!detail?.agent || isSubmitting || detail?.chat?.is_processing}
            className="min-h-12 w-full rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-white"
          />
          <button
            type="submit"
            disabled={!detail?.agent || !input.trim() || isSubmitting || detail?.chat?.is_processing}
            className="rounded-xl bg-emerald-600 px-3 text-white disabled:opacity-60"
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        </form>
      </div>
    </div>
  );
}
