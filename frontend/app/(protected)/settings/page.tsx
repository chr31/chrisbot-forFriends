'use client';

import { useCallback, useEffect, useState } from 'react';

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

type PortalAccessSettings = {
  local_login_enabled: boolean;
  local_admin_username: string;
  local_admin_password: string;
  local_admin_password_configured?: boolean;
  allowed_login_groups: string[];
  allowed_login_upns: string[];
  super_admin_groups: string[];
  super_admin_upns: string[];
  group_directory: Array<{
    name: string;
    object_id: string;
  }>;
  azure_tenant_id: string;
  azure_client_id: string;
  azure_client_secret: string;
  azure_client_secret_configured?: boolean;
  azure_redirect_uri: string;
  backend_base_url: string;
  frontend_base_url: string;
};

type McpConnection = {
  id: string;
  name: string;
  url: string;
  description: string;
  name_prefix: string;
  enabled: boolean;
  headers_json: Record<string, string>;
};

type McpRuntimeSettings = {
  client_name: string;
  client_version: string;
  protocol_version: string;
  tool_cache_ttl_ms: number;
  timeout_ms: number;
  unavailable_cooldown_ms: number;
  call_retry_base_ms: number;
  call_retry_max_ms: number;
  call_max_retries: number;
  av_timeout_ms: number;
  connections: McpConnection[];
};

type OllamaConnection = {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  enabled: boolean;
  priority: number;
};

type OllamaRuntimeSettings = {
  timeout_ms: number;
  fallback_on_unavailable: boolean;
  routing_strategy: 'priority' | 'least_loaded';
  default_connection_id: string | null;
  models: string[];
  default_model: string;
  connections: OllamaConnection[];
};

type OpenAiRuntimeSettings = {
  api_key: string;
  api_key_configured?: boolean;
  chat_model: string;
};

type TelegramRuntimeSettings = {
  enabled: boolean;
  bot_token: string;
  bot_token_configured?: boolean;
  polling_interval_ms: number;
};

type TelegramUserLink = {
  id: number;
  subject_type: 'user' | 'upn';
  subject_id: string;
  telegram_user_id: string;
  receive_notifications: boolean | number;
  telegram_username?: string | null;
  telegram_first_name?: string | null;
  telegram_last_name?: string | null;
};

type TelegramGroupTarget = {
  id: number;
  label: string;
  telegram_chat_id: string;
  is_enabled: boolean | number;
};

type EditableTelegramUserLink = {
  localId: string;
  id: number | null;
  subject_type: 'user' | 'upn';
  subject_id: string;
  telegram_user_id: string;
  receive_notifications: boolean;
  telegram_username?: string | null;
  telegram_first_name?: string | null;
  telegram_last_name?: string | null;
};

type TelegramGroupDraft = {
  id: number | null;
  label: string;
  telegram_chat_id: string;
  is_enabled: boolean;
};

type McpConnectionStatus = {
  id: string;
  url: string;
  name_prefix: string;
  connected: boolean;
  available: boolean;
  has_session: boolean;
  in_cooldown: boolean;
  cooldown_remaining_ms: number;
  last_error?: string | null;
};

type OllamaConnectionStatus = {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  available: boolean;
  current_load: number | null;
  load_level: 'unknown' | 'idle' | 'low' | 'medium' | 'high';
  active_models: string[];
  last_error?: string | null;
};

type SettingsPayload = {
  portal_access: PortalAccessSettings;
  mcp_runtime: McpRuntimeSettings;
  ollama_runtime: OllamaRuntimeSettings;
  openai_runtime: OpenAiRuntimeSettings;
  telegram_runtime: TelegramRuntimeSettings;
};

function parseCsv(value: string) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseLines(value: string) {
  return value
    .split('\n')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parsePlainLines(value: string) {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeJsonParse(raw: string) {
  if (!raw.trim()) return {};
  return JSON.parse(raw);
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

function getOllamaStatusMeta(connection: OllamaConnection, status?: OllamaConnectionStatus) {
  if (connection.enabled === false) {
    return {
      label: 'Disattivato',
      dotClassName: 'bg-yellow-400',
    };
  }
  if (status?.available) {
    return {
      label: 'Disponibile',
      dotClassName: 'bg-emerald-500',
    };
  }
  return {
    label: 'Non disponibile',
    dotClassName: 'bg-rose-500',
  };
}

function getMcpStatusMeta(connection: McpConnection, status?: McpConnectionStatus) {
  if (connection.enabled === false) {
    return {
      label: 'Disattivato',
      dotClassName: 'bg-yellow-400',
    };
  }
  if (status?.connected) {
    return {
      label: 'Connesso',
      dotClassName: 'bg-emerald-500',
    };
  }
  if (status?.available || status?.in_cooldown) {
    return {
      label: status?.in_cooldown
        ? `Cooldown ${Math.ceil((status.cooldown_remaining_ms || 0) / 1000)}s`
        : 'Disponibile senza sessione',
      dotClassName: 'bg-yellow-400',
    };
  }
  return {
    label: 'Non connesso',
    dotClassName: 'bg-rose-500',
  };
}

function toEditableTelegramUser(entry?: Partial<TelegramUserLink> & { id?: number | null }): EditableTelegramUserLink {
  return {
    localId: entry?.id ? `telegram-user-${entry.id}` : `telegram-user-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    id: entry?.id ?? null,
    subject_type: entry?.subject_type === 'upn' ? 'upn' : 'user',
    subject_id: String(entry?.subject_id || ''),
    telegram_user_id: String(entry?.telegram_user_id || ''),
    receive_notifications: Boolean(entry?.receive_notifications),
    telegram_username: entry?.telegram_username || null,
    telegram_first_name: entry?.telegram_first_name || null,
    telegram_last_name: entry?.telegram_last_name || null,
  };
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'portal' | 'ollama' | 'mcp' | 'telegram'>('portal');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingPortal, setIsSavingPortal] = useState(false);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [isSavingOllama, setIsSavingOllama] = useState(false);
  const [isSavingOpenAi, setIsSavingOpenAi] = useState(false);
  const [isSavingTelegram, setIsSavingTelegram] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portalAllowedGroups, setPortalAllowedGroups] = useState('');
  const [portalAllowedUpns, setPortalAllowedUpns] = useState('');
  const [portalSuperAdminGroups, setPortalSuperAdminGroups] = useState('');
  const [portalSuperAdminUpns, setPortalSuperAdminUpns] = useState('');
  const [localLoginEnabled, setLocalLoginEnabled] = useState(true);
  const [localAdminUsername, setLocalAdminUsername] = useState('');
  const [localAdminPassword, setLocalAdminPassword] = useState('');
  const [localAdminPasswordConfigured, setLocalAdminPasswordConfigured] = useState(false);
  const [azureTenantId, setAzureTenantId] = useState('common');
  const [azureClientId, setAzureClientId] = useState('');
  const [azureClientSecret, setAzureClientSecret] = useState('');
  const [azureClientSecretConfigured, setAzureClientSecretConfigured] = useState(false);
  const [azureRedirectUri, setAzureRedirectUri] = useState('');
  const [backendBaseUrl, setBackendBaseUrl] = useState('');
  const [frontendBaseUrl, setFrontendBaseUrl] = useState('');
  const [groupDirectory, setGroupDirectory] = useState<Array<{ name: string; object_id: string }>>([]);
  const [mcpRuntime, setMcpRuntime] = useState<McpRuntimeSettings | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpConnectionStatus>>({});
  const [connectionHeadersDraft, setConnectionHeadersDraft] = useState<Record<string, string>>({});
  const [editingMcpConnectionId, setEditingMcpConnectionId] = useState<string | null>(null);
  const [ollamaRuntime, setOllamaRuntime] = useState<OllamaRuntimeSettings | null>(null);
  const [ollamaModelsDraft, setOllamaModelsDraft] = useState('');
  const [ollamaStatuses, setOllamaStatuses] = useState<Record<string, OllamaConnectionStatus>>({});
  const [openAiRuntime, setOpenAiRuntime] = useState<OpenAiRuntimeSettings | null>(null);
  const [telegramRuntime, setTelegramRuntime] = useState<TelegramRuntimeSettings | null>(null);
  const [telegramUserRows, setTelegramUserRows] = useState<EditableTelegramUserLink[]>([]);
  const [deletedTelegramUserIds, setDeletedTelegramUserIds] = useState<number[]>([]);
  const [telegramGroups, setTelegramGroups] = useState<TelegramGroupTarget[]>([]);
  const [telegramGroupDraft, setTelegramGroupDraft] = useState<TelegramGroupDraft>({
    id: null,
    label: '',
    telegram_chat_id: '',
    is_enabled: true,
  });

  const authFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = localStorage.getItem('authToken');
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }, []);

  const loadMcpStatuses = useCallback(async () => {
    const response = await authFetch('/api/settings/mcp/status');
    if (!response.ok) return;
    const payload = await response.json().catch(() => ({})) as { connections?: McpConnectionStatus[] };
    const nextStatuses: Record<string, McpConnectionStatus> = {};
    for (const status of payload.connections || []) {
      nextStatuses[status.id] = status;
      nextStatuses[status.url] = status;
    }
    setMcpStatuses(nextStatuses);
  }, [authFetch]);

  const loadOllamaStatuses = useCallback(async () => {
    const response = await authFetch('/api/settings/ollama/status');
    if (!response.ok) return;
    const payload = await response.json().catch(() => ({})) as { connections?: OllamaConnectionStatus[] };
    const nextStatuses: Record<string, OllamaConnectionStatus> = {};
    for (const status of payload.connections || []) {
      nextStatuses[status.id] = status;
    }
    setOllamaStatuses(nextStatuses);
  }, [authFetch]);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const meResponse = await authFetch('/api/auth/me');
      if (!meResponse.ok) throw new Error('Impossibile verificare l’utente corrente.');
      const meBody = await meResponse.json();
      const user = meBody?.user || null;
      setAuthUser(user);
      if (!user?.is_super_admin) {
        setIsLoading(false);
        return;
      }

      const settingsResponse = await authFetch('/api/settings');
      if (!settingsResponse.ok) {
        const body = await settingsResponse.json().catch(() => ({}));
        throw new Error(body?.error || 'Impossibile caricare le impostazioni.');
      }
      const payload = await settingsResponse.json() as SettingsPayload;
      setPortalAllowedGroups((payload.portal_access?.allowed_login_groups || []).join(', '));
      setPortalAllowedUpns((payload.portal_access?.allowed_login_upns || []).join('\n'));
      setPortalSuperAdminGroups((payload.portal_access?.super_admin_groups || []).join(', '));
      setPortalSuperAdminUpns((payload.portal_access?.super_admin_upns || []).join('\n'));
      setLocalLoginEnabled(payload.portal_access?.local_login_enabled !== false);
      setLocalAdminUsername(payload.portal_access?.local_admin_username || '');
      setLocalAdminPassword(payload.portal_access?.local_admin_password || '');
      setLocalAdminPasswordConfigured(Boolean(payload.portal_access?.local_admin_password_configured));
      setAzureTenantId(payload.portal_access?.azure_tenant_id || 'common');
      setAzureClientId(payload.portal_access?.azure_client_id || '');
      setAzureClientSecret(payload.portal_access?.azure_client_secret || '');
      setAzureClientSecretConfigured(Boolean(payload.portal_access?.azure_client_secret_configured));
      setAzureRedirectUri(payload.portal_access?.azure_redirect_uri || '');
      setBackendBaseUrl(payload.portal_access?.backend_base_url || '');
      setFrontendBaseUrl(payload.portal_access?.frontend_base_url || '');
      setGroupDirectory(Array.isArray(payload.portal_access?.group_directory) ? payload.portal_access.group_directory : []);
      setMcpRuntime(payload.mcp_runtime || null);
      setOllamaRuntime(payload.ollama_runtime || null);
      setOpenAiRuntime(payload.openai_runtime || null);
      setTelegramRuntime(payload.telegram_runtime || null);
      const nextHeaders: Record<string, string> = {};
      for (const connection of payload.mcp_runtime?.connections || []) {
        nextHeaders[connection.id] = JSON.stringify(connection.headers_json || {}, null, 2);
      }
      setConnectionHeadersDraft(nextHeaders);
      setOllamaModelsDraft((payload.ollama_runtime?.models || []).join('\n'));

      const telegramUsersResponse = await authFetch('/api/settings/telegram/users');
      if (telegramUsersResponse.ok) {
        const telegramUsersPayload = await telegramUsersResponse.json().catch(() => ({})) as { items?: TelegramUserLink[] };
        setTelegramUserRows(Array.isArray(telegramUsersPayload.items) ? telegramUsersPayload.items.map((entry) => toEditableTelegramUser(entry)) : []);
        setDeletedTelegramUserIds([]);
      }
      const telegramGroupsResponse = await authFetch('/api/settings/telegram/groups');
      if (telegramGroupsResponse.ok) {
        const telegramGroupsPayload = await telegramGroupsResponse.json().catch(() => ({})) as { items?: TelegramGroupTarget[] };
        setTelegramGroups(Array.isArray(telegramGroupsPayload.items) ? telegramGroupsPayload.items : []);
      }
    } catch (err: any) {
      setError(err?.message || 'Errore inatteso.');
    } finally {
      setIsLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!authUser?.is_super_admin) return;
    if (activeTab === 'ollama') {
      loadOllamaStatuses();
    } else if (activeTab === 'mcp') {
      loadMcpStatuses();
    }
  }, [activeTab, authUser?.is_super_admin, loadMcpStatuses, loadOllamaStatuses]);

  const handleSavePortalAccess = async () => {
    setIsSavingPortal(true);
    try {
      const response = await authFetch('/api/settings/portal-access', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          local_login_enabled: localLoginEnabled,
          local_admin_username: localAdminUsername,
          local_admin_password: localAdminPassword,
          allowed_login_groups: parseCsv(portalAllowedGroups),
          allowed_login_upns: parseLines(portalAllowedUpns),
          super_admin_groups: parseCsv(portalSuperAdminGroups),
          super_admin_upns: parseLines(portalSuperAdminUpns),
          group_directory: groupDirectory,
          azure_tenant_id: azureTenantId,
          azure_client_id: azureClientId,
          azure_client_secret: azureClientSecret,
          azure_redirect_uri: azureRedirectUri,
          backend_base_url: backendBaseUrl,
          frontend_base_url: frontendBaseUrl,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Salvataggio impostazioni portale fallito.');
      await loadSettings();
    } catch (err: any) {
      alert(err?.message || 'Errore salvataggio accessi portale.');
    } finally {
      setIsSavingPortal(false);
    }
  };

  const handleSaveMcp = async () => {
    if (!mcpRuntime) return;
    setIsSavingMcp(true);
    try {
      const payload: McpRuntimeSettings = {
        ...mcpRuntime,
        connections: mcpRuntime.connections.map((connection) => ({
          ...connection,
          headers_json: safeJsonParse(connectionHeadersDraft[connection.id] || '{}'),
        })),
      };
      const response = await authFetch('/api/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Salvataggio impostazioni MCP fallito.');
      await loadSettings();
      await loadMcpStatuses();
    } catch (err: any) {
      alert(err?.message || 'Errore salvataggio impostazioni MCP.');
    } finally {
      setIsSavingMcp(false);
    }
  };

  const handleSaveOllama = async () => {
    if (!ollamaRuntime) return;
    setIsSavingOllama(true);
    try {
      const payload: OllamaRuntimeSettings = {
        ...ollamaRuntime,
        models: parsePlainLines(ollamaModelsDraft),
      };
      const response = await authFetch('/api/settings/ollama', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Salvataggio impostazioni Ollama fallito.');
      await loadSettings();
      await loadOllamaStatuses();
    } catch (err: any) {
      alert(err?.message || 'Errore salvataggio impostazioni Ollama.');
    } finally {
      setIsSavingOllama(false);
    }
  };

  const handleSaveOpenAi = async () => {
    if (!openAiRuntime) return;
    setIsSavingOpenAi(true);
    try {
      const response = await authFetch('/api/settings/openai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(openAiRuntime),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Salvataggio impostazioni OpenAI fallito.');
      await loadSettings();
    } catch (err: any) {
      alert(err?.message || 'Errore salvataggio impostazioni OpenAI.');
    } finally {
      setIsSavingOpenAi(false);
    }
  };

  const handleSaveTelegram = async () => {
    if (!telegramRuntime) return;
    setIsSavingTelegram(true);
    try {
      const response = await authFetch('/api/settings/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telegramRuntime),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Salvataggio impostazioni Telegram fallito.');

      for (const row of telegramUserRows) {
        if (!row.subject_id.trim() || !row.telegram_user_id.trim()) {
          throw new Error('Completa tutti i mapping Telegram prima di salvare oppure rimuovi le righe incomplete.');
        }
        const userResponse = await authFetch('/api/settings/telegram/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: row.id,
            subject_type: row.subject_type,
            subject_id: row.subject_id,
            telegram_user_id: row.telegram_user_id,
            receive_notifications: row.receive_notifications,
          }),
        });
        const userBody = await userResponse.json().catch(() => ({}));
        if (!userResponse.ok) throw new Error(userBody?.error || 'Salvataggio mapping Telegram fallito.');
      }

      for (const id of deletedTelegramUserIds) {
        const deleteResponse = await authFetch(`/api/settings/telegram/users/${id}`, {
          method: 'DELETE',
        });
        const deleteBody = await deleteResponse.json().catch(() => ({}));
        if (!deleteResponse.ok) throw new Error(deleteBody?.error || 'Eliminazione mapping Telegram fallita.');
      }

      await loadSettings();
    } catch (err: any) {
      alert(err?.message || 'Errore salvataggio impostazioni Telegram.');
    } finally {
      setIsSavingTelegram(false);
    }
  };

  const handleAddTelegramUserRow = () => {
    setTelegramUserRows((current) => [toEditableTelegramUser(), ...current]);
  };

  const handleTelegramUserRowChange = (localId: string, patch: Partial<EditableTelegramUserLink>) => {
    setTelegramUserRows((current) => current.map((row) => row.localId === localId ? { ...row, ...patch } : row));
  };

  const handleDeleteTelegramUser = async (row: EditableTelegramUserLink) => {
    if (!confirm('Eliminare questo mapping Telegram?')) return;
    if (!row.id) {
      setTelegramUserRows((current) => current.filter((entry) => entry.localId !== row.localId));
      return;
    }
    setDeletedTelegramUserIds((current) => current.includes(row.id as number) ? current : [...current, row.id as number]);
    setTelegramUserRows((current) => current.filter((entry) => entry.localId !== row.localId));
  };

  const handleSaveTelegramGroup = async () => {
    try {
      const response = await authFetch('/api/settings/telegram/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telegramGroupDraft),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Salvataggio gruppo Telegram fallito.');
      setTelegramGroupDraft({ id: null, label: '', telegram_chat_id: '', is_enabled: true });
      await loadSettings();
    } catch (err: any) {
      alert(err?.message || 'Errore salvataggio gruppo Telegram.');
    }
  };

  const editTelegramGroup = (entry: TelegramGroupTarget) => {
    setTelegramGroupDraft({
      id: Number(entry.id),
      label: String(entry.label || ''),
      telegram_chat_id: String(entry.telegram_chat_id || ''),
      is_enabled: Boolean(entry.is_enabled),
    });
  };

  const resetTelegramGroupDraft = () => {
    setTelegramGroupDraft({ id: null, label: '', telegram_chat_id: '', is_enabled: true });
  };

  const handleDeleteTelegramGroup = async (id: number) => {
    if (!confirm('Eliminare questo gruppo Telegram?')) return;
    try {
      const response = await authFetch(`/api/settings/telegram/groups/${id}`, {
        method: 'DELETE',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || 'Eliminazione gruppo Telegram fallita.');
      await loadSettings();
    } catch (err: any) {
      alert(err?.message || 'Errore eliminazione gruppo Telegram.');
    }
  };

  const addConnection = () => {
    setMcpRuntime((current) => {
      if (!current) return current;
      const nextId = `connection_${Date.now()}`;
      setConnectionHeadersDraft((draft) => ({ ...draft, [nextId]: '{}' }));
      return {
        ...current,
        connections: [
          ...current.connections,
          {
            id: nextId,
            name: 'Nuova connessione',
            url: '',
            description: '',
            name_prefix: 'mcp_',
            enabled: true,
            headers_json: {},
          },
        ],
      };
    });
  };

  const addOllamaConnection = () => {
    setOllamaRuntime((current) => {
      if (!current) return current;
      return {
        ...current,
        connections: [
          ...current.connections,
          {
            id: `ollama_${Date.now()}`,
            name: 'Nuovo server Ollama',
            base_url: '',
            default_model: '',
            enabled: true,
            priority: current.connections.length + 1,
          },
        ],
      };
    });
  };

  if (isLoading) {
    return <div className="p-8 text-white">Caricamento impostazioni...</div>;
  }

  if (authUser && !authUser.is_super_admin) {
    return <div className="p-8 text-white">Accesso riservato ai super amministratori.</div>;
  }

  const tabs = [
    { id: 'portal' as const, label: 'Accesso Portale' },
    { id: 'ollama' as const, label: 'Modelli AI' },
    { id: 'mcp' as const, label: 'Server MCP' },
    { id: 'telegram' as const, label: 'Telegram' },
  ];

  const azureConfigured = Boolean(azureClientId.trim() && azureClientSecret.trim() && azureRedirectUri.trim());
  const editingMcpConnection = editingMcpConnectionId && mcpRuntime
    ? mcpRuntime.connections.find((connection) => connection.id === editingMcpConnectionId) || null
    : null;
  const isOpenAiConfigured = Boolean((openAiRuntime?.api_key_configured || openAiRuntime?.api_key.trim()) && openAiRuntime?.chat_model.trim());
  const globalDefaultModelValue = ollamaRuntime?.default_model
    || (isOpenAiConfigured ? '__openai__' : '');

  return (
    <div className="space-y-6 py-6">
      <section className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-sky-300">Settings</p>
        <h1 className="mt-2 text-3xl font-bold text-white">Impostazioni</h1>
        {error ? (
          <div className="mt-4 rounded-xl border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">{error}</div>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as 'portal' | 'ollama' | 'mcp' | 'telegram')}
              className={`rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === tab.id
                  ? 'bg-sky-600 text-white'
                  : 'border border-gray-700 bg-gray-950/60 text-gray-300 hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {activeTab === 'portal' ? (
        <section>
        <div className="mt-6 space-y-4">
          <div className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-white">Login locale</h2>
              </div>
              <div className="flex items-center gap-3">
                <Toggle
                  checked={localLoginEnabled}
                  onChange={() => setLocalLoginEnabled((current) => !current)}
                />
                <button
                  type="button"
                  onClick={handleSavePortalAccess}
                  disabled={isSavingPortal}
                  className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
                >
                  {isSavingPortal ? 'Salvataggio...' : 'Salva accessi'}
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Username</span>
                <input
                  value={localAdminUsername}
                  onChange={(event) => setLocalAdminUsername(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="admin"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Password</span>
                <input
                  type="password"
                  value={localAdminPassword}
                  onChange={(event) => setLocalAdminPassword(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder={localAdminPasswordConfigured ? 'Gia configurata; lascia vuoto per mantenerla' : 'Password account locale'}
                />
              </label>
            </div>
          </div>

          <div className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-white">Login Azure</h2>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                azureConfigured ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'
              }`}>
                {azureConfigured ? 'Configurato' : 'Non configurato'}
              </span>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Tenant ID</span>
                <input
                  value={azureTenantId}
                  onChange={(event) => setAzureTenantId(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="common"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Client ID</span>
                <input
                  value={azureClientId}
                  onChange={(event) => setAzureClientId(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="Application (client) ID"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Client Secret</span>
                <input
                  type="password"
                  value={azureClientSecret}
                  onChange={(event) => setAzureClientSecret(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder={azureClientSecretConfigured ? 'Gia configurato; lascia vuoto per mantenerlo' : 'Client secret'}
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Redirect URI</span>
                <input
                  value={azureRedirectUri}
                  onChange={(event) => setAzureRedirectUri(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="http://127.0.0.1:3000/api/auth/azure/callback"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Backend Base URL</span>
                <input
                  value={backendBaseUrl}
                  onChange={(event) => setBackendBaseUrl(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="http://127.0.0.1:3000"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Frontend Base URL</span>
                <input
                  value={frontendBaseUrl}
                  onChange={(event) => setFrontendBaseUrl(event.target.value)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="http://127.0.0.1:3001"
                />
              </label>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Gruppi Azure ammessi al portale</span>
                <textarea
                  value={portalAllowedGroups}
                  onChange={(event) => setPortalAllowedGroups(event.target.value)}
                  className="min-h-28 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  placeholder="chrisbot.users, chrisbot.admin"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">UPN ammessi al portale</span>
                <textarea
                  value={portalAllowedUpns}
                  onChange={(event) => setPortalAllowedUpns(event.target.value)}
                  className="min-h-28 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  placeholder={'nome.cognome@azienda.it\naltro.utente@azienda.it'}
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Gruppi Azure super amministratori</span>
                <textarea
                  value={portalSuperAdminGroups}
                  onChange={(event) => setPortalSuperAdminGroups(event.target.value)}
                  className="min-h-28 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  placeholder="chrisbot.admin"
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">UPN super amministratori</span>
                <textarea
                  value={portalSuperAdminUpns}
                  onChange={(event) => setPortalSuperAdminUpns(event.target.value)}
                  className="min-h-28 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  placeholder={'admin@azienda.it\nsuper.admin@azienda.it'}
                />
              </label>
            </div>

            <div className="mt-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-white">Dizionario gruppi Azure</h3>
                  <p className="mt-1 text-xs text-gray-400">
                    Associa un nome parlante all&apos;Object ID Azure. I nomi potranno essere usati nelle altre sezioni del portale.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setGroupDirectory((current) => [...current, { name: '', object_id: '' }])}
                  className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-100 hover:bg-gray-800"
                >
                  Aggiungi gruppo
                </button>
              </div>

              <div className="mt-4 space-y-3">
                {groupDirectory.length === 0 ? (
                  <div className="text-sm text-gray-400">Nessuna associazione configurata.</div>
                ) : groupDirectory.map((entry, index) => (
                  <div key={`group-directory-row-${index}`} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                    <input
                      value={entry.name}
                      onChange={(event) => setGroupDirectory((current) => current.map((row, rowIndex) => rowIndex === index ? {
                        ...row,
                        name: event.target.value,
                      } : row))}
                      placeholder="Nome gruppo es. chrisbot.admin"
                      className="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                    />
                    <input
                      value={entry.object_id}
                      onChange={(event) => setGroupDirectory((current) => current.map((row, rowIndex) => rowIndex === index ? {
                        ...row,
                        object_id: event.target.value,
                      } : row))}
                      placeholder="Object ID Azure"
                      className="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                    />
                    <button
                      type="button"
                      onClick={() => setGroupDirectory((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                      className="rounded-xl border border-rose-800 px-3 py-2 text-sm text-rose-300 hover:bg-rose-950/60"
                    >
                      Rimuovi
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        </section>
      ) : null}

      {activeTab === 'ollama' ? (
        <section className="space-y-4">
        <div className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">OpenAI</h2>
            </div>
            <button
              type="button"
              onClick={handleSaveOpenAi}
              disabled={isSavingOpenAi || !openAiRuntime}
              className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
            >
              {isSavingOpenAi ? 'Salvataggio...' : 'Salva OpenAI'}
            </button>
          </div>

          {openAiRuntime ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">API Key</span>
                <input
                  type="password"
                  value={openAiRuntime.api_key}
                  onChange={(event) => setOpenAiRuntime((current) => current ? { ...current, api_key: event.target.value } : current)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder={openAiRuntime.api_key_configured ? 'Gia configurata; lascia vuoto per mantenerla' : 'sk-...'}
                />
              </label>
              <label className="text-sm text-gray-200">
                <span className="mb-1 block">Chat Model</span>
                <input
                  value={openAiRuntime.chat_model}
                  onChange={(event) => setOpenAiRuntime((current) => current ? { ...current, chat_model: event.target.value } : current)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                  placeholder="gpt-5-mini"
                />
              </label>
            </div>
          ) : null}
        </div>

        <div className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">Ollama</h2>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleSaveOllama}
                disabled={isSavingOllama || !ollamaRuntime}
                className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {isSavingOllama ? 'Salvataggio...' : 'Salva Ollama'}
              </button>
            </div>
          </div>

        {ollamaRuntime ? (
          <>
            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
              <label className="flex h-full flex-col text-sm text-gray-200">
                <span className="mb-1 block">Modelli Ollama disponibili</span>
                <textarea
                  value={ollamaModelsDraft}
                  onChange={(event) => setOllamaModelsDraft(event.target.value)}
                  className="min-h-[260px] flex-1 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  placeholder={'qwen3.5\ngpt-oss\ngemma:e4b'}
                />
                <span className="mt-1 block text-xs text-gray-400">
                  Un modello per riga. Esempio `gemma4:e4b`.
                </span>
              </label>

              <div className="space-y-6">
                <label className="text-sm text-gray-200">
                  <span className="mb-1 block">Server di default</span>
                  <select
                    value={ollamaRuntime.default_connection_id || ''}
                    onChange={(event) => setOllamaRuntime((current) => current ? { ...current, default_connection_id: event.target.value || null } : current)}
                    className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  >
                    <option value="">Seleziona server</option>
                    {ollamaRuntime.connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>{connection.name}</option>
                    ))}
                  </select>
                </label>

                <label className="text-sm text-gray-200">
                  <span className="mb-1 block">Modello globale di default</span>
                  <select
                    value={globalDefaultModelValue}
                    onChange={(event) => setOllamaRuntime((current) => current ? {
                      ...current,
                      default_model: event.target.value === '__openai__' ? '' : event.target.value,
                    } : current)}
                    className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  >
                    {isOpenAiConfigured ? (
                      <option value="__openai__">
                        {`ChatGPT (${openAiRuntime?.chat_model || 'gpt-5-mini'})`}
                      </option>
                    ) : null}
                    {!isOpenAiConfigured && !(ollamaRuntime.models || []).length ? (
                      <option value="" disabled>Nessun modello disponibile</option>
                    ) : null}
                    {(ollamaRuntime.models || []).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </label>

                <label className="text-sm text-gray-200">
                  <span className="mb-1 block">Timeout ms</span>
                  <input
                    type="number"
                    value={ollamaRuntime.timeout_ms}
                    onChange={(event) => setOllamaRuntime((current) => current ? { ...current, timeout_ms: Number(event.target.value || 0) } : current)}
                    className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  />
                </label>

                <div className="rounded-xl border border-gray-800 bg-gray-950/70 px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium text-gray-200">Fallback</div>
                    <Toggle
                      checked={ollamaRuntime.fallback_on_unavailable}
                      onChange={() => setOllamaRuntime((current) => current ? {
                        ...current,
                        fallback_on_unavailable: !current.fallback_on_unavailable,
                      } : current)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-sm font-semibold text-white">Server</h3>
                <button
                  type="button"
                  onClick={addOllamaConnection}
                  aria-label="Aggiungi server Ollama"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-700 text-gray-100 hover:bg-gray-800"
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current">
                    <path d="M10 4.5v11M4.5 10h11" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="mt-4 hidden grid-cols-[120px_140px_200px_minmax(240px,1fr)_96px_56px] gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 lg:grid">
                <div>Attivo</div>
                <div>Stato</div>
                <div>Nome</div>
                <div>URL</div>
                <div>Priorita</div>
                <div></div>
              </div>

              <div className="mt-4 space-y-4">
                {ollamaRuntime.connections.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-700 px-4 py-5 text-sm text-gray-400">
                    Nessun server Ollama configurato.
                  </div>
                ) : (
                  ollamaRuntime.connections.map((connection, index) => {
                    const status = ollamaStatuses[connection.id];
                    const statusMeta = getOllamaStatusMeta(connection, status);
                    return (
                      <div key={connection.id} className="border-b border-gray-800/80 pb-4 last:border-b-0">
                        <div className="grid gap-3 lg:grid-cols-[120px_140px_200px_minmax(240px,1fr)_96px_56px] lg:items-start">
                          <div className="space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Attivo</div>
                            <Toggle
                              checked={connection.enabled}
                              onChange={() => setOllamaRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((row) => row.id === connection.id ? { ...row, enabled: !row.enabled } : row),
                              }) : current)}
                            />
                          </div>

                          <div className="space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Stato</div>
                            <div className="flex min-h-10 items-center">
                              <div className="group relative inline-flex items-center">
                                <span
                                  className={`h-3 w-3 rounded-full ${statusMeta.dotClassName}`}
                                  aria-label={statusMeta.label}
                                />
                                <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                                  {statusMeta.label}
                                </div>
                              </div>
                            </div>
                            {status?.last_error ? (
                              <div className="text-xs text-rose-300">{status.last_error}</div>
                            ) : null}
                          </div>

                          <label className="text-sm text-gray-200">
                            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Nome</span>
                            <input
                              value={connection.name}
                              onChange={(event) => setOllamaRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((row) => row.id === connection.id ? { ...row, name: event.target.value } : row),
                              }) : current)}
                              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                            />
                          </label>

                          <label className="text-sm text-gray-200">
                            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">URL</span>
                            <input
                              value={connection.base_url}
                              onChange={(event) => setOllamaRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((row) => row.id === connection.id ? { ...row, base_url: event.target.value } : row),
                              }) : current)}
                              placeholder="http://host:11434"
                              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                            />
                          </label>

                          <label className="text-sm text-gray-200">
                            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Priorita</span>
                            <input
                              type="number"
                              value={connection.priority}
                              onChange={(event) => setOllamaRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((row) => row.id === connection.id ? { ...row, priority: Number(event.target.value || index + 1) } : row),
                              }) : current)}
                              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                            />
                          </label>

                          <div className="flex items-start justify-end">
                            <button
                              type="button"
                              onClick={() => {
                                const confirmed = window.confirm(`Vuoi davvero eliminare il server "${connection.name}"?`);
                                if (!confirmed) return;
                                setOllamaRuntime((current) => current ? ({
                                  ...current,
                                  connections: current.connections.filter((row) => row.id !== connection.id),
                                  default_connection_id: current.default_connection_id === connection.id ? null : current.default_connection_id,
                                }) : current);
                              }}
                              aria-label={`Rimuovi server ${connection.name}`}
                              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-rose-800 text-rose-300 hover:bg-rose-950/60"
                            >
                              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current">
                                <path d="M4.5 6h11" strokeWidth="1.6" strokeLinecap="round" />
                                <path d="M8 3.5h4" strokeWidth="1.6" strokeLinecap="round" />
                                <path d="M6.5 6v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M8.5 8.5v4.5M11.5 8.5v4.5" strokeWidth="1.6" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        ) : null}
        </div>
        </section>
      ) : null}

      {activeTab === 'telegram' ? (
        <section className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">Telegram Bot</h2>
              <p className="mt-1 text-sm text-gray-300">Configura il bot e assegna manualmente i Telegram user id agli utenti del portale.</p>
            </div>
            <div className="flex items-center gap-3">
              {telegramRuntime ? (
                <div className="flex items-center">
                  <Toggle
                    checked={telegramRuntime.enabled}
                    onChange={() => setTelegramRuntime((current) => current ? {
                      ...current,
                      enabled: !current.enabled,
                    } : current)}
                  />
                </div>
              ) : null}
              <button
                type="button"
                onClick={handleSaveTelegram}
                disabled={isSavingTelegram || !telegramRuntime}
                className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {isSavingTelegram ? 'Salvataggio...' : 'Salva Telegram'}
              </button>
            </div>
          </div>

          {telegramRuntime ? (
            <>
              <div className="mt-6 grid gap-4 lg:max-w-[720px]">
                <label className="text-sm text-gray-200">
                  <span className="mb-1 block">Bot token</span>
                  <input
                    value={telegramRuntime.bot_token}
                    onChange={(event) => setTelegramRuntime((current) => current ? { ...current, bot_token: event.target.value } : current)}
                    className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                    placeholder={telegramRuntime.bot_token_configured ? 'Gia configurato; lascia vuoto per mantenerlo' : '123456:ABC...'}
                  />
                </label>
              </div>

              <div className="mt-4 grid gap-4 lg:max-w-[340px]">
                <label className="text-sm text-gray-200">
                  <span className="mb-1 block">Intervallo polling ms</span>
                  <input
                    type="number"
                    value={telegramRuntime.polling_interval_ms}
                    onChange={(event) => setTelegramRuntime((current) => current ? { ...current, polling_interval_ms: Number(event.target.value || 0) } : current)}
                    className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                  />
                </label>
              </div>

              <div className="mt-8 rounded-2xl border border-gray-800 bg-gray-950/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Mapping utenti Telegram</h3>
                    <p className="mt-1 text-xs text-gray-400">
                      Inserisci l&apos;identificativo interno dell&apos;utente e il Telegram user id ottenuto con `whoami`.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddTelegramUserRow}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600 text-white hover:bg-sky-500"
                    aria-label="Aggiungi mapping Telegram"
                    title="Aggiungi mapping Telegram"
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5 stroke-current">
                      <path d="M10 4.5v11M4.5 10h11" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>

                <div className="mt-4 hidden grid-cols-[140px_minmax(240px,1fr)_220px_120px_56px] gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 lg:grid">
                  <div>Tipo</div>
                  <div>Utente</div>
                  <div>Telegram Id</div>
                  <div>Notifiche</div>
                  <div></div>
                </div>

                <div className="mt-4 space-y-3">
                  {telegramUserRows.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-700 px-4 py-5 text-sm text-gray-400">
                      Nessun mapping Telegram configurato.
                    </div>
                  ) : telegramUserRows.map((entry) => (
                    <div key={entry.localId} className="border-b border-gray-800/80 pb-4 last:border-b-0">
                      <div className="grid gap-3 lg:grid-cols-[140px_minmax(240px,1fr)_220px_120px_56px] lg:items-start">
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Tipo</span>
                          <select
                            value={entry.subject_type}
                            onChange={(event) => handleTelegramUserRowChange(entry.localId, { subject_type: event.target.value as 'user' | 'upn' })}
                            className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                          >
                            <option value="user">user</option>
                            <option value="upn">upn</option>
                          </select>
                        </label>
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Utente</span>
                          <input
                            value={entry.subject_id}
                            onChange={(event) => handleTelegramUserRowChange(entry.localId, { subject_id: event.target.value })}
                            placeholder="utente o upn"
                            className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                          />
                          {(entry.telegram_username || entry.telegram_first_name || entry.telegram_last_name) ? (
                            <div className="mt-2 text-xs text-gray-500">
                              Telegram collegato:
                              {entry.telegram_username ? ` @${entry.telegram_username}` : ''}
                              {entry.telegram_first_name || entry.telegram_last_name
                                ? ` ${(entry.telegram_first_name || '').trim()} ${(entry.telegram_last_name || '').trim()}`.trimEnd()
                                : ''}
                            </div>
                          ) : null}
                        </label>
                        <label className="text-sm text-gray-200">
                          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Telegram Id</span>
                          <input
                            value={entry.telegram_user_id}
                            onChange={(event) => handleTelegramUserRowChange(entry.localId, { telegram_user_id: event.target.value })}
                            placeholder="Telegram user id"
                            className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                          />
                        </label>
                        <div className="space-y-2">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Notifiche</div>
                          <Toggle
                            checked={entry.receive_notifications}
                            onChange={() => handleTelegramUserRowChange(entry.localId, { receive_notifications: !entry.receive_notifications })}
                          />
                        </div>
                        <div className="flex items-start justify-end">
                          <button
                            type="button"
                            onClick={() => handleDeleteTelegramUser(entry)}
                            aria-label={`Elimina mapping Telegram ${entry.subject_id || entry.telegram_user_id || entry.localId}`}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-rose-800 text-rose-300 hover:bg-rose-950/60"
                          >
                            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current">
                              <path d="M4.5 6h11" strokeWidth="1.6" strokeLinecap="round" />
                              <path d="M8 3.5h4" strokeWidth="1.6" strokeLinecap="round" />
                              <path d="M6.5 6v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M8.5 8.5v4.5M11.5 8.5v4.5" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-8 border-t border-gray-800 pt-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Gruppi Telegram destinatari</h3>
                      <p className="mt-1 text-xs text-gray-400">
                        Aggiungi chat di gruppo o canali dove il bot e gia presente e autorizzato a scrivere.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleSaveTelegramGroup}
                      disabled={!telegramGroupDraft.label.trim() || !telegramGroupDraft.telegram_chat_id.trim()}
                      className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
                    >
                      {telegramGroupDraft.id ? 'Aggiorna gruppo' : 'Aggiungi gruppo'}
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px_160px]">
                    <input
                      value={telegramGroupDraft.label}
                      onChange={(event) => setTelegramGroupDraft((current) => ({ ...current, label: event.target.value }))}
                      placeholder="Nome gruppo"
                      className="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                    />
                    <input
                      value={telegramGroupDraft.telegram_chat_id}
                      onChange={(event) => setTelegramGroupDraft((current) => ({ ...current, telegram_chat_id: event.target.value }))}
                      placeholder="Telegram chat id"
                      className="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                    />
                    <label className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100">
                      <input
                        type="checkbox"
                        checked={telegramGroupDraft.is_enabled}
                        onChange={(event) => setTelegramGroupDraft((current) => ({ ...current, is_enabled: event.target.checked }))}
                      />
                      Abilitato
                    </label>
                  </div>
                  {telegramGroupDraft.id ? (
                    <div className="mt-3 flex gap-3">
                      <button
                        type="button"
                        onClick={resetTelegramGroupDraft}
                        className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                      >
                        Annulla modifica
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-4 space-y-3">
                    {telegramGroups.length === 0 ? (
                      <div className="text-sm text-gray-400">Nessun gruppo Telegram configurato.</div>
                    ) : telegramGroups.map((entry) => (
                      <div key={entry.id} className="grid gap-3 rounded-2xl border border-gray-800 bg-gray-900/70 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_220px_120px_auto]">
                        <div className="text-sm text-white">{entry.label}</div>
                        <div className="text-sm text-gray-200">{entry.telegram_chat_id}</div>
                        <div className="text-sm text-gray-200">{entry.is_enabled ? 'on' : 'off'}</div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => editTelegramGroup(entry)}
                            className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                          >
                            Modifica
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteTelegramGroup(entry.id)}
                            className="rounded-xl border border-rose-800 px-3 py-2 text-sm text-rose-300 hover:bg-rose-950/60"
                          >
                            Rimuovi
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'mcp' ? (
        <section className="rounded-3xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-white">Server MCP</h2>
            <p className="mt-1 text-sm text-gray-300">Configura runtime globale del client MCP e singoli endpoint/headers.</p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleSaveMcp}
              disabled={isSavingMcp || !mcpRuntime}
              className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
            >
              {isSavingMcp ? 'Salvataggio...' : 'Salva MCP'}
            </button>
          </div>
        </div>

        {mcpRuntime ? (
          <>
            <div className="mt-6 space-y-4">
              <label className="block max-w-xl text-sm text-gray-200">
                <span className="mb-1 block">Client name</span>
                <input
                  value={String(mcpRuntime.client_name ?? '')}
                  onChange={(event) => setMcpRuntime((current) => current ? ({
                    ...current,
                    client_name: event.target.value,
                  }) : current)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                />
              </label>

              <details className="group rounded-2xl border border-gray-800 bg-gray-950/40">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-gray-100">
                  <span>Impostazioni avanzate MCP</span>
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current text-gray-400 transition-transform group-open:rotate-180">
                    <path d="m5 7.5 5 5 5-5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <div className="grid gap-4 border-t border-gray-800 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    ['client_version', 'Client version'],
                    ['protocol_version', 'Protocol version'],
                    ['tool_cache_ttl_ms', 'Tool cache TTL ms'],
                    ['timeout_ms', 'Timeout ms'],
                    ['unavailable_cooldown_ms', 'Unavailable cooldown ms'],
                    ['call_retry_base_ms', 'Retry base ms'],
                    ['call_retry_max_ms', 'Retry max ms'],
                    ['call_max_retries', 'Max retries'],
                    ['av_timeout_ms', 'AV timeout ms'],
                  ].map(([key, label]) => (
                    <label key={key} className="text-sm text-gray-200">
                      <span className="mb-1 block">{label}</span>
                      <input
                        value={String((mcpRuntime as any)[key] ?? '')}
                        onChange={(event) => setMcpRuntime((current) => current ? ({
                          ...current,
                          [key]: ['client_name', 'client_version', 'protocol_version'].includes(key)
                            ? event.target.value
                            : Number.parseInt(event.target.value || '0', 10) || 0,
                        }) : current)}
                        className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                      />
                    </label>
                  ))}
                </div>
              </details>
            </div>

            <div className="mt-8">
              <div className="mb-3 flex justify-end">
                <button
                  type="button"
                  onClick={addConnection}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-700 text-gray-100 hover:bg-gray-800"
                  aria-label="Aggiungi connessione MCP"
                  title="Aggiungi connessione"
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5 stroke-current">
                    <path d="M10 4v12M4 10h12" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="overflow-x-auto pb-2">
                <div className="min-w-[980px]">
                  <div className="hidden grid-cols-[120px_120px_220px_160px_minmax(260px,1fr)_96px] gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 lg:grid">
                    <div>Attivo</div>
                    <div>Stato</div>
                    <div>Nome</div>
                    <div>Prefix</div>
                    <div>URL</div>
                    <div></div>
                  </div>

              <div className="mt-4 space-y-4">
                {mcpRuntime.connections.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-700 px-4 py-5 text-sm text-gray-400">
                    Nessuna connessione MCP configurata.
                  </div>
                ) : (
                  mcpRuntime.connections.map((connection, index) => {
                    const status = mcpStatuses[connection.id] || mcpStatuses[connection.url];
                    const statusMeta = getMcpStatusMeta(connection, status);
                    return (
                      <div key={connection.id} className="border-b border-gray-800/80 pb-4 last:border-b-0">
                        <div className="grid gap-3 lg:grid-cols-[120px_120px_220px_160px_minmax(260px,1fr)_96px] lg:items-start">
                          <div className="space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Attivo</div>
                            <Toggle
                              checked={connection.enabled}
                              onChange={() => setMcpRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((entry) => entry.id === connection.id ? { ...entry, enabled: !entry.enabled } : entry),
                              }) : current)}
                            />
                          </div>

                          <div className="space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Stato</div>
                            <div className="flex min-h-10 items-center">
                              <div className="group relative inline-flex items-center">
                                <span
                                  className={`h-3 w-3 rounded-full ${statusMeta.dotClassName}`}
                                  aria-label={statusMeta.label}
                                />
                                <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                                  {statusMeta.label}
                                </div>
                              </div>
                            </div>
                            {status?.last_error ? (
                              <div className="text-xs text-rose-300">{status.last_error}</div>
                            ) : null}
                          </div>

                          <label className="text-sm text-gray-200">
                            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Nome</span>
                            <input
                              value={connection.name}
                              onChange={(event) => setMcpRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((entry) => entry.id === connection.id ? { ...entry, name: event.target.value } : entry),
                              }) : current)}
                              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                              placeholder={`Connessione ${index + 1}`}
                            />
                          </label>

                          <label className="text-sm text-gray-200">
                            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">Prefix</span>
                            <input
                              value={connection.name_prefix}
                              onChange={(event) => setMcpRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((entry) => entry.id === connection.id ? { ...entry, name_prefix: event.target.value } : entry),
                              }) : current)}
                              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                            />
                          </label>

                          <label className="text-sm text-gray-200">
                            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500 lg:hidden">URL</span>
                            <input
                              value={connection.url}
                              onChange={(event) => setMcpRuntime((current) => current ? ({
                                ...current,
                                connections: current.connections.map((entry) => entry.id === connection.id ? { ...entry, url: event.target.value } : entry),
                              }) : current)}
                              className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-white"
                            />
                          </label>

                          <div className="flex items-start justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingMcpConnectionId(connection.id)}
                              aria-label={`Modifica proprieta server ${connection.name}`}
                              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-700 text-gray-100 hover:bg-gray-800"
                            >
                              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current">
                                <path d="M8.5 11.5 4 16" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M6 14h2v-2" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M10 10a4 4 0 1 0 1.4-1.4" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M13 6.5h.01" strokeWidth="2.4" strokeLinecap="round" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const confirmed = window.confirm(`Vuoi davvero eliminare il server MCP "${connection.name}"?`);
                                if (!confirmed) return;
                                setMcpRuntime((current) => current ? ({
                                  ...current,
                                  connections: current.connections.filter((entry) => entry.id !== connection.id),
                                }) : current);
                                setConnectionHeadersDraft((current) => {
                                  const next = { ...current };
                                  delete next[connection.id];
                                  return next;
                                });
                                if (editingMcpConnectionId === connection.id) {
                                  setEditingMcpConnectionId(null);
                                }
                              }}
                              aria-label={`Elimina server ${connection.name}`}
                              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-rose-800 text-rose-300 hover:bg-rose-950/60"
                            >
                              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current">
                                <path d="M4.5 6h11" strokeWidth="1.6" strokeLinecap="round" />
                                <path d="M8 3.5h4" strokeWidth="1.6" strokeLinecap="round" />
                                <path d="M6.5 6v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M8.5 8.5v4.5M11.5 8.5v4.5" strokeWidth="1.6" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="mt-6 text-sm text-gray-300">Nessuna configurazione MCP disponibile.</div>
        )}
        </section>
      ) : null}

      {editingMcpConnection ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-2xl rounded-3xl border border-gray-800 bg-gray-900 p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-white">Proprieta server MCP</h3>
                <p className="mt-1 text-sm text-gray-400">{editingMcpConnection.name || editingMcpConnection.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingMcpConnectionId(null)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-700 text-gray-200 hover:bg-gray-800"
                aria-label="Chiudi popup modifica server MCP"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 stroke-current">
                  <path d="M5 5l10 10M15 5 5 15" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <label className="block text-sm text-gray-200">
                <span className="mb-1 block">Descrizione</span>
                <input
                  value={editingMcpConnection.description}
                  onChange={(event) => setMcpRuntime((current) => current ? ({
                    ...current,
                    connections: current.connections.map((entry) => entry.id === editingMcpConnection.id ? { ...entry, description: event.target.value } : entry),
                  }) : current)}
                  className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-white"
                />
              </label>

              <label className="block text-sm text-gray-200">
                <span className="mb-1 block">Headers JSON</span>
                <textarea
                  value={connectionHeadersDraft[editingMcpConnection.id] || '{}'}
                  onChange={(event) => setConnectionHeadersDraft((current) => ({
                    ...current,
                    [editingMcpConnection.id]: event.target.value,
                  }))}
                  className="min-h-48 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-white"
                />
              </label>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setEditingMcpConnectionId(null)}
                className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500"
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
