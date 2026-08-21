const { getMemoryEngineSettingsSync } = require('./appSettings');
const { embedTexts } = require('./memory/memoryEmbedding');
const { callMemoryChatJson } = require('./memory/memoryModelRuntime');

const DEFAULT_MATCH_THRESHOLD = 0.72;
const DEFAULT_BLOCK_MESSAGE = 'Questo agente non si occupa di questo argomento.';
const DEFAULT_UNCLEAR_MESSAGE = 'Puoi chiarire se la richiesta riguarda il dominio di questo agente?';
const AMBIGUITY_MARGIN = 0.08;
const LONG_MESSAGE_THRESHOLD = 1400;
const policyEmbeddingCache = new Map();

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : String(value || '').split('\n');
  return Array.from(new Set(
    source
      .flatMap((entry) => String(entry || '').split(','))
      .map((entry) => entry.trim())
      .filter(Boolean)
  )).slice(0, 100);
}

function normalizeThreshold(value, fallback = DEFAULT_MATCH_THRESHOLD) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(0.98, Math.max(0.1, number));
}

function normalizeSemanticGuardrailPolicy(agent = {}) {
  const raw = agent?.guardrails_json && typeof agent.guardrails_json === 'object'
    ? agent.guardrails_json
    : {};
  const nested = raw.semantic_guardrails && typeof raw.semantic_guardrails === 'object'
    ? raw.semantic_guardrails
    : {};
  const source = { ...raw, ...nested };
  const allowedIntents = normalizeStringList(source.allowed_intents || source.allowed_topics);
  const blockedIntents = normalizeStringList(source.blocked_intents || source.blocked_topics || source.denied_intents || source.deny_intents);
  const hasPolicy = allowedIntents.length > 0 || blockedIntents.length > 0;
  const explicitlyEnabled = source.semantic_guardrails_enabled ?? source.enabled;
  const enabled = explicitlyEnabled === undefined ? hasPolicy : explicitlyEnabled !== false;

  return {
    enabled: Boolean(enabled && hasPolicy),
    allowedIntents,
    blockedIntents,
    blockedMessage: String(source.blocked_message || source.block_message || DEFAULT_BLOCK_MESSAGE).trim() || DEFAULT_BLOCK_MESSAGE,
    unclearMessage: String(source.unclear_message || DEFAULT_UNCLEAR_MESSAGE).trim() || DEFAULT_UNCLEAR_MESSAGE,
    unclearAction: String(source.unclear_action || 'block').trim().toLowerCase() === 'clarify' ? 'clarify' : 'block',
    matchThreshold: normalizeThreshold(source.match_threshold),
  };
}

function cosineSimilarity(left = [], right = []) {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 12);
}

function buildEmbeddingProbes(message) {
  const text = String(message || '').trim();
  if (!text) return [];
  const probes = [text.slice(0, 6000)];
  const sentences = splitSentences(text);
  for (const sentence of sentences.slice(0, 8)) {
    if (sentence.length < text.length) probes.push(sentence.slice(0, 1200));
  }
  if (text.length > 1800) {
    for (let index = 0; index < text.length && probes.length < 12; index += 1200) {
      probes.push(text.slice(index, index + 1200).trim());
    }
  }
  return Array.from(new Set(probes.filter(Boolean))).slice(0, 12);
}

function buildClassifierProbes(classification = {}) {
  const values = [
    ...(Array.isArray(classification.intents) ? classification.intents : []),
    ...(Array.isArray(classification.actions) ? classification.actions : []),
    ...(Array.isArray(classification.topics) ? classification.topics : []),
    ...(Array.isArray(classification.injection_signals) ? classification.injection_signals : []),
  ];
  return Array.from(new Set(
    values
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  )).slice(0, 12);
}

function normalizeForLexicalMatch(value) {
  return String(value || '').trim().toLowerCase();
}

function findLexicalMatch(probes = [], labels = []) {
  for (const label of labels) {
    const normalizedLabel = normalizeForLexicalMatch(label);
    if (normalizedLabel.length < 3) continue;
    const probeIndex = probes.findIndex((probe) => normalizeForLexicalMatch(probe).includes(normalizedLabel));
    if (probeIndex >= 0) {
      return { label, score: 1, probe_index: probeIndex, match_type: 'lexical' };
    }
  }
  return null;
}

function bestPolicyMatch({ probeEmbeddings, labels, labelEmbeddings }) {
  let best = null;
  for (let probeIndex = 0; probeIndex < probeEmbeddings.length; probeIndex += 1) {
    for (let labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
      const score = cosineSimilarity(probeEmbeddings[probeIndex], labelEmbeddings[labelIndex]);
      if (!best || score > best.score) {
        best = {
          label: labels[labelIndex],
          score,
          probe_index: probeIndex,
        };
      }
    }
  }
  return best;
}

function buildPolicyEmbeddingCacheKey(policy, settings = {}) {
  return JSON.stringify({
    provider: settings.embedding_model_provider || '',
    model: settings.embedding_model || '',
    server: settings.embedding_ollama_server_id || settings.ollama_server_id || '',
    allowed: policy.allowedIntents,
    blocked: policy.blockedIntents,
  });
}

async function getPolicyEmbeddings(policy, settings) {
  const labels = [...policy.blockedIntents, ...policy.allowedIntents];
  const cacheKey = buildPolicyEmbeddingCacheKey(policy, settings);
  const cached = policyEmbeddingCache.get(cacheKey);
  if (cached) return cached;
  const result = await embedTexts(labels, settings);
  const entry = {
    provider: result.provider,
    model: result.model,
    blockedEmbeddings: result.embeddings.slice(0, policy.blockedIntents.length),
    allowedEmbeddings: result.embeddings.slice(policy.blockedIntents.length),
    cached: false,
  };
  policyEmbeddingCache.set(cacheKey, { ...entry, cached: true });
  if (policyEmbeddingCache.size > 200) {
    policyEmbeddingCache.delete(policyEmbeddingCache.keys().next().value);
  }
  return entry;
}

async function embedProbes(probes, settings) {
  const result = await embedTexts(probes, settings);
  return {
    provider: result.provider,
    model: result.model,
    embeddings: result.embeddings,
  };
}

function scorePolicy({ policy, probeEmbeddings, provider, model, policyEmbedding }) {
  const blockedMatch = policy.blockedIntents.length > 0
    ? bestPolicyMatch({ probeEmbeddings, labels: policy.blockedIntents, labelEmbeddings: policyEmbedding.blockedEmbeddings })
    : null;
  const allowedMatch = policy.allowedIntents.length > 0
    ? bestPolicyMatch({ probeEmbeddings, labels: policy.allowedIntents, labelEmbeddings: policyEmbedding.allowedEmbeddings })
    : null;
  const blockedHit = Boolean(blockedMatch && blockedMatch.score >= policy.matchThreshold);
  const allowedHit = Boolean(allowedMatch && allowedMatch.score >= policy.matchThreshold);

  return {
    applied: true,
    provider,
    model,
    threshold: policy.matchThreshold,
    policy_embedding_cached: Boolean(policyEmbedding.cached),
    blocked_match: blockedMatch,
    allowed_match: allowedMatch,
    blocked_hit: blockedHit,
    allowed_hit: allowedHit,
    policy: {
      allowed_count: policy.allowedIntents.length,
      blocked_count: policy.blockedIntents.length,
    },
  };
}

function finalizeDecision(policy, score, reasonSuffix = '') {
  if (score.blocked_hit) {
    return { ...score, decision: 'block', reason: `blocked_intent_match${reasonSuffix}`, message: policy.blockedMessage };
  }
  if (policy.allowedIntents.length > 0 && !score.allowed_hit) {
    const decision = policy.unclearAction === 'clarify' ? 'clarify' : 'block';
    return {
      ...score,
      decision,
      reason: `allowed_intent_missing${reasonSuffix}`,
      message: decision === 'clarify' ? policy.unclearMessage : policy.blockedMessage,
    };
  }
  return {
    ...score,
    decision: 'allow',
    reason: `${policy.allowedIntents.length > 0 ? 'allowed_intent_match' : 'no_blocked_intent_match'}${reasonSuffix}`,
  };
}

function isAmbiguousScore(policy, score, userMessage) {
  const threshold = policy.matchThreshold;
  const blockedScore = Number(score.blocked_match?.score || 0);
  const allowedScore = Number(score.allowed_match?.score || 0);
  if (String(userMessage || '').length >= LONG_MESSAGE_THRESHOLD) return true;
  if (policy.blockedIntents.length > 0 && blockedScore >= threshold - AMBIGUITY_MARGIN && blockedScore < threshold) return true;
  if (policy.allowedIntents.length > 0 && allowedScore >= threshold - AMBIGUITY_MARGIN && allowedScore < threshold) return true;
  if (policy.allowedIntents.length > 0 && policy.blockedIntents.length > 0 && Math.abs(allowedScore - blockedScore) <= AMBIGUITY_MARGIN) return true;
  return false;
}

function normalizeClassifierArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 8)
    : [];
}

async function classifyRequestBlindly(userMessage, settings) {
  const result = await callMemoryChatJson([
    {
      role: 'system',
      content: [
        'Estrai una classificazione neutrale della richiesta utente.',
        'Non decidere se la richiesta e consentita.',
        'Non inventare categorie di policy.',
        'Rispondi solo JSON con array di stringhe: intents, actions, topics, injection_signals.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: String(userMessage || '').slice(0, 8000),
    },
  ], settings);
  return {
    intents: normalizeClassifierArray(result?.intents),
    actions: normalizeClassifierArray(result?.actions),
    topics: normalizeClassifierArray(result?.topics),
    injection_signals: normalizeClassifierArray(result?.injection_signals),
  };
}

function buildAgentGuardrailRunTrace(result = {}) {
  if (!result?.applied) return { guardrail_events: [] };
  const matched = [result.blocked_match, result.allowed_match]
    .filter(Boolean)
    .map((match) => `${match.label} (${Number(match.score || 0).toFixed(3)})`);
  return {
    guardrail_events: [{
      type: 'semantic_guardrail',
      label: 'Guardrail semantico',
      status: result.decision === 'allow' ? 'completed' : 'blocked',
      content: [
        `Decisione: ${result.decision}`,
        `Motivo: ${result.reason || 'n/a'}`,
        matched.length > 0 ? `Match: ${matched.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      details: result,
    }],
  };
}

async function evaluateAgentSemanticGuardrails(agent, userMessage) {
  const policy = normalizeSemanticGuardrailPolicy(agent);
  if (!policy.enabled) {
    return { applied: false, decision: 'allow', reason: 'no_policy' };
  }

  const probes = buildEmbeddingProbes(userMessage);
  if (probes.length === 0) {
    return {
      applied: true,
      decision: 'block',
      reason: 'empty_request',
      message: policy.blockedMessage,
      policy: { allowed_count: policy.allowedIntents.length, blocked_count: policy.blockedIntents.length },
    };
  }

  const lexicalBlockedMatch = findLexicalMatch(probes, policy.blockedIntents);
  if (lexicalBlockedMatch) {
    return {
      applied: true,
      decision: 'block',
      reason: 'blocked_intent_match',
      message: policy.blockedMessage,
      threshold: policy.matchThreshold,
      blocked_match: lexicalBlockedMatch,
      allowed_match: null,
      policy: { allowed_count: policy.allowedIntents.length, blocked_count: policy.blockedIntents.length },
    };
  }

  const settings = getMemoryEngineSettingsSync();
  let embeddingResult;
  let policyEmbedding;
  try {
    [embeddingResult, policyEmbedding] = await Promise.all([
      embedProbes(probes, settings),
      getPolicyEmbeddings(policy, settings),
    ]);
  } catch (error) {
    return {
      applied: true,
      decision: 'block',
      reason: 'guardrail_embedding_unavailable',
      message: policy.blockedMessage,
      warning: String(error?.message || error),
      policy: { allowed_count: policy.allowedIntents.length, blocked_count: policy.blockedIntents.length },
    };
  }

  const initialScore = scorePolicy({
    policy,
    probeEmbeddings: embeddingResult.embeddings,
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    policyEmbedding,
  });
  const initialDecision = finalizeDecision(policy, initialScore);

  if (!isAmbiguousScore(policy, initialScore, userMessage)) {
    return initialDecision;
  }

  try {
    const classification = await classifyRequestBlindly(userMessage, settings);
    const classifierProbes = buildClassifierProbes(classification);
    if (classifierProbes.length === 0) {
      return { ...initialDecision, classifier: classification, classifier_used: true, classifier_reason: 'empty_classification' };
    }
    const classifierEmbedding = await embedProbes(classifierProbes, settings);
    const combinedScore = scorePolicy({
      policy,
      probeEmbeddings: [...embeddingResult.embeddings, ...classifierEmbedding.embeddings],
      provider: classifierEmbedding.provider,
      model: classifierEmbedding.model,
      policyEmbedding,
    });
    return {
      ...finalizeDecision(policy, combinedScore, '_after_classifier'),
      classifier,
      classifier_used: true,
      initial_decision: initialDecision,
    };
  } catch (error) {
    return {
      ...initialDecision,
      classifier_used: true,
      classifier_error: String(error?.message || error),
    };
  }
}

module.exports = {
  buildAgentGuardrailRunTrace,
  evaluateAgentSemanticGuardrails,
  normalizeSemanticGuardrailPolicy,
};
