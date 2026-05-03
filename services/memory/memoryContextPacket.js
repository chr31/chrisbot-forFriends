function normalizeMemoryScope(value) {
  return String(value || '').trim().toLowerCase() === 'dedicated' ? 'dedicated' : 'shared';
}

function getScopedAgentId(agent, scope) {
  return normalizeMemoryScope(scope) === 'dedicated' ? agent?.id || null : null;
}

function buildEmptyMemoryContextPacket(input = {}) {
  const scope = normalizeMemoryScope(input.scope);
  return {
    enabled: Boolean(input.enabled),
    scope,
    agent_id: getScopedAgentId(input.agent, scope),
    facts: [],
    entities: [],
    procedures: [],
    decisions: [],
    tool_lessons: [],
    recent_actions: [],
    summaries: [],
    warnings: [],
    contextText: '',
    skipped_reason: input.skipped_reason || null,
  };
}

function hasMemoryContext(packet) {
  return Boolean(packet && String(packet.contextText || '').trim());
}

function formatMemoryContextPacket(packet) {
  const text = String(packet?.contextText || '').trim();
  return text ? `Memory context:\n${text}` : '';
}

module.exports = {
  buildEmptyMemoryContextPacket,
  formatMemoryContextPacket,
  hasMemoryContext,
  normalizeMemoryScope,
};
