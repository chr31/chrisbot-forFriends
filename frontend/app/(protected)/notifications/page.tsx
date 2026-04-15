"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowTopRightOnSquareIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  PaperAirplaneIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import {
  ensureNotificationPermission,
  notifyNewNotifications,
  registerServiceWorker,
} from '@/lib/browserNotifications';

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

type InboxMessage = {
  id: number;
  role: 'user' | 'agent' | 'system';
  message_type: 'message' | 'status_update' | 'decision';
  created_at: string;
  content: string;
};

type AgentChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  event_type?: string;
  created_at?: string;
  agent_name?: string | null;
};

type InboxItem = {
  id: number;
  status: 'open' | 'pending_user' | 'pending_agent' | 'resolved' | 'dismissed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  title: string;
  task_title?: string | null;
  description?: string | null;
  category?: string | null;
  owner_username: string;
  task_id?: number | null;
  chat_id?: string | null;
  is_read: boolean;
  requires_reply: boolean;
  requires_confirmation: boolean;
  confirmation_state?: 'pending' | 'approved' | 'rejected' | null;
  created_at: string;
  last_message_at: string;
  messages?: InboxMessage[];
};

const API_URL = '/api';
const UNCATEGORIZED = '__uncategorized__';

function classNames(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function formatDate(value?: string | null) {
  if (!value) return 'n/d';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT');
}

function normalizeCategoryLabel(value?: string | null) {
  return value && String(value).trim() ? String(value).trim() : 'Tutte';
}

function getInboxItemTitle(item?: Pick<InboxItem, 'title' | 'task_title'> | null) {
  return item?.task_title || item?.title || 'Aggiornamento';
}

export default function NotificationsPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null);
  const [chatMessages, setChatMessages] = useState<AgentChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const hasSeededNotifications = useRef(false);
  const itemsRef = useRef<InboxItem[]>([]);
  const selectedIdRef = useRef<number | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  itemsRef.current = items;
  selectedIdRef.current = selectedId;

  useEffect(() => {
    registerServiceWorker();
    ensureNotificationPermission();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const applyLayoutMode = (matches: boolean) => setIsMobile(matches);
    applyLayoutMode(mediaQuery.matches);
    const listener = (event: MediaQueryListEvent) => applyLayoutMode(event.matches);
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return null;
    }
    return { Authorization: `Bearer ${token}` };
  };

  const fetchLinkedChat = async (chatId?: string | null, headersOverride?: Record<string, string> | null) => {
    if (!chatId) {
      setChatMessages([]);
      setChatLoading(false);
      return;
    }

    const headers = headersOverride || getAuthHeaders();
    if (!headers) return;

    setChatLoading(true);
    try {
      const response = await axios.get(`${API_URL}/agent-chats/${chatId}`, { headers });
      setChatMessages(Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      console.error('Impossibile caricare la chat collegata', err);
      setChatMessages([]);
    } finally {
      setChatLoading(false);
    }
  };

  const fetchAuthUser = async () => {
    const headers = getAuthHeaders();
    if (!headers) return null;
    const response = await axios.get(`${API_URL}/auth/me`, { headers });
    const nextUser = response.data?.user || null;
    setAuthUser(nextUser);
    if (!nextUser?.is_super_admin) {
      router.replace('/agent-chat/new');
      return null;
    }
    return nextUser;
  };

  const fetchItemDetails = async (id: number, headersOverride?: Record<string, string> | null) => {
    const headers = headersOverride || getAuthHeaders();
    if (!headers) return null;
    try {
      const response = await axios.get(`${API_URL}/inbox/${id}`, { headers });
      const item = response.data as InboxItem;
      setSelectedItem(item);
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, ...item, is_read: true } : entry)));
      await fetchLinkedChat(item.chat_id, headers);
      setError(null);
      return item;
    } catch (err) {
      console.error('Impossibile caricare dettaglio inbox item', err);
      setError('Impossibile caricare il dettaglio dell\'inbox.');
      setSelectedItem(null);
      setChatMessages([]);
      return null;
    }
  };

  const fetchItems = async (isInitialLoad = false) => {
    const headers = getAuthHeaders();
    if (!headers) return;

    try {
      const response = await axios.get(`${API_URL}/inbox?include_resolved=true&include_dismissed=true`, { headers });
      const incoming = Array.isArray(response.data) ? response.data : [];
      setItems(incoming);
      await notifyNewNotifications(incoming, {
        seedBaseline: !hasSeededNotifications.current,
      });
      hasSeededNotifications.current = true;

      if (isInitialLoad) {
        localStorage.setItem('lastVisitedNotifications', new Date().toISOString());
        window.dispatchEvent(new CustomEvent('notificationsViewed'));
      }

      const currentSelectedId = selectedIdRef.current;
      const selectedStillExists = currentSelectedId && incoming.some((item) => item.id === currentSelectedId);
      const nextSelected = selectedStillExists ? currentSelectedId : (incoming[0]?.id ?? null);

      if (nextSelected !== currentSelectedId) {
        setSelectedId(nextSelected);
      }

      if (nextSelected) {
        await fetchItemDetails(nextSelected, headers);
      } else {
        setSelectedItem(null);
        setChatMessages([]);
      }
      setError(null);
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        router.push('/login');
        return;
      }
      setError('Impossibile caricare l\'inbox.');
    } finally {
      if (isInitialLoad) {
        setLoading(false);
      }
    }
  };

  const bootstrapPage = useEffectEvent(async () => {
    try {
      const user = await fetchAuthUser();
      if (!user?.is_super_admin) return;
      await fetchItems(true);
    } catch (_err) {
      setError('Impossibile verificare i permessi utente.');
      setLoading(false);
    }
  });

  const refreshVisibleItems = useEffectEvent(() => {
    if (document.visibilityState === 'visible') {
      fetchItems(false);
    }
  });

  useEffect(() => {
    bootstrapPage();
    const intervalId = window.setInterval(() => {
      refreshVisibleItems();
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, []);

  const categoryOptions = useMemo(() => {
    const categories = Array.from(new Set(items.map((item) => item.category?.trim() || UNCATEGORIZED)))
      .sort((a, b) => normalizeCategoryLabel(a).localeCompare(normalizeCategoryLabel(b), 'it'));
    return ['all', ...categories];
  }, [items]);

  const filteredItems = useMemo(() => items.filter((item) => {
    const itemCategory = item.category?.trim() || UNCATEGORIZED;
    const matchesCategory = activeCategory === 'all' || itemCategory === activeCategory;
    return matchesCategory;
  }), [activeCategory, items]);

  const conversationMessages = useMemo<AgentChatMessage[]>(() => {
    if (chatMessages.length > 0) return chatMessages;
    return (selectedItem?.messages || []).map((message) => ({
      role: message.role === 'agent' ? 'assistant' : message.role,
      content: message.content,
      created_at: message.created_at,
    }));
  }, [chatMessages, selectedItem]);

  const unreadCount = useMemo(() => items.filter((item) => !item.is_read).length, [items]);

  useEffect(() => {
    if (activeCategory === 'all') return;
    if (!categoryOptions.includes(activeCategory)) {
      setActiveCategory('all');
    }
  }, [activeCategory, categoryOptions]);

  useEffect(() => {
    bottomAnchorRef.current?.scrollIntoView({ block: 'end' });
  }, [chatLoading, conversationMessages, selectedItem?.id]);

  const handleSelect = async (id: number) => {
    setSelectedId(id);
    await fetchItemDetails(id);
    localStorage.setItem('lastVisitedNotifications', new Date().toISOString());
    window.dispatchEvent(new CustomEvent('notificationsViewed'));
  };

  const refreshAfterMutation = async (targetId: number | null, headers: Record<string, string>) => {
    await fetchItems(false);
    if (targetId) {
      const stillExists = itemsRef.current.some((item) => item.id === targetId);
      if (stillExists) {
        setSelectedId(targetId);
        await fetchItemDetails(targetId, headers);
      }
    }
  };

  const runItemAction = async (path: string, payload?: Record<string, unknown>) => {
    if (!selectedItem) return;
    const headers = getAuthHeaders();
    if (!headers) return;
    try {
      await axios.post(`${API_URL}/inbox/${selectedItem.id}/${path}`, payload || {}, { headers });
      setReplyText('');
      await refreshAfterMutation(selectedItem.id, headers);
      setError(null);
    } catch (err: any) {
      console.error('Errore azione inbox', err);
      setError(err.response?.data?.error || 'Impossibile completare l\'azione richiesta.');
    }
  };

  const handleResolve = async (id: number) => {
    const headers = getAuthHeaders();
    if (!headers) return;
    try {
      await axios.post(`${API_URL}/inbox/${id}/resolve`, { status: 'resolved' }, { headers });
      await refreshAfterMutation(id, headers);
      setError(null);
    } catch (err: any) {
      console.error('Errore risoluzione inbox item', err);
      setError(err.response?.data?.error || 'Impossibile segnare la notifica come risolta.');
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Eliminare questa notifica?')) return;
    const headers = getAuthHeaders();
    if (!headers) return;
    try {
      await axios.delete(`${API_URL}/inbox/${id}`, { headers });
      const nextItems = itemsRef.current.filter((item) => item.id !== id);
      setItems(nextItems);
      if (selectedIdRef.current === id) {
        const nextSelected = nextItems[0]?.id ?? null;
        setSelectedId(nextSelected);
        if (nextSelected) {
          await fetchItemDetails(nextSelected, headers);
        } else {
          setSelectedItem(null);
          setChatMessages([]);
        }
      }
      setError(null);
    } catch (err: any) {
      console.error('Errore eliminazione inbox item', err);
      setError(err.response?.data?.error || 'Impossibile eliminare l\'elemento inbox.');
    }
  };

  const handleDeleteCategory = async () => {
    const categoryLabel = activeCategory === 'all' ? 'tutte le notifiche' : `tutte le notifiche della categoria "${normalizeCategoryLabel(activeCategory)}"`;
    if (!window.confirm(`Confermi l'eliminazione di ${categoryLabel}?`)) return;

    const headers = getAuthHeaders();
    if (!headers) return;

    try {
      const search = activeCategory === 'all' ? '' : `?category=${encodeURIComponent(activeCategory)}`;
      await axios.delete(`${API_URL}/inbox${search}`, { headers });
      setSelectedId(null);
      setSelectedItem(null);
      setChatMessages([]);
      await fetchItems(false);
      setError(null);
    } catch (err: any) {
      console.error('Errore eliminazione massiva inbox', err);
      setError(err.response?.data?.error || 'Impossibile eliminare le notifiche selezionate.');
    }
  };

  const handleOpenChatPage = () => {
    if (!selectedItem?.chat_id) return;
    router.push(`/agent-chat/${selectedItem.chat_id}`);
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (!form) return;
      const submitButton = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      submitButton?.click();
    }
  };

  if (loading) {
    return <div className="p-8 text-white">Caricamento inbox...</div>;
  }

  if (authUser && !authUser.is_super_admin) {
    return <div className="p-8 text-white">Accesso riservato ai super amministratori.</div>;
  }

  const showListPanel = !isMobile || !selectedItem;
  const showDetailPanel = !isMobile || Boolean(selectedItem);

  return (
    <div className="grid h-full min-w-0 grid-cols-1 gap-6 overflow-x-hidden py-6 lg:grid-cols-[26rem_minmax(0,1fr)]">
      {showListPanel ? (
      <section className="min-w-0 overflow-x-hidden rounded-2xl border border-white/10 bg-gray-900/80 p-4">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-white">Inbox</h1>
            <p className="text-sm text-gray-400">{unreadCount} elementi non letti</p>
          </div>
          <button
            type="button"
            onClick={handleDeleteCategory}
            className="rounded-lg border border-red-500/40 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-950/40"
          >
            {activeCategory === 'all' ? 'Elimina tutte' : 'Elimina categoria'}
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {categoryOptions.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setActiveCategory(value)}
              className={classNames(
                'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                activeCategory === value ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              )}
            >
              {value === 'all' ? 'Tutte le categorie' : normalizeCategoryLabel(value)}
            </button>
          ))}
        </div>

        {error ? <div className="mb-4 rounded-lg bg-red-950/60 p-3 text-sm text-red-200">{error}</div> : null}

        <div className="space-y-3 overflow-y-auto lg:max-h-[calc(100vh-14rem)]">
          {filteredItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-gray-400">
              Nessun elemento in inbox.
            </div>
          ) : null}

          {filteredItems.map((item) => (
            <div
              key={item.id}
              className={classNames(
                'rounded-xl border p-3 transition-colors',
                selectedId === item.id
                  ? 'border-blue-500 bg-blue-950/30'
                  : 'border-white/10 bg-gray-800/70 hover:border-white/20 hover:bg-gray-800'
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => handleSelect(item.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{getInboxItemTitle(item)}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs uppercase tracking-wide text-gray-400">
                        <span>{item.status}</span>
                        <span>{normalizeCategoryLabel(item.category)}</span>
                        {item.requires_confirmation ? <span>conferma</span> : null}
                      </div>
                    </div>
                    {!item.is_read ? <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-400" /> : null}
                  </div>
                  <div className="text-xs text-gray-500">{formatDate(item.created_at)}</div>
                </button>
                <button
                  type="button"
                  onClick={() => handleResolve(item.id)}
                  className="rounded-lg border border-white/10 p-2 text-gray-400 hover:border-emerald-500/40 hover:bg-emerald-950/30 hover:text-emerald-200"
                  aria-label={`Segna come risolta ${getInboxItemTitle(item)}`}
                >
                  <CheckCircleIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(item.id)}
                  className="rounded-lg border border-white/10 p-2 text-gray-400 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-200"
                  aria-label={`Elimina notifica ${getInboxItemTitle(item)}`}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
      ) : null}

      {showDetailPanel ? (
      <section className="flex h-[calc(100vh-8rem)] min-h-0 min-w-0 flex-col overflow-x-hidden rounded-2xl border border-white/10 bg-gray-900/80 lg:h-full">
        {!selectedItem ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-gray-400">
            Seleziona un elemento dall&apos;inbox.
          </div>
        ) : (
          <>
            <div className="border-b border-white/10 px-6 py-5">
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0">
                  {isMobile ? (
                    <button
                      type="button"
                      onClick={() => setSelectedItem(null)}
                      className="mb-3 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-gray-800 px-3 py-2 text-sm text-white hover:bg-gray-700"
                    >
                      <ArrowLeftIcon className="h-4 w-4" />
                      Torna alla lista
                    </button>
                  ) : null}
                  <h2 className="break-words text-2xl font-semibold text-white">{getInboxItemTitle(selectedItem)}</h2>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-400">
                    <span>{selectedItem.status}</span>
                    <span>{normalizeCategoryLabel(selectedItem.category)}</span>
                    {selectedItem.requires_confirmation ? <span>richiede conferma</span> : null}
                    <span>priorità {selectedItem.priority}</span>
                    {selectedItem.task_id ? <span>task #{selectedItem.task_id}</span> : null}
                    <span>{formatDate(selectedItem.created_at)}</span>
                  </div>
                </div>
                {selectedItem.chat_id ? (
                  <button
                    type="button"
                    onClick={handleOpenChatPage}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-gray-800 px-3 py-2 text-sm text-white hover:bg-gray-700"
                  >
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    Apri chat
                  </button>
                ) : null}
              </div>

              {selectedItem.requires_confirmation && selectedItem.confirmation_state === 'pending' ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => runItemAction('confirm', { decision: 'approve', content: replyText || 'Conferma approvata.' })}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                  >
                    Approva
                  </button>
                  <button
                    type="button"
                    onClick={() => runItemAction('confirm', { decision: 'reject', content: replyText || 'Conferma rifiutata.' })}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
                  >
                    Rifiuta
                  </button>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-6">
              <div className="min-w-0 space-y-3">
                {chatLoading ? (
                  <div className="text-sm text-gray-400">Caricamento chat...</div>
                ) : conversationMessages.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-gray-400">
                    Nessuna conversazione disponibile.
                  </div>
                ) : (
                  conversationMessages.map((message, index) => (
                    <div
                      key={`${message.role}-${message.created_at || index}-${index}`}
                      className={classNames(
                        'min-w-0 max-w-[85%] overflow-x-hidden rounded-xl p-3 text-sm break-words',
                        message.role === 'user'
                          ? 'ml-auto bg-sky-600 text-white sm:max-w-md lg:max-w-xl'
                          : message.role === 'assistant'
                            ? 'bg-gray-800 text-gray-100 sm:max-w-md lg:max-w-2xl'
                            : 'bg-amber-950/30 text-amber-50 sm:max-w-md lg:max-w-2xl'
                      )}
                    >
                      <div className="mb-1 text-xs uppercase tracking-wide text-gray-400">
                        {message.agent_name || message.role}
                        {message.event_type ? ` · ${message.event_type}` : ''}
                        {message.created_at ? ` · ${formatDate(message.created_at)}` : ''}
                      </div>
                      <div className="markdown-content min-w-0 break-words">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))
                )}
                <div ref={bottomAnchorRef} />
              </div>
            </div>

            <div className="border-t border-white/10 p-4">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  runItemAction('reply', { content: replyText });
                }}
                className="flex min-w-0 items-end gap-3 overflow-x-hidden"
              >
                <textarea
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder="Scrivi una risposta amministrativa..."
                  className="min-h-12 min-w-0 w-full rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-white outline-none placeholder:text-gray-500"
                />
                <button
                  type="submit"
                  disabled={!replyText.trim()}
                  className="rounded-xl bg-emerald-600 p-3 text-white disabled:opacity-60"
                >
                  <PaperAirplaneIcon className="h-5 w-5" />
                </button>
              </form>
            </div>
          </>
        )}
      </section>
      ) : null}
    </div>
  );
}
