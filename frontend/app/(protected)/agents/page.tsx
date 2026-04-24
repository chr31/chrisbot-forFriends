'use client';

import { Dialog, Transition } from '@headlessui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { AiOptionsResponse, buildModelOptions, decodeModelValue, encodeModelValue, ModelConfig, normalizeModelConfig, OllamaConnectionOption } from '../../../lib/aiModels';
import {
  XMarkIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
  PlayIcon,
  ShieldCheckIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

type AgentKind = 'worker' | 'orchestrator';
type VisibilityScope = 'public' | 'restricted' | 'private';

type AgentPermission = {
  subject_type: 'user' | 'upn';
  subject_id: string;
  role: 'chat' | 'manage';
};

type AgentRelation = {
  worker_agent_id: number;
  worker_name?: string;
  routing_hint?: string | null;
  is_active?: boolean;
};

type Agent = {
  id: number;
  name: string;
  slug: string;
  kind: AgentKind;
  user_description: string;
  allowed_group_names_csv?: string;
  system_prompt: string;
  default_model_config: ModelConfig;
  guardrails_json: Record<string, unknown>;
  visibility_scope: VisibilityScope;
  direct_chat_enabled: boolean;
  is_alive: boolean;
  alive_loop_seconds: number;
  alive_prompt: string;
  alive_context_messages: number;
  alive_include_goals: boolean;
  goals: string;
  memories: string;
  is_active: boolean;
  tool_names: string[];
  permissions: AgentPermission[];
  relations: AgentRelation[];
};

type QuickAgentUpdates = {
  is_active?: boolean;
  direct_chat_enabled?: boolean;
  visibility_scope?: VisibilityScope;
  model_config?: ModelConfig;
};

type Tool = {
  name: string;
  description: string;
};

type ToolOption = Tool & {
  available: boolean;
  selected: boolean;
};

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

type GuardrailForm = {
  max_tool_rounds: number;
  max_delegations: number;
  max_depth: number;
  extra_json: string;
};

type FormState = {
  id: number | null;
  name: string;
  slug: string;
  kind: AgentKind;
  user_description: string;
  allowed_group_names_csv: string;
  system_prompt: string;
  default_model_config: ModelConfig;
  visibility_scope: VisibilityScope;
  direct_chat_enabled: boolean;
  is_alive: boolean;
  alive_loop_seconds: number;
  alive_prompt: string;
  alive_context_messages: number;
  alive_include_goals: boolean;
  goals: string;
  memories: string;
  is_active: boolean;
  tool_names: string[];
  relations: Array<{
    worker_agent_id: number;
    routing_hint: string;
    is_active: boolean;
  }>;
  permissions_text: string;
  guardrails: GuardrailForm;
};

const DEFAULT_GUARDRAILS: GuardrailForm = {
  max_tool_rounds: 8,
  max_delegations: 3,
  max_depth: 2,
  extra_json: '{}',
};

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  slug: '',
  kind: 'worker',
  user_description: '',
  allowed_group_names_csv: '',
  system_prompt: '',
  default_model_config: { provider: 'ollama', model: 'qwen3.5', ollama_server_id: null },
  visibility_scope: 'public',
  direct_chat_enabled: true,
  is_alive: false,
  alive_loop_seconds: 60,
  alive_prompt: '',
  alive_context_messages: 12,
  alive_include_goals: false,
  goals: '',
  memories: '',
  is_active: true,
  tool_names: [],
  relations: [],
  permissions_text: '',
  guardrails: DEFAULT_GUARDRAILS,
};

function toPositiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function splitGuardrails(raw: Record<string, unknown> | null | undefined): GuardrailForm {
  const source = raw && typeof raw === 'object' ? { ...raw } : {};
  const known = {
    max_tool_rounds: toPositiveInteger(source.max_tool_rounds, 8),
    max_delegations: toPositiveInteger(source.max_delegations, 3),
    max_depth: toPositiveInteger(source.max_depth, 2),
  };
  delete source.max_tool_rounds;
  delete source.max_delegations;
  delete source.max_depth;
  return {
    ...known,
    extra_json: JSON.stringify(source, null, 2),
  };
}

function InfoHint({ label, description }: { label: string; description: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open]);

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={`Info ${label}`}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white"
      >
        <InformationCircleIcon className="h-4 w-4" />
      </button>
      {open && (
        <span className="absolute left-7 top-0 z-10 w-64 rounded-xl border border-gray-800 bg-gray-950 px-3 py-2 text-xs font-normal normal-case tracking-normal text-gray-200 shadow-lg">
          {description}
        </span>
      )}
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-emerald-500' : 'bg-gray-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function CollapsiblePanel({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-4">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-white">{title}</p>
          {subtitle ? <p className="mt-1 text-xs text-gray-400">{subtitle}</p> : null}
        </div>
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
          {isOpen ? 'Nascondi' : 'Mostra'}
        </span>
      </button>
      {isOpen ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function buildGuardrailsPayload(guardrails: GuardrailForm) {
  const extra = JSON.parse(guardrails.extra_json || '{}');
  return {
    ...extra,
    max_tool_rounds: toPositiveInteger(guardrails.max_tool_rounds, 8),
    max_delegations: toPositiveInteger(guardrails.max_delegations, 3),
    max_depth: toPositiveInteger(guardrails.max_depth, 2),
  };
}

function parsePermissions(text: string): AgentPermission[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(':').map((item) => item.trim()).filter(Boolean);
      if (parts.length < 2) return null;
      const role = parts[parts.length - 1] === 'manage' ? 'manage' : 'chat';
      const subjectType = parts[0] === 'upn' ? 'upn' : 'user';
      const subjectId = subjectType === 'upn'
        ? parts.slice(1, -1).join(':')
        : parts.slice(0, -1).join(':');
      return {
        subject_type: subjectType,
        subject_id: subjectId,
        role,
      } as AgentPermission;
    })
    .filter((entry): entry is AgentPermission => Boolean(entry?.subject_id));
}

function formFromAgent(agent: Agent): FormState {
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    kind: agent.kind,
    user_description: agent.user_description || '',
    allowed_group_names_csv: agent.allowed_group_names_csv || '',
    system_prompt: agent.system_prompt,
    default_model_config: normalizeModelConfig(agent.default_model_config),
    visibility_scope: agent.visibility_scope,
    direct_chat_enabled: agent.direct_chat_enabled,
    is_alive: agent.is_alive,
    alive_loop_seconds: agent.alive_loop_seconds || 60,
    alive_prompt: agent.alive_prompt || '',
    alive_context_messages: agent.alive_context_messages || 12,
    alive_include_goals: agent.alive_include_goals,
    goals: agent.goals || '',
    memories: agent.memories || '',
    is_active: agent.is_active,
    tool_names: agent.tool_names || [],
    relations: (agent.relations || [])
      .map((entry) => ({
        worker_agent_id: Number(entry.worker_agent_id),
        routing_hint: String(entry.routing_hint || ''),
        is_active: entry.is_active !== false,
      }))
      .filter((entry) => Number.isFinite(entry.worker_agent_id)),
    permissions_text: (agent.permissions || [])
      .map((entry) => `${entry.subject_type === 'upn' ? `upn:${entry.subject_id}` : entry.subject_id}:${entry.role}`)
      .join('\n'),
    guardrails: splitGuardrails(agent.guardrails_json),
  };
}

export default function AgentsPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [toolSearch, setToolSearch] = useState('');
  const [agentSearch, setAgentSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AgentKind>('orchestrator');
  const [configTab, setConfigTab] = useState<'properties' | 'personalization'>('properties');
  const [aiOptions, setAiOptions] = useState<AiOptionsResponse | null>(null);
  const [ollamaOptions, setOllamaOptions] = useState<OllamaConnectionOption[]>([]);
  const [isAliveSectionOpen, setIsAliveSectionOpen] = useState(false);
  const [aliveLoopSecondsDraft, setAliveLoopSecondsDraft] = useState(String(EMPTY_FORM.alive_loop_seconds));
  const [aliveContextMessagesDraft, setAliveContextMessagesDraft] = useState(String(EMPTY_FORM.alive_context_messages));

  const fetchData = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const meResponse = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!meResponse.ok) {
        throw new Error('Impossibile verificare l’utente corrente.');
      }
      const mePayload = await meResponse.json();
      const nextUser = mePayload?.user || null;
      setAuthUser(nextUser);
      if (!nextUser?.is_super_admin) {
        return;
      }

      const [agentsResponse, toolsResponse, ollamaOptionsResponse] = await Promise.all([
        fetch('/api/agents', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/agents/tools', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/settings/ai/options', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!agentsResponse.ok || !toolsResponse.ok) {
        throw new Error('Impossibile caricare agenti o tool.');
      }
      const [agentsPayload, toolsPayload, ollamaOptionsPayload] = await Promise.all([
        agentsResponse.json(),
        toolsResponse.json(),
        ollamaOptionsResponse.ok ? ollamaOptionsResponse.json() : Promise.resolve({}),
      ]);
      setAgents(Array.isArray(agentsPayload) ? agentsPayload : []);
      setTools(Array.isArray(toolsPayload) ? toolsPayload : []);
      const nextAiOptions = (ollamaOptionsPayload || null) as AiOptionsResponse | null;
      setAiOptions(nextAiOptions);
      setOllamaOptions(Array.isArray(nextAiOptions?.ollama?.connections) ? nextAiOptions.ollama.connections : []);
      setForm((current) => ({
        ...current,
        default_model_config: normalizeModelConfig(current.default_model_config, nextAiOptions?.default_selection || EMPTY_FORM.default_model_config),
      }));
    } catch (err: any) {
      setError(err?.message || 'Errore inatteso.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const normalizedToolSearch = toolSearch.trim().toLowerCase();
  const mergedTools = useMemo<ToolOption[]>(() => {
    const availableByName = new Map(tools.map((tool) => [tool.name, tool]));
    const selectedMissing = form.tool_names
      .filter((toolName) => !availableByName.has(toolName))
      .map((toolName) => ({
        name: toolName,
        description: 'Tool attualmente non disponibile sul server MCP.',
        available: false,
        selected: true,
      }));

    const availableTools = tools.map((tool) => ({
      ...tool,
      available: true,
      selected: form.tool_names.includes(tool.name),
    }));

    return [...availableTools, ...selectedMissing].sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1;
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [tools, form.tool_names]);
  const filteredTools = useMemo(
    () =>
      mergedTools.filter((tool) => {
        if (!normalizedToolSearch) return true;
        return (
          tool.name.toLowerCase().includes(normalizedToolSearch) ||
          tool.description.toLowerCase().includes(normalizedToolSearch)
        );
      }),
    [mergedTools, normalizedToolSearch]
  );

  const normalizedAgentSearch = agentSearch.trim().toLowerCase();
  const searchedAgents = useMemo(
    () =>
      agents.filter((agent) => {
        if (!normalizedAgentSearch) return true;
        return (
          agent.name.toLowerCase().includes(normalizedAgentSearch) ||
          agent.slug.toLowerCase().includes(normalizedAgentSearch) ||
          agent.system_prompt.toLowerCase().includes(normalizedAgentSearch)
        );
      }),
    [agents, normalizedAgentSearch]
  );

  const filteredAgents = useMemo(
    () => searchedAgents.filter((agent) => agent.kind === activeTab),
    [activeTab, searchedAgents]
  );

  const availableChatAgents = useMemo(
    () => filteredAgents.filter((agent) => agent.direct_chat_enabled && agent.is_active),
    [filteredAgents]
  );

  const tabCounts = useMemo(
    () => ({
      worker: searchedAgents.filter((agent) => agent.kind === 'worker').length,
      orchestrator: searchedAgents.filter((agent) => agent.kind === 'orchestrator').length,
    }),
    [searchedAgents]
  );

  const selectedRelationIds = useMemo(
    () => new Set(form.relations.map((entry) => entry.worker_agent_id)),
    [form.relations]
  );
  const workerAgents = useMemo(
    () => agents
      .filter((agent) => agent.id !== form.id)
      .sort((left, right) => {
        const leftSelected = selectedRelationIds.has(left.id);
        const rightSelected = selectedRelationIds.has(right.id);
        if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
        return left.name.localeCompare(right.name, 'it');
      }),
    [agents, form.id, selectedRelationIds]
  );
  const modelOptions = useMemo(
    () => buildModelOptions(aiOptions?.catalog, form.default_model_config),
    [aiOptions?.catalog, form.default_model_config]
  );

  const setGuardrailField = (field: keyof GuardrailForm, value: string | boolean | number) => {
    setForm((current) => ({
      ...current,
      guardrails: {
        ...current.guardrails,
        [field]: value,
      },
    }));
  };

  const setAliveNumberField = (field: 'alive_loop_seconds' | 'alive_context_messages', rawValue: string, fallback: number) => {
    if (field === 'alive_loop_seconds') {
      setAliveLoopSecondsDraft(rawValue);
    } else {
      setAliveContextMessagesDraft(rawValue);
    }

    if (rawValue.trim() === '') return;

    const parsed = toPositiveInteger(rawValue, fallback);
    setForm((current) => ({
      ...current,
      [field]: parsed,
    }));
  };

  const commitAliveNumberField = (field: 'alive_loop_seconds' | 'alive_context_messages', fallback: number) => {
    const rawValue = field === 'alive_loop_seconds' ? aliveLoopSecondsDraft : aliveContextMessagesDraft;
    const parsed = toPositiveInteger(rawValue, fallback);

    setForm((current) => ({
      ...current,
      [field]: parsed,
    }));

    if (field === 'alive_loop_seconds') {
      setAliveLoopSecondsDraft(String(parsed));
    } else {
      setAliveContextMessagesDraft(String(parsed));
    }

    return parsed;
  };

  const setAliveEnabled = (enabled: boolean) => {
    setForm((current) => ({
      ...current,
      is_alive: enabled && current.direct_chat_enabled,
    }));
    if (!enabled) {
      setIsAliveSectionOpen(false);
    }
  };

  const toggleTool = (toolName: string) => {
    setForm((current) => ({
      ...current,
      tool_names: current.tool_names.includes(toolName)
        ? current.tool_names.filter((name) => name !== toolName)
        : [...current.tool_names, toolName],
    }));
  };

  const toggleChild = (agentId: number) => {
    setForm((current) => ({
      ...current,
      relations: current.relations.some((entry) => entry.worker_agent_id === agentId)
        ? current.relations.filter((entry) => entry.worker_agent_id !== agentId)
        : [...current.relations, { worker_agent_id: agentId, routing_hint: '', is_active: true }],
    }));
  };

  const setRelationField = (agentId: number, field: 'routing_hint', value: string) => {
    setForm((current) => ({
      ...current,
      relations: current.relations.map((entry) =>
        entry.worker_agent_id === agentId
          ? { ...entry, [field]: value }
          : entry
      ),
    }));
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setAliveLoopSecondsDraft(String(EMPTY_FORM.alive_loop_seconds));
    setAliveContextMessagesDraft(String(EMPTY_FORM.alive_context_messages));
    setSuccess(null);
    setError(null);
    setToolSearch('');
    setConfigTab('properties');
    setIsAliveSectionOpen(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }

    try {
      const normalizedAliveLoopSeconds = commitAliveNumberField('alive_loop_seconds', 60);
      const normalizedAliveContextMessages = commitAliveNumberField('alive_context_messages', 12);
      const payload = {
        name: form.name,
        slug: form.slug || undefined,
        kind: form.kind,
        user_description: form.user_description,
        system_prompt: form.system_prompt,
        allowed_group_names_csv: form.allowed_group_names_csv,
        default_model_config: form.default_model_config,
        visibility_scope: form.visibility_scope,
        direct_chat_enabled: form.direct_chat_enabled,
        is_alive: form.direct_chat_enabled ? form.is_alive : false,
        alive_loop_seconds: normalizedAliveLoopSeconds,
        alive_prompt: form.alive_prompt,
        alive_context_messages: normalizedAliveContextMessages,
        alive_include_goals: form.alive_include_goals,
        goals: form.goals,
        memories: form.memories,
        is_active: form.is_active,
        tool_names: form.tool_names,
        relations: form.kind === 'orchestrator'
          ? form.relations.map((entry) => ({ ...entry, is_active: true }))
          : [],
        permissions: parsePermissions(form.permissions_text),
        guardrails: buildGuardrailsPayload(form.guardrails),
      };

      const response = await fetch(form.id ? `/api/agents/${form.id}` : '/api/agents', {
        method: form.id ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || 'Salvataggio non riuscito.');
      }

      setSuccess(form.id ? 'Agente aggiornato.' : 'Agente creato.');
      setForm(formFromAgent(body));
      if (!form.id) {
        setIsConfigOpen(false);
      }
      window.dispatchEvent(new CustomEvent('agentCatalogUpdated'));
      fetchData();
    } catch (err: any) {
      setError(err?.message || 'Errore nel salvataggio.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (agentId: number) => {
    const targetAgent = agents.find((entry) => entry.id === agentId);
    const confirmed = window.confirm(
      `Confermi l'eliminazione dell'agente${targetAgent?.name ? ` "${targetAgent.name}"` : ''}?`
    );
    if (!confirmed) return;

    const token = localStorage.getItem('authToken');
    if (!token) return;
    try {
      const response = await fetch(`/api/agents/${agentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || 'Eliminazione non riuscita.');
      }
      if (form.id === agentId) {
        resetForm();
        setIsConfigOpen(false);
      }
      window.dispatchEvent(new CustomEvent('agentCatalogUpdated'));
      fetchData();
    } catch (err: any) {
      setError(err?.message || 'Errore in eliminazione.');
    }
  };

  const handleQuickUpdate = async (agent: Agent, updates: QuickAgentUpdates) => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }

    setError(null);
    try {
      const payload = {
        name: agent.name,
        slug: agent.slug || undefined,
        kind: agent.kind,
        user_description: agent.user_description,
        system_prompt: agent.system_prompt,
        allowed_group_names_csv: agent.allowed_group_names_csv || '',
        model_config: updates.model_config ?? agent.default_model_config,
        visibility_scope: updates.visibility_scope ?? agent.visibility_scope,
        direct_chat_enabled: updates.direct_chat_enabled ?? agent.direct_chat_enabled,
        is_active: updates.is_active ?? agent.is_active,
        tool_names: agent.tool_names,
        relations: agent.kind === 'orchestrator'
          ? (agent.relations || []).map((entry) => ({
            worker_agent_id: Number(entry.worker_agent_id),
            routing_hint: String(entry.routing_hint || ''),
            is_active: entry.is_active !== false,
          }))
          : [],
        permissions: agent.permissions || [],
        guardrails: agent.guardrails_json || {},
      };

      const response = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Aggiornamento rapido non riuscito.');
      }
      setAgents((current) => current.map((entry) => (entry.id === agent.id ? body : entry)));
      if (form.id === agent.id) {
        setForm(formFromAgent(body));
      }
      window.dispatchEvent(new CustomEvent('agentCatalogUpdated'));
    } catch (err: any) {
      setError(err?.message || 'Errore nell’aggiornamento rapido.');
    }
  };

  const openCreateModal = () => {
    const nextForm = {
      ...EMPTY_FORM,
      kind: activeTab,
      default_model_config: normalizeModelConfig(aiOptions?.default_selection, EMPTY_FORM.default_model_config),
      guardrails: DEFAULT_GUARDRAILS,
    };
    setForm(nextForm);
    setAliveLoopSecondsDraft(String(nextForm.alive_loop_seconds));
    setAliveContextMessagesDraft(String(nextForm.alive_context_messages));
    setSuccess(null);
    setError(null);
    setToolSearch('');
    setConfigTab('properties');
    setIsAliveSectionOpen(false);
    setIsConfigOpen(true);
  };

  const openEditModal = (agent: Agent) => {
    const nextForm = {
      ...formFromAgent(agent),
      default_model_config: normalizeModelConfig(agent.default_model_config, aiOptions?.default_selection || EMPTY_FORM.default_model_config),
    };
    setForm((current) => ({
      ...current,
      ...nextForm,
    }));
    setAliveLoopSecondsDraft(String(nextForm.alive_loop_seconds));
    setAliveContextMessagesDraft(String(nextForm.alive_context_messages));
    setSuccess(null);
    setError(null);
    setToolSearch('');
    setConfigTab('properties');
    setIsAliveSectionOpen(false);
    setIsConfigOpen(true);
  };

  if (!isLoading && authUser && !authUser.is_super_admin) {
    return <div className="p-8 text-white">Accesso riservato agli amministratori.</div>;
  }

  return (
    <div className="py-6 sm:py-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-sky-300">Agent Lab</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Agenti e orchestratori</h1>
              <p className="mt-2 max-w-3xl text-sm text-gray-300">
                Crea agenti di worker o orchestratore.
              </p>
            </div>
          </div>


          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-2xl border border-gray-800 bg-gray-950/70 p-1">
              {([
                { key: 'orchestrator', label: 'Orchestrator', count: tabCounts.orchestrator },
                { key: 'worker', label: 'Worker', count: tabCounts.worker },
              ] as Array<{ key: AgentKind; label: string; count: number }>).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                    activeTab === tab.key
                      ? 'bg-sky-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {tab.label} ({tab.count})
                </button>
              ))}
            </div>

            <div className="flex flex-1 items-center justify-end gap-3">
              <div className="flex w-full max-w-xs items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2">
                <MagnifyingGlassIcon className="h-4 w-4 text-gray-400" />
                <input
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Cerca agente..."
                  className="w-full bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
                />
              </div>
              <button
                type="button"
                onClick={openCreateModal}
                aria-label="Nuovo agente"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600 text-white hover:bg-sky-500"
              >
                <PlusIcon className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="mt-5 hidden grid-cols-[96px_minmax(0,1.2fr)_minmax(0,1fr)_160px_110px_128px] gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 lg:grid">
            <div>Attivo</div>
            <div>Nome</div>
            <div>Modello</div>
            <div>Visibilità</div>
            <div>Chat</div>
            <div>Azioni</div>
          </div>

          <div className="mt-4 space-y-4">
            {isLoading && <div className="text-sm text-gray-300">Caricamento agenti...</div>}
            {!isLoading && filteredAgents.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-700 p-4 text-sm text-gray-400">
                Nessun {activeTab === 'worker' ? 'worker' : 'orchestrator'} trovato con i filtri correnti.
              </div>
            )}
            {filteredAgents.map((agent) => (
              <div key={agent.id} className="border-b border-gray-800/80 pb-4 last:border-b-0">
                <div className="grid gap-3 lg:grid-cols-[96px_minmax(0,1.2fr)_minmax(0,1fr)_160px_110px_128px] lg:items-start">
                  <div className="min-w-0 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Attivo</div>
                    <Toggle
                      checked={agent.is_active}
                      onChange={() => handleQuickUpdate(agent, { is_active: !agent.is_active })}
                    />
                  </div>

                  <div className="min-w-0 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Nome</div>
                    <div>
                      <p className="text-sm font-semibold text-white">{agent.name}</p>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Modello</div>
                    <select
                      value={encodeModelValue(agent.default_model_config)}
                      onChange={(e) => handleQuickUpdate(agent, {
                        model_config: normalizeModelConfig(
                          decodeModelValue(e.target.value, agent.default_model_config),
                          agent.default_model_config
                        ),
                      })}
                      className="min-h-10 w-full min-w-0 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm text-gray-100 outline-none transition focus:border-sky-500"
                    >
                      {buildModelOptions(aiOptions?.catalog, agent.default_model_config).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Visibilità</div>
                    <select
                      value={agent.visibility_scope}
                      onChange={(e) => handleQuickUpdate(agent, {
                        visibility_scope: e.target.value as VisibilityScope,
                      })}
                      className="min-h-10 w-full min-w-0 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm capitalize text-gray-100 outline-none transition focus:border-sky-500"
                    >
                      <option value="public">public</option>
                      <option value="restricted">restricted</option>
                      <option value="private">private</option>
                    </select>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Chat</div>
                    <Toggle
                      checked={agent.direct_chat_enabled}
                      onChange={() => handleQuickUpdate(agent, { direct_chat_enabled: !agent.direct_chat_enabled })}
                    />
                  </div>

                  <div className="min-w-0 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Azioni</div>
                    <div className="flex items-start justify-start gap-2 lg:justify-end">
                      <button
                        type="button"
                        onClick={() => router.push(`/agent-chat/new?agentId=${agent.id}`)}
                        aria-label={`Apri chat con ${agent.name}`}
                        disabled={!agent.direct_chat_enabled}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-700/50 bg-emerald-600/10 text-emerald-100 hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <PlayIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(agent)}
                        aria-label={`Modifica ${agent.name}`}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-700 text-gray-100 hover:bg-gray-800"
                      >
                        <PencilSquareIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(agent.id)}
                        aria-label={`Elimina ${agent.name}`}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-rose-800 text-rose-300 hover:bg-rose-950/60"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Transition.Root show={isConfigOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsConfigOpen}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-900/80" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-start justify-center p-4 sm:p-6">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-200"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-150"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="w-full max-w-5xl rounded-3xl border border-gray-800 bg-gray-900 p-5 shadow-xl sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-sky-200">
                        <ShieldCheckIcon className="h-5 w-5" />
                        {form.id ? 'Configurazione agente' : 'Nuovo agente'}
                      </Dialog.Title>
                      <p className="mt-1 text-sm text-gray-400">
                        Definisci comportamento, tool, permessi e relazioni di orchestrazione.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsConfigOpen(false)}
                      className="rounded-xl border border-gray-700 p-2 text-gray-300 hover:bg-gray-800 hover:text-white"
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>
                  </div>

                  <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                    <div className="inline-flex rounded-2xl border border-gray-800 bg-gray-950/70 p-1">
                      <button
                        type="button"
                        onClick={() => setConfigTab('properties')}
                        className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${configTab === 'properties' ? 'bg-sky-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                      >
                        Proprieta
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfigTab('personalization')}
                        className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${configTab === 'personalization' ? 'bg-sky-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                      >
                        Personalizzazione
                      </button>
                    </div>

                    {configTab === 'properties' ? (
                      <>
                        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,0.55fr)_minmax(0,0.55fr)_minmax(0,0.55fr)]">
                          <label className="text-sm text-gray-200">
                            <span className="mb-1 flex items-center gap-2">Nome <InfoHint label="Nome" description="Etichetta leggibile dell'agente. E usata in UI, timeline e strumenti di delega." /></span>
                            <input
                              value={form.name}
                              onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
                              className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                              required
                            />
                          </label>
                          <label className="text-sm text-gray-200">
                            <span className="mb-1 flex items-center gap-2">Tipo <InfoHint label="Tipo" description="Worker esegue task e usa tool. Orchestrator può anche delegare ai sotto-agenti configurati." /></span>
                            <select
                              value={form.kind}
                              onChange={(e) => setForm((current) => ({ ...current, kind: e.target.value as AgentKind }))}
                              className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                            >
                              <option value="worker">worker</option>
                              <option value="orchestrator">orchestrator</option>
                            </select>
                          </label>
                          <label className="text-sm text-gray-200">
                            <span className="mb-1 flex items-center gap-2">Modello <InfoHint label="Modello" description="Modello predefinito usato per le nuove chat di questo agente, salvo override manuale." /></span>
                            <select
                              value={encodeModelValue(form.default_model_config)}
                              onChange={(e) => setForm((current) => ({
                                ...current,
                                default_model_config: normalizeModelConfig(
                                  decodeModelValue(e.target.value, current.default_model_config),
                                  current.default_model_config
                                ),
                              }))}
                              className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                            >
                              {modelOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </label>
                          <label className="text-sm text-gray-200">
                            <span className="mb-1 flex items-center gap-2">Server Ollama <InfoHint label="Server Ollama" description="Opzionale. Se valorizzato, l'agente usera quel server quando il provider selezionato e Ollama." /></span>
                            <select
                              value={form.default_model_config.ollama_server_id || ''}
                              onChange={(e) => setForm((current) => ({
                                ...current,
                                default_model_config: {
                                  ...current.default_model_config,
                                  ollama_server_id: e.target.value || null,
                                },
                              }))}
                              disabled={form.default_model_config.provider !== 'ollama'}
                              className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white disabled:opacity-50"
                            >
                              <option value="">Default globale</option>
                              {ollamaOptions.map((option) => (
                                <option key={option.id} value={option.id}>{option.name}</option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.55fr)_minmax(0,1.45fr)]">
                          <label className="text-sm text-gray-200">
                            <span className="mb-1 flex items-center gap-2">Visibilità <InfoHint label="Visibilità" description="Public rende l'agente accessibile a tutti gli utenti autorizzati dal flusso base. Restricted/private preparano il terreno per policy più strette." /></span>
                            <select
                              value={form.visibility_scope}
                              onChange={(e) => setForm((current) => ({ ...current, visibility_scope: e.target.value as VisibilityScope }))}
                              className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                            >
                              <option value="public">public</option>
                              <option value="restricted">restricted</option>
                              <option value="private">private</option>
                            </select>
                          </label>
                          <div className="space-y-4">
                            <label className="block text-sm text-gray-200">
                              <span className="mb-1 flex items-center gap-2">Gruppi Azure abilitati <InfoHint label="Gruppi Azure abilitati" description="Elenco gruppi Azure separati da virgola che possono accedere a questo agente. Puoi usare nomi parlanti mappati nella sezione Impostazioni oppure direttamente gli Object ID Azure. I membri di `chrisbot.admin` hanno sempre accesso anche se qui non indicati." /></span>
                              <input
                                value={form.allowed_group_names_csv}
                                onChange={(e) => setForm((current) => ({ ...current, allowed_group_names_csv: e.target.value }))}
                                className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                                placeholder="es. chrisbot.admin, chrisbot.helpdesk"
                              />
                            </label>
                          </div>
                        </div>

                        <label className="block text-sm text-gray-200">
                          <span className="mb-1 flex items-center gap-2">Permessi utente / UPN <InfoHint label="Permessi utente / UPN" description="Autorizzazioni esplicite per singoli utenti. Usa `username:chat` o `username:manage` per l'identificativo interno, oppure `upn:nome.cognome@azienda.it:chat` e `upn:nome.cognome@azienda.it:manage` per un vincolo esplicito sul UPN Azure." /></span>
                          <span className="mb-2 block text-xs text-gray-400">Una riga per permesso. Formati supportati: `username:chat`, `username:manage`, `upn:nome.cognome@azienda.it:chat`, `upn:nome.cognome@azienda.it:manage`.</span>
                          <textarea
                            value={form.permissions_text}
                            onChange={(e) => setForm((current) => ({ ...current, permissions_text: e.target.value }))}
                            className="min-h-24 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white"
                          />
                        </label>

                        <CollapsiblePanel
                          title="Guardrail"
                          subtitle="Limiti strutturati per iterazioni, deleghe e profondita. Il JSON extra resta disponibile per estensioni future."
                        >
                          <div className="grid gap-4 sm:grid-cols-2">
                            <label className="text-sm text-gray-200">
                              <span className="mb-1 flex items-center gap-2">Max tool rounds <InfoHint label="Max tool rounds" description="Numero massimo di cicli assistant -> tool -> assistant concessi in una singola run." /></span>
                              <input
                            type="number"
                            min={1}
                            value={form.guardrails.max_tool_rounds}
                            onChange={(e) => setGuardrailField('max_tool_rounds', e.target.value)}
                            className="w-full rounded-xl border border-gray-700 bg-black/20 px-3 py-2 text-white"
                          />
                        </label>
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 flex items-center gap-2">Max delegations <InfoHint label="Max delegations" description="Quante deleghe a sotto-agenti può eseguire un orchestratore prima che la run venga bloccata." /></span>
                          <input
                            type="number"
                            min={0}
                            value={form.guardrails.max_delegations}
                            onChange={(e) => setGuardrailField('max_delegations', e.target.value)}
                            className="w-full rounded-xl border border-gray-700 bg-black/20 px-3 py-2 text-white"
                          />
                        </label>
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 flex items-center gap-2">Max depth <InfoHint label="Max depth" description="Profondità massima dell'albero di run padre-figlio. Evita catene di delega troppo profonde." /></span>
                          <input
                            type="number"
                            min={0}
                            value={form.guardrails.max_depth}
                            onChange={(e) => setGuardrailField('max_depth', e.target.value)}
                            className="w-full rounded-xl border border-gray-700 bg-black/20 px-3 py-2 text-white"
                          />
                        </label>
                      </div>
                      <label className="mt-4 block text-sm text-gray-200">
                        <span className="mb-1 flex items-center gap-2">Extra guardrails JSON <InfoHint label="Extra guardrails JSON" description="Campi avanzati non ancora modellati in UI. Restano serializzati insieme ai guardrail principali." /></span>
                          <textarea
                            value={form.guardrails.extra_json}
                            onChange={(e) => setGuardrailField('extra_json', e.target.value)}
                            className="min-h-24 w-full rounded-xl border border-gray-700 bg-black/20 px-3 py-2 font-mono text-sm text-white"
                          />
                        </label>
                        </CollapsiblePanel>

                        <div>
                          <div className="flex items-center justify-between gap-3">
                            <p className="flex items-center gap-2 text-sm font-medium text-gray-200">Tool MCP assegnati <InfoHint label="Tool MCP assegnati" description="Elenco delle funzioni MCP che l'agente può invocare. Per gli orchestratori puoi limitarli ai soli tool necessari." /></p>
                            <div className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2">
                              <MagnifyingGlassIcon className="h-4 w-4 text-gray-400" />
                              <input
                                value={toolSearch}
                                onChange={(e) => setToolSearch(e.target.value)}
                                placeholder="Filtra nome o descrizione..."
                                className="w-56 bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
                              />
                            </div>
                          </div>
                          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-2xl border border-gray-800 bg-gray-950/80 p-3">
                            {filteredTools.length === 0 && (
                              <div className="text-sm text-gray-400">Nessun tool corrisponde alla ricerca.</div>
                            )}
                            {filteredTools.map((tool) => (
                              <label key={tool.name} className={`flex items-start gap-3 text-sm ${tool.available ? 'text-gray-200' : 'text-gray-500'}`}>
                                <input
                                  type="checkbox"
                                  checked={tool.selected}
                                  disabled={!tool.available}
                                  onChange={() => toggleTool(tool.name)}
                                  className="mt-1 h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                                />
                                <span>
                                  <span className="block font-medium text-white">
                                    {tool.name}
                                    {!tool.available ? ' · non disponibile' : ''}
                                  </span>
                                  <span className="text-xs text-gray-400">{tool.description}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>

                        {form.kind === 'orchestrator' && (
                          <div>
                            <p className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-200">Sotto-agenti delegabili <InfoHint label="Sotto-agenti delegabili" description="Worker che l'orchestratore può chiamare come strumenti virtuali di delega." /></p>
                            <div className="max-h-64 space-y-3 overflow-y-auto rounded-2xl border border-gray-800 bg-gray-950/80 p-3">
                              {workerAgents.map((agent) => (
                                <div key={agent.id} className="rounded-xl border border-gray-800 bg-black/20 p-3">
                                  <label className="flex items-center gap-3 text-sm text-gray-200">
                                    <input
                                      type="checkbox"
                                      checked={selectedRelationIds.has(agent.id)}
                                      onChange={() => toggleChild(agent.id)}
                                      className="h-4 w-4 accent-emerald-500"
                                    />
                                    <span>{agent.name}</span>
                                  </label>
                                  {selectedRelationIds.has(agent.id) && (
                                    <div className="mt-3">
                                      <label className="block text-sm text-gray-200">
                                        <span className="mb-1 flex items-center gap-2">Routing hint <InfoHint label="Routing hint" description="Testo breve usato nel contesto dell'orchestratore per spiegare quando delegare a questo sotto-agente." /></span>
                                        <input
                                          value={form.relations.find((entry) => entry.worker_agent_id === agent.id)?.routing_hint || ''}
                                          onChange={(e) => setRelationField(agent.id, 'routing_hint', e.target.value)}
                                          placeholder="Es: usa questo agente per AV, sale e supporto eventi"
                                          className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                                        />
                                      </label>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className={`rounded-2xl border p-4 ${
                          form.is_alive ? 'border-emerald-800/40 bg-emerald-950/10' : 'border-gray-800 bg-gray-950/60'
                        }`}>
                          <div className="flex items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => form.is_alive && setIsAliveSectionOpen((current) => !current)}
                              disabled={!form.is_alive}
                              className="min-w-0 text-left disabled:cursor-default"
                            >
                              <span className="block text-sm font-semibold text-white">Alive mode</span>
                            </button>
                            <div className="flex items-center gap-3">
                              {form.is_alive ? (
                                <button
                                  type="button"
                                  onClick={() => setIsAliveSectionOpen((current) => !current)}
                                  className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 hover:text-white"
                                >
                                  {isAliveSectionOpen ? 'Nascondi' : 'Mostra'}
                                </button>
                              ) : null}
                              <Toggle
                                checked={form.is_alive}
                                onChange={() => setAliveEnabled(!form.is_alive)}
                                disabled={!form.direct_chat_enabled}
                              />
                            </div>
                          </div>
                          {form.is_alive && isAliveSectionOpen ? (
                            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
                                <div className="space-y-4">
                                  <label className="block text-sm text-gray-200">
                                    <span className="mb-1 flex items-center gap-2">Secondi loop <InfoHint label="Secondi loop" description="Intervallo in secondi tra una risposta dell'agente e il successivo invio automatico del prompt alive." /></span>
                                    <input
                                      type="number"
                                      min={1}
                                      value={aliveLoopSecondsDraft}
                                      onChange={(e) => setAliveNumberField('alive_loop_seconds', e.target.value, 60)}
                                      onBlur={() => commitAliveNumberField('alive_loop_seconds', 60)}
                                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                                    />
                                  </label>
                                  <label className="block text-sm text-gray-200">
                                    <span className="mb-1 flex items-center gap-2">Context message <InfoHint label="Context message" description="Numero massimo di messaggi visibili user/assistant inviati al modello a ogni iterazione." /></span>
                                    <input
                                      type="number"
                                      min={1}
                                      value={aliveContextMessagesDraft}
                                      onChange={(e) => setAliveNumberField('alive_context_messages', e.target.value, 12)}
                                      onBlur={() => commitAliveNumberField('alive_context_messages', 12)}
                                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                                    />
                                  </label>
                                </div>
                                <label className="block text-sm text-gray-200">
                                  <span className="mb-1 flex items-center gap-2">Prompt alive <InfoHint label="Prompt alive" description="Prompt utente riutilizzato dal loop automatico quando la chat resta in play." /></span>
                                  <textarea
                                    value={form.alive_prompt}
                                    onChange={(e) => setForm((current) => ({ ...current, alive_prompt: e.target.value }))}
                                    className="min-h-[10.5rem] w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                                  />
                                </label>
                              </div>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="block text-sm text-gray-200">
                          <span className="mb-1 flex items-center gap-2">Descrizione utente <InfoHint label="Descrizione utente" description="Testo breve mostrato in chat per aiutare l'utente a capire quando usare questo agente." /></span>
                          <textarea
                            value={form.user_description}
                            onChange={(e) => setForm((current) => ({ ...current, user_description: e.target.value }))}
                            className="min-h-24 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                            placeholder="Spiega in modo semplice cosa fa questo agente e quando conviene usarlo."
                          />
                        </label>

                        <label className="block text-sm text-gray-200">
                          <span className="mb-1 flex items-center gap-2">Prompt di sistema <InfoHint label="Prompt di sistema" description="Istruzioni di comportamento dell'agente. Definiscono ruolo, stile, vincoli e obiettivi operativi." /></span>
                          <textarea
                            value={form.system_prompt}
                            onChange={(e) => setForm((current) => ({ ...current, system_prompt: e.target.value }))}
                            className="min-h-32 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                            required
                          />
                        </label>

                        <label className="block text-sm text-gray-200">
                          <span className="mb-1 flex flex-wrap items-center justify-between gap-3">
                            <span className="flex items-center gap-2">Goals <InfoHint label="Goals" description="Obiettivi persistenti dell'agente. Possono essere letti/modificati anche tramite i tool interni get/edit goals." /></span>
                          </span>
                          <textarea
                            value={form.goals}
                            onChange={(e) => setForm((current) => ({ ...current, goals: e.target.value }))}
                            className="min-h-24 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                          />
                        </label>

                        <label className="block text-sm text-gray-200">
                          <span className="mb-1 flex items-center gap-2">Memories <InfoHint label="Memories" description="Memoria persistente dell'agente. Può essere letta/modificata anche tramite i tool interni get/edit memories." /></span>
                          <textarea
                            value={form.memories}
                            onChange={(e) => setForm((current) => ({ ...current, memories: e.target.value }))}
                            className="min-h-24 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                          />
                        </label>
                      </>
                    )}

                    {error && <p className="text-sm text-rose-300">{error}</p>}
                    {success && <p className="text-sm text-emerald-300">{success}</p>}

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-4 text-sm text-gray-200">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={form.direct_chat_enabled}
                            onChange={(e) => {
                              setForm((current) => ({
                                ...current,
                                direct_chat_enabled: e.target.checked,
                                is_alive: e.target.checked ? current.is_alive : false,
                              }));
                              if (!e.target.checked) {
                                setIsAliveSectionOpen(false);
                              }
                            }}
                            className="h-4 w-4 accent-sky-500"
                          />
                          Chat diretta abilitata
                          <InfoHint label="Chat diretta abilitata" description="Se disattivata, l'agente non può essere scelto per chat diretta ma può ancora essere usato come sotto-agente." />
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={form.is_active}
                            onChange={(e) => setForm((current) => ({ ...current, is_active: e.target.checked }))}
                            className="h-4 w-4 accent-sky-500"
                          />
                          Agente attivo
                          <InfoHint label="Agente attivo" description="Disabilita temporaneamente l'agente senza eliminarne configurazione, chat e storico." />
                        </label>
                      </div>
                      <div className="ml-auto flex items-center gap-3">
                        <button
                          type="submit"
                          disabled={isSaving}
                          className="rounded-xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
                        >
                          {isSaving ? 'Salvataggio...' : form.id ? 'Aggiorna agente' : 'Crea agente'}
                        </button>
                        {form.id && (
                          <button
                            type="button"
                            onClick={() => handleDelete(form.id as number)}
                            className="rounded-xl border border-rose-800 px-4 py-3 text-sm text-rose-300 hover:bg-rose-950/60"
                          >
                            Elimina
                          </button>
                        )}
                      </div>
                    </div>
                  </form>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>
    </div>
  );
}
