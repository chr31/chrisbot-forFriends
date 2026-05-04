const { createInternalNotification } = require('./notifications');
const { getGoals, editGoals } = require('./agentState');
const { getControlEngineSettingsSync } = require('../appSettings');
const {
  executeControlAction,
  getControlSchemaContext,
  retrieveControlInfo,
  updateControlSchema,
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
  const tools = [
    {
      key: 'controlEngineGetSchemaContext',
      name: 'ControlEngine_getSchemaContext',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_getSchemaContext`,
      description: 'Restituisce i valori accettati e le regole stringenti per preparare una proposta JSON Control Engine prima di chiamare updateSchema. Usa questo tool prima di creare o modificare action ssh/telnet. Restituisce sempre una stringa JSON.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: getControlSchemaContext,
    },
    {
      key: 'controlEngineRetrieveInfo',
      name: 'ControlEngine_retriveInfo',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_retriveInfo`,
      description: 'Interroga il grafo Control Engine per trovare edifici, stanze, device e azioni eseguibili o di monitoring. Restituisce sempre una stringa JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Richiesta naturale o filtro testuale.' },
          intent: { type: 'string', enum: ['control', 'monitoring'], description: 'Intento azione desiderato.' },
          building: { type: 'string', description: 'Nome o alias edificio opzionale.' },
          room: { type: 'string', description: 'Nome o alias stanza opzionale.' },
          device_type: { type: 'string', description: 'Tipo device, es. projector, printer, audio, computer.' },
          capability: { type: 'string', description: 'Capability richiesta, es. status_online, power_on, audio_value.' },
          action_type: { type: 'string', enum: ['bash', 'telnet', 'telnet_auth', 'ssh', 'ping', 'http', 'http_api'], description: 'Adapter tecnico azione opzionale.' },
          limit: { type: 'number', description: 'Numero massimo risultati.' },
        },
        additionalProperties: false,
      },
      handler: retrieveControlInfo,
    },
    {
      key: 'controlEngineUpdateSchema',
      name: 'ControlEngine_updateSchema',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_updateSchema`,
      description: 'Aggiunge o aggiorna nodi e relazioni del grafo Control Engine. Usa prima ControlEngine_getSchemaContext per ottenere connection_ref accettati. Le action telnet/ssh richiedono command e connection_ref esistente/enabled; bash richiede command e vieta connection_ref; host, porta, username e password non vanno mai nel grafo. Usa dry_run=true per preview. Restituisce sempre una stringa JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Istruzione naturale per creare o aggiornare elementi del grafo.' },
          dry_run: { type: 'boolean', description: 'Se true genera solo una preview.' },
          schema: {
            type: 'object',
            description: 'Payload strutturato con locations/building/room, devices, capabilities, actions.',
            additionalProperties: true,
          },
          locations: { type: 'array', items: { type: 'object', additionalProperties: true } },
          location: { type: 'object', additionalProperties: true },
          capabilities: { type: 'array', items: { type: 'object', additionalProperties: true } },
          capability: { type: 'object', additionalProperties: true },
          building: { type: 'object', additionalProperties: true },
          room: { type: 'object', additionalProperties: true },
          device: { type: 'object', additionalProperties: true },
          action: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      handler: updateControlSchema,
    },
  ];

  if (settings.execution_enabled) {
    tools.push({
      key: 'controlEngineExecuteAction',
      name: 'ControlEngine_executeAction',
      publicName: `${DEFAULT_INTERNAL_PREFIX}ControlEngine_executeAction`,
          description: 'Esegue azioni gia presenti nel grafo Control Engine su device target. Le action ssh/telnet usano solo connection_ref salvato nel grafo e connessioni persistenti configurate nelle impostazioni. Restituisce sempre una stringa JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Richiesta originale o motivazione dell esecuzione.' },
          dry_run: { type: 'boolean', description: 'Se true non esegue realmente.' },
          params: { type: 'object', description: 'Parametri runtime opzionali, es. username/password per telnet_auth.', additionalProperties: true },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                device_id: { type: 'string' },
                action_id: { type: 'string' },
              },
              required: ['device_id', 'action_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['targets'],
        additionalProperties: false,
      },
      handler: executeControlAction,
    });
  }

  return tools;
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
