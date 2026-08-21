function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeTimeout(value, fallback = 8000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

// mem0 OSS restituisce le memorie in forme diverse a seconda della versione:
// array puro, { results: [...] } oppure { memories: [...] }.
function extractMemories(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.memories)) return payload.memories;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

/**
 * Client HTTP verso un'istanza mem0 OSS self-hosted.
 * Espone solo le operazioni usate dal portale: add e search, piu' un health
 * probe per il test connessione. Nessun dettaglio HTTP deve uscire da qui.
 */
class Mem0Provider {
  constructor(settings = {}) {
    this.settings = settings || {};
    this.baseUrl = trimTrailingSlash(settings.mem0_api_url || 'http://127.0.0.1:8888');
    this.apiKey = String(settings.mem0_api_key || '').trim();
    this.timeoutMs = normalizeTimeout(settings.mem0_timeout_ms, 8000);
    // add() innesca l'estrazione LLM lato mem0: puo' richiedere decine di
    // secondi, quindi ha un timeout dedicato molto piu' ampio della search.
    this.addTimeoutMs = normalizeTimeout(settings.mem0_add_timeout_ms, 60000);
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = normalizeTimeout(options.timeoutMs, this.timeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        Accept: 'application/json',
        ...(options.headers || {}),
      };
      // mem0 OSS: API key per-utente o admin via header X-API-Key.
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        const message = payload?.error || payload?.detail || payload?.message || response.statusText || 'mem0 API error';
        throw new Error(`${response.status} ${message}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Aggiunge memorie a partire dalla conversazione. mem0 estrae, deduplica e
   * aggiorna internamente. Richiede almeno un identificatore di scope.
   */
  async add(messages, scope = {}) {
    const body = { messages };
    if (scope.agent_id) body.agent_id = String(scope.agent_id);
    if (scope.user_id) body.user_id = String(scope.user_id);
    if (scope.run_id) body.run_id = String(scope.run_id);
    if (scope.metadata && typeof scope.metadata === 'object') body.metadata = scope.metadata;
    return this.request('/memories', { method: 'POST', body, timeoutMs: this.addTimeoutMs });
  }

  /**
   * Ricerca semantica delle memorie nello scope indicato.
   * Ritorna sempre un array di memorie normalizzato.
   */
  async search(query, scope = {}) {
    const body = { query: String(query || '') };
    if (scope.agent_id) body.agent_id = String(scope.agent_id);
    if (scope.user_id) body.user_id = String(scope.user_id);
    if (scope.run_id) body.run_id = String(scope.run_id);
    if (scope.filters && typeof scope.filters === 'object') body.filters = scope.filters;
    if (scope.limit) body.limit = scope.limit;
    const payload = await this.request('/search', { method: 'POST', body });
    return extractMemories(payload);
  }

  /**
   * Test connessione: esercita l'endpoint /search cosi da validare sia la
   * raggiungibilita' sia l'autenticazione (API key). Una risposta vuota e' OK.
   */
  async health() {
    const results = await this.search('healthcheck', { user_id: '__chrisbot_healthcheck__', limit: 1 });
    return { ok: true, reachable: true, sample_count: Array.isArray(results) ? results.length : 0 };
  }
}

function createMem0Provider(settings = {}) {
  return new Mem0Provider(settings);
}

module.exports = {
  Mem0Provider,
  createMem0Provider,
  extractMemories,
};
