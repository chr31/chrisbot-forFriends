# Chrisbot Memory Engine

Documento di progetto per la nuova gestione delle memorie strutturate di Chrisbot.

Questo documento definisce la direzione architetturale e i guardrail da seguire nelle implementazioni future. Il Memory Engine sostituisce completamente la vecchia memoria testuale semplice degli agenti.

## Obiettivo

Il Memory Engine permette agli agenti di recuperare, usare e aggiornare memorie utili durante le conversazioni.

L'obiettivo e' dare all'agente il contesto giusto al momento giusto, senza appesantire stabilmente il prompt e senza lasciare all'LLM il controllo diretto della memoria persistente.

Principio guida:

```txt
LLM = analizza, interpreta, propone struttura
Neo4j = fonte di verita' della memoria operativa
Memory Engine = valida, regola, salva, recupera e inietta contesto
```

## Superamento della memoria semplice

La memoria semplice attuale basata sul campo testuale `agents.memories` viene dismessa completamente.

Non e' prevista migrazione dei contenuti esistenti, perche' il campo non contiene informazioni discriminanti per l'utilizzo futuro.

Da rimuovere:

- colonna SQL `agents.memories`
- lettura/scrittura backend del campo `memories`
- campo frontend "Memories" nella pagina agenti
- tool interni `chrisbot_getMemories` e `chrisbot_editMemories`
- riferimenti testuali alla vecchia memoria manuale

I `goals` restano separati dalla memoria: sono obiettivi persistenti espliciti dell'agente, non memoria estratta automaticamente.

## Oggetti di memoria

Il primo modello concettuale del grafo usa questi oggetti.

```txt
Episode
Evento immutabile realmente accaduto.
Esempi: messaggio utente, risposta assistant, tool call, tool result, errore.

Entity
Concetto rilevante riconosciuto nel contesto.
Esempi: agente, progetto, tool, repository, servizio, procedura, asset.

Fact
Conoscenza riutilizzabile estratta dagli episodi.
Esempi: una decisione, un vincolo progettuale, una lezione operativa su un tool.

Link
Relazione tra oggetti.
Esempi: tool -> richiede -> parametro, agente -> lavora_su -> progetto.

Summary
Sintesi compatta di episodi, fatti o gruppi di relazioni, utile per il prompt.
```

## Campi database Memory Engine

Il processo reale del portale produce sempre due livelli distinti:

```txt
Run operativa
Audit di cosa e' stato chiesto, quale agente ha lavorato, quali tool/deleghe sono stati usati e con quale esito.

Memoria riutilizzabile
Informazione stabile o semi-stabile che puo' essere recuperata in una run futura.
```

Per questo il grafo non deve salvare solo "testi", ma anche il contesto operativo che li ha generati.

### MemoryRun

Nodo che rappresenta una `agent_runs` applicativa.

Campi:

```txt
id
agent_run_id
chat_id
agent_id
memory_agent_id
user_key
process_status
started_at
finished_at
created_at
updated_at
```

Semantica:

```txt
agent_id
Agente che ha eseguito la run.

memory_agent_id
Scope agente della memoria. Valorizzato solo per memorie dedicated; NULL per shared.

user_key
Utente/interlocutore della run, solo come audit del processo. Non partiziona la memoria e non entra nella chiave di retrieval.

process_status
completed | failed | partial | skipped | unknown
```

### MemoryEpisode

Evento immutabile realmente accaduto durante una run.

Campi:

```txt
id
scope
agent_id
memory_agent_id
user_key
chat_id
agent_run_id
run_key
episode_type
process_status
content
request_text
result_text
summary
metadata_json
occurred_at
created_at
```

Valori iniziali `episode_type`:

```txt
run_process
user_request
assistant_response
tool_call
tool_result
error
```

Regola:

```txt
Gli Episode non vengono deduplicati e non vengono modificati semanticamente.
Servono a ricostruire lo storico e a dare evidenza ai fatti estratti.
Lo storico resta sugli Episode/Run; i MemoryItem ricercabili devono rappresentare la versione corrente minima.
```

### MemoryItem

Nodo ricercabile e riutilizzabile nel retrieval.

Campi:

```txt
id
scope
agent_id
source_user_key
agent_label
memory_type
category
topic
subject_key
information
searchable_text
confidence
importance
embedding
embedding_model
embedding_provider
is_active
first_seen_at
last_seen_at
last_accessed_at
seen_count
access_count
created_at
updated_at
```

Semantica:

```txt
agent_id
Scope agente della memoria. NULL per shared, valorizzato per dedicated.

source_user_key
Utente/interlocutore da cui arriva l'informazione. Serve come contesto di provenienza, non come partizione della memoria.

agent_label
Agente che ha ricevuto o consolidato l'informazione.

topic
Argomento o identificatore stabile del soggetto della memoria.
Esempi: asset ID, repository, tool name, progetto, servizio.
Quando presente, la chiave canonica del MemoryItem usa tipo, scope, agente, categoria e topic: una nuova informazione sullo stesso soggetto aggiorna la versione corrente invece di creare storico duplicato.

subject_key
Chiave normalizzata dell'argomento operativo. Serve per collegare e aggiornare memorie sulla stessa rete semantica senza dipendere dalla forma testuale del topic.

information
Informazione minima e riutilizzabile da recuperare in futuro.

confidence
Quanto e' forte l'evidenza che la memoria sia vera.

importance
Quanto conviene recuperarla in futuro.

embedding
Vettore calcolato su searchable_text.
```

Valori iniziali `memory_type`:

```txt
fact
entity
procedure
decision
tool_lesson
summary
action_history
```

### MemoryTool

Nodo tool, collegato alle run che lo hanno usato.

Campi:

```txt
name
created_at
updated_at
```

Relazione:

```txt
(MemoryRun)-[:USED_TOOL {
  call_id,
  status,
  arguments_json,
  result_excerpt,
  created_at,
  updated_at
}]->(MemoryTool)
```

### MemoryRequest

Nodo sintetico della richiesta operativa.

Campi:

```txt
id
key
summary
request_text
scope
agent_id
first_seen_at
last_seen_at
seen_count
created_at
updated_at
```

Semantica:

```txt
summary
Riassunto prodotto dal modello chat memoria. Il prompt chiede massimo 10 parole, ma il backend non applica limiti di parole rigidi.

key
Forma normalizzata del summary, usata come anchor semantico.
```

### MemoryTopic

Nodo argomento operativo.

Campi:

```txt
id
key
name
category
scope
agent_id
first_seen_at
last_seen_at
seen_count
created_at
updated_at
```

Esempi:

```txt
assetmanager
active directory
asset tag
snipe-it
repository chrisbot
```

### MemoryStatus

Nodo stato operativo condiviso tra processo e tool.

Valori iniziali:

```txt
completed
failed
partial
skipped
unknown
```

### Relazioni principali

```txt
(MemoryEpisode)-[:PART_OF_RUN]->(MemoryRun)
(MemoryRun)-[:HANDLED_BY]->(MemoryAgent)
(MemoryRun)-[:USED_TOOL]->(MemoryTool)
(MemoryRun)-[:FOR_REQUEST]->(MemoryRequest)
(MemoryRun)-[:ABOUT]->(MemoryTopic)
(MemoryRun)-[:HAS_STATUS]->(MemoryStatus)
(MemoryRun)-[:TOOL_STATUS]->(MemoryStatus)
(MemoryRequest)-[:ABOUT]->(MemoryTopic)
(MemoryItem)-[:DERIVED_FROM]->(MemoryEpisode)
(MemoryItem)-[:NEEDED_FOR]->(MemoryRequest)
(MemoryItem)-[:NEEDED_FOR]->(MemoryTopic)
(MemoryItem)-[:NEEDED_FOR]->(MemoryTool)
(MemoryItem)-[:NEEDED_FOR]->(MemoryStatus)
(MemoryItem)-[:RELATED_TO]->(MemoryTopic)
(MemoryItem)-[:OBSERVED_IN]->(MemoryRun)
```

Questa struttura permette sia storico/audit, sia retrieval semantico, sia "sinapsi" tra run diverse tramite richiesta, argomento, tool, stato, topic e contenuto vettoriale.

Regola di compattezza:

```txt
afterMemory salva solo candidati operativi davvero riutilizzabili.
Se un candidato e' ridondante rispetto al MemoryItem corrente, non aggiorna il nodo.
Se un candidato e' piu' recente e contraddice lo stesso topic, sovrascrive il MemoryItem corrente.
La memoria infinita non conserva versioni storiche nei MemoryItem; lo storico tecnico resta solo negli Episode/Run di audit.
```

Nota di scope:

```txt
Il Memory Engine non partiziona le memorie per utente.
La memoria e' operativa dell'agente: contesto, procedure, decisioni, tool lesson e capacita apprese.
Se l'agente parla con piu persone, puo' riutilizzare cio' che ha imparato in una conversazione nelle run successive.
Non vengono salvate preferenze personali o profili utente salvo che diventino esplicitamente contesto operativo del dominio.
```

Categorie iniziali:

```txt
project_context
goal
tool_lesson
procedure
decision
error
conversation_summary
action_history
asset_context
service_context
```

Regole semantiche:

```txt
error
Evento negativo accaduto.

tool_lesson
Insegnamento stabile sull'uso di un tool.

procedure
Sequenza operativa riutilizzabile.

decision
Scelta progettuale approvata.

action_history
Cronologia sintetica di azioni recenti.
```

## Scope delle memorie

Ogni agente puo' scegliere separatamente se usare le memorie prima della risposta e se migliorarle dopo ogni run.

Quando il toggle agente `Use memories` e' attivo, beforeMemory viene applicata nella chat agente, a condizione che anche il Memory Engine globale sia attivo.

afterMemory viene applicata solo quando e' attivo il toggle agente `Improve memories`.

Il dropdown dell'agente non decide se eseguire le funzioni: decide solo su quale scope di memoria lavorano.

```txt
dedicated
Memorie dedicate all'agente.
Nel grafo hanno agent_id valorizzato.
Sono lette e scritte solo da quello specifico agente.

shared
Memorie condivise.
Nel grafo hanno agent_id NULL.
Sono lette e scritte da tutti gli agenti configurati per usare memoria condivisa.
```

Regola runtime:

```txt
Memory Engine globale OFF
-> nessuna funzione di memoria viene eseguita

Memory Engine globale ON + agente Use memories OFF + Improve memories OFF
-> nessuna funzione di memoria viene eseguita per quell'agente

Memory Engine globale ON + agente Use memories ON + dedicated
-> beforeMemory cerca memorie con agent_id = agente corrente
-> afterMemory salva memorie con agent_id = agente corrente solo se Improve memories e' ON

Memory Engine globale ON + agente Use memories ON + shared
-> beforeMemory cerca memorie con agent_id NULL
-> afterMemory salva memorie con agent_id NULL solo se Improve memories e' ON

Memory Engine globale ON + agente Use memories OFF + Improve memories ON
-> beforeMemory non viene eseguita
-> afterMemory salva memorie secondo il Tipo memoria configurato
```

## Configurazione globale

La configurazione globale vive in `app_settings`, coerentemente con OpenAI, Ollama, MCP e Telegram.

Il portale espone una tab dedicata:

```txt
Impostazioni > Memorie
```

Campi:

```txt
Memory Engine ON/OFF

Modello chat per memorie
- dropdown con i modelli disponibili nel portale
- puo' essere ChatGPT/OpenAI o locale/Ollama
- usato per analisi, sintesi, selezione, deduplica e proposta di aggiornamento memorie

Modello embedding per memorie
- dropdown dedicato ai modelli embedding disponibili nel portale
- puo' essere OpenAI o locale/Ollama
- usato per trasformare le query di recupero e i contenuti persistenti in vettori
- distinto dal modello chat per memorie e dal modello chat dell'agente

Server Ollama
- dropdown con i server Ollama gia' configurati
- visibile/richiesto quando il modello chat o il modello embedding scelto e' Ollama

Endpoint API embedding Ollama
- derivato dal server Ollama selezionato
- usa l'API Ollama embedding/embed configurata nel backend
- testabile dalla UI insieme al modello embedding selezionato

Neo4j URL
- default: bolt://neo4j:7687
- puo' puntare al container locale o a un database esterno
- se il backend gira fuori Docker Compose e Neo4j e' pubblicato sull'host locale, usare bolt://127.0.0.1:7687 o bolt://localhost:7687

Neo4j username

Neo4j password
- salvata cifrata come gli altri secret applicativi

Stato connessione
- connesso
- errore
- non configurato

Pulsante Test connessione
```

Il portale non avvia o spegne direttamente container Docker.

Il container Neo4j locale viene predisposto nel deploy e viene attivato tramite configurazione `.env` / profili Docker Compose. La UI decide se il Memory Engine e' abilitato e quali credenziali usare, non controlla il ciclo di vita Docker.

## Deploy Neo4j

Il `docker-compose.yml` deve includere un servizio Neo4j opzionale.

Comportamento previsto:

```txt
Memory Engine OFF
-> il backend non usa Neo4j
-> il container puo' anche essere presente, ma resta irrilevante per il runtime

Memory Engine ON + URL locale
-> il backend prova a collegarsi all'URL configurato, normalmente bolt://neo4j:7687

Memory Engine ON + URL esterno
-> il backend usa l'URL e le credenziali salvate nelle impostazioni
```

Variabili env indicative per il deploy locale:

```env
COMPOSE_PROFILES=local-mysql,local-neo4j
NEO4J_USER=neo4j
NEO4J_PASSWORD=change-me-neo4j
```

Questa e' la configurazione minima per avviare Neo4j locale insieme a MySQL locale.

Le porte sono opzionali perche' il compose ha default interni:

```env
NEO4J_HTTP_HOST_PORT=7474
NEO4J_BOLT_HOST_PORT=7687
```

ON/OFF del container locale:

```txt
ON
-> aggiungere local-neo4j a COMPOSE_PROFILES

OFF
-> rimuovere local-neo4j da COMPOSE_PROFILES
```

Le credenziali operative usate dal backend vengono comunque gestite dalla UI e salvate cifrate nel database applicativo.

## Configurazione agente

Nella pagina impostazioni agente viene aggiunta una sezione:

```txt
Memory Engine
```

Campi:

```txt
Use memories

Tipo memoria
- condivisa
- dedicata

Improve memories
```

Default:

```txt
Use memories OFF
Improve memories OFF
Tipo memoria: condivisa
```

Persistenza suggerita nel record agente:

```txt
memory_engine_enabled TINYINT(1) NOT NULL DEFAULT 0
improve_memories_enabled TINYINT(1) NOT NULL DEFAULT 0
memory_scope ENUM('shared', 'dedicated') NOT NULL DEFAULT 'shared'
```

## Flusso runtime

Il flusso chat agente deve integrare due funzioni principali.

```js
beforeMemory({ agent, chatId, messages, userMessage, modelConfig })
afterMemory({ agent, chatId, messages, assistantResponse, toolCalls, toolResults, modelConfig })
```

Le funzioni sono eseguite solo quando:

```txt
Memory Engine globale = ON
Use memories agente = ON per beforeMemory
Improve memories agente = ON per afterMemory
```

### beforeMemory

Scopo: preparare un pacchetto compatto di contesto da iniettare prima della risposta dell'agente.

Responsabilita':

```txt
1. Riceve il contesto recente della chat.
2. Usa il modello chat dedicato alle memorie per generare:
   - summary richiesta, richiesto nel prompt in massimo 10 parole
   - argomenti operativi stabili
   - retrieval query semantiche
3. Usa il modello embedding dedicato per trasformare summary, argomenti e query in vettori.
4. Recupera da Neo4j le memorie candidate coerenti con lo scope dell'agente, includendo match sulla rete MemoryRequest/MemoryTopic/MemoryTool.
5. Usa il modello chat per valutare e compattare le memorie rilevanti in un contextText richiesto nel prompt in massimo 50 parole.
6. Produce un memoryContextPacket.
7. Inietta il pacchetto nel prompt prima della chiamata modello dell'agente.
```

Output indicativo:

```json
{
  "facts": [],
  "entities": [],
  "procedures": [],
  "decisions": [],
  "tool_lessons": [],
  "recent_actions": [],
  "warnings": []
}
```

Il pacchetto deve essere compatto, leggibile e limitato alle informazioni utili per la richiesta corrente.

### afterMemory

Scopo: aggiornare il grafo dopo la risposta dell'agente.

Responsabilita':

```txt
1. Riceve messaggi, risposta assistant, tool calls e tool results.
2. Usa il modello chat dedicato alle memorie per proporre summary richiesta, topic e memorie operative minime.
3. Salva sempre gli Episode rilevanti come eventi immutabili.
4. Valida i candidati prodotti dal modello.
5. Scarta duplicati, output incerti o troppo generici.
6. Aggiorna MemoryItem tramite codice backend, sovrascrivendo la versione corrente quando trova una memoria correlata sullo stesso subject_key/topic.
7. Genera embedding per i contenuti ricercabili nuovi o aggiornati.
8. Collega la memoria aggiornata alla rete MemoryRequest/MemoryTopic/MemoryTool/MemoryStatus tramite relazioni NEEDED_FOR e correlate.
9. Invalida fatti superati solo con evidenza forte.
```

Il modello chat non deve scrivere direttamente su Neo4j.

Il modello produce JSON strutturato; il backend valida e applica le modifiche.

## Modello IA dedicato alle memorie

Il Memory Engine usa modelli dedicati configurati nelle impostazioni globali.

Questi modelli sono distinti dal modello scelto per la risposta dell'agente.

```txt
Modello chat per memorie
-> analizza il contesto
-> genera query semantiche naturali
-> filtra e compatta le memorie recuperate
-> propone nuovi Episode, Entity, Fact, Link e Summary

Modello embedding per memorie
-> trasforma le query semantiche in vettori
-> trasforma Fact, Entity, Summary e contenuti ricercabili in vettori persistenti
-> abilita ricerca semantica nel grafo/database
```

Uso previsto:

```txt
beforeMemory
-> analisi del contesto in ingresso
-> generazione di 2-3 retrieval query in linguaggio naturale
-> embedding delle query con il modello embedding dedicato
-> recupero memorie candidate tramite ricerca semantica
-> selezione/compattazione delle memorie tramite modello chat

afterMemory
-> analisi di cosa e' successo nella conversazione
-> proposta di Episode, Entity, Fact, Link, Summary
-> proposta di invalidazioni, mai applicate automaticamente senza validazione
-> embedding dei contenuti persistenti nuovi o aggiornati
```

Provider supportati:

```txt
OpenAI/ChatGPT
Ollama locale/remoto
```

Se il modello chat o embedding e' Ollama, viene usato il server Ollama selezionato nella tab Memorie.

Il backend deve quindi esporre anche la gestione API per gli embedding Ollama, separata dalla generazione chat:

```txt
Ollama chat
-> usata dal modello chat per memorie

Ollama embeddings
-> usata dal modello embedding per memorie
-> deve supportare test modello, error handling e timeout
-> deve restituire vettori normalizzati o comunque compatibili con la ricerca scelta
```

## Interfaccia backend

Il codice applicativo non deve dipendere direttamente dal driver Neo4j fuori dal repository della memoria.

Interfaccia minima:

```js
testConnection(config)

addEpisode(input)
addEntity(input)
addFact(input)
addLink(input)
updateSummary(input)
invalidateFact(input)

searchFacts(query)
searchEntities(query)
searchContext(query)
```

Struttura file coerente con il progetto:

```txt
services/memory/
  memoryOrchestrator.js
  beforeMemory.js
  afterMemory.js
  memoryAnalyzer.js
  memoryPromptBuilder.js
  memoryContextPacket.js

services/memory/repositories/
  memoryRepository.js
  neo4jMemoryRepository.js

services/memory/prompts/
  beforeMemory.prompt.js
  afterMemory.prompt.js
  compressMemory.prompt.js

database/
  db_memory_settings.js
```

Le impostazioni possono vivere in `app_settings`; `db_memory_settings.js` puo' essere solo un wrapper applicativo sopra `db_app_settings`.

## Iniezione nel prompt

Il contesto memoria deve essere aggiunto come blocco separato nel system prompt o immediatamente dopo il system prompt.

Formato indicativo:

```txt
Memory context:
<contenuto sintetico e rilevante>
```

Regole:

- non includere memorie non pertinenti
- non superare un budget compatto
- distinguere fatti stabili da azioni recenti
- non presentare ipotesi come fatti
- se non ci sono memorie utili, non iniettare blocchi vuoti
- ogni blocco iniettato deve essere riconducibile a candidate `selected_ids`
- se la compattazione via modello fallisce, il fallback deterministico deve usare solo candidati con score/confidenza/importanza sufficienti

## Guardrail

Regole non negoziabili:

- l'LLM non scrive mai direttamente sul grafo
- il backend valida ogni modifica proposta dal modello
- gli episodi sono immutabili
- le invalidazioni richiedono evidenza forte
- le memorie dedicate hanno sempre `agent_id` valorizzato
- le memorie condivise hanno sempre `agent_id` NULL
- se Neo4j non e' configurato o non e' raggiungibile, la chat agente deve poter continuare senza memoria
- errori del Memory Engine non devono bloccare la risposta principale dell'agente, salvo futura configurazione esplicita
- non reinserire una memoria testuale manuale equivalente a `agents.memories`

## Prima milestone implementativa

La prima milestone non deve risolvere tutta la modellazione del grafo.

Deve dimostrare che:

```txt
1. La vecchia memoria semplice e' rimossa.
2. Le impostazioni globali Memory Engine sono configurabili dalla UI.
3. Neo4j e' predisposto nel deploy e testabile dal backend.
4. Gli agenti hanno ON/OFF memoria e scope shared/dedicated.
5. beforeMemory e afterMemory sono agganciate al flusso chat, con afterMemory controllata da Improve memories.
6. Le funzioni usano i modelli dedicati alle memorie.
7. Il grafo viene scritto solo tramite repository validato.
8. La chat continua anche se il Memory Engine fallisce.
```

## Sequenza di lavoro

Roadmap approvata:

Step 1
Dismettere completamente la memoria semplice attuale in DB, backend, tool interni e frontend.

Step 2
Integrare nel deploy il container Neo4j locale opzionale.

Step 3
Inserire la tab Impostazioni > Memorie con modello chat, modello embedding, server Ollama condizionale, URL Neo4j, username, password e stato connessione.

Step 4
Inserire le impostazioni memoria nella pagina agente e predisporre beforeMemory/afterMemory nel flusso chat.

Step 5
Implementare la prima pipeline di recupero semantico dentro beforeMemory e predisporre gli embedding per afterMemory.

Obiettivo dello step:

```txt
Costruire il primo retrieval pack temporaneo da iniettare nel prompt, usando:
1. modello chat per sintetizzare il contesto in query semantiche naturali
2. modello embedding per trasformare le query
3. ricerca semantica delle memorie candidate
4. modello chat per filtrare e sintetizzare le memorie candidate
5. memoryContextPacket compatto restituito al flusso chat
```

Dettaglio beforeMemory:

```txt
1. Riceve il contesto corrente della conversazione.
2. Il modello chat produce summary richiesta, topic operativi e 2-3 retrieval query brevi in linguaggio naturale.
3. Summary, topic e query vengono trasformati in embedding tramite il modello embedding configurato.
4. Il repository cerca memorie candidate nello scope corretto con ricerca semantica, match lessicale e rete semantica su MemoryRequest/MemoryTopic/MemoryTool:
   - shared -> agent_id NULL
   - dedicated -> agent_id = agente corrente
5. I risultati vengono uniti, deduplicati e ordinati per:
   - similarita' semantica
   - match lessicale su identificatori o nomi operativi
   - collegamenti NEEDED_FOR/RELATED_TO verso richiesta, argomento o tool
   - importanza
   - confidenza
   - recency/last_accessed_at
6. Il modello chat riceve contesto sintetico + candidate memory e produce un retrieval pack compatto, richiesto in massimo 50 parole.
7. Se il modello di compattazione fallisce, il backend costruisce un pack deterministico solo da candidati forti.
8. beforeMemory restituisce un memoryContextPacket pronto per l'iniezione nel prompt.
```

Formato indicativo delle retrieval query:

```json
{
  "request_summary": "progettare retrieval Memory Engine",
  "topics": [
    { "name": "Memory Engine", "category": "project_context" }
  ],
  "queries": [
    "L'utente sta progettando l'architettura del Memory Engine con beforeMemory e afterMemory.",
    "Si sta discutendo come recuperare memorie rilevanti dal database usando embedding semantici.",
    "L'utente vuole distinguere il ruolo del modello chat dal ruolo del modello embedding nella gestione delle memorie."
  ]
}
```

Regola:

```txt
Le query per embedding devono essere frasi naturali sintetiche, non solo parole chiave.
I limiti di 10 parole per il summary e 50 parole per il contextText sono istruzioni di prompt, non vincoli rigidi di codice.
```

Dettaglio afterMemory in questa fase:

```txt
1. Continua a usare il modello chat per proporre summary richiesta, topic e nuove memorie strutturate.
2. Il backend scarta memorie personali, generiche, transitorie, goal e candidate sotto confidence 0.7; le categorie fuori tassonomia vengono normalizzate alla categoria operativa minima coerente.
3. Per ogni MemoryItem ricercabile validato dal backend, genera anche l'embedding.
4. Prima del salvataggio cerca memorie correlate nello stesso scope usando embedding, topic, subject_key e rete semantica.
5. Se trova una memoria corrente coerente con stesso tipo/categoria/topic o alta similarita' con overlap operativo, aggiorna quel MemoryItem invece di creare storico duplicato.
6. Salva contenuto, metadata ed embedding tramite repository validato.
7. Collega MemoryItem a MemoryRequest, MemoryTopic e MemoryTool con NEEDED_FOR, cosi il retrieval futuro puo' recuperare prerequisiti e tool lesson della stessa operazione.
8. Non applica ancora logiche avanzate di invalidazione salvo casi espliciti e ad alta confidenza.
```

Estensione impostazioni richiesta nello stesso step:

```txt
Impostazioni > Memorie
-> aggiungere selezione modello embedding
-> supportare modelli embedding Ollama
-> usare il server Ollama selezionato anche per le API embedding
-> aggiungere test configurazione embedding
-> salvare configurazione in app_settings insieme alle altre impostazioni memoria
```

Integrazione backend Ollama:

```txt
services/ollamaRuntime.js
-> aggiungere funzione dedicata per embedding
-> usare /api/embed o compatibilita' /api/embeddings in base alla versione Ollama target
-> gestire errori, timeout, modello mancante e risposta vettoriale non valida

services/memory/
-> usare il runtime embedding senza conoscere dettagli HTTP di Ollama
-> mantenere separata la responsabilita' tra chat analysis e vector embedding
```
