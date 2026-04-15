export type RemoteNotification = {
  id: number | string;
  title?: string;
  task_title?: string;
  type?: string;
  category?: string;
  status?: string;
  description?: string;
  data_creazione?: string;
  created_at?: string;
  last_message_at?: string;
};

const LAST_DELIVERED_KEY = 'lastNotificationDeliveredAt';
let cachedLastDelivered: string | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let permissionRequest: Promise<NotificationPermission> | null = null;
let subscriptionSyncPromise: Promise<boolean> | null = null;

const loadLastDelivered = () => {
  if (cachedLastDelivered) return cachedLastDelivered;
  if (typeof window === 'undefined') return null;
  cachedLastDelivered = localStorage.getItem(LAST_DELIVERED_KEY);
  return cachedLastDelivered;
};

const persistLastDelivered = (value: string) => {
  cachedLastDelivered = value;
  if (typeof window === 'undefined') return;
  localStorage.setItem(LAST_DELIVERED_KEY, value);
};

export const registerServiceWorker = async () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register('/sw.js')
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        return registration;
      })
      .catch((error) => {
        console.error('Impossibile registrare il service worker per le notifiche.', error);
        return null;
      });
  }
  return registrationPromise;
};

function base64UrlToUint8Array(base64UrlString: string) {
  const padding = '='.repeat((4 - (base64UrlString.length % 4)) % 4);
  const normalized = (base64UrlString + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

export const ensureNotificationPermission = async () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') {
    await registerServiceWorker();
    return true;
  }
  if (Notification.permission === 'denied') return false;
  if (!permissionRequest) {
    permissionRequest = Notification.requestPermission().finally(() => {
      permissionRequest = null;
    });
  }
  const permission = await permissionRequest;
  if (permission === 'granted') {
    await registerServiceWorker();
    return true;
  }
  return false;
};

export const ensurePushSubscription = async (authToken?: string | null) => {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (!authToken) return false;
  if (Notification.permission !== 'granted') return false;
  if (!subscriptionSyncPromise) {
    subscriptionSyncPromise = (async () => {
      const registration = await registerServiceWorker();
      if (!registration) return false;

      const publicKeyResponse = await fetch('/api/push/public-key', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!publicKeyResponse.ok) return false;
      const publicKeyPayload = await publicKeyResponse.json();
      const publicKey = String(publicKeyPayload?.publicKey || '').trim();
      if (!publicKey) return false;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        });
      }

      const syncResponse = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ subscription }),
      });
      return syncResponse.ok;
    })().finally(() => {
      subscriptionSyncPromise = null;
    });
  }
  return subscriptionSyncPromise;
};

const sanitizeBody = (text?: string) => {
  if (!text) return 'Hai una nuova notifica.';
  return text
    .replace(/\!\[[^\]]*\]\([^\)]*\)/g, '') // rimuove immagini markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link markdown -> testo
    .replace(/[#>*_`~\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

type NotifyOptions = {
  seedBaseline?: boolean;
};

export const notifyNewNotifications = async (
  notifications: RemoteNotification[],
  options: NotifyOptions = {}
) => {
  if (typeof window === 'undefined' || !notifications.length) return;

  const sorted = [...notifications].sort(
    (a, b) =>
      new Date(a.last_message_at || a.created_at || a.data_creazione || 0).getTime() -
      new Date(b.last_message_at || b.created_at || b.data_creazione || 0).getTime()
  );

  const lastDelivered = loadLastDelivered();
  const hasBaseline = Boolean(lastDelivered);

  if (!hasBaseline && options.seedBaseline) {
    const latest = sorted[sorted.length - 1]?.last_message_at || sorted[sorted.length - 1]?.created_at || sorted[sorted.length - 1]?.data_creazione;
    if (latest) persistLastDelivered(new Date(latest).toISOString());
    return;
  }

  const baselineTime = lastDelivered ? new Date(lastDelivered).getTime() : 0;
  const freshNotifications = sorted.filter(
    (item) => new Date(item.last_message_at || item.created_at || item.data_creazione || 0).getTime() > baselineTime
  );

  if (!freshNotifications.length) {
    const latest = sorted[sorted.length - 1]?.last_message_at || sorted[sorted.length - 1]?.created_at || sorted[sorted.length - 1]?.data_creazione;
    if (latest && new Date(latest).getTime() > baselineTime) {
      persistLastDelivered(new Date(latest).toISOString());
    }
    return;
  }

  const hasPermission = await ensureNotificationPermission();
  if (!hasPermission) {
    const latest = freshNotifications[freshNotifications.length - 1]?.last_message_at || freshNotifications[freshNotifications.length - 1]?.created_at || freshNotifications[freshNotifications.length - 1]?.data_creazione;
    if (latest) persistLastDelivered(new Date(latest).toISOString());
    return;
  }

  const registration = await registerServiceWorker();

  for (const item of freshNotifications) {
    const heading = item.task_title || item.title || item.category || item.type || 'Aggiornamento';
    const title = `Inbox: ${heading}`;
    const options: NotificationOptions = {
      body: sanitizeBody(item.description || item.task_title || item.title || item.category || item.type),
      tag: `notification-${item.id}`,
      data: { url: '/notifications' },
    };

    try {
      if (registration?.showNotification) {
        registration.showNotification(title, options);
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, options);
      }
    } catch (error) {
      console.error('Impossibile inviare la notifica del browser.', error);
    }
  }

  const latest = freshNotifications[freshNotifications.length - 1]?.last_message_at || freshNotifications[freshNotifications.length - 1]?.created_at || freshNotifications[freshNotifications.length - 1]?.data_creazione;
  if (latest) persistLastDelivered(new Date(latest).toISOString());
};
