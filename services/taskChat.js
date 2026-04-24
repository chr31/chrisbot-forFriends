const crypto = require('crypto');
const { ADMIN_SHARED_OWNER } = require('../utils/adminAccess');
const { getTaskById, updateTask } = require('../database/db_tasks');
const { getAgentById } = require('../database/db_agents');
const { createAgentChat, getAgentChatByChatId, updateAgentChatConfig } = require('../database/db_agent_chats');
const { getAgentDefaultModelConfig } = require('./aiModelCatalog');

function buildTaskChatId(taskId, runKey = null) {
  return runKey ? `task-${taskId}-${runKey}` : `task-${taskId}`;
}

async function ensureTaskChat(taskInput, options = {}) {
  const task = taskInput?.id ? taskInput : await getTaskById(taskInput);
  if (!task?.id || !task.worker_agent_id) return null;

  const worker = options.worker || await getAgentById(task.worker_agent_id);
  if (!worker?.id) return null;

  const storedChatId = String(task.payload_json?.task_chat_id || '').trim();
  const forceNew = options.forceNew === true;
  const runKey = forceNew
    ? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`
    : null;
  const chatId = forceNew ? buildTaskChatId(task.id, runKey) : (storedChatId || buildTaskChatId(task.id));
  const existingChat = await getAgentChatByChatId(chatId);
  const modelConfig = getAgentDefaultModelConfig(worker);
  if (!existingChat) {
    await createAgentChat({
      chat_id: chatId,
      agent_id: worker.id,
      owner_username: ADMIN_SHARED_OWNER,
      title: String(
        forceNew
          ? `${task.title || task.payload_json?.request_text || `Task ${task.id}`} [run ${new Date().toISOString()}]`
          : (task.title || task.payload_json?.request_text || `Task ${task.id}`)
      ).trim().slice(0, 180),
      config_json: {
        model_config: modelConfig,
      },
    });
  } else if (JSON.stringify(existingChat.config_json?.model_config || null) !== JSON.stringify(modelConfig)) {
    await updateAgentChatConfig(chatId, {
      ...(existingChat.config_json || {}),
      model_config: modelConfig,
    });
  }

  if (!forceNew && storedChatId !== chatId) {
    await updateTask(task.id, {
      payload_json: {
        ...(task.payload_json || {}),
        task_chat_id: chatId,
      },
    });
  }

  return {
    chatId,
    ownerUsername: ADMIN_SHARED_OWNER,
  };
}

module.exports = {
  buildTaskChatId,
  ensureTaskChat,
};
