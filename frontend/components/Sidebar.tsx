// components/Sidebar.tsx
'use client';

import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import {
  XMarkIcon,
  TrashIcon,
  PlusIcon,
  BellIcon,
  ClockIcon,
  CircleStackIcon,
  Cog6ToothIcon,
  ArrowLeftOnRectangleIcon, // Icona per il logout
} from '@heroicons/react/24/outline';
import { CpuChipIcon } from '@heroicons/react/24/outline';
import { usePathname, useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  ensureNotificationPermission,
  ensurePushSubscription,
  notifyNewNotifications,
  registerServiceWorker,
} from '@/lib/browserNotifications';

type AgentChat = {
  id: string;
  title?: string | null;
  agent_id: number;
  agent_name: string;
  agent_slug: string;
  agent_kind: 'worker' | 'orchestrator';
  unreadCount: number;
  last_date?: string;
};

type ConversationItem = {
  id: string;
  title: string;
  subtitle: string;
  unreadCount: number;
  lastDate?: string;
};

type Notification = {
  id: number;
  title?: string;
  description?: string;
  data_creazione?: string;
  created_at?: string;
  last_message_at?: string;
  is_read?: boolean;
};

type AuthUser = {
  name: string;
  is_super_admin: boolean;
};

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}

function readCachedAuthUser() {
  try {
    const raw = localStorage.getItem('authUser');
    return raw ? JSON.parse(raw) as AuthUser : null;
  } catch (_) {
    return null;
  }
}

function isAbortLikeError(error: unknown) {
  if (!error) return false;
  const name = String((error as any)?.name || '');
  return name === 'AbortError';
}

export default function Sidebar({ open, setOpen }: { open: boolean, setOpen: (open: boolean) => void }) {
  const [agentChats, setAgentChats] = useState<AgentChat[]>([]);
  const [currentConversationPage, setCurrentConversationPage] = useState(1);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState(0);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const hasSeededNotifications = useRef(false);
  const authUserRef = useRef<AuthUser | null>(null);
  const authResolvedRef = useRef(false);
  const pathname = usePathname();
  const router = useRouter();
  
  const API_URL = '/api';
  const CHATS_PER_PAGE = 25;

  const navigation = [
    { name: 'Nuova chat', href: '/agent-chat/new', icon: PlusIcon },
    ...(authUser?.is_super_admin ? [{ name: 'Alive agents', href: '/alive-agents', icon: CpuChipIcon }] : []),
    ...(authUser?.is_super_admin ? [{ name: 'Inbox', href: '/notifications', icon: BellIcon, count: unreadNotificationsCount }] : []),
    ...(authUser?.is_super_admin ? [{ name: 'Agenti', href: '/agents', icon: CpuChipIcon }] : []),
    ...(authUser?.is_super_admin ? [{ name: 'Task', href: '/pianificazioni', icon: ClockIcon }] : []),
    ...(authUser?.is_super_admin ? [{ name: 'Memory engine', href: '/memory-engine', icon: CircleStackIcon }] : []),
    ...(authUser?.is_super_admin ? [{ name: 'Impostazioni', href: '/settings', icon: Cog6ToothIcon }] : []),
  ];

  const conversations: ConversationItem[] = [
    ...agentChats.map((chat) => ({
      id: chat.id,
      title: chat.title || chat.agent_name,
      subtitle: `${chat.agent_name} · ${chat.agent_kind}`,
      unreadCount: chat.unreadCount,
      lastDate: chat.last_date,
    })),
  ].sort((a, b) => {
    const aTime = a.lastDate ? Date.parse(a.lastDate) : 0;
    const bTime = b.lastDate ? Date.parse(b.lastDate) : 0;
    return bTime - aTime;
  });

  const totalConversationPages = Math.max(1, Math.ceil(conversations.length / CHATS_PER_PAGE));
  const paginatedConversations = conversations.slice(
    (currentConversationPage - 1) * CHATS_PER_PAGE,
    currentConversationPage * CHATS_PER_PAGE
  );

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  useEffect(() => {
    authResolvedRef.current = authResolved;
  }, [authResolved]);

  const fetchAuthUser = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      setAuthResolved(true);
      return null;
    }
    const cachedUser = readCachedAuthUser();
    if (cachedUser) {
      setAuthUser(cachedUser);
      setAuthResolved(true);
    }
    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        return cachedUser;
      }
      const data = await response.json();
      const nextUser = data?.user || null;
      setAuthUser(nextUser);
      if (nextUser) {
        localStorage.setItem('authUser', JSON.stringify(nextUser));
      }
      setAuthResolved(true);
      return nextUser;
    } catch (_) {
      setAuthResolved(true);
      return cachedUser;
    }
  }, [API_URL]);

  const fetchAgentChats = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/agent-chats`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        if (response.status === 403) {
          localStorage.removeItem('authToken');
          router.push('/login');
        }
        throw new Error(`Errore dal server: ${response.statusText}`);
      }

      const data = await response.json();
      setAgentChats(Array.isArray(data) ? data : []);
    } catch (error) {
      if (!isAbortLikeError(error)) {
        setAgentChats([]);
      }
    }
  }, [router]);

  const checkUnreadNotifications = useCallback(async () => {
    if (!authResolvedRef.current) return;
    const token = localStorage.getItem('authToken');
    if (!token) return;
    if (!authUserRef.current?.is_super_admin) {
      setUnreadNotificationsCount(0);
      return;
    }

    try {
      const response = await fetch(`${API_URL}/inbox`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const notifications: Notification[] = await response.json();
        const lastVisited = localStorage.getItem('lastVisitedNotifications') || new Date(0).toISOString();
        const unreadCount = notifications.filter(n => {
          const createdAt = n.last_message_at || n.created_at || n.data_creazione;
          return !n.is_read || new Date(createdAt || 0) > new Date(lastVisited);
        }).length;
        setUnreadNotificationsCount(unreadCount);
        await notifyNewNotifications(notifications, {
          seedBaseline: !hasSeededNotifications.current,
        });
        hasSeededNotifications.current = true;
      }
    } catch (error) {
      setUnreadNotificationsCount(0);
    }
  }, []);

  const refreshChats = useCallback(() => {
    fetchAgentChats();
  }, [fetchAgentChats]);

  useEffect(() => {
    registerServiceWorker();
    const bootstrapNotifications = async () => {
      const hasPermission = await ensureNotificationPermission();
      if (!hasPermission) return;
      const token = localStorage.getItem('authToken');
      if (!token) return;
      await ensurePushSubscription(token);
    };
    bootstrapNotifications().catch(() => {});

    const bootstrapAuth = async () => {
      const nextUser = await fetchAuthUser();
      if (nextUser?.is_super_admin) {
        await checkUnreadNotifications();
      }
    };

    bootstrapAuth();

    return () => {};
  }, [checkUnreadNotifications, fetchAuthUser]);

  useEffect(() => {
    refreshChats();
  }, [refreshChats]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshChats();
        checkUnreadNotifications();
      }
    };

    const chatsIntervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshChats();
      }
    }, 10000);
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        checkUnreadNotifications();
      }
    }, 30000);

    window.addEventListener('agentChatCreated', refreshChats);
    window.addEventListener('agentChatUpdated', refreshChats);
    window.addEventListener('notificationsViewed', checkUnreadNotifications);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(chatsIntervalId);
      clearInterval(intervalId);
      window.removeEventListener('agentChatCreated', refreshChats);
      window.removeEventListener('agentChatUpdated', refreshChats);
      window.removeEventListener('notificationsViewed', checkUnreadNotifications);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [checkUnreadNotifications, refreshChats]);

  useEffect(() => {
    if (currentConversationPage > totalConversationPages) {
      setCurrentConversationPage(totalConversationPages);
    }
  }, [currentConversationPage, totalConversationPages]);

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    router.push('/login');
  };

  const handleDeleteAgentChat = async (chatId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm('Sei sicuro di voler eliminare questa chat agente?')) return;
    const token = localStorage.getItem('authToken');
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/agent-chats/${chatId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error('Errore eliminazione chat agente.');
      }
      window.dispatchEvent(new CustomEvent('agentChatUpdated'));
      fetchAgentChats();
      if (pathname === `/agent-chat/${chatId}`) {
        router.push('/agent-chat/new');
      }
    } catch (error) {
      alert('Errore durante l\'eliminazione della chat agente.');
    }
  };

  const handleDeleteAllAgentChats = async () => {
    const totalChats = conversations.length;
    if (totalChats === 0) return;
    if (!confirm(`Sei sicuro di voler eliminare tutte le chat visibili? (${totalChats})`)) return;

    const token = localStorage.getItem('authToken');
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/agent-chats`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error('Errore eliminazione massiva chat agente.');
      }
      window.dispatchEvent(new CustomEvent('agentChatUpdated'));
      setCurrentConversationPage(1);
      setAgentChats([]);
      router.push('/agent-chat/new');
      fetchAgentChats();
    } catch (_error) {
      alert('Errore durante l\'eliminazione di tutte le chat agente.');
    }
  };

  const sidebarContent = (
    <div className="flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900 px-6 pb-4">

      <div className="flex h-16 shrink-0 items-center" style={{"marginTop":"20px"}}>
        <Image src="/logo-white.png" alt="ChrisBot Logo" width={100} height={100} />
        <h1 className="text-white text-xl font-bold">ChrisBot</h1>
      </div>
      <nav className="flex flex-1 flex-col">
        <ul role="list" className="flex flex-1 flex-col gap-y-7">
          <li>
            <ul role="list" className="-mx-2 space-y-1">
              {navigation.map((item) => (
                <li key={item.name}>
                  <a
                    href={item.href}
                    className={classNames(
                      item.href === pathname
                        ? 'bg-gray-800 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800',
                      'group flex items-center gap-x-3 rounded-md p-2 text-sm leading-6 font-semibold'
                    )}
                  >
                    <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                    {item.name}
                    {item.count && item.count > 0 ? (
                      <span className="ml-auto inline-block min-w-[1.5rem] text-center py-0.5 px-2 text-xs font-medium bg-blue-600 text-white rounded-full">
                        {item.count}
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
        </ul>
      </li>
      <li className="flex-grow flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold leading-6 text-gray-400">Conversazioni</div>
          <button
            type="button"
            onClick={handleDeleteAllAgentChats}
            disabled={conversations.length === 0}
            className={classNames(
              'rounded border px-2 py-1 text-[11px]',
              conversations.length === 0
                ? 'cursor-not-allowed border-gray-800 text-gray-600'
                : 'border-red-800 text-red-300 hover:border-red-500 hover:text-white'
            )}
          >
            Elimina tutte
          </button>
        </div>
        <div className="mt-2 space-y-1 flex-grow overflow-y-auto">
          {paginatedConversations.length === 0 && (
            <div className="rounded-md border border-dashed border-gray-800 px-3 py-2 text-xs text-gray-500">
              Nessuna conversazione disponibile.
            </div>
          )}
          {paginatedConversations.map((conversation) => {
            const isActive = pathname.includes(conversation.id);
            return (
              <div
                key={conversation.id}
                className={classNames(
                  isActive ? 'bg-gray-800' : 'hover:bg-gray-800',
                  'relative group flex flex-col rounded-md'
                )}
              >
                <a
                  href={`/agent-chat/${conversation.id}`}
                  className={classNames(
                    isActive ? 'text-white' : 'text-gray-400 group-hover:text-white',
                    'flex w-full items-start justify-between p-2 pr-14 text-sm leading-6 font-semibold'
                  )}
                >
                  <div className="flex min-w-0 flex-col overflow-hidden">
                    <span className="truncate">{conversation.title}</span>
                    <span className="truncate text-xs text-gray-500 group-hover:text-gray-300">
                      {conversation.subtitle}
                    </span>
                    {conversation.lastDate && (
                      <span className="truncate text-xs text-gray-500 group-hover:text-gray-300">
                        {new Date(conversation.lastDate).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {conversation.unreadCount > 0 && (
                    <span className="ml-2 inline-block min-w-[1.5rem] flex-shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-center text-xs font-medium text-white">
                      {conversation.unreadCount}
                    </span>
                  )}
                </a>
                <div className="absolute right-1 top-2 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(event) => handleDeleteAgentChat(conversation.id, event)}
                    className="p-1 text-gray-500 hover:text-white"
                    title="Elimina chat agente"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {conversations.length > CHATS_PER_PAGE && (
          <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
            <button
              onClick={() => setCurrentConversationPage((prev) => Math.max(1, prev - 1))}
              disabled={currentConversationPage === 1}
              className={classNames(
                'rounded border border-gray-700 px-2 py-1',
                currentConversationPage === 1 ? 'opacity-40 cursor-not-allowed' : 'hover:border-gray-500 hover:text-white'
              )}
            >
              Precedente
            </button>
            <span>Pagina {currentConversationPage} / {totalConversationPages}</span>
            <button
              onClick={() => setCurrentConversationPage((prev) => Math.min(totalConversationPages, prev + 1))}
              disabled={currentConversationPage === totalConversationPages}
              className={classNames(
                'rounded border border-gray-700 px-2 py-1',
                currentConversationPage === totalConversationPages ? 'opacity-40 cursor-not-allowed' : 'hover:border-gray-500 hover:text-white'
              )}
            >
              Successiva
            </button>
          </div>
        )}
          </li>
          {/* Logout Button */}
          <li className="mt-auto">
             <button
                onClick={handleLogout}
                className="group flex items-center gap-x-3 rounded-md p-2 text-sm leading-6 font-semibold text-gray-400 hover:text-white hover:bg-gray-800 w-full"
              >
                <ArrowLeftOnRectangleIcon className="h-6 w-6 shrink-0" aria-hidden="true" />
                Logout
              </button>
          </li>
        </ul>
      </nav>
    </div>
  );

  return (
    <>
      {/* Sidebar per Mobile */}
      <Transition.Root show={open} as={Fragment}>
        <Dialog as="div" className="relative z-50 lg:hidden" onClose={setOpen}>
          <Transition.Child as={Fragment} enter="transition-opacity ease-linear duration-300" enterFrom="opacity-0" enterTo="opacity-100" leave="transition-opacity ease-linear duration-300" leaveFrom="opacity-100" leaveTo="opacity-0">
            <div className="fixed inset-0 bg-gray-900/80" />
          </Transition.Child>
          <div className="fixed inset-0 flex">
            <Transition.Child as={Fragment} enter="transition ease-in-out duration-300 transform" enterFrom="-translate-x-full" enterTo="translate-x-0" leave="transition ease-in-out duration-300 transform" leaveFrom="translate-x-0" leaveTo="-translate-x-full">
              <Dialog.Panel className="relative mr-16 flex w-full max-w-xs flex-1">
                <Transition.Child as={Fragment} enter="ease-in-out duration-300" enterFrom="opacity-0" enterTo="opacity-100" leave="ease-in-out duration-300" leaveFrom="opacity-100" leaveTo="opacity-0">
                  <div className="absolute left-full top-0 flex w-16 justify-center pt-5">
                    <button type="button" className="-m-2.5 p-2.5" onClick={() => setOpen(false)}>
                      <span className="sr-only">Close sidebar</span>
                      <XMarkIcon className="h-6 w-6 text-white" aria-hidden="true" />
                    </button>
                  </div>
                </Transition.Child>
                {sidebarContent}
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Sidebar per Desktop */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
        {sidebarContent}
      </div>
    </>
  );
}
