function countPacketEntries(packet = {}) {
  return ['facts', 'entities', 'procedures', 'decisions', 'tool_lessons', 'recent_actions', 'summaries']
    .reduce((total, key) => total + (Array.isArray(packet[key]) ? packet[key].length : 0), 0);
}

const MEMORY_SECTIONS = [
  ['facts', 'Fatti'],
  ['entities', 'Entita'],
  ['procedures', 'Procedure'],
  ['decisions', 'Decisioni'],
  ['tool_lessons', 'Lezioni tool'],
  ['recent_actions', 'Azioni recenti'],
  ['summaries', 'Sintesi'],
];

function getDisplayContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function normalizeTraceItem(value, sectionLabel) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      section: sectionLabel,
      topic: getDisplayContent(value.topic || value.category || value.memory_type || sectionLabel),
      information: getDisplayContent(value.information || value.description || value.name || value),
    };
  }
  return {
    section: sectionLabel,
    topic: sectionLabel,
    information: getDisplayContent(value),
  };
}

function getPacketItems(packet = {}) {
  const items = [];
  for (const [key, label] of MEMORY_SECTIONS) {
    const values = Array.isArray(packet[key]) ? packet[key] : [];
    for (const value of values) {
      const item = normalizeTraceItem(value, label);
      if (String(item.information || '').trim()) items.push(item);
    }
  }
  return items.slice(0, 12);
}

function getPacketTopics(packet = {}) {
  const topics = packet.request?.topics || packet.retrieval?.topics || packet.process?.topics || [];
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => getDisplayContent(topic?.name || topic?.topic || topic?.key || topic))
    .filter(Boolean)
    .slice(0, 8);
}

function buildMemoryTraceDetails(packet = {}, phase) {
  const items = getPacketItems(packet);
  const contextText = String(packet.contextText || '').trim();
  const reusableInfo = Array.isArray(packet.process?.reusable_info)
    ? packet.process.reusable_info.map(getDisplayContent).filter(Boolean).slice(0, 10)
    : [];
  const warnings = Array.isArray(packet.warnings)
    ? packet.warnings.map(getDisplayContent).filter(Boolean).slice(0, 8)
    : [];
  return {
    phase,
    request_summary: getDisplayContent(
      packet.request?.summary
        || packet.retrieval?.request_summary
        || packet.process?.request_summary
        || ''
    ),
    topics: getPacketTopics(packet),
    contextText,
    items,
    reusable_info: reusableInfo,
    retrieval: packet.retrieval || null,
    embedding: packet.embedding || null,
    episodes: packet.episodes || null,
    warnings,
  };
}

function formatMemoryTraceContent(packet = {}, fallback) {
  const parts = [];
  const scope = String(packet.scope || '').trim();
  const skippedReason = String(packet.skipped_reason || '').trim();
  const warnings = Array.isArray(packet.warnings) ? packet.warnings.filter(Boolean) : [];
  const entryCount = countPacketEntries(packet);
  const requestSummary = getDisplayContent(packet.request?.summary || packet.retrieval?.request_summary || packet.process?.request_summary || '');

  if (scope) parts.push(`Scope: ${scope}`);
  if (requestSummary) parts.push(`Richiesta: ${requestSummary}`);
  if (packet.enabled === false) parts.push('Memory Engine non eseguito.');
  if (skippedReason) parts.push(`Stato: ${skippedReason}`);
  if (entryCount > 0) parts.push(`Elementi: ${entryCount}`);
  if (warnings.length > 0) parts.push(`Warning:\n${warnings.map((warning) => `- ${warning}`).join('\n')}`);

  return parts.length > 0 ? parts.join('\n') : fallback;
}

function buildMemoryRunTrace(beforePacket = null, afterPacket = null, options = {}) {
  const events = [];
  if (beforePacket) {
    events.push({
      type: 'memory_before',
      label: 'Memory retrieve',
      content: formatMemoryTraceContent(beforePacket, 'Recupero memoria completato.'),
      status: beforePacket.skipped_reason ? 'skipped' : 'completed',
      scope: beforePacket.scope || null,
      details: buildMemoryTraceDetails(beforePacket, 'before'),
    });
  }
  if (afterPacket) {
    events.push({
      type: 'memory_after',
      label: 'Memory salvataggio',
      content: formatMemoryTraceContent(afterPacket, 'Salvataggio memoria completato.'),
      status: afterPacket.skipped_reason ? 'skipped' : 'completed',
      scope: afterPacket.scope || null,
      details: buildMemoryTraceDetails(afterPacket, 'after'),
    });
  } else if (options.includePendingAfter) {
    events.push({
      type: 'memory_after',
      label: 'Memory salvataggio',
      content: 'Salvataggio memoria in corso.',
      status: 'running',
      scope: beforePacket?.scope || null,
      details: {
        phase: 'after',
        request_summary: '',
        topics: [],
        contextText: '',
        items: [],
        reusable_info: [],
        retrieval: null,
        embedding: null,
        episodes: null,
        warnings: [],
      },
    });
  }
  return { memory_events: events };
}

module.exports = {
  buildMemoryRunTrace,
};
