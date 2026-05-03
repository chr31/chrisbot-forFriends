const crypto = require('crypto');
const { createNeo4jDriver, loadNeo4jDriver, normalizeConnectionInput } = require('../neo4jConnection');
const {
  buildCanonicalMemoryKey,
  buildRunKey,
  buildScopedGraphKey,
  canonicalizeGraphKey,
  isLikelyFailureText,
  normalizeAgentId,
  normalizeConfidence,
  normalizeEpisodeType,
  normalizeImportance,
  normalizeMemoryType,
  normalizeProcessStatus,
  normalizeSearchableText,
  normalizeText,
  toJsonString,
} = require('../memorySchema');

const schemaCache = new Set();
const LEXICAL_STOP_WORDS = new Set([
  'about',
  'agent',
  'agente',
  'alla',
  'alle',
  'also',
  'come',
  'con',
  'contesto',
  'corrente',
  'della',
  'delle',
  'degli',
  'engine',
  'from',
  'memoria',
  'memorie',
  'memory',
  'operativa',
  'operativo',
  'per',
  'processo',
  'questa',
  'questo',
  'richiesta',
  'sono',
  'that',
  'the',
  'this',
  'utente',
  'user',
  'with',
]);

const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT memory_episode_id IF NOT EXISTS FOR (n:MemoryEpisode) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT memory_item_id IF NOT EXISTS FOR (n:MemoryItem) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT memory_run_id IF NOT EXISTS FOR (n:MemoryRun) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT memory_agent_id IF NOT EXISTS FOR (n:MemoryAgent) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT memory_tool_name IF NOT EXISTS FOR (n:MemoryTool) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT memory_request_id IF NOT EXISTS FOR (n:MemoryRequest) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT memory_topic_id IF NOT EXISTS FOR (n:MemoryTopic) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT memory_status_name IF NOT EXISTS FOR (n:MemoryStatus) REQUIRE n.name IS UNIQUE',
  'CREATE INDEX memory_item_scope IF NOT EXISTS FOR (n:MemoryItem) ON (n.scope)',
  'CREATE INDEX memory_item_agent IF NOT EXISTS FOR (n:MemoryItem) ON (n.agent_id)',
  'CREATE INDEX memory_item_type IF NOT EXISTS FOR (n:MemoryItem) ON (n.memory_type)',
  'CREATE INDEX memory_item_subject IF NOT EXISTS FOR (n:MemoryItem) ON (n.subject_key)',
  'CREATE INDEX memory_item_active IF NOT EXISTS FOR (n:MemoryItem) ON (n.is_active)',
  'CREATE INDEX memory_episode_run IF NOT EXISTS FOR (n:MemoryEpisode) ON (n.agent_run_id)',
  'CREATE INDEX memory_episode_scope IF NOT EXISTS FOR (n:MemoryEpisode) ON (n.scope)',
  'CREATE INDEX memory_request_scope IF NOT EXISTS FOR (n:MemoryRequest) ON (n.scope)',
  'CREATE INDEX memory_topic_scope IF NOT EXISTS FOR (n:MemoryTopic) ON (n.scope)',
];

function getSessionAccessMode(mode) {
  const neo4j = loadNeo4jDriver();
  return mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE;
}

function mapNodeProperties(node) {
  const props = node?.properties || node || {};
  const mapped = {};
  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value.toNumber === 'function') {
      mapped[key] = value.toNumber();
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}

function normalizeScope(value) {
  return String(value || '').trim().toLowerCase() === 'dedicated' ? 'dedicated' : 'shared';
}

function buildConnectionCacheKey(config) {
  return [
    config.neo4j_url,
    config.neo4j_username,
  ].join('|');
}

function buildRunParams(input = {}) {
  const agentRunId = normalizeAgentId(input.agent_run_id || input.run_id);
  const runKey = buildRunKey(agentRunId);
  const actorAgentId = normalizeAgentId(input.actor_agent_id || input.executing_agent_id || input.agent_id);
  return {
    runKey,
    agentRunId,
    chatId: normalizeText(input.chat_id || input.chatId || '', 255) || null,
    agentId: actorAgentId,
    memoryAgentId: normalizeAgentId(input.agent_id),
    agentName: normalizeText(input.actor_agent_name || input.agent_name || '', 255) || null,
    userKey: normalizeText(input.user_key || input.userKey || input.owner_username || '', 255) || null,
    processStatus: normalizeProcessStatus(input.process_status, 'unknown'),
    startedAt: input.started_at || null,
    finishedAt: input.finished_at || null,
  };
}

function normalizeGraphTopic(input = {}, scope = 'shared', agentId = null) {
  const name = normalizeText(
    typeof input === 'string' ? input : input.name || input.topic || input.key || '',
    180
  );
  if (!name) return null;
  const key = canonicalizeGraphKey(typeof input === 'string' ? name : input.key || input.subject_key || name, name);
  return {
    id: buildScopedGraphKey('topic', { scope, agent_id: agentId, key }),
    key,
    name,
    category: normalizeText(typeof input === 'string' ? '' : input.category || '', 120) || null,
    scope,
    agentId,
  };
}

function normalizeGraphTopics(values = [], scope = 'shared', agentId = null) {
  const seen = new Set();
  const topics = [];
  for (const value of Array.isArray(values) ? values : []) {
    const topic = normalizeGraphTopic(value, scope, agentId);
    if (!topic || seen.has(topic.id)) continue;
    seen.add(topic.id);
    topics.push(topic);
  }
  return topics.slice(0, 8);
}

function buildRequestGraphParams(input = {}) {
  const scope = normalizeScope(input.scope);
  const agentId = normalizeAgentId(input.agent_id);
  const summary = normalizeText(input.request_summary || input.summary || input.request_text || '', 220);
  if (!summary) return null;
  const key = canonicalizeGraphKey(input.request_key || summary, summary);
  return {
    id: buildScopedGraphKey('request', { scope, agent_id: agentId, key }),
    key,
    summary,
    requestText: normalizeText(input.request_text || input.requestText || '', 1200) || null,
    scope,
    agentId,
  };
}

function normalizeEmbedding(value) {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
    : null;
}

function extractLexicalTerms(input = [], limit = 18) {
  const source = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const terms = [];
  const raw = source.join(' ');
  const matches = raw.match(/[A-Za-z0-9_./:@-]{3,}/g) || [];
  for (const match of matches) {
    const term = match
      .toLowerCase()
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!term || seen.has(term) || LEXICAL_STOP_WORDS.has(term)) continue;
    const hasAnchorShape = /[0-9_./:@-]/.test(term);
    if (!hasAnchorShape && term.length < 5) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

function mergeCandidate(byId, item, score) {
  if (!item?.id) return;
  const numericScore = Number(score || 0);
  const previous = byId.get(item.id);
  if (!previous || numericScore > previous.score) {
    byId.set(item.id, { ...item, score: numericScore });
  }
}

class Neo4jMemoryRepository {
  constructor(config = {}) {
    this.config = normalizeConnectionInput(config);
  }

  async withSession(mode, fn) {
    const driver = createNeo4jDriver(this.config);
    const session = driver.session({ defaultAccessMode: getSessionAccessMode(mode) });
    try {
      if (mode !== 'read') {
        await this.ensureSchema(session);
      }
      return await fn(session);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async ensureSchema(session) {
    const cacheKey = buildConnectionCacheKey(this.config);
    if (schemaCache.has(cacheKey)) return;
    for (const statement of SCHEMA_STATEMENTS) {
      await session.run(statement);
    }
    schemaCache.add(cacheKey);
  }

  async ensureReady() {
    return this.withSession('write', async () => ({
      ok: true,
      schema: 'ready',
    }));
  }

  async clearAllMemoryData() {
    return this.withSession('write', async (session) => {
      const result = await session.run(`
        MATCH (n)
        WHERE any(label IN labels(n) WHERE label STARTS WITH 'Memory')
        WITH collect(n) AS nodes, count(n) AS deleted
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN deleted
      `);
      const deleted = result.records[0]?.get('deleted');
      return {
        deleted: deleted && typeof deleted.toNumber === 'function' ? deleted.toNumber() : Number(deleted || 0),
      };
    });
  }

  async upsertRunGraph(session, input = {}) {
    const params = buildRunParams(input);
    if (!params.runKey) return null;

    await session.run(
      `
      MERGE (r:MemoryRun {id: $runKey})
      ON CREATE SET r.created_at = datetime()
      SET
        r.agent_run_id = $agentRunId,
        r.chat_id = $chatId,
        r.agent_id = $agentId,
        r.memory_agent_id = $memoryAgentId,
        r.user_key = $userKey,
        r.process_status = $processStatus,
        r.started_at = coalesce($startedAt, r.started_at),
        r.finished_at = coalesce($finishedAt, r.finished_at),
        r.updated_at = datetime()
      `,
      params
    );

    if (params.agentId) {
      await session.run(
        `
        MERGE (a:MemoryAgent {id: $agentId})
        ON CREATE SET a.created_at = datetime()
        SET a.name = coalesce($agentName, a.name), a.updated_at = datetime()
        WITH a
        MATCH (r:MemoryRun {id: $runKey})
        MERGE (r)-[:HANDLED_BY]->(a)
        `,
        params
      );
    }

    return params.runKey;
  }

  async recordRunSemantics(input = {}) {
    return this.withSession('write', async (session) => {
      const runKey = await this.upsertRunGraph(session, input);
      if (!runKey) return { runKey: null, request: null, topics: [] };

      const scope = normalizeScope(input.scope);
      const agentId = normalizeAgentId(input.agent_id);
      const request = buildRequestGraphParams({
        scope,
        agent_id: agentId,
        request_summary: input.request_summary,
        request_text: input.request_text,
      });
      const topics = normalizeGraphTopics(input.topics, scope, agentId);
      const processStatus = normalizeProcessStatus(input.process_status, 'unknown');

      if (processStatus) {
        await session.run(
          `
          MERGE (s:MemoryStatus {name: $status})
          ON CREATE SET s.created_at = datetime()
          SET s.updated_at = datetime()
          WITH s
          MATCH (r:MemoryRun {id: $runKey})
          MERGE (r)-[:HAS_STATUS]->(s)
          `,
          { runKey, status: processStatus }
        );
      }

      if (request) {
        await session.run(
          `
          MERGE (q:MemoryRequest {id: $id})
          ON CREATE SET q.created_at = datetime(), q.first_seen_at = datetime(), q.seen_count = 0
          SET
            q.key = $key,
            q.summary = $summary,
            q.request_text = coalesce($requestText, q.request_text),
            q.scope = $scope,
            q.agent_id = $agentId,
            q.last_seen_at = datetime(),
            q.updated_at = datetime(),
            q.seen_count = coalesce(q.seen_count, 0) + 1
          WITH q
          MATCH (r:MemoryRun {id: $runKey})
          MERGE (r)-[:FOR_REQUEST]->(q)
          `,
          { ...request, runKey }
        );
      }

      for (const topic of topics) {
        await session.run(
          `
          MERGE (t:MemoryTopic {id: $id})
          ON CREATE SET t.created_at = datetime(), t.first_seen_at = datetime(), t.seen_count = 0
          SET
            t.key = $key,
            t.name = $name,
            t.category = coalesce($category, t.category),
            t.scope = $scope,
            t.agent_id = $agentId,
            t.last_seen_at = datetime(),
            t.updated_at = datetime(),
            t.seen_count = coalesce(t.seen_count, 0) + 1
          WITH t
          MATCH (r:MemoryRun {id: $runKey})
          MERGE (r)-[:ABOUT]->(t)
          `,
          { ...topic, runKey }
        );

        if (request) {
          await session.run(
            `
            MATCH (q:MemoryRequest {id: $requestId}), (t:MemoryTopic {id: $topicId})
            MERGE (q)-[:ABOUT]->(t)
            `,
            { requestId: request.id, topicId: topic.id }
          );
        }
      }

      return { runKey, request, topics };
    });
  }

  async linkMemoryItemSemantics(input = {}) {
    const itemId = normalizeText(input.item_id || input.id || '', 128);
    if (!itemId) return { linked: false };
    return this.withSession('write', async (session) => {
      const scope = normalizeScope(input.scope);
      const agentId = normalizeAgentId(input.agent_id);
      const request = input.request?.id
        ? input.request
        : buildRequestGraphParams({
            scope,
            agent_id: agentId,
            request_summary: input.request_summary,
            request_text: input.request_text,
          });
      const topics = Array.isArray(input.topics) && input.topics.every((topic) => topic?.id)
        ? input.topics
        : normalizeGraphTopics(input.topics, scope, agentId);
      const toolNames = [...new Set((Array.isArray(input.tool_names) ? input.tool_names : [])
        .map((name) => normalizeText(name, 255))
        .filter(Boolean))].slice(0, 8);
      const processStatus = normalizeProcessStatus(input.process_status, null);
      const runKey = buildRunKey(input.agent_run_id || input.run_id);

      if (request) {
        await session.run(
          `
          MERGE (q:MemoryRequest {id: $id})
          ON CREATE SET q.created_at = datetime(), q.first_seen_at = datetime(), q.seen_count = 0
          SET
            q.key = $key,
            q.summary = $summary,
            q.request_text = coalesce($requestText, q.request_text),
            q.scope = $scope,
            q.agent_id = $agentId,
            q.last_seen_at = datetime(),
            q.updated_at = datetime(),
            q.seen_count = coalesce(q.seen_count, 0) + 1
          WITH q
          MATCH (m:MemoryItem {id: $itemId})
          MERGE (m)-[rel:NEEDED_FOR]->(q)
          ON CREATE SET rel.created_at = datetime()
          SET rel.run_key = $runKey, rel.updated_at = datetime()
          `,
          { ...request, itemId, runKey }
        );
      }

      for (const topic of topics) {
        await session.run(
          `
          MERGE (t:MemoryTopic {id: $id})
          ON CREATE SET t.created_at = datetime(), t.first_seen_at = datetime(), t.seen_count = 0
          SET
            t.key = $key,
            t.name = $name,
            t.category = coalesce($category, t.category),
            t.scope = $scope,
            t.agent_id = $agentId,
            t.last_seen_at = datetime(),
            t.updated_at = datetime(),
            t.seen_count = coalesce(t.seen_count, 0) + 1
          WITH t
          MATCH (m:MemoryItem {id: $itemId})
          MERGE (m)-[rel:NEEDED_FOR]->(t)
          ON CREATE SET rel.created_at = datetime()
          SET rel.run_key = $runKey, rel.updated_at = datetime()
          `,
          { ...topic, itemId, runKey }
        );

        await session.run(
          `
          MATCH (m:MemoryItem {id: $itemId}), (t:MemoryTopic {id: $id})
          MERGE (m)-[rel:RELATED_TO]->(t)
          ON CREATE SET rel.created_at = datetime()
          SET rel.updated_at = datetime()
          `,
          { ...topic, itemId }
        );

        if (request) {
          await session.run(
            `
            MATCH (q:MemoryRequest {id: $requestId}), (t:MemoryTopic {id: $topicId})
            MERGE (q)-[:ABOUT]->(t)
            `,
            { requestId: request.id, topicId: topic.id }
          );
        }
      }

      for (const toolName of toolNames) {
        await session.run(
          `
          MERGE (tool:MemoryTool {name: $toolName})
          ON CREATE SET tool.created_at = datetime()
          SET tool.updated_at = datetime()
          WITH tool
          MATCH (m:MemoryItem {id: $itemId})
          MERGE (m)-[rel:NEEDED_FOR]->(tool)
          ON CREATE SET rel.created_at = datetime()
          SET rel.run_key = $runKey, rel.updated_at = datetime()
          `,
          { itemId, toolName, runKey }
        );
      }

      if (processStatus) {
        await session.run(
          `
          MERGE (s:MemoryStatus {name: $status})
          ON CREATE SET s.created_at = datetime()
          SET s.updated_at = datetime()
          WITH s
          MATCH (m:MemoryItem {id: $itemId})
          MERGE (m)-[rel:NEEDED_FOR]->(s)
          ON CREATE SET rel.created_at = datetime()
          SET rel.run_key = $runKey, rel.updated_at = datetime()
          `,
          { itemId, status: processStatus, runKey }
        );
      }

      if (runKey) {
        await session.run(
          `
          MATCH (m:MemoryItem {id: $itemId}), (r:MemoryRun {id: $runKey})
          MERGE (m)-[rel:OBSERVED_IN]->(r)
          ON CREATE SET rel.created_at = datetime()
          SET rel.updated_at = datetime()
          `,
          { itemId, runKey }
        );
      }

      return {
        linked: true,
        request_id: request?.id || null,
        topic_ids: topics.map((topic) => topic.id),
        tool_names: toolNames,
      };
    });
  }

  async addEpisode(input = {}) {
    return this.withSession('write', async (session) => {
      const runKey = await this.upsertRunGraph(session, input);
      const id = normalizeText(input.id || crypto.randomUUID(), 128);
      const content = normalizeText(input.content || '', 6000);
      if (!content) return null;

      const params = {
        id,
        scope: normalizeScope(input.scope),
        actorAgentId: normalizeAgentId(input.actor_agent_id || input.executing_agent_id || input.agent_id),
        memoryAgentId: normalizeAgentId(input.agent_id),
        userKey: normalizeText(input.user_key || input.userKey || input.owner_username || '', 255) || null,
        chatId: normalizeText(input.chat_id || input.chatId || '', 255) || null,
        agentRunId: normalizeAgentId(input.agent_run_id || input.run_id),
        runKey,
        episodeType: normalizeEpisodeType(input.episode_type),
        processStatus: normalizeProcessStatus(input.process_status),
        content,
        requestText: normalizeText(input.request_text || '', 1600) || null,
        resultText: normalizeText(input.result_text || '', 1600) || null,
        summary: normalizeText(input.summary || '', 1200) || null,
        metadataJson: toJsonString(input.metadata_json || input.metadata || {}),
        occurredAt: input.occurred_at || new Date().toISOString(),
      };

      await session.run(
        `
        MERGE (e:MemoryEpisode {id: $id})
        ON CREATE SET e.created_at = datetime()
        SET
          e.scope = $scope,
          e.agent_id = $actorAgentId,
          e.memory_agent_id = $memoryAgentId,
          e.user_key = $userKey,
          e.chat_id = $chatId,
          e.agent_run_id = $agentRunId,
          e.run_key = $runKey,
          e.episode_type = $episodeType,
          e.process_status = $processStatus,
          e.content = $content,
          e.request_text = $requestText,
          e.result_text = $resultText,
          e.summary = $summary,
          e.metadata_json = $metadataJson,
          e.occurred_at = datetime($occurredAt)
        `,
        params
      );

      if (runKey) {
        await session.run(
          `
          MATCH (e:MemoryEpisode {id: $id}), (r:MemoryRun {id: $runKey})
          MERGE (e)-[:PART_OF_RUN]->(r)
          `,
          params
        );
      }

      return { id, ...params };
    });
  }

  async upsertMemoryItem(input = {}) {
    return this.withSession('write', async (session) => {
      const runKey = await this.upsertRunGraph(session, input);
      const information = normalizeText(input.information || '', 2200);
      if (!information) return null;
      const memoryType = normalizeMemoryType(input.memory_type || input.type);
      const topic = normalizeText(input.topic || input.category || '', 255);
      const id = normalizeText(input.id || buildCanonicalMemoryKey({
        ...input,
        memory_type: memoryType,
        topic,
        information,
      }), 128);
      const embedding = normalizeEmbedding(input.embedding);
      const existing = await session.run(
        `
        OPTIONAL MATCH (m:MemoryItem {id: $id})
        RETURN m
        `,
        { id }
      );
      const existingItem = mapNodeProperties(existing.records?.[0]?.get('m'));
      const params = {
        id,
        scope: normalizeScope(input.scope),
        agentId: normalizeAgentId(input.agent_id),
        sourceUserKey: normalizeText(input.user_key || input.userKey || input.owner_username || '', 255) || null,
        agentLabel: normalizeText(input.agent_label || input.agent_name || '', 255) || null,
        memoryType,
        category: normalizeText(input.category || '', 120) || null,
        topic,
        subjectKey: canonicalizeGraphKey(input.subject_key || input.key || topic, topic),
        information,
        searchableText: normalizeSearchableText(input.searchable_text || [
          topic,
          information,
        ].filter(Boolean).join(' - '), 2200),
        confidence: normalizeConfidence(input.confidence),
        importance: normalizeImportance(input.importance),
        embedding,
        hasEmbedding: Array.isArray(embedding) && embedding.length > 0,
        embeddingModel: normalizeText(input.embedding_model || '', 160) || null,
        embeddingProvider: normalizeText(input.embedding_provider || '', 40) || null,
        episodeId: normalizeText(input.episode_id || '', 128) || null,
        runKey,
      };

      const isRedundant = existingItem?.id
        && normalizeText(existingItem.information || '', 2200) === information
        && normalizeText(existingItem.searchable_text || '', 2200) === params.searchableText
        && normalizeText(existingItem.topic || '', 255) === (params.topic || '')
        && normalizeText(existingItem.subject_key || '', 255) === (params.subjectKey || '')
        && normalizeText(existingItem.category || '', 120) === (params.category || '')
        && normalizeMemoryType(existingItem.memory_type) === memoryType;

      if (isRedundant) {
        return { id, ...params, unchanged: true };
      }

      await session.run(
        `
        MERGE (m:MemoryItem {id: $id})
        ON CREATE SET
          m.created_at = datetime(),
          m.first_seen_at = datetime(),
          m.seen_count = 0,
          m.access_count = 0
        SET
          m.scope = $scope,
          m.agent_id = $agentId,
          m.source_user_key = $sourceUserKey,
          m.agent_label = $agentLabel,
          m.memory_type = $memoryType,
          m.category = $category,
          m.topic = $topic,
          m.subject_key = $subjectKey,
          m.information = $information,
          m.searchable_text = $searchableText,
          m.confidence = CASE WHEN coalesce(m.confidence, 0.0) > $confidence THEN m.confidence ELSE $confidence END,
          m.importance = CASE WHEN coalesce(m.importance, 0.0) > $importance THEN m.importance ELSE $importance END,
          m.embedding = CASE WHEN $hasEmbedding THEN $embedding ELSE m.embedding END,
          m.embedding_model = CASE WHEN $hasEmbedding THEN $embeddingModel ELSE m.embedding_model END,
          m.embedding_provider = CASE WHEN $hasEmbedding THEN $embeddingProvider ELSE m.embedding_provider END,
          m.is_active = true,
          m.last_seen_at = datetime(),
          m.updated_at = datetime(),
          m.seen_count = coalesce(m.seen_count, 0) + 1
        `,
        params
      );

      if (params.episodeId) {
        await session.run(
          `
          MATCH (m:MemoryItem {id: $id})
          OPTIONAL MATCH (m)-[oldRel:DERIVED_FROM]->(:MemoryEpisode)
          DELETE oldRel
          WITH m
          MATCH (e:MemoryEpisode {id: $episodeId})
          MERGE (m)-[rel:DERIVED_FROM]->(e)
          ON CREATE SET rel.created_at = datetime()
          SET rel.run_key = $runKey, rel.confidence = $confidence
          `,
          params
        );
      }

      return { id, ...params };
    });
  }

  async recordToolUse(input = {}) {
    const toolName = normalizeText(input.tool_name || input.name || '', 255);
    if (!toolName) return null;
    return this.withSession('write', async (session) => {
      const runKey = await this.upsertRunGraph(session, input);
      if (!runKey) return null;
      const resultText = normalizeText(input.result_text || '', 1200);
      const status = normalizeProcessStatus(
        input.status || (isLikelyFailureText(resultText) ? 'failed' : 'completed'),
        'completed'
      );
      const params = {
        runKey,
        toolName,
        callId: normalizeText(input.tool_call_id || crypto.randomUUID(), 128),
        status,
        argsJson: toJsonString(input.arguments || input.args || {}),
        resultText,
      };
      await session.run(
        `
        MERGE (t:MemoryTool {name: $toolName})
        ON CREATE SET t.created_at = datetime()
        SET t.updated_at = datetime()
        WITH t
        MATCH (r:MemoryRun {id: $runKey})
        MERGE (r)-[rel:USED_TOOL {call_id: $callId}]->(t)
        ON CREATE SET rel.created_at = datetime()
        SET
          rel.status = $status,
          rel.arguments_json = $argsJson,
          rel.result_excerpt = $resultText,
          rel.updated_at = datetime()
        `,
        params
      );
      await session.run(
        `
        MERGE (s:MemoryStatus {name: $status})
        ON CREATE SET s.created_at = datetime()
        SET s.updated_at = datetime()
        WITH s
        MATCH (r:MemoryRun {id: $runKey}), (t:MemoryTool {name: $toolName})
        MERGE (r)-[runStatus:TOOL_STATUS {call_id: $callId, tool_name: $toolName}]->(s)
        ON CREATE SET runStatus.created_at = datetime()
        SET runStatus.updated_at = datetime()
        MERGE (t)-[toolStatus:OBSERVED_STATUS {run_key: $runKey, call_id: $callId}]->(s)
        ON CREATE SET toolStatus.created_at = datetime()
        SET toolStatus.updated_at = datetime()
        `,
        params
      );
      return params;
    });
  }

  async searchContext(input = {}) {
    const neo4j = loadNeo4jDriver();
    const embeddings = Array.isArray(input.embeddings)
      ? input.embeddings
      : [input.embedding].filter(Boolean);
    const normalizedEmbeddings = embeddings.map(normalizeEmbedding).filter((entry) => entry?.length);
    const lexicalTerms = extractLexicalTerms(input.query_texts || input.queryTexts || input.queries || input.query || []);
    if (normalizedEmbeddings.length === 0 && lexicalTerms.length === 0) return [];

    const scope = normalizeScope(input.scope);
    const numericLimit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.trunc(Number(input.limit))) : 12;
    const paramsBase = {
      scope,
      agentId: normalizeAgentId(input.agent_id),
      minScore: Number.isFinite(Number(input.min_score)) ? Number(input.min_score) : 0.2,
      limit: neo4j.int(numericLimit),
    };

    const byId = new Map();
    await this.withSession('read', async (session) => {
      for (const embedding of normalizedEmbeddings) {
        const result = await session.run(
          `
          MATCH (m:MemoryItem)
          WHERE m.is_active = true
            AND m.embedding IS NOT NULL
            AND size(m.embedding) = size($embedding)
            AND m.scope = $scope
            AND (
              ($scope = 'shared' AND m.agent_id IS NULL)
              OR ($scope = 'dedicated' AND m.agent_id = $agentId)
            )
          WITH m,
            reduce(dot = 0.0, i IN range(0, size(m.embedding) - 1) | dot + (m.embedding[i] * $embedding[i])) AS dot,
            sqrt(reduce(norm = 0.0, value IN m.embedding | norm + (value * value))) AS memoryNorm,
            sqrt(reduce(norm = 0.0, value IN $embedding | norm + (value * value))) AS queryNorm
          WITH m,
            CASE
              WHEN memoryNorm = 0.0 OR queryNorm = 0.0 THEN 0.0
              ELSE dot / (memoryNorm * queryNorm)
            END AS score
          WHERE score >= $minScore
          RETURN m, score
          ORDER BY score DESC, coalesce(m.importance, 0.5) DESC, coalesce(m.confidence, 0.5) DESC, coalesce(m.last_accessed_at, m.updated_at) DESC
          LIMIT $limit
          `,
          { ...paramsBase, embedding }
        );

        for (const record of result.records) {
          const item = mapNodeProperties(record.get('m'));
          const score = Number(record.get('score') || 0);
          mergeCandidate(byId, item, score);
        }
      }

      if (lexicalTerms.length > 0) {
        const result = await session.run(
          `
          MATCH (m:MemoryItem)
          WHERE m.is_active = true
            AND m.scope = $scope
            AND (
              ($scope = 'shared' AND m.agent_id IS NULL)
              OR ($scope = 'dedicated' AND m.agent_id = $agentId)
            )
          WITH m,
            toLower(coalesce(m.topic, '')) AS topic,
            toLower(coalesce(m.subject_key, '')) AS subjectKey,
            toLower(coalesce(m.category, '')) AS category,
            toLower(coalesce(m.searchable_text, m.information, '')) AS text,
            $terms AS terms
          WITH m, topic, subjectKey, category, text,
            [term IN terms WHERE topic CONTAINS term OR subjectKey CONTAINS term OR category CONTAINS term OR text CONTAINS term] AS matchedTerms
          WHERE size(matchedTerms) > 0
          WITH m, matchedTerms,
            CASE WHEN any(term IN matchedTerms WHERE topic CONTAINS term) THEN 0.24 ELSE 0.0 END AS subjectBoost,
            CASE WHEN any(term IN matchedTerms WHERE category CONTAINS term) THEN 0.12 ELSE 0.0 END AS labelBoost,
            toFloat(size(matchedTerms)) / toFloat(size($terms)) AS coverage
          RETURN m, (0.28 + subjectBoost + labelBoost + (coverage * 0.28)) AS score
          ORDER BY score DESC, coalesce(m.importance, 0.5) DESC, coalesce(m.confidence, 0.5) DESC, coalesce(m.last_accessed_at, m.updated_at) DESC
          LIMIT $limit
          `,
          { ...paramsBase, terms: lexicalTerms }
        );

        for (const record of result.records) {
          mergeCandidate(
            byId,
            mapNodeProperties(record.get('m')),
            Number(record.get('score') || 0)
          );
        }

        const semanticResult = await session.run(
          `
          MATCH (m:MemoryItem)-[rel]->(anchor)
          WHERE m.is_active = true
            AND type(rel) IN ['NEEDED_FOR', 'RELATED_TO', 'SUPPORTS_REQUEST']
            AND (anchor:MemoryRequest OR anchor:MemoryTopic OR anchor:MemoryTool OR anchor:MemoryStatus)
            AND m.scope = $scope
            AND (
              ($scope = 'shared' AND m.agent_id IS NULL)
              OR ($scope = 'dedicated' AND m.agent_id = $agentId)
            )
          WITH m, rel, anchor,
            toLower(
              coalesce(anchor.summary, '') + ' ' +
              coalesce(anchor.key, '') + ' ' +
              coalesce(anchor.name, '') + ' ' +
              coalesce(anchor.category, '')
            ) AS anchorText,
            toLower(coalesce(m.topic, '')) AS topic,
            toLower(coalesce(m.subject_key, '')) AS subjectKey,
            toLower(coalesce(m.category, '')) AS category,
            toLower(coalesce(m.searchable_text, m.information, '')) AS memoryText,
            $terms AS terms
          WITH m, type(rel) AS relType, anchorText, topic, subjectKey, category, memoryText,
            [term IN terms WHERE anchorText CONTAINS term OR topic CONTAINS term OR subjectKey CONTAINS term OR category CONTAINS term OR memoryText CONTAINS term] AS matchedTerms
          WHERE size(matchedTerms) > 0
          WITH m, relType, matchedTerms,
            CASE WHEN relType = 'NEEDED_FOR' THEN 0.12 ELSE 0.04 END AS relationBoost,
            CASE WHEN any(term IN matchedTerms WHERE topic CONTAINS term) THEN 0.16 ELSE 0.0 END AS subjectBoost,
            CASE WHEN any(term IN matchedTerms WHERE category CONTAINS term) THEN 0.08 ELSE 0.0 END AS labelBoost,
            toFloat(size(matchedTerms)) / toFloat(size($terms)) AS coverage
          RETURN m, (0.32 + relationBoost + subjectBoost + labelBoost + (coverage * 0.24)) AS score
          ORDER BY score DESC, coalesce(m.importance, 0.5) DESC, coalesce(m.confidence, 0.5) DESC, coalesce(m.last_accessed_at, m.updated_at) DESC
          LIMIT $limit
          `,
          { ...paramsBase, terms: lexicalTerms }
        );

        for (const record of semanticResult.records) {
          mergeCandidate(
            byId,
            mapNodeProperties(record.get('m')),
            Number(record.get('score') || 0)
          );
        }
      }
    });

    return [...byId.values()]
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if ((right.importance || 0) !== (left.importance || 0)) return (right.importance || 0) - (left.importance || 0);
        return (right.confidence || 0) - (left.confidence || 0);
      })
      .slice(0, numericLimit);
  }

  async touchMemoryItems(ids = []) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return { updated: 0 };
    return this.withSession('write', async (session) => {
      const result = await session.run(
        `
        MATCH (m:MemoryItem)
        WHERE m.id IN $ids
        SET m.last_accessed_at = datetime(), m.access_count = coalesce(m.access_count, 0) + 1
        RETURN count(m) AS updated
        `,
        { ids: uniqueIds }
      );
      const updated = result.records?.[0]?.get('updated');
      return { updated: updated?.toNumber ? updated.toNumber() : Number(updated || 0) };
    });
  }
}

module.exports = {
  Neo4jMemoryRepository,
};
