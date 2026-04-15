const { processWebPushQueue, ensureWebPushConfigured } = require('./webPushService');

let timer = null;

function initializeWebPushScheduler() {
  if (timer) return timer;

  if (!ensureWebPushConfigured()) {
    console.warn('Web Push disabilitato: configurazione VAPID mancante o non valida.');
    return null;
  }

  processWebPushQueue().catch((error) => {
    console.error('Errore processamento iniziale coda Web Push:', error);
  });

  timer = setInterval(() => {
    processWebPushQueue().catch((error) => {
      console.error('Errore processamento coda Web Push:', error);
    });
  }, 5000);

  return timer;
}

module.exports = { initializeWebPushScheduler };
