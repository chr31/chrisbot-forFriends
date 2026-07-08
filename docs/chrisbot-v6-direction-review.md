# Chrisbot v6 direction review

Questo documento fotografa la direzione v6 rispetto allo stato attuale del codice.

> Nota di aggiornamento: il Control Engine (grafo Neo4j, tool `ControlEngine_*`) e la dashboard grafo sono stati RIMOSSI dal codice, cosi' come l'integrazione LLM Wiki della Memory Engine. Il Memory Engine ora usa solo mem0. Le parti di questo documento che descrivono Control Engine, tool `ControlEngine_*` e LLM Wiki sono quindi superate e vanno lette come storiche/rimosse.

## Obiettivo v6

La versione 6 deve ridurre la dipendenza da molti agenti specializzati con system prompt e tool statici.

La direzione desiderata e':

```txt
un agente runtime
-> recupera memorie quando servono
-> esegue solo azioni risolte e governate
-> scrive audit/run trace separati dalla conoscenza stabile
```

Nota: la riga originale prevedeva anche "scopre capability operative dal Control Engine". Il Control Engine e' stato rimosso, quindi quella parte non e' piu' valida.

La versione 5 resta il baseline legacy: orchestrazione di agenti, prompt specifici, tool MCP assegnati staticamente.

## Stato attuale

Il progetto sta andando nella direzione corretta, ma e' ancora in una fase ibrida.

Allineamenti gia' presenti:

- il vecchio campo plain-text `agents.memories` e' dismesso dalle migration.
- gli agenti hanno toggle separati per `Use memories` e `Improve memories`.
- il Memory Engine usa mem0 per ricerca semantica (beforeMemory) ed estrazione/aggiornamento memorie (afterMemory).

Rimosso rispetto alla direzione originale:

- il Control Engine e il dominio `services/control/` sono stati rimossi (grafo Neo4j, location/device/action/capability/adapter, flag `enabled`/`execution_enabled`).
- i tool interni `ControlEngine_getGraph`, `ControlEngine_updateGraph` e i metodi correlati non esistono piu'.
- lo scope memorie `shared`/`dedicated` e il grafo Memory Engine (`MemoryRun`, `MemoryEpisode`, `MemoryItem`, `MemoryRequest`, `MemoryTopic`, `MemoryTool`, `MemoryStatus`) su Neo4j sono stati sostituiti da mem0.

Rischi/prototipi ancora aperti:

- `chrisbot-mcp` registra ancora un catalogo statico di tool dominio-specifici.
- `agent_tool_bindings` resta il meccanismo operativo di abilitazione tool per agente.
- `chrisbot-mcp-mac` e' potente e utile, ma deve restare adapter ad alto rischio con audit, permessi e conferme.

## Separazione inserimento/utilizzo

La separazione deve diventare un contratto esplicito.

### Flusso runtime

```txt
richiesta utente
-> guardrail semantici
-> beforeMemory (ricerca semantica su mem0)
-> agente runtime
-> afterMemory (invio turno a mem0)
-> audit run/episodi
```

Nota: i passi originali `retrieve control info` ed `execute action risolta` dipendevano dal Control Engine, ora rimosso.

### Flusso inserimento

```txt
admin, import o ingestion task
-> schema context
-> validazione
-> canonicalizzazione
-> alignment su id/alias/vicinato/embedding
-> upsert governato
-> query di verifica
```

L'inserimento aggiorna il Memory Engine, ma deve essere tracciabile e separato dalla normale run utente. (Il riferimento originale al Control Engine non e' piu' valido: il Control Engine e' stato rimosso.)

## Decisione architetturale

La direzione e' corretta se ogni nuova feature rispetta questi punti:

- conoscenza stabile nel Memory Engine, non nel system prompt;
- MCP come adapter/provider, non come router primario di conoscenza;
- run e tool result come audit, non come stato corrente.

Il punto originale su "capability eseguibile nel Control Engine" non e' piu' applicabile: il Control Engine e' stato rimosso.

## Prossimi step

1. Esplicitare due modalita': `runtime usage` e `admin/ingestion`, con route/service/permessi separati.
2. Aggiungere test mirati per:
   - Memory Engine globale off;
   - `Use memories` off;
   - `Improve memories` off.
3. Migrare progressivamente prompt e tool statici: prima inventario, poi parity test, poi rimozione dei casi coperti dalla memoria.

Sono stati RIMOSSI dai prossimi step, perche' relativi a componenti non piu' presenti nel codice:

- i tool runtime `ControlEngine_getGraph`/`ControlEngine_updateGraph` e le loro versioni "shaped" (`ControlEngine_retrieveInfo`, `ControlEngine_resolveAction`, `ControlEngine_executeAction`, `ControlEngine_getSchemaContext`);
- `updateControlGraph` e il raw Cypher del Control Engine;
- l'hardening del Memory Engine come consumer read-only di LLM Wiki e i relativi workflow di ingestion/lint;
- i test su project id LLM Wiki, credenziali inline Control Engine e mutazioni Control Engine.

## Skill Codex collegata

E' stata creata la skill locale `chrisbot-v6-guidelines` in:

```txt
/Users/christian.cusin/.codex/skills/chrisbot-v6-guidelines
```

Usarla per future review o implementazioni v6 che toccano Memory Engine, MCP, agent runtime e separazione tra inserimento e utilizzo.
