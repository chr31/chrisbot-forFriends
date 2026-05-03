# Funzioni

Panoramica sintetica delle aree principali del portale e di come collegare i servizi necessari.

## Autenticazione

Pagina: `Impostazioni`

Cosa permette:

- abilitare o disabilitare login locale
- creare credenziali admin locali
- configurare login Microsoft Entra ID / Azure AD
- definire gruppi e UPN autorizzati
- definire super admin, redirect URI e base URL del portale

Per collegare il servizio:

- per login locale basta creare l'admin al primo avvio oppure configurarlo da `Impostazioni`
- per Azure/Entra servono `tenant id`, `client id`, `client secret` e una redirect URI coerente con l'URL pubblico del backend

## Modelli IA

Pagina: `Impostazioni > Modelli AI`

Cosa permette:

- configurare una API key OpenAI
- scegliere il modello chat OpenAI
- configurare uno o più server Ollama
- definire modello di default, server di default e strategia di routing

Per collegare il servizio:

- OpenAI: inserisci la tua API key e il modello desiderato
- Ollama: registra uno o più endpoint raggiungibili dal backend, ad esempio `http://host:11434`

## Server Ollama

Pagina: `Impostazioni > Modelli AI`

Cosa permette:

- definire connessioni Ollama multiple
- assegnare priorità ai server
- scegliere `least_loaded` o `priority` come strategia
- mantenere una lista di modelli utilizzabili dagli agenti

Per collegare il servizio:

- avvia Ollama sul server desiderato
- assicurati che il backend possa raggiungerlo in rete
- se Ollama gira fuori dal container, esponilo alla rete e usa un `base_url` accessibile dal backend

## Memorie

Pagina: `Impostazioni > Memorie`

Cosa permette:

- abilitare o disabilitare il Memory Engine globale
- scegliere il modello dedicato all'analisi delle memorie
- selezionare il server Ollama quando il modello scelto e' locale
- configurare URL, username e password Neo4j
- verificare lo stato della connessione Neo4j

Per collegare il servizio:

- per Neo4j locale abilita il profilo `local-neo4j` in `COMPOSE_PROFILES`
- usa come URL interno predefinito `bolt://neo4j:7687`
- salva username e password dalla tab `Memorie`
- usa `Test connessione` per verificare che il backend possa raggiungere Neo4j

## Telegram

Pagina: `Impostazioni > Telegram`

Cosa permette:

- abilitare o disabilitare il bot
- impostare il `bot token`
- definire l'intervallo di polling
- associare utenti del portale a `telegram_user_id`
- configurare gruppi destinatari per notifiche broadcast

Per collegare il servizio:

- crea il bot con BotFather e incolla il token
- per i mapping utente usa il comando `whoami` dal bot per recuperare il `telegram_user_id`
- salva i mapping dal portale prima di attivare notifiche o chat Telegram

## Agents

Pagina: `Agenti`

Cosa permette:

- creare agenti worker e orchestrator
- definire descrizione, stato e canale di chat diretta
- assegnare permessi utenti, gruppi e UPN
- associare tool MCP agli agenti
- collegare orchestrator e worker tra loro

Per collegare il servizio:

- prima configura `Modelli AI` e `Server MCP`
- poi crea gli agenti e assegna i tool necessari
- abilita la chat diretta solo per gli agenti che devono essere accessibili dalla sidebar

## Tasks

Pagina: `Task`

Cosa permette:

- creare task schedulati o manuali
- scegliere esecutore e categoria
- definire cron, attivazione, notifiche e storico esecuzioni
- gestire anche le routine dinamiche create dal portale

Istruzioni applicative:

- per task eseguiti da agenti assicurati che l'agente abbia modello e tool già configurati
- le routine create dal portale vengono salvate fuori dalla repo e restano persistenti nei volumi Docker

## Inbox

Pagina: `Inbox`

Cosa permette:

- visualizzare notifiche operative e richieste asincrone
- leggere messaggi correlati a task, agenti e processi applicativi
- rispondere, risolvere o eliminare elementi
- usare il canale come action center per casi che non devono vivere solo in chat

Istruzioni applicative:

- alcune azioni del portale e dei task generano elementi inbox automaticamente
- se Telegram è configurato, parte delle notifiche può essere inoltrata anche ai destinatari associati

## Server MCP

Pagina: `Impostazioni > Server MCP`

Cosa permette:

- registrare endpoint MCP remoti
- definire prefisso nome tool
- configurare header custom
- abilitare o disabilitare singole connessioni

Per collegare il servizio:

- inserisci URL del server MCP
- aggiungi eventuali header richiesti dal server
- verifica poi da `Agenti` che i tool importati siano assegnabili agli agenti
