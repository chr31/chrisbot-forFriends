const { createInternalNotification } = require('./notifications');
const { getGoals, editGoals } = require('./agentState');
const { getControlEngineSettingsSync } = require('../appSettings');
const {
  getControlGraph,
  getControlSessions,
  updateControlGraph,
} = require('../control/controlOrchestrator');

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

function getControlEngineToolDefinitions() {
  const settings = getControlEngineSettingsSync();
  if (!settings.enabled) return [];
  return [
    {
      key: 'controlEngineGetGraph',
      name: 'ControlEngine_getGraph',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_getGraph`,
      description: 'Tool che permette di ricavare informazioni dalla struttura del grafo di controllo',
      inputSchema: {
        type: 'object',
        properties: {
          queryGraph: { type: 'string', description: 'Query Cypher di lettura da eseguire su Neo4j senza restrizioni automatiche sui nodi.' },
          runCommands: { type: 'boolean', description: 'Se true esegue tutti i comandi presenti nei risultati e restituisce i loro output.' },
        },
        required: ['queryGraph', 'runCommands'],
        additionalProperties: false,
      },
      handler: getControlGraph,
    },
    {
      key: 'controlEngineGetSessions',
      name: 'ControlEngine_getSessions',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_getSessions`,
      description: 'Tool che restiutisce le sessioni disponibili da associare ai comandi singoli',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: getControlSessions,
    },
    {
      key: 'controlEngineUpdateGraph',
      name: 'ControlEngine_updateGraph',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_updateGraph`,
      description: 'Tool che permette di aggiornare la struttura del grafo di controllo con nuove informazioni o riscrivendo quelle obsolete.',
      inputSchema: {
        type: 'object',
        properties: {
          queryGraph: { type: 'string', description: 'Query Cypher di aggiornamento da eseguire su Neo4j senza restrizioni automatiche sui nodi.' },
        },
        required: ['queryGraph'],
        additionalProperties: false,
      },
      handler: updateControlGraph,
    },
  ];
}

function buildInternalToolRegistry() {
  const tools = [];
  const nameMap = new Map();
  const reverseNameMap = new Map();
  const handlerMap = new Map();
  const prefixes = new Set();

  for (const definition of [...INTERNAL_TOOL_DEFINITIONS, ...getControlEngineToolDefinitions()]) {
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
