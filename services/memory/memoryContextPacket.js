function buildEmptyMemoryContextPacket(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    provider: input.provider || null,
    project_id: input.project_id || null,
    agent_id: input.agent?.id || null,
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
  return text ? `Memory context (read-only):\n${text}` : '';
}

module.exports = {
  buildEmptyMemoryContextPacket,
  formatMemoryContextPacket,
  hasMemoryContext,
};
