const { createInternalNotification } = require('./notifications');

const DEFAULT_INTERNAL_PREFIX = 'chrisbot_';

const INTERNAL_TOOL_DEFINITIONS = [
  {
    key: 'sendNotification',
    name: 'sendNotification',
    publicName: `${DEFAULT_INTERNAL_PREFIX}sendNotification`,
    description: 'Registra una notifica nel pannello notifiche.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Testo della notifica da registrare nel portale.',
        },
        title: {
          type: 'string',
          description: 'Titolo opzionale della notifica.',
        },
        _chatId: {
          type: 'string',
          description: 'Chat agente sorgente usata per risolvere il proprietario della notifica.',
        },
        _agentId: {
          type: 'number',
          description: 'ID agente associato alla notifica.',
        },
        _runId: {
          type: 'number',
          description: 'ID esecuzione agente associato alla notifica.',
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      await createInternalNotification(args);
      return 'Notifica inviata correttamente.';
    },
  },
];

function buildInternalToolRegistry() {
  const tools = [];
  const nameMap = new Map();
  const reverseNameMap = new Map();
  const handlerMap = new Map();
  const prefixes = new Set();

  for (const definition of INTERNAL_TOOL_DEFINITIONS) {
    const publicName = String(definition.publicName || '').trim();
    if (!publicName) continue;

    tools.push({
      type: 'function',
      function: {
        name: publicName,
        description: definition.description || '',
        parameters: definition.inputSchema || { type: 'object', properties: {} },
      },
    });

    nameMap.set(publicName, definition.name);
    reverseNameMap.set(definition.name, publicName);
    handlerMap.set(publicName, definition.handler);

    const separatorIndex = publicName.indexOf('_');
    if (separatorIndex > 0) {
      prefixes.add(publicName.slice(0, separatorIndex + 1));
    }
  }

  return {
    tools,
    nameMap,
    reverseNameMap,
    handlerMap,
    prefixes: Array.from(prefixes),
  };
}

module.exports = {
  DEFAULT_INTERNAL_PREFIX,
  buildInternalToolRegistry,
};
