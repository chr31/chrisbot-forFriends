const webpush = require('web-push');
const {
  getActiveWebPushSubscriptions,
  markWebPushSubscriptionSuccess,
  markWebPushSubscriptionError,
  claimPendingWebPushQueue,
  markWebPushQueueSent,
  markWebPushQueueFailed,
} = require('../database/db_web_push');

let vapidConfigured = false;
let vapidConfigError = null;

function getVapidConfig() {
  const subject = String(process.env.WEB_PUSH_VAPID_SUBJECT || '').trim();
  const publicKey = String(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
  if (!subject || !publicKey || !privateKey) {
    return null;
  }
  return { subject, publicKey, privateKey };
}

function ensureWebPushConfigured() {
  if (vapidConfigured) return true;
  if (vapidConfigError) return false;

  const config = getVapidConfig();
  if (!config) {
    vapidConfigError = new Error('WEB_PUSH_VAPID_* non configurate.');
    return false;
  }

  try {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    vapidConfigured = true;
    return true;
  } catch (error) {
    vapidConfigError = error;
    return false;
  }
}

function getPublicVapidKey() {
  const config = getVapidConfig();
  return config?.publicKey || null;
}

function shouldDeactivateSubscription(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return statusCode === 404 || statusCode === 410;
}

async function sendWebPushToOwner(ownerUsername, payload) {
  if (!ensureWebPushConfigured()) {
    throw vapidConfigError || new Error('Web Push non configurato.');
  }

  const subscriptions = await getActiveWebPushSubscriptions(ownerUsername);
  if (!subscriptions.length) {
    return { delivered: 0, subscriptions: 0 };
  }

  const body = JSON.stringify({
    title: payload.title || 'ChrisBot',
    body: payload.body || 'Hai una nuova notifica.',
    url: payload.url || '/notifications',
    tag: payload.tag || null,
    ...((payload.payload_json && typeof payload.payload_json === 'object') ? payload.payload_json : {}),
  });

  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
          },
        },
        body
      );
      delivered += 1;
      await markWebPushSubscriptionSuccess(subscription.id);
    } catch (error) {
      await markWebPushSubscriptionError(
        subscription.id,
        String(error?.body || error?.message || error),
        shouldDeactivateSubscription(error)
      );
    }
  }

  return { delivered, subscriptions: subscriptions.length };
}

let queueProcessing = false;

async function processWebPushQueue(limit = 20) {
  if (queueProcessing) return { processed: 0, skipped: true };
  if (!ensureWebPushConfigured()) return { processed: 0, skipped: true };

  queueProcessing = true;
  try {
    const jobs = await claimPendingWebPushQueue(limit);
    for (const job of jobs) {
      try {
        await sendWebPushToOwner(job.owner_username, job);
        await markWebPushQueueSent(job.id);
      } catch (error) {
        await markWebPushQueueFailed(job.id, String(error?.message || error));
      }
    }
    return { processed: jobs.length, skipped: false };
  } finally {
    queueProcessing = false;
  }
}

module.exports = {
  ensureWebPushConfigured,
  getPublicVapidKey,
  sendWebPushToOwner,
  processWebPushQueue,
};
