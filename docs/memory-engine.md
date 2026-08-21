# Chrisbot Memory Engine

Il Memory Engine di Chrisbot e' basato su [mem0](https://github.com/mem0ai/mem0) OSS self-hosted. Chrisbot non gestisce piu' un grafo di memorie proprio: delega a mem0 estrazione, deduplica, aggiornamento e ricerca semantica delle memorie. L'integrazione si riduce a due funzioni agganciate al flusso chat (`beforeMemory` e `afterMemory`) che parlano con mem0 via HTTP.

## Flusso runtime

```txt
richiesta utente
-> guardrail semantici
-> beforeMemory: ricerca semantica su mem0 e iniezione nel prompt
-> risposta dell'agente
-> afterMemory: invio del turno (user + assistant) a mem0 per l'estrazione
```

`beforeMemory` e `afterMemory` non bloccano la chat: se mem0 non e' configurato o non risponde, la conversazione prosegue senza memoria e l'errore viene solo annotato.

## Configurazione globale (mem0)

Le impostazioni vivono in `app_settings` (chiave `memory_engine`), coerentemente con OpenAI, Ollama, MCP e Telegram, e sono esposte dal portale nella tab:

```txt
Impostazioni > Memory Engine
```

Campi mem0 salvati a DB:

```txt
enabled            ON/OFF globale del Memory Engine
mem0_api_url       URL dell'istanza mem0 OSS (default http://127.0.0.1:8888)
mem0_api_key       API key mem0, salvata cifrata (header X-API-Key)
mem0_timeout_ms    timeout delle chiamate di ricerca
mem0_add_timeout_ms timeout piu' ampio per l'estrazione (add), che gira un LLM lato mem0
mem0_search_limit  numero massimo di memorie recuperate per ricerca
```

Il default di bootstrap di `mem0_api_url` puo' essere impostato con l'env `MEM0_API_URL`; tutto il resto si configura dal portale. Il test connessione esercita l'endpoint di ricerca mem0 per validare raggiungibilita' e autenticazione.

Nota: nella stessa area di impostazioni convivono i campi dei modelli usati dai guardrail semantici (`analysis_model_provider`/`analysis_model`, `embedding_model_provider`/`embedding_model`, `ollama_server_id`/`embedding_ollama_server_id`). Questi campi NON sono legacy: servono ai guardrail semantici degli agenti, non a mem0.

## Configurazione per agente

Ogni agente ha due flag indipendenti nel proprio record:

```txt
memory_engine_enabled   (Use memories)    -> l'agente usa le memorie in beforeMemory
improve_memories_enabled (Improve memories) -> l'agente aggiorna le memorie in afterMemory
```

Default:

```txt
Use memories OFF
Improve memories OFF
```

Regole runtime:

```txt
Memory Engine globale OFF
-> nessuna funzione di memoria viene eseguita

Memory Engine globale ON + Use memories ON
-> beforeMemory cerca su mem0 con scope agent_id = agente corrente e inietta il contesto

Memory Engine globale ON + Improve memories ON
-> afterMemory invia il turno a mem0 con scope agent_id = agente corrente
```

Lo scope delle memorie e' l'agente: mem0 viene interrogato e scritto usando `agent_id` uguale all'id dell'agente. Non c'e' partizionamento per utente.

## beforeMemory

File: `services/memory/beforeMemory.js`.

Scopo: recuperare da mem0 le memorie utili alla richiesta corrente e iniettarle nel prompt.

```txt
1. Gira solo se Memory Engine globale ON e Use memories dell'agente ON.
2. Costruisce una singola query di ricerca dal messaggio utente (fallback: ultimo turno user nella history).
3. Chiama mem0 search(query, { agent_id, limit }).
4. Normalizza le memorie restituite (mem0 puo' rispondere come array, { results }, { memories } o { data }).
5. Costruisce un blocco di contesto compatto (budget di caratteri configurabile) e lo inietta come messaggio system subito dopo il system prompt principale.
6. Se non ci sono memorie utili non inietta alcun blocco.
```

`beforeMemory` restituisce un `memoryContextPacket` con la query usata, gli hit e l'eventuale `skipped_reason` (`global_disabled`, `agent_disabled`, `missing_agent_id`, `empty_query`, `no_memories`, `retrieval_error`).

## afterMemory

File: `services/memory/afterMemory.js`.

Scopo: inviare a mem0 il turno appena concluso perche' ne estragga/aggiorni le memorie.

```txt
1. Gira solo se Memory Engine globale ON e Improve memories dell'agente ON.
2. Costruisce il turno come messaggi { role: user, content } + { role: assistant, content }.
3. Chiama mem0 add(messages, { agent_id, run_id? }).
4. mem0 esegue internamente estrazione, deduplica e aggiornamento delle memorie: Chrisbot non decide cosa salvare.
5. Non blocca la run dell'agente principale; errori vengono solo annotati.
```

`afterMemory` restituisce un esito con `written` e l'eventuale `skipped_reason` (`global_disabled`, `agent_disabled`, `missing_agent_id`, `empty_turn`, `add_error`).

## Struttura file

```txt
services/memory/
  beforeMemory.js         ricerca su mem0 e iniezione nel prompt
  afterMemory.js          invio del turno a mem0
  memoryContextPacket.js  costruzione/formato del pacchetto di contesto
  memoryOrchestrator.js   punto di ingresso che coordina before/after
  memoryRunTrace.js       tracciamento della run di memoria
  providers/
    mem0Provider.js       client HTTP verso mem0 (add, search, health)
```

Il client mem0 e' l'unico punto che conosce i dettagli HTTP: espone solo `add`, `search` e un `health` per il test connessione.

## Guardrail

- mem0 non e' obbligatorio: se non configurato o non raggiungibile la chat continua senza memoria.
- gli errori del Memory Engine non bloccano la risposta principale dell'agente.
- `beforeMemory` gira solo con `Use memories` ON; `afterMemory` solo con `Improve memories` ON; entrambi solo con Memory Engine globale ON.
- lo scope e' sempre l'agente (`agent_id`): un agente non legge/scrive memorie di un altro agente.
