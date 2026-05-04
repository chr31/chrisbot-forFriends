const { normalizeText, toJsonString } = require('./memorySchema');

function getMessageContent(message = {}) {
  if (typeof message.content === 'string') return message.content;
  if (message.content === undefined || message.content === null) return '';
  return toJsonString(message.content) || '';
}

function summarizeToolCall(toolCall = {}) {
  const name = toolCall?.function?.name || toolCall?.name || 'unknown_tool';
  const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? null;
  return normalizeText(`${name}: ${toJsonString(args) || ''}`, 800);
}

function summarizeToolResult(result = {}, toolName = '') {
  const prefix = toolName ? `${toolName}: ` : '';
  return normalizeText(`${prefix}${result?.content || result?.result || ''}`, 1000);
}

function buildConversationText(chat = {}, maxMessages = 14) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  return messages
    .slice(-maxMessages)
    .map((message) => {
      const role = String(message?.role || 'unknown');
      if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return `assistant tool_calls: ${message.tool_calls.map(summarizeToolCall).join(' | ')}`;
      }
      if (role === 'tool') {
        return `tool result: ${normalizeText(getMessageContent(message), 900)}`;
      }
      return `${role}: ${normalizeText(getMessageContent(message), 1200)}`;
    })
    .filter((line) => line.trim())
    .join('\n');
}

function buildToolActivityText(chat = {}) {
  const toolCalls = Array.isArray(chat.toolCalls) ? chat.toolCalls : [];
  const resultById = new Map(
    (Array.isArray(chat.toolResults) ? chat.toolResults : [])
      .map((result) => [String(result.tool_call_id || ''), result])
  );

  return toolCalls
    .map((toolCall) => {
      const id = String(toolCall?.id || '');
      const name = toolCall?.function?.name || toolCall?.name || 'unknown_tool';
      const result = resultById.get(id);
      return [
        `tool: ${summarizeToolCall(toolCall)}`,
        result ? `result: ${summarizeToolResult(result, name)}` : null,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function buildBeforeQueryMessages({ chat }) {
  const conversation = buildConversationText(chat, 10);
  const userRequest = normalizeText(chat?.userMessage?.content || '', 1200);
  return [
    {
      role: 'system',
      content: [
        'Sei il modulo di retrieval query del Memory Engine.',
        'Produci solo JSON valido.',
        'Riassumi la richiesta corrente in massimo 10 parole.',
        'Estrai 1-4 argomenti operativi stabili: tool, servizio, asset, repository, processo o dominio.',
        'Genera 2 o 3 frasi naturali brevi per cercare memorie utili.',
        'Le query devono descrivere intenzione, contesto e oggetti importanti, non essere keyword isolate.',
        'Le query devono aiutare a trovare prerequisiti, tool gia riusciti, errori noti e informazioni necessarie.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Richiesta corrente:\n${userRequest || '(nessuna richiesta esplicita)'}`,
        `Conversazione recente:\n${conversation || '(vuota)'}`,
        [
          'Rispondi nel formato JSON:',
          '{',
          '  "request_summary": "massimo 10 parole",',
          '  "topics": [{"name":"argomento stabile","category":"asset_context|service_context|tool_lesson|procedure|project_context"}],',
          '  "queries":["frase naturale 1","frase naturale 2"]',
          '}',
        ].join('\n'),
      ].join('\n\n'),
    },
  ];
}

function buildBeforeCompactionMessages({ chat, candidates, requestAnalysis }) {
  const conversation = buildConversationText(chat, 10);
  const requestSummary = normalizeText(requestAnalysis?.request_summary || '', 220);
  const topics = (Array.isArray(requestAnalysis?.topics) ? requestAnalysis.topics : [])
    .map((topic) => normalizeText(topic?.name || topic?.topic || topic, 120))
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');
  const candidateText = (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => {
      const parts = [
        `#${index + 1}`,
        `id: ${candidate.id}`,
        `type: ${candidate.memory_type}`,
        `score: ${Number(candidate.score || 0).toFixed(3)}`,
        `confidence: ${Number(candidate.confidence || 0).toFixed(2)}`,
        `importance: ${Number(candidate.importance || 0).toFixed(2)}`,
        `topic: ${normalizeText(candidate.topic || candidate.category || '', 200)}`,
        `information: ${normalizeText(candidate.information || candidate.searchable_text || '', 900)}`,
      ];
      return parts.join('\n');
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content: [
        'Sei il modulo di compattazione del Memory Engine.',
        'Produci solo JSON valido.',
        'Seleziona solo memorie davvero utili alla richiesta corrente.',
        'Se nessuna memoria candidata e necessaria per rispondere, restituisci array vuoti e contextText vuoto.',
        'Ogni informazione inserita in contextText deve derivare da selected_ids.',
        'Non trasformare ipotesi o ricordi incerti in fatti.',
        'Non includere dettagli personali o preferenze dell utente.',
        'Il campo contextText deve essere massimo 50 parole, compatto e pronto da inserire nel prompt agente.',
        'Privilegia prerequisiti, tool gia riusciti, failure mode e info necessarie alla richiesta corrente.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Richiesta sintetica:\n${requestSummary || '(non disponibile)'}`,
        `Argomenti:\n${topics || '(non disponibili)'}`,
        `Conversazione corrente:\n${conversation || '(vuota)'}`,
        `Memorie candidate:\n${candidateText || '(nessuna)'}`,
        [
          'Rispondi nel formato JSON:',
          '{',
          '  "selected_ids": ["id"],',
          '  "facts": ["..."],',
          '  "entities": ["..."],',
          '  "procedures": ["..."],',
          '  "decisions": ["..."],',
          '  "tool_lessons": ["..."],',
          '  "recent_actions": ["..."],',
          '  "contextText": "testo compatto"',
          '}',
        ].join('\n'),
      ].join('\n\n'),
    },
  ];
}

function buildAfterExtractionMessages({ chat, agent, scope, processStatus }) {
  const conversation = buildConversationText(chat, 16);
  const toolActivity = buildToolActivityText(chat);
  const assistantResponse = normalizeText(chat?.assistantResponse || '', 1600);
  const userRequest = normalizeText(chat?.userMessage?.content || '', 1200);
  return [
    {
      role: 'system',
      content: [
        'Sei il modulo di estrazione del Memory Engine.',
        'Produci solo JSON valido.',
        'Riassumi la richiesta in massimo 10 parole e identifica gli argomenti operativi stabili.',
        'Proponi solo memorie operative riutilizzabili dall\'agente in run future.',
        'Non creare piu di 3 memorie totali.',
        'Se una singola frase contiene agente/argomento/informazione/identificativi, salvala come una sola memoria fact o entity.',
        'Non creare contemporaneamente fact, entity, procedure e summary per la stessa informazione.',
        'Salva meno informazioni possibili: solo identificativi, procedure, decisioni, vincoli, tool lesson o contesto operativo che servira davvero.',
        'Salva capacita apprese, lezioni sui tool, procedure, decisioni, vincoli di progetto e contesto operativo.',
        'Quando esiste un identificativo stabile, usalo come topic: asset ID, service name, repository, endpoint, tool name o procedure key.',
        'Per asset_context privilegia identificativi riusabili come asset ID e non descrizioni lunghe.',
        'Per tool_lesson indica soprattutto input richiesti, chiamate riuscite, errori ricorrenti e fallback validati.',
        'L esito grezzo dei tool della run viene gia salvato nel grafo tecnico MemoryRun/USED_TOOL: non creare memorie solo per dire che un tool e riuscito o fallito.',
        'Crea una tool_lesson da un esito tool solo se contiene una lezione riutilizzabile: mapping stabile tra dispositivo/servizio e dominio, input necessario, failure mode, fallback o risultato operativo osservabile.',
        'Per richieste di controllo stato salva al massimo una memoria operativa compatta sul soggetto stabile osservato, includendo nello stesso testo eventuale dispositivo, servizio o stream rilevato.',
        'Non salvare come MemoryItem stati temporanei: funzionante ora, play/stop, brano corrente, volume corrente, data corrente, nessun errore nella run. Questi restano solo negli episodi di audit.',
        'Se un informazione diventa piu aggiornata, proponi la versione minima corrente, non una cronologia.',
        'Non duplicare informazioni gia espresse nella stessa estrazione.',
        'Non salvare obiettivi/goals dell agente: restano nel campo goals separato.',
        'Non salvare riassunti generici come "l utente ha chiesto..." senza valore operativo futuro.',
        'Non usare summaries per informazioni puntuali: usa facts con category appropriata.',
        'Non salvare cronologia, trascrizioni o dettagli del processo se non diventano una procedura o una lezione riutilizzabile.',
        'Non salvare preferenze personali dell\'utente, tratti caratteriali, tono desiderato o dettagli personali non operativi.',
        'Usa confidence >= 0.7 solo quando il testo lo supporta chiaramente.',
        'Usa category solo tra project_context, asset_context, service_context, tool_lesson, procedure, decision, error, conversation_summary, action_history.',
        'Non proporre invalidazioni in questa fase.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Agente: ${agent?.name || agent?.id || 'unknown'}`,
        `Scope memoria: ${scope}`,
        `Stato processo: ${processStatus || 'completed'}`,
        `Richiesta utente:\n${userRequest || '(vuota)'}`,
        `Risposta assistant:\n${assistantResponse || '(vuota)'}`,
        `Tool usati:\n${toolActivity || '(nessun tool)'}`,
        `Conversazione recente:\n${conversation || '(vuota)'}`,
        [
          'Rispondi nel formato JSON:',
          '{',
          '  "request_summary": "massimo 10 parole",',
          '  "topics": [{"name":"assetmanager","category":"asset_context|service_context|tool_lesson|procedure|project_context"}],',
          '  "facts": [{"topic":"argomento o identificatore stabile","information":"informazione compatta","category":"project_context|asset_context|service_context","confidence":0.8,"importance":0.6}],',
          '  "entities": [{"topic":"entita","entity_type":"asset|tool|agent|project|service|concept","information":"descrizione compatta","confidence":0.8,"importance":0.5}],',
          '  "procedures": [{"topic":"procedura","information":"workflow compatto","confidence":0.8,"importance":0.7}],',
          '  "decisions": [{"topic":"decisione","information":"decisione compatta","confidence":0.8,"importance":0.8}],',
          '  "tool_lessons": [{"topic":"tool","information":"lezione compatta","confidence":0.8,"importance":0.7}],',
          '  "summaries": [],',
          '  "warnings": []',
          '}',
        ].join('\n'),
      ].join('\n\n'),
    },
  ];
}

module.exports = {
  buildAfterExtractionMessages,
  buildBeforeCompactionMessages,
  buildBeforeQueryMessages,
  buildConversationText,
  buildToolActivityText,
  summarizeToolCall,
  summarizeToolResult,
};
