const crypto = require('crypto');
const { askOllamaChatCompletions } = require('../utils/askGpt');
const { getMcpTools, callMcpTool } = require('../utils/mcpClient');
const { getAgentById, getAgentToolNames, getAgentRelations } = require('../database/db_agents');
const { insertAgentMessages } = require('../database/db_agent_chats');
const { insertAgentRun, updateAgentRunIfStatus } = require('../database/db_agent_runs');
const { createOpenAiClient, getDefaultOpenAiModel } = require('./openaiRuntime');
const { MODEL_PROVIDERS, normalizeModelConfig, getAgentDefaultModelConfig } = require('./aiModelCatalog');

function toToolContentString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function toAssistantContentString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        if (item && typeof item.data === 'string') return item.data;
        try {
          return JSON.stringify(item);
        } catch (_) {
          return String(item);
        }
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.data === 'string') return value.data;
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function parseToolArguments(rawArgs) {
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs !== 'string') return {};
  return JSON.parse(rawArgs);
}

function parseToolArgumentsSafely(rawArgs) {
  try {
    return { args: parseToolArguments(rawArgs), error: null };
  } catch (error) {
    return {
      args: {},
      error: error?.message || 'JSON argomenti non valido',
    };
  }
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function parseJsonIfPossible(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function stringifyForModel(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function extractToolFallbackText(content) {
  const parsed = parseJsonIfPossible(content);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.isError) {
      return stringifyForModel(parsed.error || parsed.result || parsed).trim();
    }
    if (parsed.error !== undefined && parsed.error !== null && String(parsed.error).trim()) {
      return `Errore tool: ${String(parsed.error).trim()}`;
    }
    if (parsed.result !== undefined && parsed.result !== null) {
      const resultText = stringifyForModel(parsed.result).trim();
      if (resultText) return resultText;
    }
    const parsedText = stringifyForModel(parsed).trim();
    if (parsedText) return parsedText;
  }
  return String(content || '').trim();
}

function buildAssistantFallbackFromToolMessages(toolMessages = []) {
  for (let index = toolMessages.length - 1; index >= 0; index -= 1) {
    const candidate = extractToolFallbackText(toolMessages[index]?.content);
    if (candidate) return candidate;
  }
  return '';
}

function sanitizeMessages(messages) {
  const sanitized = [];
  let pendingToolCallIds = new Set();

  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!raw || !raw.role) continue;
    if (raw.role === 'assistant' && raw.tool_calls) {
      pendingToolCallIds = new Set(
        Array.isArray(raw.tool_calls) ? raw.tool_calls.map((tc) => tc?.id).filter(Boolean) : []
      );
      sanitized.push({
        role: 'assistant',
        content: raw.content ?? null,
        tool_calls: raw.tool_calls,
      });
      continue;
    }

    if (raw.role === 'tool') {
      const last = sanitized[sanitized.length - 1];
      const hasCaller =
        raw.tool_call_id &&
        last &&
        last.role === 'assistant' &&
        Array.isArray(last.tool_calls) &&
        last.tool_calls.some((tc) => tc.id === raw.tool_call_id);
      if (hasCaller) {
        sanitized.push({
          role: 'tool',
          tool_call_id: raw.tool_call_id,
          content: toToolContentString(raw.content),
        });
        pendingToolCallIds.delete(raw.tool_call_id);
      }
      continue;
    }

    sanitized.push({ role: raw.role, content: raw.role === 'assistant' ? toAssistantContentString(raw.content) : (raw.content ?? '') });
  }

  for (const toolCallId of pendingToolCallIds) {
    sanitized.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: 'Tool non eseguito: storico incompleto recuperato dal database.',
    });
  }

  return sanitized;
}

function isNestedWorkerToolResult(row) {
  if (!row || row.role !== 'tool' || row.event_type !== 'tool_result') return false;
  const depth = Number(row?.metadata_json?.depth || 0);
  return depth > 0 || Boolean(row?.metadata_json?.delegated_by_agent_id);
}

function isNotificationToolName(functionName) {
  const normalized = String(functionName || '').trim().toLowerCase();
  return normalized === 'sendnotification'
    || normalized.endsWith('_sendnotification')
    || normalized.endsWith('.sendnotification')
    || normalized.endsWith(':sendnotification');
}

function isInternalPortalToolName(functionName) {
  const normalized = String(functionName || '').trim().toLowerCase();
  return normalized.startsWith('chrisbot_');
}

function isCacheableToolCall(functionName) {
  const normalized = String(functionName || '').trim().toLowerCase();
  if (!normalized) return false;
  if (isNotificationToolName(normalized) || isInternalPortalToolName(normalized)) return false;
  if (normalized.startsWith('delegate_to_')) return false;
  return !/(^|[_.:-])(send|create|update|delete|remove|post|put|patch|write|upsert)([_.:-]|$)/.test(normalized);
}

function normalizeGuardrails(agent) {
  const raw = agent?.guardrails_json && typeof agent.guardrails_json === 'object' ? agent.guardrails_json : {};
  return {
    max_tool_rounds: Number.isFinite(Number(raw.max_tool_rounds)) ? Math.max(1, Math.trunc(Number(raw.max_tool_rounds))) : 8,
    max_delegations: Number.isFinite(Number(raw.max_delegations)) ? Math.max(0, Math.trunc(Number(raw.max_delegations))) : 3,
    max_depth: Number.isFinite(Number(raw.max_depth)) ? Math.max(0, Math.trunc(Number(raw.max_depth))) : 2,
  };
}

async function persistConversationMessages(context, messages) {
  const writer = typeof context?.messageWriter === 'function' ? context.messageWriter : insertAgentMessages;
  await writer(messages);
}

async function logAgentEvent(context, agent, eventType, content, metadata = {}) {
  await persistConversationMessages(context, [{
    chat_id: context.chatId,
    agent_id: agent?.id || null,
    role: eventType === 'guardrail' ? 'assistant' : 'assistant',
    event_type: eventType,
    content: String(content || ''),
    metadata_json: {
      run_id: context.runId || null,
      parent_run_id: context.parentRunId || null,
      depth: Number.isFinite(context.depth) ? context.depth : 0,
      ...metadata,
    },
  }]);
}

async function getAllowedMcpTools(toolNames) {
  const allTools = await getMcpTools();
  const allowedSet = new Set(Array.isArray(toolNames) ? toolNames : []);
  return allTools.filter((tool) => {
    const name = tool?.function?.name || tool?.name;
    return Boolean(name) && allowedSet.has(name);
  });
}

async function executeMcpTool(functionName, args, context, toolCall, agent) {
  let content = '';
  try {
    const toolArgs = { ...(args || {}) };
    if (isInternalPortalToolName(functionName)) {
      toolArgs._chatId = context.chatId || null;
      toolArgs._agentId = agent?.id || context.agentId || null;
      toolArgs._runId = context.runId || null;
    }
    if (isNotificationToolName(functionName)) {
      toolArgs._chatId = context.chatId || null;
      toolArgs._agentId = agent?.id || context.agentId || null;
      toolArgs._runId = context.runId || null;
    }
    const result = await callMcpTool(functionName, toolArgs);
    content = toToolContentString(result);
  } catch (error) {
    content = [
      'Errore esecuzione tool',
      `Funzione: ${functionName}`,
      `Dettaglio: ${error?.message || 'errore sconosciuto'}`,
    ].join('\n');
  }

  await persistConversationMessages(context, [{
    chat_id: context.chatId,
    agent_id: agent.id,
    role: 'tool',
    event_type: 'tool_result',
    content,
    metadata_json: {
      run_id: context.runId || null,
      parent_run_id: context.parentRunId || null,
      depth: Number.isFinite(context.depth) ? context.depth : 0,
      tool_name: functionName,
      tool_call_id: toolCall?.id || null,
      arguments: args || {},
    },
  }]);

  return {
    role: 'tool',
    tool_call_id: toolCall?.id,
    content,
  };
}

function buildDelegationToolName(agent) {
  const base = String(agent.slug || agent.name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `delegate_to_${base.slice(0, 48) || 'agent'}`;
}

async function buildDelegationTools(orchestratorAgent) {
  if (orchestratorAgent.kind !== 'orchestrator') return { tools: [], childByToolName: new Map() };
  const relations = await getAgentRelations(orchestratorAgent.id);
  const activeRelations = relations.filter((entry) => entry.is_active);
  const childByToolName = new Map();
  const tools = [];
  for (const rel of activeRelations) {
    const childAgent = await getAgentById(rel.worker_agent_id);
    if (!childAgent) continue;
    const toolName = buildDelegationToolName(childAgent);
    childByToolName.set(toolName, { agent: childAgent, relation: rel });
    const hint = rel?.routing_hint ? ` Suggerimento: ${rel.routing_hint}.` : '';
    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: `Delega il task all'agente ${childAgent.name}.${hint}`,
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: `Istruzioni complete da passare a ${childAgent.name}.`,
            },
          },
          required: ['task'],
        },
      },
    });
  }
  return { tools, childByToolName };
}

async function executeAgentRun(agent, messages, context) {
  const guardrails = normalizeGuardrails(agent);
  if (context.depth > guardrails.max_depth) {
    await logAgentEvent(
      context,
      agent,
      'guardrail',
      `Guardrail attivato: profondita massima superata (${guardrails.max_depth}).`,
      { guardrail_type: 'max_depth', blocked: true }
    );
    throw new Error(`Guardrail: profondita massima superata (${guardrails.max_depth}).`);
  }

  const agentToolNames = await getAgentToolNames(agent.id);
  const mcpTools = await getAllowedMcpTools(agentToolNames);
  const { tools: delegationTools, childByToolName } = await buildDelegationTools(agent);
  const allTools = [...mcpTools, ...delegationTools];
  const sanitizedMessages = sanitizeMessages(messages);

  const modelConfig = normalizeModelConfig(context.modelConfig || {}, getAgentDefaultModelConfig(agent))
  const responseMessage = modelConfig.provider === MODEL_PROVIDERS.OPENAI
    ? await createOpenAiClient().chat.completions.create({
        model: modelConfig.model || getDefaultOpenAiModel(),
        messages: sanitizedMessages,
        tools: allTools.length > 0 ? allTools : undefined,
      }).then((response) => ({
        ...response.choices[0].message,
        total_tokens: Number.isFinite(response?.usage?.total_tokens) ? response.usage.total_tokens : null,
      }))
    : await askOllamaChatCompletions(
        sanitizedMessages,
        allTools.length > 0 ? allTools : null,
        modelConfig.model,
        { ollamaServerId: modelConfig.ollama_server_id || context.ollamaServerId || null }
      );

  return { responseMessage, guardrails, childByToolName };
}

async function runAgentConversation(agent, messages, context, depth = 0, toolState = null) {
  const sharedToolState = toolState || {
    resultBySignature: new Map(),
    callsBySignature: new Map(),
    delegationCount: 0,
  };
  const { responseMessage, guardrails, childByToolName } = await executeAgentRun(agent, messages, context);

  messages.push(responseMessage);

  if (responseMessage.role === 'assistant') {
    const assistantContent = toAssistantContentString(responseMessage.content);
    const hasVisibleAssistantPayload = Boolean(assistantContent.trim())
      || Boolean(String(responseMessage.reasoning || '').trim())
      || Number.isFinite(responseMessage.total_tokens);
    if ((context.depth || 0) === 0 && hasVisibleAssistantPayload) {
      await persistConversationMessages(context, [{
        chat_id: context.chatId,
        agent_id: agent.id,
        role: 'assistant',
        event_type: 'message',
        content: assistantContent,
        reasoning: responseMessage.reasoning || null,
        total_tokens: responseMessage.total_tokens || null,
        metadata_json: {
          run_id: context.runId || null,
          parent_run_id: context.parentRunId || null,
          depth: Number.isFinite(context.depth) ? context.depth : 0,
          delegated_by_agent_id: depth > 0 ? context.parentAgentId || null : null,
        },
      }]);
    }
  }

  if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
    return toAssistantContentString(responseMessage.content);
  }

  if (depth >= guardrails.max_tool_rounds) {
    await logAgentEvent(
      context,
      agent,
      'guardrail',
      `Guardrail attivato: limite iterazioni tool raggiunto (${guardrails.max_tool_rounds}).`,
      { guardrail_type: 'max_tool_rounds', blocked: true }
    );
    throw new Error(`Guardrail: limite iterazioni tool raggiunto (${guardrails.max_tool_rounds}).`);
  }

  const toolMessages = [];
  for (const toolCall of responseMessage.tool_calls) {
    const fnName = toolCall?.function?.name || 'unknown_tool';
    const parsedToolArgs = parseToolArgumentsSafely(toolCall?.function?.arguments);
    if (parsedToolArgs.error) {
      const content = [
        'Argomenti tool non validi: JSON non parsabile.',
        `Funzione: ${fnName}`,
        `Dettaglio: ${parsedToolArgs.error}`,
      ].join('\n');
      await persistConversationMessages(context, [{
        chat_id: context.chatId,
        agent_id: agent.id,
        role: 'tool',
        event_type: 'tool_result',
        content,
        metadata_json: {
          run_id: context.runId || null,
          parent_run_id: context.parentRunId || null,
          depth: Number.isFinite(context.depth) ? context.depth : 0,
          tool_name: fnName,
          tool_call_id: toolCall?.id || null,
          invalid_arguments: true,
          raw_arguments: toolCall?.function?.arguments ?? null,
        },
      }]);
      toolMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content,
      });
      continue;
    }
    const parsedArgs = parsedToolArgs.args;
    const signature = `${fnName}::${stableStringify(parsedArgs)}`;
    const canReuseToolResult = isCacheableToolCall(fnName);
    if (canReuseToolResult && sharedToolState.resultBySignature.has(signature)) {
      toolMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: sharedToolState.resultBySignature.get(signature),
      });
      continue;
    }

    if (childByToolName.has(fnName)) {
      if (sharedToolState.delegationCount >= guardrails.max_delegations) {
        const content = `Guardrail: limite deleghe raggiunto (${guardrails.max_delegations}).`;
        await logAgentEvent(
          context,
          agent,
          'guardrail',
          content,
          { guardrail_type: 'max_delegations', blocked: true, tool_call_id: toolCall.id }
        );
        toolMessages.push({ role: 'tool', tool_call_id: toolCall.id, content });
        if (canReuseToolResult) {
          sharedToolState.resultBySignature.set(signature, content);
        }
        continue;
      }

      sharedToolState.delegationCount += 1;
      const childInfo = childByToolName.get(fnName);
      const childAgent = childInfo.agent;
      const delegatedTask = String(parsedArgs.task || '').trim();
      await persistConversationMessages(context, [{
        chat_id: context.chatId,
        agent_id: childAgent.id,
        role: 'assistant',
        event_type: 'delegation',
        content: `Delega verso ${childAgent.name}: ${delegatedTask}`,
        metadata_json: {
          run_id: context.runId || null,
          parent_run_id: context.parentRunId || null,
          depth: Number.isFinite(context.depth) ? context.depth : 0,
          delegated_by_agent_id: agent.id,
          child_agent_id: childAgent.id,
          target_agent_name: childAgent.name,
          tool_call_id: toolCall.id,
        },
      }]);

      const childMessages = [
        { role: 'system', content: `${childAgent.system_prompt}\nOggi e il ${new Date().toISOString()}` },
        { role: 'user', content: delegatedTask },
      ];
      const childRun = await insertAgentRun({
        chat_id: context.chatId,
        agent_id: childAgent.id,
        parent_run_id: context.runId || null,
        status: 'running',
        model_name: getAgentDefaultModelConfig(childAgent).model,
        model_provider: getAgentDefaultModelConfig(childAgent).provider,
        depth: (context.depth || 0) + 1,
        started_at: new Date(),
      });
      let childResult;
      try {
        childResult = await runAgentConversation(childAgent, childMessages, {
          ...context,
          agentId: childAgent.id,
          parentAgentId: agent.id,
          parentRunId: context.runId || null,
          runId: childRun.id,
          modelConfig: getAgentDefaultModelConfig(childAgent),
          ollamaServerId: getAgentDefaultModelConfig(childAgent).ollama_server_id || null,
          depth: context.depth + 1,
          messageWriter: context.messageWriter,
        }, 0, {
          resultBySignature: new Map(),
          callsBySignature: new Map(),
          delegationCount: 0,
        });
        await updateAgentRunIfStatus(childRun.id, {
          status: 'completed',
          finished_at: new Date(),
        }, 'running');
      } catch (error) {
        await updateAgentRunIfStatus(childRun.id, {
          status: 'failed',
          finished_at: new Date(),
          last_error: String(error?.message || error),
        }, 'running');
        throw error;
      }

      const childContent = typeof childResult === 'string' ? childResult : JSON.stringify(childResult);
      await persistConversationMessages(context, [{
        chat_id: context.chatId,
        agent_id: childAgent.id,
        role: 'tool',
        event_type: 'delegation_result',
        content: childContent,
        metadata_json: {
          run_id: childRun.id,
          parent_run_id: context.runId || null,
          depth: Number.isFinite(context.depth) ? context.depth + 1 : 1,
          delegated_by_agent_id: agent.id,
          child_agent_id: childAgent.id,
          tool_call_id: toolCall.id,
        },
      }]);
      toolMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: childContent,
      });
      if (canReuseToolResult) {
        sharedToolState.resultBySignature.set(signature, childContent);
      }
      continue;
    }

    const result = await executeMcpTool(fnName, parsedArgs, context, toolCall, agent);
    const content = toToolContentString(result.content);
    toolMessages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content,
    });
    if (canReuseToolResult) {
      sharedToolState.resultBySignature.set(signature, content);
    }
  }

  messages.push(...toolMessages);
  const finalResponse = await runAgentConversation(agent, messages, context, depth + 1, sharedToolState);
  const finalResponseText = String(finalResponse || '').trim();
  if (finalResponseText) {
    return finalResponseText;
  }

  const fallbackText = buildAssistantFallbackFromToolMessages(toolMessages);
  if (!fallbackText) {
    return finalResponseText;
  }

  if (depth === 0) {
    await persistConversationMessages(context, [{
      chat_id: context.chatId,
      agent_id: agent.id,
      role: 'assistant',
      event_type: 'message',
      content: fallbackText,
      metadata_json: {
        run_id: context.runId || null,
        parent_run_id: context.parentRunId || null,
        depth: Number.isFinite(context.depth) ? context.depth : 0,
        generated_fallback: true,
        fallback_reason: 'empty_final_response_after_tools',
      },
    }]);
  }

  return fallbackText;
}
function buildAgentSystemPrompt(agent) {
  const promptParts = [String(agent?.system_prompt || '').trim()];
  if (String(agent?.goals || '').trim()) {
    promptParts.push(`Goals:\n${String(agent.goals).trim()}`);
  }
  return `${promptParts.filter(Boolean).join('\n\n')} Oggi e il ${new Date().toISOString()}`.trim();
}

function mapStoredRowToHistoryEntry(row, options = {}) {
  const visibleOnly = options.visibleOnly === true;
  if (row.event_type === 'delegation') {
    return null;
  }
  if (row.event_type === 'guardrail') {
    return null;
  }
  if (row.role === 'assistant' && (Number(row?.metadata_json?.depth || 0) > 0 || row?.metadata_json?.delegated_by_agent_id)) {
    return null;
  }
  if (isNestedWorkerToolResult(row)) {
    return null;
  }
  if (visibleOnly) {
    if (row.role !== 'user' && row.role !== 'assistant') return null;
    if (row.event_type !== 'message' && row.event_type !== 'alive_prompt') return null;
    return { role: row.role, content: row.content, reasoning: row.reasoning || null };
  }
  if (row.role === 'tool' && row.metadata_json?.tool_call_id) {
    return { role: 'tool', content: row.content, tool_call_id: row.metadata_json.tool_call_id };
  }
  if (row.role === 'tool') {
    return null;
  }
  return { role: row.role, content: row.content, reasoning: row.reasoning || null };
}

async function buildInitialAgentHistory(agent, rows, options = {}) {
  if (Array.isArray(rows) && rows.length > 0) {
    const mapped = rows.map((row) => {
      return mapStoredRowToHistoryEntry(row, options);
    }).filter(Boolean);
    if (options.visibleOnly === true) {
      const visibleLimit = Number.isFinite(Number(options.visibleLimit))
        ? Math.max(1, Math.trunc(Number(options.visibleLimit)))
        : mapped.length;
      return [
        { role: 'system', content: buildAgentSystemPrompt(agent) },
        ...mapped.slice(-visibleLimit),
      ];
    }
    const currentSystemPrompt = buildAgentSystemPrompt(agent);
    if (mapped[0]?.role === 'system') {
      return [
        { ...mapped[0], content: currentSystemPrompt },
        ...mapped.slice(1),
      ];
    }
    return [
      { role: 'system', content: currentSystemPrompt },
      ...mapped,
    ];
  }
  return [
    { role: 'system', content: buildAgentSystemPrompt(agent) },
  ];
}

function createChatId() {
  return crypto.randomUUID();
}

module.exports = {
  runAgentConversation,
  buildAgentSystemPrompt,
  buildInitialAgentHistory,
  createChatId,
};
