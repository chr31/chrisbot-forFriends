# Agent Platform Roadmap

## Direzione

Chrisbot sta convergendo verso una piattaforma multi-agente con:

- chat dirette con agenti
- orchestrator e worker specializzati
- task schedulabili con run ed eventi
- inbox operativa per casi asincroni
- controllo accessi via utenti, gruppi e Microsoft Entra ID

La direzione rimane: consolidare questi domini e ridurre progressivamente il legacy, senza mantenere a lungo due modelli concorrenti.

## Architettura attuale

- `agents`: catalogo agenti, relazioni orchestrator/worker, permessi e tool binding
- `agent-chats`: conversazione primaria e run tree
- `tasks`: scheduler, runtime, cron, esecuzioni ed eventi
- `inbox`: canale operativo per notifiche strutturate, reply e conferme
- `auth`: login locale e Azure/Entra con gruppi e policy server-side

## Direzioni future

### 1. Orchestrazione esplicita

- decidere se avere un orchestrator principale di default
- rendere piu' esplicito il passaggio da chat a delega a task

### 2. Task come dominio operativo completo

- migliorare ownership, permessi e UX dei task
- ridurre dipendenze dalle routine legacy ancora presenti

### 3. Inbox come action center

- completare la sostituzione del modello `notifications` legacy
- chiarire il legame tra inbox item, conferme, reply e chat collegate

### 4. Access control

- valutare identity mapping persistente oltre ai claim del token
- chiarire la strategia definitiva per gruppi e assegnazioni

### 5. Legacy reduction

- rimuovere codice, documentazione e percorsi UI ormai residuali
- mantenere solo il legacy con valore operativo verificato

## Principi

- nuove capability nei domini `agents`, `tasks` o `inbox`
- permessi sempre enforced lato backend
- separazione tra esperienza utente e telemetria tecnica
- riduzione del legacy solo dopo verifica di parity
