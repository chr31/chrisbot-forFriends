# Agent Platform Backlog

## Stato attuale

Il repository ha gia' in produzione i domini principali:

- `agents` per catalogo, permessi, relazioni orchestrator/worker e chat dirette
- `agent-chats` per la conversazione primaria
- `tasks` per scheduler, runtime, cronologia esecuzioni ed eventi
- `inbox` per segnalazioni operative, richieste di input e conferme
- autenticazione locale e Microsoft Entra ID con gruppi e policy lato backend

## Backlog attivo

### 1. Orchestrazione

- [ ] definire se serve un orchestrator principale di default
- [ ] collegare gli orchestrator alla creazione/aggiornamento task in modo first-class
- [ ] chiarire quando una capability deve aprire chat diretta col worker invece di passare da delega

### 2. Tasks

- [ ] rifinire UX task list e task detail dove oggi la pagina e' ancora molto amministrativa
- [ ] rafforzare il modello permessi task oltre al solo contesto admin
- [ ] valutare rimozione progressiva delle routine legacy quando esiste parity funzionale

### 3. Inbox

- [ ] completare la sostituzione semantica della sezione `notifications` legacy
- [ ] chiarire le regole di continuita' tra inbox item, task e chat correlate

### 4. Access control

- [ ] decidere se introdurre una identity table interna multi-provider
- [ ] chiarire se il mapping gruppi deve restare solo su claim/token o essere sincronizzato localmente

### 5. Cleanup

- [ ] rimuovere documentazione e componenti residuali non piu' utili
- [ ] ridurre ulteriormente il perimetro legacy dopo verifica di parity

## Decisioni gia' prese

- La chat agente e' il canale primario.
- L'inbox serve per casi operativi e asincroni, non per duplicare la chat diretta.
- I permessi devono essere enforced lato backend.
- Nuove capability applicative devono nascere nei domini `agents`, `tasks` o `inbox`.
