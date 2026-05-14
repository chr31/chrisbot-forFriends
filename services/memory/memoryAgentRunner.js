const { createOpenAiClient } = require('../openaiRuntime');
const { callOllamaChatCompletions } = require('../ollamaRuntime');
const { createMemoryRepository } = require('./repositories/memoryRepository');

const MAX_MEMORY_TOOL_CALLS = 50;

const RUN_CYPHER_TOOL = {
  type: 'function',
  function: {
    name: 'runCypherQuery',
    description: 'Esegue una query Cypher sul database Neo4j del Memory Engine.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query Cypher da eseguire.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry?.text === 'string') return entry.text;
        return JSON.stringify(entry);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value?.text === 'string') return value.text;
  return JSON.stringify(value);
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  return JSON.parse(String(rawArgs));
}

function toolString(payload) {
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return JSON.stringify({ ok: false, error: 'Risultato non serializzabile.' });
  }
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Continue with fenced/object extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      // Continue with object slicing.
    }
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function buildStructuredOutputInstruction(output = {}) {
  const key = String(output.key || '').trim();
  const description = String(output.description || '').trim();
  if (!key) return '';
  return [
    'Rispondi sempre e solo con un oggetto JSON valido.',
    `Lo schema obbligatorio e: {"${key}":"..."}.`,
    description ? `La proprieta ${key} ha questo scopo: ${description}.` : null,
    'Non aggiungere testo fuori dal JSON.',
  ].filter(Boolean).join('\n');
}

function extractStructuredText(content, output = {}) {
  const key = String(output.key || '').trim();
  const text = toText(content).trim();
  if (!key) return { text, structured: null };
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return { text, structured: null };
  const value = parsed[key];
  const structuredText = Array.isArray(value) ? value.join('\n') : String(value || '').trim();
  return {
    text: structuredText || text,
    structured: parsed,
  };
}

function normalizeMainChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ['system', 'user', 'assistant'].includes(message?.role))
    .map((message) => ({
      role: message.role,
      content: toText(message.content),
    }))
    .filter((message) => String(message.content || '').trim());
}

async function callMemoryModel(messages, settings, output = {}) {
  const provider = String(settings.analysis_model_provider || '').trim().toLowerCase();
  const model = String(settings.analysis_model || 'gpt-5-mini').trim() || 'gpt-5-mini';
  if (provider === 'openai') {
    const params = {
      model,
      messages,
      tools: [RUN_CYPHER_TOOL],
    };
    if (output?.key) {
      params.response_format = { type: 'json_object' };
    }
    const response = await createOpenAiClient().chat.completions.create(params);
    return response.choices?.[0]?.message || { role: 'assistant', content: '' };
  }
  if (provider === 'ollama' || provider === 'exo') {
    const result = await callOllamaChatCompletions(messages, [RUN_CYPHER_TOOL], model, {
      ollamaServerId: settings.ollama_server_id || null,
      providerType: provider,
    });
    return result?.message || { role: 'assistant', content: '' };
  }
  throw new Error(`Provider chat memoria non supportato: ${provider || 'non configurato'}`);
}

async function runMemoryAgent({ settings, messages, userPrompt, output }) {
  const repository = createMemoryRepository(settings);
  const structuredOutputInstruction = buildStructuredOutputInstruction(output);
  const agentMessages = [
    {
      role: 'system',
      content: String(settings.memory_agent_system_prompt || '').trim(),
    },
    ...normalizeMainChatMessages(messages),
    {
      role: 'user',
      content: [String(userPrompt || '').trim(), structuredOutputInstruction].filter(Boolean).join('\n\n'),
    },
  ].filter((message) => String(message.content || '').trim());

  let toolCallCount = 0;
  let lastMessage = null;

  for (let round = 0; round <= MAX_MEMORY_TOOL_CALLS; round += 1) {
    lastMessage = await callMemoryModel(agentMessages, settings, output);
    agentMessages.push(lastMessage);
    const toolCalls = Array.isArray(lastMessage.tool_calls) ? lastMessage.tool_calls : [];
    if (toolCalls.length === 0) {
      const parsed = extractStructuredText(lastMessage.content, output);
      return {
        text: parsed.text,
        structured: parsed.structured,
        tool_call_count: toolCallCount,
      };
    }

    for (const toolCall of toolCalls) {
      toolCallCount += 1;
      const toolCallId = toolCall.id || `memory_tool_${toolCallCount}`;
      if (toolCallCount > MAX_MEMORY_TOOL_CALLS) {
        agentMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: toolString({
            ok: false,
            error: `Limite massimo di ${MAX_MEMORY_TOOL_CALLS} chiamate runCypherQuery raggiunto.`,
          }),
        });
        continue;
      }

      let content;
      try {
        const args = parseToolArgs(toolCall.function?.arguments);
        const query = String(args.query || '').trim();
        if (!query) throw new Error('Parametro query mancante.');
        const result = await repository.runCypherQuery(query);
        content = toolString({ ok: true, result });
      } catch (error) {
        content = toolString({ ok: false, error: String(error?.message || error) });
      }
      agentMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content,
      });
    }
  }

  return {
    text: extractStructuredText(lastMessage?.content, output).text,
    tool_call_count: toolCallCount,
    warning: `Limite massimo di ${MAX_MEMORY_TOOL_CALLS} chiamate runCypherQuery raggiunto.`,
  };
}

module.exports = {
  MAX_MEMORY_TOOL_CALLS,
  normalizeMainChatMessages,
  runMemoryAgent,
};
