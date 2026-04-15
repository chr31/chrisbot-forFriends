const { listEnabledTelegramNotificationTargets } = require('../database/db_telegram');
const { sendTelegramMessage } = require('./telegramBot');

function buildNotificationText(input = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || input.message || input.text || '').trim();
  if (title && body && title !== body) return `${title}\n\n${body}`;
  if (body) return body;
  if (title) return title;
  return 'Notifica';
}

async function broadcastTelegramNotification(input = {}) {
  const targets = await listEnabledTelegramNotificationTargets();
  if (!targets.length) return { sent: 0 };

  const text = buildNotificationText(input);
  let sent = 0;
  await Promise.all(
    targets.map(async (target) => {
      try {
        await sendTelegramMessage(target.telegram_chat_id, text);
        sent += 1;
      } catch (error) {
        console.error(`Errore invio notifica Telegram verso ${target.telegram_chat_id}:`, error?.message || error);
      }
    })
  );
  return { sent };
}

module.exports = {
  broadcastTelegramNotification,
};
