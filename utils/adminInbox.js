const { insertInboxItem, getInboxItemByKey, updateInboxItem, insertInboxMessage } = require('../database/db_inbox');
const { ensureTaskChat } = require('../services/taskChat');
const { ADMIN_SHARED_OWNER } = require('./adminAccess');

async function resolveFallbackChatId(options = {}) {
  const explicitChatId = String(options.chat_id || '').trim();
  if (explicitChatId) return explicitChatId;
  if (!options.task_id) return null;

  try {
    const taskChat = await ensureTaskChat(options.task_id);
    return String(taskChat?.chatId || '').trim() || null;
  } catch (_error) {
    return null;
  }
}

async function upsertAdminInboxItem(options = {}) {
  const owners = Array.isArray(options.owner_usernames) && options.owner_usernames.length > 0
    ? options.owner_usernames
    : [ADMIN_SHARED_OWNER];

  if (owners.length === 0) return [];

  const fallbackChatId = await resolveFallbackChatId(options);
  const createdIds = [];
  for (const ownerUsername of owners) {
    const owner = String(ownerUsername || '').trim();
    if (!owner) continue;

    const itemKey = options.item_key ? `${options.item_key}:${owner.toLowerCase()}` : null;
    const existing = itemKey ? await getInboxItemByKey(itemKey) : null;
    const ownerChatId = options.chat_id_by_owner?.[owner.toLowerCase()]
      || options.chat_id
      || fallbackChatId
      || existing?.chat_id
      || null;
    const ownerAgentRunId = options.agent_run_id_by_owner?.[owner.toLowerCase()] || options.agent_run_id || null;
    const ownerMetadata = options.metadata_json_by_owner?.[owner.toLowerCase()] || options.metadata_json || {};
    const payload = {
      item_type: options.item_type || 'warning',
      status: options.status || 'open',
      priority: options.priority || 'normal',
      title: options.title || 'Segnalazione amministrativa',
      description: options.description || null,
      category: options.category || null,
      agent_id: options.agent_id || null,
      chat_id: ownerChatId,
      agent_run_id: ownerAgentRunId,
      task_id: options.task_id || null,
      task_run_id: options.task_run_id || null,
      requires_reply: options.requires_reply ? 1 : 0,
      requires_confirmation: options.requires_confirmation ? 1 : 0,
      confirmation_state: options.confirmation_state || null,
      metadata_json: ownerMetadata,
      is_read: 0,
      last_message_at: options.last_message_at || new Date(),
      item_key: itemKey,
    };

    let inboxItemId = existing?.id || null;
    if (!inboxItemId) {
      const created = await insertInboxItem({
        owner_username: owner,
        item_key: itemKey,
        message: options.message,
        ...payload,
      });
      inboxItemId = created.id;
    } else {
      await updateInboxItem(inboxItemId, payload);
    }

    if (options.message) {
      await insertInboxMessage({
        inbox_item_id: inboxItemId,
        role: options.message_role || 'system',
        message_type: options.message_type || 'message',
        agent_id: options.agent_id || null,
        username: options.username || null,
        content: String(options.message),
        metadata_json: ownerMetadata,
        created_at: options.last_message_at || new Date(),
      });
    }
    createdIds.push(inboxItemId);
  }

  return createdIds;
}

module.exports = {
  upsertAdminInboxItem,
};
