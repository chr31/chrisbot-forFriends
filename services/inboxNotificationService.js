const pool = require('../database/mysql');
const { enqueueWebPushNotification } = require('../database/db_web_push');
const { getTelegramRuntimeSettingsSync } = require('./appSettings');
const { buildTelegramSendDeliveries } = require('./telegramFormatting');
const { postTelegramMethod, sendTelegramDelivery } = require('./telegramApiClient');
const { ADMIN_SHARED_OWNER } = require('../utils/adminAccess');

const TELEGRAM_TEXT_LIMIT = 4000;

function toNullableString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTelegramText(input = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (title && body && title !== body) return `${title}\n\n${body}`;
  return body || title || 'Notifica';
}

async function sendTelegramChunks(chatId, text) {
  const runtime = getTelegramRuntimeSettingsSync();
  const token = String(runtime?.bot_token || '').trim();
  if (runtime?.enabled !== true || !token) return;

  const deliveries = await buildTelegramSendDeliveries({
    chatId,
    text: String(text || '').trim() || 'Notifica',
    parseMode: runtime?.parse_mode,
    maxLength: TELEGRAM_TEXT_LIMIT,
  });
  for (const delivery of deliveries) {
    try {
      await sendTelegramDelivery(token, delivery);
    } catch (error) {
      if (delivery.method === 'sendPhoto' && delivery.fallbackPayloads?.length) {
        console.error('Errore invio immagine tabella Telegram, uso fallback testo:', error?.message || error);
        for (const fallbackPayload of delivery.fallbackPayloads) {
          await postTelegramMethod(token, 'sendMessage', fallbackPayload);
        }
        continue;
      }
      throw error;
    }
  }
}

async function getChatOwnerUsername(db, chatId) {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) return null;

  const [rows] = await db.query(
    `SELECT owner_username
       FROM agent_chats
      WHERE chat_id = ?
      LIMIT 1`,
    [normalizedChatId]
  );

  const owner = String(rows?.[0]?.owner_username || '').trim();
  return owner || null;
}

async function resolveNotificationOwners(db, options = {}) {
  const sourceOwner = await getChatOwnerUsername(db, options.chatId || null);
  if (sourceOwner) return { owners: [sourceOwner], sourceOwner };
  return { owners: [ADMIN_SHARED_OWNER], sourceOwner: null };
}

async function cloneChatForOwners(db, input = {}) {
  const owners = Array.from(
    new Set((input.owners || []).map((owner) => String(owner || '').trim()).filter(Boolean))
  );
  const sourceChatId = String(input.chatId || '').trim();
  const agentId = Number.isFinite(Number(input.agentId)) ? Number(input.agentId) : null;

  if (!sourceChatId || !agentId || owners.length === 0) {
    return { owners, chatIdByOwner: {} };
  }

  const [sourceMessages] = await db.query(
    `SELECT chat_id, agent_id, role, event_type, content, metadata_json, reasoning, total_tokens, created_at
       FROM agent_messages
      WHERE chat_id = ?
      ORDER BY created_at ASC, id ASC`,
    [sourceChatId]
  );

  const chatIdByOwner = {};
  for (const owner of owners) {
    if (input.sourceOwner && owner === input.sourceOwner) {
      chatIdByOwner[owner] = sourceChatId;
      continue;
    }

    const ownerChatId = `${sourceChatId}-${owner.replace(/[^a-z0-9._-]+/gi, '_').toLowerCase()}`;
    chatIdByOwner[owner] = ownerChatId;

    await db.query(
      `INSERT INTO agent_chats (chat_id, agent_id, owner_username, title)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         agent_id = VALUES(agent_id),
         title = COALESCE(VALUES(title), title)`,
      [ownerChatId, agentId, owner, input.title || null]
    );

    const [existingRows] = await db.query(
      'SELECT id FROM agent_messages WHERE chat_id = ? LIMIT 1',
      [ownerChatId]
    );
    if (existingRows.length > 0 || !Array.isArray(sourceMessages) || sourceMessages.length === 0) continue;

    for (const row of sourceMessages) {
      await db.query(
        `INSERT INTO agent_messages
          (chat_id, agent_id, role, event_type, content, metadata_json, reasoning, total_tokens, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ownerChatId,
          Number.isFinite(Number(row.agent_id)) ? Number(row.agent_id) : agentId,
          String(row.role || 'system'),
          String(row.event_type || 'message'),
          String(row.content || ''),
          row.metadata_json ? JSON.stringify(row.metadata_json) : null,
          row.reasoning ? String(row.reasoning) : null,
          Number.isFinite(Number(row.total_tokens)) ? Number(row.total_tokens) : null,
          String(row.role || '') === 'assistant' ? 0 : 1,
          row.created_at || new Date(),
        ]
      );
    }
  }

  return { owners, chatIdByOwner };
}

async function listTelegramTargetsForOwners(db, owners) {
  const normalizedOwners = Array.from(new Set((owners || []).map((owner) => String(owner || '').trim()).filter(Boolean)));
  const targets = new Set();

  if (normalizedOwners.length > 0) {
    const [userRows] = await db.query(
      `SELECT telegram_user_id
         FROM telegram_user_links
        WHERE receive_notifications = 1
          AND subject_id IN (${normalizedOwners.map(() => '?').join(', ')})`,
      normalizedOwners
    );

    for (const row of userRows || []) {
      const chatId = String(row.telegram_user_id || '').trim();
      if (chatId) targets.add(chatId);
    }
  }

  const [groupRows] = await db.query(
    `SELECT telegram_chat_id
       FROM telegram_group_targets
      WHERE is_enabled = 1`
  );

  for (const row of groupRows || []) {
    const chatId = String(row.telegram_chat_id || '').trim();
    if (chatId) targets.add(chatId);
  }

  return Array.from(targets);
}

async function sendTargetedTelegramNotification(input = {}) {
  const targets = await listTelegramTargetsForOwners(pool, input.owners || []);
  if (targets.length === 0) return;

  const text = normalizeTelegramText({
    title: input.title,
    body: input.body,
  });

  await Promise.all(
    targets.map(async (chatId) => {
      try {
        await sendTelegramChunks(chatId, text);
      } catch (error) {
        console.error(`Errore invio Telegram verso ${chatId}:`, error?.message || error);
      }
    })
  );
}

async function createInboxNotification(input = {}) {
  const { insertInboxItem, insertInboxMessage } = require('../database/db_inbox');
  const description = String(input.description || '').trim();
  if (!description) throw new Error('description is required');

  const title = String(input.title || 'Notifica Chrisbot').trim() || 'Notifica Chrisbot';
  const chatId = toNullableString(input.chatId);
  const agentId = Number.isFinite(Number(input.agentId)) ? Number(input.agentId) : null;
  const agentRunId = Number.isFinite(Number(input.agentRunId)) ? Number(input.agentRunId) : null;
  const category = toNullableString(input.category) || 'Chrisbot';

  const conn = await pool.getConnection();
  let telegramPayload = null;

  try {
    await conn.beginTransaction();

    const { owners, sourceOwner } = await resolveNotificationOwners(conn, { chatId });
    const { chatIdByOwner } = await cloneChatForOwners(conn, {
      chatId,
      agentId,
      title,
      owners,
      sourceOwner,
    });

    let lastInsertId = 0;
    const insertedIds = [];

    for (const owner of owners) {
      const created = await insertInboxItem({
        owner_username: owner,
        status: 'open',
        priority: 'normal',
        title,
        description,
        category,
        agent_id: agentId,
        chat_id: chatIdByOwner[owner] || null,
        agent_run_id: agentRunId,
        requires_reply: chatIdByOwner[owner] ? 1 : 0,
        metadata_json: {
          source: 'internal_sendNotification',
          type: category,
        },
        is_read: 0,
        last_message_at: new Date(),
      }, {
        db: conn,
        skipWebPush: true,
        skipTelegram: true,
      });

      lastInsertId = created.id;
      insertedIds.push(created.id);

      await insertInboxMessage({
        db: conn,
        inbox_item_id: created.id,
        role: chatIdByOwner[owner] ? 'agent' : 'system',
        message_type: 'message',
        agent_id: agentId,
        content: description,
        metadata_json: {
          source: 'internal_sendNotification',
          type: category,
        },
        created_at: new Date(),
      });

      await enqueueWebPushNotification({
        owner_username: owner,
        title: `Inbox: ${title}`,
        body: description,
        url: '/notifications',
        tag: `internal-notification-${created.id}`,
        payload_json: {
          source: 'internal_sendNotification',
          inbox_item_id: created.id,
          category,
        },
      });
    }

    await conn.commit();

    telegramPayload = {
      owners,
      title: `Inbox: ${title}`,
      body: description,
    };

    return {
      inserted: insertedIds.length,
      inboxItemId: lastInsertId,
      inboxItemIds: insertedIds,
      owners,
      title,
      category,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    if (telegramPayload) {
      await sendTargetedTelegramNotification(telegramPayload).catch((error) => {
        console.error('Errore inoltro Telegram notifica inbox:', error);
      });
    }
  }
}

module.exports = {
  createInboxNotification,
};
