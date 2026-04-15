'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AiOptionsResponse, buildModelOptions, decodeModelValue, encodeModelValue, ModelConfig, normalizeModelConfig, OllamaConnectionOption } from '../../../lib/aiModels';

type Agent = {
  id: number;
  name: string;
  kind: 'worker' | 'orchestrator';
  is_active: boolean;
};

type Task = {
  id: number;
  title: string;
  description?: string | null;
  status: 'draft' | 'pending' | 'scheduled' | 'running' | 'needs_confirmation' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  schedule_json?: {
    mode?: 'cron' | 'once';
    cron?: string | null;
    run_at?: string | null;
  } | null;
  worker_agent_id?: number | null;
  notification_type?: string | null;
  notifications_enabled: boolean;
  is_active: boolean;
  payload_json?: {
    request_text?: string;
    notification_label?: string;
    model_config?: ModelConfig | null;
  } | null;
  needs_confirmation: boolean;
  latest_run_id?: number | null;
  latest_run_status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null;
  latest_run_trigger_type?: string | null;
  latest_run_started_at?: string | null;
  latest_run_finished_at?: string | null;
  latest_run_last_error?: string | null;
  latest_run_metadata_json?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type TaskRun = {
  id: number;
  task_id: number;
  agent_id?: number | null;
  chat_id?: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger_type: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  metadata_json?: Record<string, unknown> | null;
  created_at: string;
};

type TaskEvent = {
  id: number;
  task_id: number;
  task_run_id?: number | null;
  event_type: string;
  actor_type?: string | null;
  actor_id?: string | null;
  content?: string | null;
  payload_json?: Record<string, unknown> | null;
  created_at: string;
};

type TaskDetail = Task & {
  assignments?: Array<{
    subject_type: string;
    subject_id: string;
    role: string;
  }>;
  runs: TaskRun[];
  events: TaskEvent[];
};

type ScheduleMode = 'cron' | 'once';
type ModalTab = 'config' | 'runs' | 'events';
type PlanningView = 'tasks' | 'routines';
type RuntimeStatus = {
  enabled: boolean;
  state: 'on' | 'off';
  active_jobs: number;
};

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

type LegacyRoutine = {
  name: string;
  title: string;
  description: string;
  entrypoint?: string | null;
  runtime?: string | null;
  template_id?: string | null;
  sync_status?: 'ready' | 'missing' | 'error' | null;
  version?: number | null;
  cron_expression?: string | null;
  is_active: boolean;
  is_running: boolean;
  last_run_id?: number | null;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  last_status?: 'running' | 'completed' | 'failed' | null;
  last_error?: string | null;
  last_triggered_by?: string | null;
};

type RoutineTemplate = {
  id: string;
  name: string;
  description: string;
};

type RoutineDraftRow = {
  localId: string;
  title: string;
  description: string;
  cron_expression: string;
  is_active: boolean;
  template_id: string;
};

type RoutineFormState = {
  title: string;
  description: string;
  cron_expression: string;
  is_active: boolean;
};

function buildRoutineSlug(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

function createRoutineDraft(templateId = 'basic-node'): RoutineDraftRow {
  return {
    localId: `routine-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '',
    description: '',
    cron_expression: '',
    is_active: false,
    template_id: templateId,
  };
}

function buildRoutineInfo(routine: LegacyRoutine) {
  return [
    `Stato: ${routine.is_running ? 'running' : routine.last_status || 'idle'}`,
    `Run: ${routine.last_run_id ?? 'n/d'}`,
    `Sync: ${routine.sync_status || 'n/d'}`,
    `Avvio: ${routine.last_started_at ? new Date(routine.last_started_at).toLocaleString('it-IT') : 'n/d'}`,
    `Fine: ${routine.last_finished_at ? new Date(routine.last_finished_at).toLocaleString('it-IT') : 'n/d'}`,
    `Trigger: ${routine.last_triggered_by || 'n/d'}`,
  ];
}

type TaskFormState = {
  title: string;
  description: string;
  schedule_mode: ScheduleMode;
  scheduler_cron: string;
  run_at: string;
  worker_agent_id: string;
  request_text: string;
  notification_label: string;
  model_config: ModelConfig;
  notifications_enabled: boolean;
  is_active: boolean;
  needs_confirmation: boolean;
};

const TASKS_PER_PAGE = 20;

const EMPTY_FORM: TaskFormState = {
  title: '',
  description: '',
  schedule_mode: 'cron',
  scheduler_cron: '0 * * * *',
  run_at: '',
  worker_agent_id: '',
  request_text: '',
  notification_label: '',
  model_config: { provider: 'ollama', model: 'qwen3.5', ollama_server_id: null },
  notifications_enabled: true,
  is_active: true,
  needs_confirmation: false,
};

function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return '';
  const normalized = String(value).trim();
  if (!normalized) return '';
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (match) return `${match[1]}T${match[2]}`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function formatSchedule(task: Task) {
  const mode = task.schedule_json?.mode || 'cron';
  if (mode === 'once') {
    if (!task.schedule_json?.run_at) return 'Una tantum';
    return new Date(task.schedule_json.run_at).toLocaleString('it-IT');
  }
  return task.schedule_json?.cron || '-';
}

function getRunTone(status: Task['latest_run_status']) {
  switch (status) {
    case 'running':
      return 'border-amber-700/50 bg-amber-600/10 text-amber-100';
    case 'completed':
      return 'border-emerald-700/50 bg-emerald-600/10 text-emerald-100';
    case 'failed':
      return 'border-rose-700/50 bg-rose-600/10 text-rose-100';
    case 'cancelled':
      return 'border-gray-700 bg-gray-800 text-gray-300';
    default:
      return 'border-sky-700/50 bg-sky-600/10 text-sky-100';
  }
}

function getStatusTone(status: Task['status']) {
  switch (status) {
    case 'scheduled':
    case 'running':
      return 'border-amber-700/50 bg-amber-600/10 text-amber-100';
    case 'completed':
      return 'border-emerald-700/50 bg-emerald-600/10 text-emerald-100';
    case 'failed':
    case 'blocked':
      return 'border-rose-700/50 bg-rose-600/10 text-rose-100';
    default:
      return 'border-gray-700 bg-gray-800 text-gray-200';
  }
}

function getRunPreview(run: TaskRun) {
  const preview = run.metadata_json?.result_preview;
  return typeof preview === 'string' ? preview.trim() : '';
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

function IconButton({
  label,
  onClick,
  disabled = false,
  tone = 'default',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'success' | 'danger';
  children: React.ReactNode;
}) {
  const toneClassName = tone === 'success'
    ? 'border-emerald-700/60 text-emerald-100 hover:bg-emerald-900/30'
    : tone === 'danger'
      ? 'border-rose-800 text-rose-300 hover:bg-rose-950/60'
      : 'border-gray-700 text-gray-100 hover:bg-gray-800';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${toneClassName} disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

function buildFormFromTask(task: Task): TaskFormState {
  return {
    title: task.title || '',
    description: task.description || '',
    schedule_mode: task.schedule_json?.mode === 'once' ? 'once' : 'cron',
    scheduler_cron: task.schedule_json?.cron || '0 * * * *',
    run_at: toDateTimeLocalValue(task.schedule_json?.run_at),
    worker_agent_id: task.worker_agent_id ? String(task.worker_agent_id) : '',
    request_text: String(task.payload_json?.request_text || ''),
    notification_label: String(task.notification_type || task.payload_json?.notification_label || ''),
    model_config: normalizeModelConfig(task.payload_json?.model_config || {}),
    notifications_enabled: Boolean(task.notifications_enabled),
    is_active: Boolean(task.is_active),
    needs_confirmation: Boolean(task.needs_confirmation),
  };
}

export default function TaskPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [legacyRoutines, setLegacyRoutines] = useState<LegacyRoutine[]>([]);
  const [routineTemplates, setRoutineTemplates] = useState<RoutineTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [notificationFilter, setNotificationFilter] = useState<'all' | 'on' | 'off'>('all');
  const [executorFilter, setExecutorFilter] = useState('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [activeTab, setActiveTab] = useState<ModalTab>('config');
  const [form, setForm] = useState<TaskFormState>(EMPTY_FORM);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [aiOptions, setAiOptions] = useState<AiOptionsResponse | null>(null);
  const [ollamaOptions, setOllamaOptions] = useState<OllamaConnectionOption[]>([]);
  const [isRuntimeUpdating, setIsRuntimeUpdating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isBulkUpdatingActive, setIsBulkUpdatingActive] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null);
  const [runningLegacyRoutineName, setRunningLegacyRoutineName] = useState<string | null>(null);
  const [savingLegacyRoutineName, setSavingLegacyRoutineName] = useState<string | null>(null);
  const [legacyRoutineForm, setLegacyRoutineForm] = useState<Record<string, RoutineFormState>>({});
  const [routineSearch, setRoutineSearch] = useState('');
  const [draftRoutineRows, setDraftRoutineRows] = useState<RoutineDraftRow[]>([]);
  const [routineSources, setRoutineSources] = useState<Record<string, string>>({});
  const [editingRoutineName, setEditingRoutineName] = useState<string | null>(null);
  const [loadingRoutineSourceName, setLoadingRoutineSourceName] = useState<string | null>(null);
  const [savingRoutineSourceName, setSavingRoutineSourceName] = useState<string | null>(null);
  const [deletingRoutineName, setDeletingRoutineName] = useState<string | null>(null);
  const [planningView, setPlanningView] = useState<PlanningView>('tasks');
  const [currentPage, setCurrentPage] = useState(1);
  const [cronPrompt, setCronPrompt] = useState('');
  const [isGeneratingCron, setIsGeneratingCron] = useState(false);
  const [cronSummary, setCronSummary] = useState<string[]>([]);
  const [cronAssumptions, setCronAssumptions] = useState<string[]>([]);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const bulkMenuRef = useRef<HTMLDivElement | null>(null);
  const [isBulkMenuOpen, setIsBulkMenuOpen] = useState(false);

  useEffect(() => {
    if (!isBulkMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (bulkMenuRef.current?.contains(target)) return;
      setIsBulkMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isBulkMenuOpen]);

  const authFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = localStorage.getItem('authToken');
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }, []);

  const fetchTasks = useCallback(async () => {
    const response = await authFetch('/api/tasks');
    if (!response.ok) throw new Error('Impossibile caricare i task.');
    const data = await response.json();
    setTasks(Array.isArray(data) ? data : []);
  }, [authFetch]);

  const fetchAgents = useCallback(async () => {
    const response = await authFetch('/api/agents');
    if (!response.ok) throw new Error('Impossibile caricare gli agenti.');
    const data = await response.json();
    const nextAgents = (Array.isArray(data) ? data : [])
      .filter((agent) => agent?.is_active)
      .map((agent) => ({
        id: Number(agent.id),
        name: String(agent.name || ''),
        kind: (agent.kind === 'orchestrator' ? 'orchestrator' : 'worker') as Agent['kind'],
        is_active: Boolean(agent.is_active),
      }));
    setAgents(nextAgents);
  }, [authFetch]);

  const fetchTaskDetail = useCallback(async (taskId: number) => {
    const response = await authFetch(`/api/tasks/${taskId}`);
    if (!response.ok) throw new Error('Impossibile caricare il dettaglio task.');
    const data = await response.json();
    setTaskDetail(data);
    return data as TaskDetail;
  }, [authFetch]);

  const fetchRuntimeStatus = useCallback(async () => {
    const response = await authFetch('/api/tasks/runtime/status');
    if (!response.ok) throw new Error('Impossibile caricare lo stato runtime task.');
    const data = await response.json();
    setRuntimeStatus(data);
  }, [authFetch]);

  const fetchAiOptions = useCallback(async () => {
    const response = await authFetch('/api/settings/ai/options');
    if (!response.ok) throw new Error('Impossibile caricare le opzioni AI.');
    const data = await response.json() as AiOptionsResponse;
    setAiOptions(data);
    setOllamaOptions(Array.isArray(data?.ollama?.connections) ? data.ollama.connections : []);
    setForm((current) => ({
      ...current,
      model_config: normalizeModelConfig(current.model_config, data?.default_selection),
    }));
  }, [authFetch]);

  const fetchAuthUser = useCallback(async () => {
    const cachedRaw = localStorage.getItem('authUser');
    if (cachedRaw) {
      try {
        const cachedUser = JSON.parse(cachedRaw) as AuthUser;
        setAuthUser(cachedUser);
      } catch (_) {}
    }

    const response = await authFetch('/api/auth/me');
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const nextUser = data?.user || null;
    setAuthUser(nextUser);
    if (nextUser) {
      localStorage.setItem('authUser', JSON.stringify(nextUser));
    }
    return nextUser as AuthUser | null;
  }, [authFetch]);

  const fetchLegacyRoutines = useCallback(async () => {
    const response = await authFetch('/api/tasks/legacy-routines');
    if (response.status === 403) {
      setLegacyRoutines([]);
      return;
    }
    if (!response.ok) throw new Error('Impossibile caricare le routine Node legacy.');
    const data = await response.json();
    const routines = Array.isArray(data) ? data : [];
    setLegacyRoutines(routines);
    setLegacyRoutineForm((current) => {
      const next = { ...current };
      for (const routine of routines) {
        next[routine.name] = {
          title: String(routine.title || ''),
          description: String(routine.description || ''),
          cron_expression: String(routine.cron_expression || ''),
          is_active: Boolean(routine.is_active),
        };
      }
      return next;
    });
  }, [authFetch]);

  const fetchRoutineTemplates = useCallback(async () => {
    const response = await authFetch('/api/tasks/legacy-routines/templates');
    if (response.status === 403) {
      setRoutineTemplates([]);
      return;
    }
    if (!response.ok) throw new Error('Impossibile caricare i template routine.');
    const data = await response.json();
    const templates = Array.isArray(data) ? data : [];
    setRoutineTemplates(templates);
  }, [authFetch]);

  const loadPage = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextUser = await fetchAuthUser();
      if (!nextUser?.is_super_admin) {
        setTasks([]);
        setAgents([]);
        setLegacyRoutines([]);
        return;
      }
      await Promise.all([
        fetchTasks(),
        fetchAgents(),
        fetchRuntimeStatus(),
        fetchAiOptions(),
        fetchLegacyRoutines(),
        fetchRoutineTemplates(),
      ]);
    } catch (err: any) {
      setError(err?.message || 'Errore inatteso.');
    } finally {
      setIsLoading(false);
    }
  }, [fetchAgents, fetchAiOptions, fetchAuthUser, fetchLegacyRoutines, fetchRoutineTemplates, fetchRuntimeStatus, fetchTasks]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  useEffect(() => {
    if (!legacyRoutines.some((routine) => routine.is_running)) return;
    const intervalId = window.setInterval(() => {
      fetchLegacyRoutines().catch(() => {});
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [fetchLegacyRoutines, legacyRoutines]);

  const filteredTasks = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesSearch = !normalized || (
        task.title.toLowerCase().includes(normalized) ||
        String(task.description || '').toLowerCase().includes(normalized) ||
        String(task.payload_json?.request_text || '').toLowerCase().includes(normalized)
      );

      const taskCategory = task.notification_type || 'Task';
      const matchesCategory = categoryFilter === 'all' || taskCategory === categoryFilter;

      const matchesNotifications = notificationFilter === 'all'
        || (notificationFilter === 'on' && task.notifications_enabled)
        || (notificationFilter === 'off' && !task.notifications_enabled);

      const taskExecutor = task.worker_agent_id ? String(task.worker_agent_id) : 'unassigned';
      const matchesExecutor = executorFilter === 'all' || taskExecutor === executorFilter;

      return matchesSearch && matchesCategory && matchesNotifications && matchesExecutor;
    });
  }, [categoryFilter, executorFilter, notificationFilter, search, tasks]);

  const filteredRoutines = useMemo(() => {
    const normalized = routineSearch.trim().toLowerCase();
    return legacyRoutines.filter((routine) => {
      if (!normalized) return true;
      return (
        String(routine.title || '').toLowerCase().includes(normalized)
        || String(routine.description || '').toLowerCase().includes(normalized)
        || String(routine.cron_expression || '').toLowerCase().includes(normalized)
      );
    });
  }, [legacyRoutines, routineSearch]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, categoryFilter, notificationFilter, executorFilter]);

  const totalTaskPages = useMemo(
    () => Math.max(1, Math.ceil(filteredTasks.length / TASKS_PER_PAGE)),
    [filteredTasks.length]
  );

  useEffect(() => {
    if (currentPage > totalTaskPages) {
      setCurrentPage(totalTaskPages);
    }
  }, [currentPage, totalTaskPages]);

  const paginatedTasks = useMemo(() => {
    const startIndex = (currentPage - 1) * TASKS_PER_PAGE;
    return filteredTasks.slice(startIndex, startIndex + TASKS_PER_PAGE);
  }, [currentPage, filteredTasks]);

  const paginationLabel = useMemo(() => {
    if (filteredTasks.length === 0) return '0-0 di 0';
    const startIndex = (currentPage - 1) * TASKS_PER_PAGE + 1;
    const endIndex = Math.min(filteredTasks.length, startIndex + TASKS_PER_PAGE - 1);
    return `${startIndex}-${endIndex} di ${filteredTasks.length}`;
  }, [currentPage, filteredTasks.length]);

  const areAllTasksActive = useMemo(
    () => tasks.length > 0 && tasks.every((task) => task.is_active),
    [tasks]
  );
  const categoryOptions = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.notification_type || 'Task'))).sort((a, b) => a.localeCompare(b, 'it')),
    [tasks]
  );

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents]
  );
  const modelOptions = useMemo(
    () => buildModelOptions(aiOptions?.catalog, form.model_config),
    [aiOptions?.catalog, form.model_config]
  );
  const executorOptions = useMemo(() => {
    const assignedAgentIds = new Set(
      tasks
        .map((task) => task.worker_agent_id)
        .filter((agentId): agentId is number => Number.isFinite(agentId))
    );

    return agents
      .filter((agent) => assignedAgentIds.has(agent.id))
      .map((agent) => ({ id: String(agent.id), label: `${agent.name} (${agent.kind})` }))
      .sort((a, b) => a.label.localeCompare(b.label, 'it'));
  }, [agents, tasks]);

  const openCreateModal = () => {
    setEditingTaskId(null);
    setTaskDetail(null);
    setForm({
      ...EMPTY_FORM,
      model_config: normalizeModelConfig(aiOptions?.default_selection, EMPTY_FORM.model_config),
    });
    setActiveTab('config');
    setCronPrompt('');
    setCronSummary([]);
    setCronAssumptions([]);
    setIsModalOpen(true);
  };

  const openEditModal = async (task: Task) => {
    setEditingTaskId(task.id);
    setForm(buildFormFromTask(task));
    setActiveTab('config');
    setCronPrompt('');
    setCronSummary([]);
    setCronAssumptions([]);
    setIsModalOpen(true);
    try {
      await fetchTaskDetail(task.id);
    } catch (err: any) {
      setError(err?.message || 'Errore nel caricamento task.');
    }
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingTaskId(null);
    setTaskDetail(null);
    setForm({
      ...EMPTY_FORM,
      model_config: normalizeModelConfig(aiOptions?.default_selection, EMPTY_FORM.model_config),
    });
    setActiveTab('config');
    setCronPrompt('');
    setCronSummary([]);
    setCronAssumptions([]);
  };

  const handleGenerateCron = async () => {
    const prompt = cronPrompt.trim();
    if (!prompt) {
      alert('Inserisci una richiesta naturale per generare la cron.');
      return;
    }

    setIsGeneratingCron(true);
    try {
      const response = await authFetch('/api/tasks/generate-cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome',
          model_config: form.model_config,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Generazione cron non riuscita.');
      }
      setForm((current) => ({
        ...current,
        schedule_mode: 'cron',
        scheduler_cron: String(body?.cron_expression || current.scheduler_cron),
      }));
      setCronSummary(Array.isArray(body?.summary) ? body.summary.map((entry: unknown) => String(entry)) : []);
      setCronAssumptions(Array.isArray(body?.assumptions) ? body.assumptions.map((entry: unknown) => String(entry)) : []);
    } catch (err: any) {
      alert(err?.message || 'Errore durante la generazione della cron.');
    } finally {
      setIsGeneratingCron(false);
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.title.trim()) {
      alert('Inserisci un titolo task.');
      return;
    }
    if (!form.worker_agent_id) {
      alert('Seleziona l\'agente che eseguirà il task.');
      return;
    }
    if (!form.request_text.trim()) {
      alert('Inserisci la richiesta operativa del task.');
      return;
    }
    if (form.schedule_mode === 'cron' && !form.scheduler_cron.trim()) {
      alert('Inserisci una stringa cron valida.');
      return;
    }
    if (form.schedule_mode === 'once' && !form.run_at.trim()) {
      alert('Inserisci data e ora di esecuzione.');
      return;
    }

    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      status: 'scheduled',
      worker_agent_id: Number(form.worker_agent_id),
      notification_type: form.notification_label.trim() || null,
      notifications_enabled: form.notifications_enabled,
      is_active: form.is_active,
      needs_confirmation: form.needs_confirmation,
      schedule_json: form.schedule_mode === 'cron'
        ? { mode: 'cron', cron: form.scheduler_cron.trim() }
        : { mode: 'once', run_at: form.run_at },
      payload_json: {
        request_text: form.request_text.trim(),
        notification_label: form.notification_label.trim() || null,
        model_config: form.model_config,
      },
    };

    setIsSaving(true);
    try {
      const response = await authFetch(editingTaskId ? `/api/tasks/${editingTaskId}` : '/api/tasks', {
        method: editingTaskId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Salvataggio non riuscito.');
      }
      await loadPage();
      if (editingTaskId) {
        const updatedId = Number(body?.id || editingTaskId);
        await fetchTaskDetail(updatedId);
        setEditingTaskId(updatedId);
      } else {
        closeModal();
      }
    } catch (err: any) {
      alert(err?.message || 'Errore nel salvataggio del task.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (taskId: number) => {
    const confirmed = window.confirm('Confermi l\'eliminazione di questo task?');
    if (!confirmed) return;
    try {
      const response = await authFetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Eliminazione non riuscita.');
      await loadPage();
      if (editingTaskId === taskId) closeModal();
    } catch {
      alert('Errore durante l\'eliminazione del task.');
    }
  };

  const handleToggleActive = async (task: Task) => {
    try {
      const response = await authFetch(`/api/tasks/${task.id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !task.is_active }),
      });
      if (!response.ok) throw new Error('Aggiornamento task fallito.');
      await loadPage();
      if (editingTaskId === task.id) {
        await fetchTaskDetail(task.id);
      }
    } catch {
      alert('Errore durante l\'attivazione/disattivazione del task.');
    }
  };

  const handleToggleAllActive = async () => {
    if (tasks.length === 0) return;
    setIsBulkUpdatingActive(true);
    try {
      const response = await authFetch('/api/tasks/active', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !areAllTasksActive }),
      });
      if (!response.ok) throw new Error('Aggiornamento massivo task fallito.');
      await loadPage();
      if (editingTaskId) {
        await fetchTaskDetail(editingTaskId);
      }
    } catch {
      alert('Errore durante l\'attivazione/disattivazione massiva dei task.');
    } finally {
      setIsBulkUpdatingActive(false);
    }
  };

  const handleToggleNotifications = async (task: Task) => {
    try {
      const response = await authFetch(`/api/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notifications_enabled: !task.notifications_enabled,
        }),
      });
      if (!response.ok) throw new Error('Aggiornamento notifiche fallito.');
      await loadPage();
      if (editingTaskId === task.id) {
        await fetchTaskDetail(task.id);
      }
    } catch {
      alert('Errore durante l\'aggiornamento delle notifiche del task.');
    }
  };

  const handleRunNow = async (task: Task) => {
    setRunningTaskId(task.id);
    try {
      const response = await authFetch(`/api/tasks/${task.id}/run`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = body?.reason ? ` (${body.reason})` : '';
        throw new Error(`${body?.error || 'Task non avviato'}${reason}`);
      }
      await loadPage();
      if (editingTaskId === task.id) {
        await fetchTaskDetail(task.id);
      }
      alert(`Task avviato. Run ID: ${body?.run_id ?? 'n/d'}.`);
    } catch (err: any) {
      alert(err?.message || 'Errore durante l\'esecuzione del task.');
    } finally {
      setRunningTaskId(null);
    }
  };

  const handleToggleRuntime = async () => {
    setIsRuntimeUpdating(true);
    try {
      const nextAction = runtimeStatus?.enabled ? 'off' : 'on';
      const response = await authFetch(`/api/tasks/runtime/${nextAction}`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Aggiornamento runtime fallito.');
      const body = await response.json();
      setRuntimeStatus(body?.status || null);
      if (nextAction === 'on') {
        await fetchTasks();
      }
    } catch {
      alert('Errore durante l\'aggiornamento del runtime task.');
    } finally {
      setIsRuntimeUpdating(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const response = await authFetch('/api/tasks/export');
      if (!response.ok) throw new Error('Export non riuscito.');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `tasks-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante l\'export dei task.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsImporting(true);
    try {
      const csv = await file.text();
      const response = await authFetch('/api/tasks/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Import non riuscito.');
      }
      await loadPage();
      const errors = Array.isArray(body?.errors) && body.errors.length > 0
        ? `\n\nDettagli:\n${body.errors.slice(0, 10).join('\n')}`
        : '';
      alert(`Import completato. Creati: ${body?.created ?? 0}. Saltati: ${body?.skipped ?? 0}.${errors}`);
    } catch (err: any) {
      alert(err?.message || 'Errore durante l\'import dei task.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleRunLegacyRoutine = async (routineName: string) => {
    setRunningLegacyRoutineName(routineName);
    try {
      const response = await authFetch(`/api/tasks/legacy-routines/${routineName}/run`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Routine non avviata.');
      }
      await fetchLegacyRoutines();
      alert(`Routine ${routineName} avviata.`);
    } catch (err: any) {
      alert(err?.message || `Errore durante l'avvio della routine ${routineName}.`);
    } finally {
      setRunningLegacyRoutineName(null);
    }
  };

  const saveLegacyRoutineMetadata = async (routineName: string) => {
    const draft = legacyRoutineForm[routineName];
    if (!draft) {
      return null;
    }

    const response = await authFetch(`/api/tasks/legacy-routines/${routineName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        template_id: legacyRoutines.find((entry) => entry.name === routineName)?.template_id || null,
        cron_expression: draft.cron_expression.trim(),
        is_active: draft.is_active,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error || 'Routine non aggiornata.');
    }
    return body;
  };

  const handleSaveLegacyRoutine = async (routineName: string) => {
    setSavingLegacyRoutineName(routineName);
    try {
      await saveLegacyRoutineMetadata(routineName);
      await fetchLegacyRoutines();
    } catch (err: any) {
      alert(err?.message || `Errore durante il salvataggio della routine ${routineName}.`);
    } finally {
      setSavingLegacyRoutineName(null);
    }
  };

  const handleOpenRoutineEditor = async (routineName: string) => {
    setEditingRoutineName(routineName);
    if (routineSources[routineName] !== undefined) return;
    setLoadingRoutineSourceName(routineName);
    try {
      const response = await authFetch(`/api/tasks/legacy-routines/${routineName}/source`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Impossibile caricare il sorgente routine.');
      }
      setRoutineSources((current) => ({
        ...current,
        [routineName]: String(body?.source || ''),
      }));
    } catch (err: any) {
      alert(err?.message || `Errore durante il caricamento della routine ${routineName}.`);
      setEditingRoutineName(null);
    } finally {
      setLoadingRoutineSourceName(null);
    }
  };

  const closeRoutineEditor = () => {
    setEditingRoutineName(null);
  };

  const handleSaveRoutineSource = async (routineName: string) => {
    const source = routineSources[routineName];
    if (!source?.trim()) {
      alert('Inserisci il codice della routine.');
      return;
    }
    setSavingRoutineSourceName(routineName);
    try {
      await saveLegacyRoutineMetadata(routineName);
      const response = await authFetch(`/api/tasks/legacy-routines/${routineName}/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Salvataggio routine non riuscito.');
      }
      await fetchLegacyRoutines();
      alert(`Routine ${routineName} salvata.`);
    } catch (err: any) {
      alert(err?.message || `Errore durante il salvataggio della routine ${routineName}.`);
    } finally {
      setSavingRoutineSourceName(null);
    }
  };

  const handleRoutineTemplateChange = async (routineName: string, nextTemplateId: string) => {
    const routine = legacyRoutines.find((entry) => entry.name === routineName);
    if (!routine) return;
    const currentTemplateId = String(routine.template_id || '');
    if (currentTemplateId === String(nextTemplateId || '')) return;

    const confirmed = window.confirm(
      'Cambiare tipo rigenererà il codice della routine usando il nuovo template e sovrascriverà il contenuto attuale. Vuoi continuare?'
    );
    if (!confirmed) return;

    setLoadingRoutineSourceName(routineName);
    try {
      const response = await authFetch(`/api/tasks/legacy-routines/${routineName}/reset-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: nextTemplateId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Cambio tipo routine non riuscito.');
      }
      setLegacyRoutines((current) => current.map((entry) => (
        entry.name === routineName
          ? { ...entry, template_id: nextTemplateId || null }
          : entry
      )));
      setRoutineSources((current) => ({
        ...current,
        [routineName]: String(body?.source || ''),
      }));
      await fetchLegacyRoutines();
    } catch (err: any) {
      alert(err?.message || 'Errore durante il cambio tipo della routine.');
    } finally {
      setLoadingRoutineSourceName(null);
    }
  };

  const handleAddRoutineRow = () => {
    setDraftRoutineRows((current) => [
      createRoutineDraft(String(routineTemplates[0]?.id || 'basic-node')),
      ...current,
    ]);
  };

  const handleDraftRoutineChange = (localId: string, patch: Partial<RoutineDraftRow>) => {
    setDraftRoutineRows((current) => current.map((row) => row.localId === localId ? { ...row, ...patch } : row));
  };

  const handleDeleteDraftRoutine = (localId: string) => {
    setDraftRoutineRows((current) => current.filter((row) => row.localId !== localId));
  };

  const handleCreateRoutine = async (draftRow: RoutineDraftRow) => {
    if (!draftRow.title.trim()) {
      alert('Inserisci un titolo routine.');
      return;
    }
    const generatedName = buildRoutineSlug(draftRow.title);
    if (!generatedName) {
      alert('Il titolo non genera un nome routine valido.');
      return;
    }
    setSavingLegacyRoutineName(draftRow.localId);
    try {
      const response = await authFetch('/api/tasks/legacy-routines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draftRow.title.trim(),
          description: draftRow.description.trim() || null,
          template_id: draftRow.template_id || String(routineTemplates[0]?.id || 'basic-node'),
          cron_expression: draftRow.cron_expression.trim() || null,
          is_active: draftRow.is_active,
          name: generatedName,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Creazione routine non riuscita.');
      }
      setDraftRoutineRows((current) => current.filter((row) => row.localId !== draftRow.localId));
      await fetchLegacyRoutines();
      await handleOpenRoutineEditor(String(body?.name || generatedName));
    } catch (err: any) {
      alert(err?.message || 'Errore durante la creazione della routine.');
    } finally {
      setSavingLegacyRoutineName(null);
    }
  };

  const handleDeleteRoutine = async (routineName: string, routineTitle: string) => {
    const confirmed = window.confirm(`Vuoi davvero eliminare la routine "${routineTitle}"?`);
    if (!confirmed) return;
    setDeletingRoutineName(routineName);
    try {
      const response = await authFetch(`/api/tasks/legacy-routines/${routineName}`, {
        method: 'DELETE',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || 'Eliminazione routine non riuscita.');
      }
      setRoutineSources((current) => {
        const next = { ...current };
        delete next[routineName];
        return next;
      });
      if (editingRoutineName === routineName) {
        closeRoutineEditor();
      }
      await fetchLegacyRoutines();
    } catch (err: any) {
      alert(err?.message || `Errore durante l'eliminazione della routine ${routineTitle}.`);
    } finally {
      setDeletingRoutineName(null);
    }
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
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-sky-300">Task Platform</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Pianificazioni</h1>
              <p className="mt-2 max-w-3xl text-sm text-gray-300">
                I task cono prompt che vengono shedulati e iterati in un agent. Le routin sono funzioni node eseguibili singolarmente.
              </p>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleImportFile}
              className="hidden"
            />
          </div>
        
        

          <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-2xl border border-gray-800 bg-gray-950/70 p-1">
                {([
                  { key: 'tasks', label: 'Task', count: tasks.length },
                  { key: 'routines', label: 'Routine', count: legacyRoutines.length },
                ] as Array<{ key: PlanningView; label: string; count: number }>).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setPlanningView(tab.key)}
                    className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                      planningView === tab.key
                        ? 'bg-sky-600 text-white'
                        : 'text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    {tab.label} ({tab.count})
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 sm:flex-nowrap">
              {planningView === 'tasks' ? (
                <>
                  <div className="flex w-full sm:w-72 md:w-80 items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2">
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Cerca.."
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleRuntime}
                    disabled={isRuntimeUpdating}
                    className={`rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
                      runtimeStatus?.enabled
                        ? 'border-emerald-700/50 bg-emerald-600/10 text-emerald-100 hover:bg-emerald-600/20'
                        : 'border-rose-700/50 bg-rose-600/10 text-rose-100 hover:bg-rose-600/20'
                    }`}
                  >
                    {isRuntimeUpdating
                      ? 'Aggiornamento runtime...'
                      : `Schedule ${runtimeStatus?.enabled ? 'ON' : 'OFF'}`}
                  </button>
                  <div ref={bulkMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setIsBulkMenuOpen((current) => !current)}
                      className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-100 hover:bg-gray-800"
                    >
                      <span className="inline-flex items-center gap-2">
                        Bulk
                        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                          <path d="M5.5 7.5 10 12l4.5-4.5" />
                        </svg>
                      </span>
                    </button>
                    {isBulkMenuOpen ? (
                      <div className="absolute right-0 z-10 mt-2 w-44 rounded-2xl border border-gray-800 bg-gray-950/95 p-2 shadow-xl">
                        <button
                          type="button"
                          onClick={() => {
                            setIsBulkMenuOpen(false);
                            handleExport();
                          }}
                          disabled={isExporting}
                          className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-gray-100 hover:bg-gray-800 disabled:opacity-60"
                        >
                          {isExporting ? 'Export...' : 'Export CSV'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsBulkMenuOpen(false);
                            handleImportClick();
                          }}
                          disabled={isImporting}
                          className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-gray-100 hover:bg-gray-800 disabled:opacity-60"
                        >
                          {isImporting ? 'Import...' : 'Import CSV'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={openCreateModal}
                    aria-label="Nuovo task"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600 text-white hover:bg-sky-500"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                      <path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" />
                    </svg>
                  </button>
                </>
              ) : (
                <>
                  <div className="flex w-full sm:w-72 md:w-80 items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2">
                    <input
                      value={routineSearch}
                      onChange={(event) => setRoutineSearch(event.target.value)}
                      placeholder="Cerca routine..."
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddRoutineRow}
                    aria-label="Nuova routine"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600 text-white hover:bg-sky-500"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                      <path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>

          {error ? (
            <div className="mt-6 rounded-xl border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">{error}</div>
          ) : null}

          {planningView === 'tasks' ? (
            isLoading ? (
              <div className="mt-6 text-sm text-gray-300">Caricamento task...</div>
            ) : filteredTasks.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-gray-700 px-4 py-5 text-sm text-gray-400">
                Nessun task schedulato trovato.
              </div>
            ) : (
              <>
              <div className="mt-6 overflow-x-auto rounded-2xl border border-gray-800 bg-gray-950/70">
                <table className="min-w-full divide-y divide-gray-800 text-sm">
                  <thead className="bg-gray-950/90 text-left text-xs uppercase tracking-[0.2em] text-gray-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">
                        <div className="flex flex-col gap-2">
                          <span>Stato</span>
                          <div className="normal-case tracking-normal">
                            <Toggle
                              checked={areAllTasksActive}
                              onChange={handleToggleAllActive}
                              disabled={isBulkUpdatingActive}
                            />
                          </div>
                        </div>
                      </th>
                      <th className="px-4 py-3 font-semibold">Task</th>
                      <th className="px-4 py-3 font-semibold">Schedule</th>
                      <th className="px-4 py-3 font-semibold">
                        <div className="flex flex-col gap-2">
                          <span>Esecutore</span>
                          <select
                            value={executorFilter}
                            onChange={(event) => setExecutorFilter(event.target.value)}
                            className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-xs font-medium normal-case tracking-normal text-gray-200"
                          >
                            <option value="all">Tutti</option>
                            <option value="unassigned">Non assegnato</option>
                            {executorOptions.map((option) => (
                              <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                      </th>
                      <th className="px-4 py-3 font-semibold">
                        <div className="flex flex-col gap-2">
                          <span>Categoria</span>
                          <select
                            value={categoryFilter}
                            onChange={(event) => setCategoryFilter(event.target.value)}
                            className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-xs font-medium normal-case tracking-normal text-gray-200"
                          >
                            <option value="all">Tutte</option>
                            {categoryOptions.map((category) => (
                              <option key={category} value={category}>{category}</option>
                            ))}
                          </select>
                        </div>
                      </th>
                      <th className="px-4 py-3 font-semibold">
                        <div className="flex flex-col gap-2">
                          <span>Notifiche</span>
                          <select
                            value={notificationFilter}
                            onChange={(event) => setNotificationFilter(event.target.value as 'all' | 'on' | 'off')}
                            className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-xs font-medium normal-case tracking-normal text-gray-200"
                          >
                            <option value="all">Tutte</option>
                            <option value="on">On</option>
                            <option value="off">Off</option>
                          </select>
                        </div>
                      </th>
                      <th className="px-4 py-3 font-semibold text-right">Azioni</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {paginatedTasks.map((task) => {
                      const worker = task.worker_agent_id ? agentsById.get(task.worker_agent_id) : null;
                      return (
                        <tr key={task.id} className="align-top text-gray-200">
                          <td className="px-4 py-3">
                            <div className="flex">
                              <Toggle
                                checked={task.is_active}
                                onChange={() => handleToggleActive(task)}
                                disabled={isBulkUpdatingActive}
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-semibold text-white">{task.title}</div>
                            {task.description ? (
                              <div className="mt-1 max-w-xl text-xs text-gray-400">{task.description}</div>
                            ) : null}
                            {task.latest_run_id ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                                <span className={`rounded-full border px-2 py-0.5 font-semibold ${getRunTone(task.latest_run_status || null)}`}>
                                  run {task.latest_run_id} · {task.latest_run_status}
                                </span>
                                <span className="text-gray-500">
                                  {task.latest_run_finished_at
                                    ? `fine ${new Date(task.latest_run_finished_at).toLocaleString('it-IT')}`
                                    : task.latest_run_started_at
                                      ? `avvio ${new Date(task.latest_run_started_at).toLocaleString('it-IT')}`
                                      : ''}
                                </span>
                              </div>
                            ) : null}
                            {task.latest_run_last_error ? (
                              <div className="mt-1 max-w-xl text-xs text-rose-300">
                                {task.latest_run_last_error}
                              </div>
                            ) : null}
                            <div className="mt-1 text-xs text-gray-500">#{task.id}</div>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-300">{formatSchedule(task)}</td>
                          <td className="px-4 py-3 text-xs text-gray-300">
                            {worker ? `${worker.name} (${worker.kind})` : 'Non assegnato'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-400">
                            {task.notification_type || 'Task'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <Toggle
                                checked={task.notifications_enabled}
                                onChange={() => handleToggleNotifications(task)}
                              />
                              <span className="text-xs text-gray-300">
                                {task.notifications_enabled ? 'on' : 'off'}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              <IconButton
                                label={runningTaskId === task.id || task.status === 'running' ? 'In esecuzione' : 'Esegui ora'}
                                onClick={() => handleRunNow(task)}
                                disabled={task.status === 'running' || runningTaskId === task.id}
                                tone="success"
                              >
                                {runningTaskId === task.id ? (
                                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin">
                                    <circle cx="12" cy="12" r="9" className="stroke-current opacity-25" strokeWidth="3" />
                                    <path d="M21 12a9 9 0 0 0-9-9" className="stroke-current" strokeWidth="3" strokeLinecap="round" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                                    <path d="M6 4.5v11l9-5.5-9-5.5Z" />
                                  </svg>
                                )}
                              </IconButton>
                              <IconButton
                                label="Apri"
                                onClick={() => openEditModal(task)}
                              >
                                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                                  <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
                                </svg>
                              </IconButton>
                              <IconButton
                                label="Elimina"
                                onClick={() => handleDelete(task.id)}
                                tone="danger"
                              >
                                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                                  <path d="M7.5 3a1 1 0 0 0-.8.4L6 4H3.5a1 1 0 1 0 0 2H4l.7 9.1A2 2 0 0 0 6.7 17h6.6a2 2 0 0 0 2-1.9L16 6h.5a1 1 0 1 0 0-2H14l-.7-.6a1 1 0 0 0-.8-.4h-5ZM8 8a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1Z" />
                                </svg>
                              </IconButton>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-gray-400">Visualizzati {paginationLabel}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((current) => Math.max(1, current - 1))}
                    disabled={currentPage === 1}
                    className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-100 hover:bg-gray-800 disabled:opacity-50"
                  >
                    Precedente
                  </button>
                  <span className="rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm text-gray-200">
                    Pagina {currentPage} / {totalTaskPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCurrentPage((current) => Math.min(totalTaskPages, current + 1))}
                    disabled={currentPage >= totalTaskPages}
                    className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-100 hover:bg-gray-800 disabled:opacity-50"
                  >
                    Successiva
                  </button>
                </div>
              </div>
              </>
            )
          ) : (
            <div className="mt-6">
              <div className="hidden grid-cols-[88px_minmax(220px,1.25fr)_180px_minmax(260px,1fr)_180px] gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 lg:grid">
                <div>Attivo</div>
                <div>Nome</div>
                <div>Cron</div>
                <div>Info</div>
                <div className="text-right">Azioni</div>
              </div>

              <div className="mt-4 space-y-4">
                {draftRoutineRows.length === 0 && filteredRoutines.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-700 px-4 py-5 text-sm text-gray-400">
                    Nessuna routine trovata.
                  </div>
                ) : null}

                {draftRoutineRows.map((draft) => (
                  <div key={draft.localId} className="border-b border-sky-800/40 pb-4 last:border-b-0">
                    <div className="grid gap-3 lg:grid-cols-[88px_minmax(220px,1.25fr)_180px_minmax(260px,1fr)_180px] lg:items-start">
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Attivo</div>
                        <Toggle
                          checked={draft.is_active}
                          onChange={() => handleDraftRoutineChange(draft.localId, { is_active: !draft.is_active })}
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Nome</div>
                        <input
                          value={draft.title}
                          onChange={(event) => handleDraftRoutineChange(draft.localId, { title: event.target.value })}
                          placeholder="Nuova routine"
                          className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                        />
                      </div>

                      <label className="text-sm text-gray-200">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Cron</span>
                        <input
                          value={draft.cron_expression}
                          onChange={(event) => handleDraftRoutineChange(draft.localId, { cron_expression: event.target.value })}
                          placeholder="0 7 * * *"
                          className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 font-mono text-white"
                        />
                      </label>

                      <div className="rounded-xl border border-sky-800/40 bg-sky-950/20 px-3 py-2 text-sm text-sky-100">
                        Routine nuova. Il codice viene creato dal template e poi modificato dal popup editor.
                      </div>

                      <div className="flex items-start justify-end gap-2">
                        <IconButton
                          label="Esegui routine"
                          onClick={() => {}}
                          disabled
                          tone="success"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="M6 4.5v11l9-5.5-9-5.5Z" />
                          </svg>
                        </IconButton>
                        <IconButton
                          label="Modifica codice"
                          onClick={() => {}}
                          disabled
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="m13.5 3.5 3 3L8 15H5v-3l8.5-8.5Z" />
                          </svg>
                        </IconButton>
                        <IconButton
                          label="Salva routine"
                          onClick={() => handleCreateRoutine(draft)}
                          disabled={savingLegacyRoutineName === draft.localId}
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="M4 3.5A1.5 1.5 0 0 1 5.5 2h7.379a1.5 1.5 0 0 1 1.06.44l1.621 1.62A1.5 1.5 0 0 1 16 5.12V16.5A1.5 1.5 0 0 1 14.5 18h-9A1.5 1.5 0 0 1 4 16.5v-13ZM6 4v4h6V4H6Zm0 8v4h8v-4H6Z" />
                          </svg>
                        </IconButton>
                        <IconButton
                          label="Elimina riga"
                          onClick={() => handleDeleteDraftRoutine(draft.localId)}
                          tone="danger"
                        >
                          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 stroke-current">
                            <path d="M4.5 6h11" strokeWidth="1.6" strokeLinecap="round" />
                            <path d="M8 3.5h4" strokeWidth="1.6" strokeLinecap="round" />
                            <path d="M6.5 6v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M8.5 8.5v4.5M11.5 8.5v4.5" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </IconButton>
                      </div>
                    </div>
                  </div>
                ))}

                {filteredRoutines.map((routine) => (
                  <div key={routine.name} className="border-b border-gray-800/80 pb-4 last:border-b-0">
                    <div className="grid gap-3 lg:grid-cols-[88px_minmax(220px,1.25fr)_180px_minmax(260px,1fr)_180px] lg:items-start">
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Attivo</div>
                        <Toggle
                          checked={legacyRoutineForm[routine.name]?.is_active ?? routine.is_active}
                          onChange={() => setLegacyRoutineForm((current) => ({
                            ...current,
                            [routine.name]: {
                              title: current[routine.name]?.title ?? routine.title,
                              description: current[routine.name]?.description ?? routine.description,
                              cron_expression: current[routine.name]?.cron_expression ?? String(routine.cron_expression || ''),
                              is_active: !(current[routine.name]?.is_active ?? routine.is_active),
                            },
                          }))}
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Nome</div>
                        <input
                          value={legacyRoutineForm[routine.name]?.title ?? routine.title}
                          onChange={(event) => setLegacyRoutineForm((current) => ({
                            ...current,
                            [routine.name]: {
                              title: event.target.value,
                              description: current[routine.name]?.description ?? routine.description,
                              cron_expression: current[routine.name]?.cron_expression ?? String(routine.cron_expression || ''),
                              is_active: current[routine.name]?.is_active ?? routine.is_active,
                            },
                          }))}
                          className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                        />
                      </div>

                      <label className="text-sm text-gray-200">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Cron</span>
                        <input
                          value={legacyRoutineForm[routine.name]?.cron_expression || ''}
                          onChange={(event) => setLegacyRoutineForm((current) => ({
                            ...current,
                            [routine.name]: {
                              title: current[routine.name]?.title ?? routine.title,
                              description: current[routine.name]?.description ?? routine.description,
                              cron_expression: event.target.value,
                              is_active: current[routine.name]?.is_active ?? routine.is_active,
                            },
                          }))}
                          className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 font-mono text-white"
                          placeholder="0 7 * * *"
                        />
                      </label>

                      <div className="space-y-2">
                        <div className="rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm text-gray-300">
                          {buildRoutineInfo(routine).map((line) => (
                            <div key={`${routine.name}-${line}`}>{line}</div>
                          ))}
                        </div>
                        {routine.last_error ? (
                          <div className="rounded-xl border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                            {routine.last_error}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex items-start justify-end gap-2">
                        <IconButton
                          label={routine.is_running || runningLegacyRoutineName === routine.name ? 'In esecuzione' : 'Esegui routine'}
                          onClick={() => handleRunLegacyRoutine(routine.name)}
                          disabled={routine.is_running || runningLegacyRoutineName === routine.name}
                          tone="success"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="M6 4.5v11l9-5.5-9-5.5Z" />
                          </svg>
                        </IconButton>
                        <IconButton
                          label="Modifica codice"
                          onClick={() => handleOpenRoutineEditor(routine.name)}
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="m13.5 3.5 3 3L8 15H5v-3l8.5-8.5Z" />
                          </svg>
                        </IconButton>
                        <IconButton
                          label="Salva routine"
                          onClick={() => handleSaveLegacyRoutine(routine.name)}
                          disabled={savingLegacyRoutineName === routine.name}
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="M4 3.5A1.5 1.5 0 0 1 5.5 2h7.379a1.5 1.5 0 0 1 1.06.44l1.621 1.62A1.5 1.5 0 0 1 16 5.12V16.5A1.5 1.5 0 0 1 14.5 18h-9A1.5 1.5 0 0 1 4 16.5v-13ZM6 4v4h6V4H6Zm0 8v4h8v-4H6Z" />
                          </svg>
                        </IconButton>
                        <IconButton
                          label="Elimina routine"
                          onClick={() => handleDeleteRoutine(routine.name, routine.title)}
                          disabled={deletingRoutineName === routine.name}
                          tone="danger"
                        >
                          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 stroke-current">
                            <path d="M4.5 6h11" strokeWidth="1.6" strokeLinecap="round" />
                            <path d="M8 3.5h4" strokeWidth="1.6" strokeLinecap="round" />
                            <path d="M6.5 6v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M8.5 8.5v4.5M11.5 8.5v4.5" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </IconButton>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {editingRoutineName ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-gray-950/80 p-4"
          onClick={closeRoutineEditor}
        >
          <div
            className="mx-auto max-w-5xl rounded-3xl border border-gray-800 bg-gray-900 p-5 shadow-xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-300">Routine</p>
                <h2 className="mt-2 text-2xl font-bold text-white">Modifica codice</h2>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleSaveRoutineSource(editingRoutineName)}
                  disabled={savingRoutineSourceName === editingRoutineName || loadingRoutineSourceName === editingRoutineName}
                  className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
                >
                  {savingRoutineSourceName === editingRoutineName ? 'Salvataggio...' : 'Salva routine'}
                </button>
                <button
                  type="button"
                  onClick={closeRoutineEditor}
                  className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                >
                  Chiudi
                </button>
              </div>
            </div>

            {loadingRoutineSourceName === editingRoutineName ? (
              <div className="mt-6 text-sm text-gray-300">Caricamento sorgente...</div>
            ) : (
              <>
                {(() => {
                  const routine = legacyRoutines.find((entry) => entry.name === editingRoutineName);
                  if (!routine) return null;
                  const draft = legacyRoutineForm[editingRoutineName] || {
                    title: routine.title,
                    description: routine.description || '',
                    cron_expression: routine.cron_expression || '',
                    is_active: routine.is_active,
                  };
                  return (
                    <>
                      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 block">Descrizione</span>
                          <textarea
                            value={draft.description}
                            onChange={(event) => setLegacyRoutineForm((current) => ({
                              ...current,
                              [editingRoutineName]: {
                                title: current[editingRoutineName]?.title ?? routine.title,
                                description: event.target.value,
                                cron_expression: current[editingRoutineName]?.cron_expression ?? String(routine.cron_expression || ''),
                                is_active: current[editingRoutineName]?.is_active ?? routine.is_active,
                              },
                            }))}
                            rows={3}
                            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                          />
                        </label>
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 block">Tipo</span>
                          <select
                            value={routine.template_id || ''}
                            onChange={(event) => handleRoutineTemplateChange(editingRoutineName, event.target.value)}
                            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                          >
                            {routineTemplates.map((template) => (
                              <option key={template.id} value={template.id}>{template.name}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <textarea
                        value={routineSources[editingRoutineName] || ''}
                        onChange={(event) => setRoutineSources((current) => ({
                          ...current,
                          [editingRoutineName]: event.target.value,
                        }))}
                        rows={22}
                        className="mt-6 w-full rounded-2xl border border-gray-700 bg-gray-950 px-3 py-3 font-mono text-sm text-white"
                        spellCheck={false}
                      />
                    </>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      ) : null}

      {isModalOpen ? (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-gray-950/80 p-4"
          onClick={closeModal}
        >
          <div
            className="mx-auto max-w-5xl rounded-3xl border border-gray-800 bg-gray-900 p-5 shadow-xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-300">Task</p>
                <h2 className="mt-2 text-2xl font-bold text-white">
                  {editingTaskId ? 'Dettaglio task' : 'Nuovo task'}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                Chiudi
              </button>
            </div>

            <div className="mt-6 inline-flex rounded-2xl border border-gray-800 bg-gray-950/70 p-1">
              {([
                { key: 'config', label: 'Config' },
                { key: 'runs', label: 'Runs' },
                { key: 'events', label: 'Events' },
              ] as Array<{ key: ModalTab; label: string }>).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  disabled={!editingTaskId && tab.key !== 'config'}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                    activeTab === tab.key
                      ? 'bg-sky-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800 disabled:opacity-40'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === 'config' ? (
              <form onSubmit={handleSave} className="mt-6 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-gray-200">
                    <span className="mb-1 block">Titolo</span>
                    <input
                      value={form.title}
                      onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                      required
                    />
                  </label>
                  <label className="text-sm text-gray-200">
                    <span className="mb-1 block">Worker esecutore</span>
                    <select
                      value={form.worker_agent_id}
                      onChange={(event) => setForm((current) => ({ ...current, worker_agent_id: event.target.value }))}
                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                      required
                    >
                      <option value="">Seleziona agente</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} ({agent.kind})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block text-sm text-gray-200">
                  <span className="mb-1 block">Descrizione</span>
                  <textarea
                    value={form.description}
                    onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                    className="min-h-24 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  />
                </label>

                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="text-sm text-gray-200">
                    <span className="mb-1 block">Tipo schedulazione</span>
                    <select
                      value={form.schedule_mode}
                      onChange={(event) => setForm((current) => ({ ...current, schedule_mode: event.target.value as ScheduleMode }))}
                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                    >
                      <option value="cron">cron</option>
                      <option value="once">una tantum</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={form.is_active}
                      onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))}
                      className="h-4 w-4 accent-sky-500"
                    />
                    Task attivo
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={form.needs_confirmation}
                      onChange={(event) => setForm((current) => ({ ...current, needs_confirmation: event.target.checked }))}
                      className="h-4 w-4 accent-sky-500"
                    />
                    Richiede conferma utente
                  </label>
                </div>

                {form.schedule_mode === 'cron' ? (
                  <div className="space-y-4">
                    <label className="block text-sm text-gray-200">
                      <span className="mb-1 block">Genera Cron</span>
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <input
                          type="text"
                          value={cronPrompt}
                          onChange={(event) => setCronPrompt(event.target.value)}
                          className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                          placeholder="Esempio: ogni lunedi alle 8:30, il primo giorno del mese alle 07:00, dal lunedi al venerdi alle 18..."
                        />
                        <button
                          type="button"
                          onClick={handleGenerateCron}
                          disabled={isGeneratingCron}
                          aria-label={isGeneratingCron ? 'Generazione cron in corso' : 'Genera cron'}
                          title={isGeneratingCron ? 'Generazione cron in corso' : 'Genera cron'}
                          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-sky-700/60 text-sky-100 hover:bg-sky-900/20 disabled:opacity-60"
                        >
                          {isGeneratingCron ? (
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 20 20"
                              className="h-4 w-4 animate-spin"
                            >
                              <circle
                                cx="10"
                                cy="10"
                                r="7"
                                fill="none"
                                stroke="currentColor"
                                strokeOpacity="0.25"
                                strokeWidth="2"
                              />
                              <path
                                d="M10 3a7 7 0 0 1 7 7"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                              />
                            </svg>
                          ) : (
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 20 20"
                              className="h-4 w-4 fill-current"
                            >
                              <path d="M10 1.5l1.47 4.53h4.76l-3.85 2.8 1.47 4.52L10 10.56l-3.85 2.79 1.47-4.52-3.85-2.8h4.76L10 1.5zm6.25 11.25l.73 2.25h2.27l-1.84 1.34.7 2.16-1.86-1.35-1.86 1.35.71-2.16L13.25 15h2.27l.73-2.25zm-12.5 0l.73 2.25h2.27l-1.84 1.34.7 2.16-1.86-1.35-1.86 1.35.71-2.16L.75 15h2.27l.73-2.25z" />
                            </svg>
                          )}
                        </button>
                      </div>
                    </label>

                    {cronSummary.length > 0 || cronAssumptions.length > 0 ? (
                      <div className="rounded-2xl border border-sky-800/40 bg-sky-950/20 p-4 text-sm text-sky-50">
                        {cronSummary.length > 0 ? (
                          <div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-300">Interpretazione</div>
                            <ul className="space-y-1 text-sm text-sky-100">
                              {cronSummary.map((entry, index) => (
                                <li key={`${entry}-${index}`}>- {entry}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {cronAssumptions.length > 0 ? (
                          <div className={cronSummary.length > 0 ? 'mt-3' : ''}>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-300">Assunzioni</div>
                            <ul className="space-y-1 text-sm text-sky-100">
                              {cronAssumptions.map((entry, index) => (
                                <li key={`${entry}-${index}`}>- {entry}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <label className="block text-sm text-gray-200">
                      <span className="mb-1 block">Stringa cron</span>
                      <input
                        value={form.scheduler_cron}
                        onChange={(event) => setForm((current) => ({ ...current, scheduler_cron: event.target.value }))}
                        className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-white"
                        required
                      />
                    </label>
                  </div>
                ) : (
                  <label className="block text-sm text-gray-200">
                    <span className="mb-1 block">Data/ora esecuzione</span>
                    <input
                      type="datetime-local"
                      value={form.run_at}
                      onChange={(event) => setForm((current) => ({ ...current, run_at: event.target.value }))}
                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                      required
                    />
                  </label>
                )}

                <label className="block text-sm text-gray-200">
                  <span className="mb-1 block">Richiesta operativa</span>
                  <textarea
                    value={form.request_text}
                    onChange={(event) => setForm((current) => ({ ...current, request_text: event.target.value }))}
                    className="min-h-32 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                    placeholder="Descrivi in modo operativo cosa deve fare il worker."
                    required
                  />
                </label>

                <label className="block text-sm text-gray-200">
                  <span className="mb-1 block">Etichetta notifica temporanea</span>
                  <input
                    value={form.notification_label}
                    onChange={(event) => setForm((current) => ({ ...current, notification_label: event.target.value }))}
                    className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                    placeholder="Campo temporaneo in attesa della nuova inbox"
                  />
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm text-gray-200">
                    <span className="mb-1 block">Modello AI</span>
                    <select
                      value={encodeModelValue(form.model_config)}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        model_config: normalizeModelConfig({
                          ...decodeModelValue(event.target.value, current.model_config),
                          ollama_server_id: current.model_config.ollama_server_id,
                        }, current.model_config),
                      }))}
                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                    >
                      {modelOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-sm text-gray-200">
                    <span className="mb-1 block">Server Ollama</span>
                    <select
                      value={form.model_config.ollama_server_id || ''}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        model_config: {
                          ...current.model_config,
                          ollama_server_id: event.target.value || null,
                        },
                      }))}
                      disabled={form.model_config.provider !== 'ollama'}
                      className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white disabled:opacity-50"
                    >
                      <option value="">Default globale</option>
                      {ollamaOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.name}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm text-gray-200">
                  <input
                    type="checkbox"
                    checked={form.notifications_enabled}
                    onChange={(event) => setForm((current) => ({ ...current, notifications_enabled: event.target.checked }))}
                    className="h-4 w-4 accent-sky-500"
                  />
                  Notifiche abilitate
                </label>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
                  >
                    {isSaving ? 'Salvataggio...' : editingTaskId ? 'Aggiorna task' : 'Crea task'}
                  </button>
                  {editingTaskId ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(editingTaskId)}
                      className="rounded-xl border border-rose-800 px-4 py-3 text-sm text-rose-300 hover:bg-rose-950/60"
                    >
                      Elimina
                    </button>
                  ) : null}
                </div>
              </form>
            ) : activeTab === 'runs' ? (
              <div className="mt-6 space-y-3">
                {!taskDetail ? (
                  <div className="text-sm text-gray-400">Caricamento runs...</div>
                ) : taskDetail.runs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-700 px-4 py-4 text-sm text-gray-400">
                    Nessun run disponibile per questo task.
                  </div>
                ) : (
                  taskDetail.runs.map((run) => (
                    <div key={run.id} className="rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-white">Run {run.id}</span>
                        <span className="rounded-full border border-gray-700 px-2 py-0.5 text-xs text-gray-300">{run.status}</span>
                        <span className="rounded-full border border-gray-700 px-2 py-0.5 text-xs text-gray-300">{run.trigger_type}</span>
                      </div>
                      <div className="mt-2 text-xs text-gray-400">
                        Start: {run.started_at ? new Date(run.started_at).toLocaleString('it-IT') : '-'}
                        {' · '}
                        End: {run.finished_at ? new Date(run.finished_at).toLocaleString('it-IT') : '-'}
                      </div>
                      {run.last_error ? (
                        <div className="mt-3 rounded-xl border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
                          {run.last_error}
                        </div>
                      ) : null}
                      {!run.last_error && getRunPreview(run) ? (
                        <div className="mt-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-100 whitespace-pre-wrap">
                          {getRunPreview(run)}
                        </div>
                      ) : null}
                      {run.chat_id ? (
                        <div className="mt-3">
                          <a
                            href={`/agent-chat/${encodeURIComponent(run.chat_id)}`}
                            className="text-sm text-sky-300 hover:text-sky-200"
                          >
                            Apri chat del run
                          </a>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {!taskDetail ? (
                  <div className="text-sm text-gray-400">Caricamento eventi...</div>
                ) : taskDetail.events.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-700 px-4 py-4 text-sm text-gray-400">
                    Nessun evento disponibile per questo task.
                  </div>
                ) : (
                  taskDetail.events.map((taskEvent) => (
                    <div key={taskEvent.id} className="rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-white">{taskEvent.event_type}</span>
                        {taskEvent.actor_id ? (
                          <span className="rounded-full border border-gray-700 px-2 py-0.5 text-xs text-gray-300">
                            {taskEvent.actor_type || 'actor'}: {taskEvent.actor_id}
                          </span>
                        ) : null}
                      </div>
                      {taskEvent.content ? (
                        <p className="mt-2 text-sm text-gray-300">{taskEvent.content}</p>
                      ) : null}
                      <div className="mt-2 text-xs text-gray-500">
                        {new Date(taskEvent.created_at).toLocaleString('it-IT')}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
