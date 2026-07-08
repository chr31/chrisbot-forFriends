const { beforeMemory } = require('./beforeMemory');
const { afterMemory } = require('./afterMemory');
const { buildEmptyMemoryContextPacket } = require('./memoryContextPacket');

async function runBeforeMemory(input = {}) {
  try {
    return await beforeMemory(input);
  } catch (error) {
    console.error('Errore beforeMemory:', error);
    return buildEmptyMemoryContextPacket({
      agent: input.agent,
      enabled: false,
      provider: 'mem0',
      skipped_reason: 'error',
    });
  }
}

// Scrittura memorie non-bloccante: i chiamanti la lanciano senza await, dopo
// aver prodotto la risposta, per non aggiungere latenza alla chat.
async function runAfterMemory(input = {}) {
  try {
    return await afterMemory(input);
  } catch (error) {
    console.error('Errore afterMemory:', error);
    return {
      enabled: false,
      provider: 'mem0',
      written: false,
      skipped_reason: 'error',
      warnings: [String(error?.message || error)],
    };
  }
}

module.exports = {
  runBeforeMemory,
  runAfterMemory,
};
