#!/usr/bin/env node

const assert = require('assert');
const { Neo4jControlRepository } = require('../services/control/repositories/neo4jControlRepository');
const { withInferredControlFilters } = require('../services/control/controlOrchestrator');

const config = {
  neo4j_url: process.env.TEST_NEO4J_URL || 'bolt://127.0.0.1:17687',
  neo4j_username: process.env.TEST_NEO4J_USERNAME || 'neo4j',
  neo4j_password: process.env.TEST_NEO4J_PASSWORD || 'test-control-pass',
  embedding_model_provider: '',
};

const repo = new Neo4jControlRepository(config);

async function seedGraph() {
  await repo.upsertSchema({
    locations: [
      {
        id: 'test:loc:campus_esterno',
        kind: 'campus',
        name: 'Campus Esterno',
        path: 'campus_esterno',
        aliases: ['campus esterno', 'esterno'],
      },
      {
        id: 'test:loc:serra',
        kind: 'zone',
        name: 'Serra',
        parent: 'Campus Esterno',
        path: 'campus_esterno/serra',
        aliases: ['serra', 'greenhouse'],
      },
    ],
    devices: [
      {
        id: 'test:device:bluesound_serra',
        name: 'Bluesound Serra',
        device_type: 'bluesound',
        location: 'Serra',
        tags: ['audio'],
        aliases: ['musica serra', 'player serra'],
      },
      {
        id: 'test:device:bluesound_patio',
        name: 'Bluesound Patio',
        device_type: 'bluesound',
        location: 'Campus Esterno',
        tags: ['audio'],
        aliases: ['musica campus esterno', 'player esterno'],
      },
    ],
    actions: [
      {
        id: 'test:action:stream_status_serra',
        name: 'Controlla stato stream Bluesound Serra',
        action_type: 'bash',
        intent: 'monitoring',
        capability_key: 'stream_status',
        device_ref: 'Bluesound Serra',
        command: 'echo stream',
      },
      {
        id: 'test:action:online_serra',
        name: 'Controlla online Bluesound Serra',
        action_type: 'bash',
        intent: 'monitoring',
        capability_key: 'status_online',
        device_ref: 'Bluesound Serra',
        command: 'echo online',
      },
      {
        id: 'test:action:music_play_patio',
        name: 'Avvia musica Bluesound Patio',
        action_type: 'bash',
        intent: 'control',
        capability_key: 'music_play',
        device_ref: 'Bluesound Patio',
        command: 'echo play',
      },
      {
        id: 'test:action:online_patio',
        name: 'Controlla online Bluesound Patio',
        action_type: 'bash',
        intent: 'monitoring',
        capability_key: 'status_online',
        device_ref: 'Bluesound Patio',
        command: 'echo online',
      },
    ],
  });
}

async function runCase(prompt, expected) {
  const filters = withInferredControlFilters({ query: prompt, limit: 20 });
  const matches = await repo.search(filters);
  const compact = matches.map((entry) => ({
    device: entry.device.name,
    device_type: entry.device.device_type,
    location: entry.building?.name,
    room: entry.room?.name,
    action: entry.action.name,
    capability: entry.action.capability_key,
    intent: entry.action.intent,
    execute_target: {
      device_id: entry.device.id,
      action_id: entry.action.id,
    },
  }));

  assert.deepStrictEqual(
    compact.map((entry) => `${entry.device}:${entry.capability}`).sort(),
    expected.sort(),
    `Prompt non risolto correttamente: ${prompt}\n${JSON.stringify({ filters, compact }, null, 2)}`
  );

  const targets = await repo.getActionTargets(compact.map((entry) => entry.execute_target));
  assert.strictEqual(targets.length, compact.length, `Target esecuzione mancanti per: ${prompt}`);
  return { prompt, filters, matches: compact };
}

async function main() {
  await repo.ensureReady();
  await seedGraph();

  const results = [];
  results.push(await runCase('controlla la musica in serra se è in stato stream', [
    'Bluesound Serra:stream_status',
  ]));
  results.push(await runCase('avvia la musica nel campus esterno', [
    'Bluesound Patio:music_play',
  ]));
  results.push(await runCase('controlla tutti i Bluesound se sono online', [
    'Bluesound Patio:status_online',
    'Bluesound Serra:status_online',
  ]));

  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
