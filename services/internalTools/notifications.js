const { createInboxNotification } = require('../inboxNotificationService');

async function createInternalNotification(input = {}) {
  return createInboxNotification({
    description: input.description,
    title: input.title || 'Notifica Chrisbot',
    chatId: input._chatId || null,
    agentId: input._agentId || null,
    agentRunId: input._runId || null,
    category: 'Chrisbot',
  });
}

module.exports = {
  createInternalNotification,
};
