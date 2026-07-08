const { createInternalNotification } = require('./notifications');
const { getGoals, editGoals } = require('./agentState');

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
      },
      required: ['description'],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      await createInternalNotification(args);
      return 'Notifica inviata correttamente.';
    },
  },
  {
    key: 'getGoals',
    name: 'getGoals',
    publicName: `${DEFAULT_INTERNAL_PREFIX}getGoals`,
    description: 'Restituisce il testo corrente dei goals dell’agente che chiama il tool.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: getGoals,
  },
  {
    key: 'editGoals',
    name: 'editGoals',
    publicName: `${DEFAULT_INTERNAL_PREFIX}editGoals`,
    description: 'Sostituisce interamente i goals dell’agente. Recupera prima il valore corrente con getGoals.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Nuovo testo completo dei goals.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: editGoals,
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
