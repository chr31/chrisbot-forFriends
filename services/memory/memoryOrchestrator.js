const { beforeMemory } = require('./beforeMemory');
const { afterMemory } = require('./afterMemory');

function extractToolActivity(messages = []) {
  const toolCalls = [];
  const toolResults = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      toolCalls.push(...message.tool_calls);
    }
    if (message?.role === 'tool') {
      toolResults.push({
        tool_call_id: message.tool_call_id || null,
        content: message.content || '',
      });
    }
  }
  return { toolCalls, toolResults };
}

async function runBeforeMemory(input = {}) {
  try {
    return await beforeMemory(input);
  } catch (error) {
    console.error('Errore beforeMemory:', error);
    return {
      enabled: false,
      scope: input.agent?.memory_scope || 'shared',
      agent_id: input.agent?.memory_scope === 'dedicated' ? input.agent?.id || null : null,
      facts: [],
      entities: [],
      procedures: [],
      decisions: [],
      tool_lessons: [],
      recent_actions: [],
      warnings: [String(error?.message || error)],
      contextText: '',
      skipped_reason: 'error',
    };
  }
}

async function runAfterMemory(input = {}) {
  try {
    const chat = input.chat && typeof input.chat === 'object'
      ? input.chat
      : {
          chatId: input.chatId || null,
          messages: input.messages,
          userMessage: input.userMessage || null,
          assistantResponse: input.assistantResponse || '',
        };
    const toolActivity = extractToolActivity(chat.messages);
    return await afterMemory({
      ...input,
      chat: {
        ...chat,
        toolCalls: Array.isArray(chat.toolCalls) && chat.toolCalls.length > 0 ? chat.toolCalls : toolActivity.toolCalls,
        toolResults: Array.isArray(chat.toolResults) && chat.toolResults.length > 0 ? chat.toolResults : toolActivity.toolResults,
      },
    });
  } catch (error) {
    console.error('Errore afterMemory:', error);
    return {
      enabled: false,
      scope: input.agent?.memory_scope || 'shared',
      agent_id: input.agent?.memory_scope === 'dedicated' ? input.agent?.id || null : null,
      facts: [],
      entities: [],
      procedures: [],
      decisions: [],
      tool_lessons: [],
      recent_actions: [],
      warnings: [String(error?.message || error)],
      contextText: '',
      skipped_reason: 'error',
    };
  }
}

module.exports = {
  extractToolActivity,
  runBeforeMemory,
  runAfterMemory,
};
