# Chrisbot

Applicazione Node.js/Express + Next.js con autenticazione locale/Azure, persistenza MySQL, scheduler task e integrazioni opzionali con OpenAI.

## Prerequisiti

- Docker
- Docker Compose

## Avvio rapido con Docker

1. Copia `.env.example` in `.env`.

```bash
cp .env.example .env
```

2. Inserisci almeno queste proprietà nel file `.env` per l'avvio base con `docker compose` e MySQL incluso:

```env
ACCESS_TOKEN_SECRET=replace-with-a-long-random-secret
MYSQL_ROOT_PASSWORD=change-root-password
MYSQL_USER=chrisbot
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=chrisbot
```

3. Esegui il container:

```bash
docker compose up --build
```

Se cambi variabili `NEXT_PUBLIC_*`, ricostruisci il frontend: Next.js le incorpora nel bundle in fase di build, quindi `docker compose up --build` e' necessario.
La configurazione Azure/Entra ID, l'abilitazione del login locale e le credenziali dell'admin locale si gestiscono dalla pagina `Impostazioni > Accesso Portale` e vengono salvate nel database applicativo.
La configurazione OpenAI e Ollama si gestisce dalla pagina `Impostazioni > Modelli AI`.
I segreti sensibili salvati nelle impostazioni, come password locale, `azure_client_secret` e `OpenAI API key`, vengono cifrati lato applicazione prima della persistenza su DB.
Se non e' configurato ne' Microsoft ne' un account locale, la pagina di login chiede di creare direttamente il primo account locale.

Servizi esposti:

- Backend: `http://127.0.0.1:3000`
- Frontend: `http://127.0.0.1:3001`
- MySQL: `127.0.0.1:3307`

Se `MYSQL_HOST` e' lasciato a `mysql` oppure non viene cambiato, Docker Compose usa il container MySQL incluso e crea automaticamente database e utente applicativo usando `MYSQL_DATABASE`, `MYSQL_USER` e `MYSQL_PASSWORD`.
Se invece imposti `MYSQL_HOST` verso un server esterno, backend e deploy useranno quel database. In questo caso il servizio MySQL del compose puo' anche rimanere definito ma non viene usato dal backend; nel deploy GitHub Actions non viene nemmeno avviato.
La porta host del container MySQL e' configurabile con `MYSQL_HOST_PORT`; il default `3307` evita conflitti con un MySQL locale gia' in ascolto su `3306`, quindi non e' obbligatorio valorizzarla.

## Variabili env minime obbligatorie

Per l'app principale in questa repository, le env davvero minime dipendono da come avvii il progetto:

- `docker compose` con MySQL incluso: `ACCESS_TOKEN_SECRET`, `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
- backend collegato a un MySQL esterno: `ACCESS_TOKEN_SECRET` piu' i parametri MySQL non coperti dai default effettivi (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`)

Default gia' gestiti dal codice:

- `PORT=3000`
- `TZ=Europe/Rome`
- `MYSQL_HOST=localhost` nel backend standalone, oppure `mysql` quando usi `docker compose`
- `MYSQL_PORT=3306`
- `MYSQL_CONNECTION_LIMIT=10`
- `MYSQL_TZ=Z`
- `BACKEND_URL` e `NEXT_PUBLIC_API_URL` non sono richieste nel compose standard, perche' il frontend punta gia' al backend interno

`ACCESS_TOKEN_SECRET` e' obbligatoria non solo per i JWT, ma anche per cifrare le impostazioni sensibili salvate nel database.

### Variabili env opzionali

- `BACKEND_URL`, `BACKEND_INSECURE_SKIP_TLS_VERIFY`, `BACKEND_CA_CERT`: proxy server-side del frontend verso il backend.
- `TASK_SCHEDULER_RECONCILE_MS`, `LOG_NOTIF_DELETE`, `TZ`: tuning runtime e diagnostica.
- `PUBLIC_BACKEND_URL`, `FRONTEND_BASE_URL`: servono solo per precompilare i default della configurazione portale/Azure.
- `WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`: richieste solo se vuoi attivare le Web Push.

## Env ancora lette dal progetto

App principale (`README.md` root):

- Core runtime: `ACCESS_TOKEN_SECRET`, `PORT`, `TZ`
- MySQL: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_CONNECTION_LIMIT`, `MYSQL_TZ`
- Frontend proxy / URL base: `BACKEND_URL`, `NEXT_PUBLIC_API_URL`, `BACKEND_INSECURE_SKIP_TLS_VERIFY`, `BACKEND_CA_CERT`, `PUBLIC_BACKEND_URL`, `FRONTEND_BASE_URL`
- Scheduler / debug: `TASK_SCHEDULER_RECONCILE_MS`, `LOG_NOTIF_DELETE`, `DEBUG`, `DEBUG_PROXY`
- Integrazioni opzionali: `MAKE_TOKEN`
- Web Push opzionale: `WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`

Modulo separato `chrisbot-mcp/`:

- Config bootstrap MCP e auth: `PORT`, `NODE_ENV`, `LOG_LEVEL`, `MCP_HOST`, `MCP_ALLOWED_HOSTS`, `MCP_PATH`, `MCP_BEARER_MODE`, `MCP_BEARER_TOKENS`, `MCP_JWT_SECRET`, `MCP_JWT_ISSUER`, `MCP_JWT_AUDIENCE`, `TOOL_PREFIX`
- DB condiviso: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT`
- Integrazioni opzionali: `MAKE_TOKEN`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `NOTION_DATABASE_ID_TICKET`, `NOTION_EVENTS_DATABASE_ID`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID`, `ZOHO_REGION`, `ZOHO_PROJECTS_PORTAL`, `ZOHO_LAST_TICKET_SCRIPT_URL`, `ZOHO_UPDATED_TICKETS_SCRIPT_URL`, `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_BASE_DN`, `CAMPUS_SCRIPT_URL`, `CAMPUS_SCRIPT_TOKEN`, `AV_DEVICES_SCRIPT_URL`, `AV_DEVICES_SCRIPT_TOKEN`, `TELNET_USER`, `TELNET_PASS`, `TELNET_IDLE_MS`, `TELNET_KEEPALIVE_MS`, `TELNET_RECONNECT_MAX_MS`, `TELNET_SEND_TIMEOUT_MS`, `TELNET_CONTACT_MODE`, `TELNET_PINNED`, `ASSETMANAGER_BASE_URL`, `ASSETMANAGER_API_TOKEN`, `ASSETMANAGER_TIMEOUT_MS`, `ASSETMANAGER_DEFAULT_MANUFACTURER_ID`, `ASSETMANAGER_MODALITA_FIELD_NAME`, `ASSETMANAGER_LABEL_BASE_URL`, `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, `HOME_ASSISTANT_AGENT_ID`

Note sul `.env.example` root:

- `MYSQL_ROOT_PASSWORD` e `MYSQL_HOST_PORT` restano utili al solo `docker compose`, ma non vengono lette direttamente dal backend Node

## Configurazione Modelli

- Per usare modelli Ollama devi accedere alle impostazioni e configurare almeno un server nella sezione `Impostazioni > Modelli AI`.
- Per usare modelli OpenAI devi configurare `API Key` e `Chat Model` nella stessa sezione.

## Note operative

- Il backend inizializza automaticamente le tabelle MySQL all'avvio.
- In Docker Compose il servizio MySQL viene inizializzato automaticamente e conserva i dati nel volume `chrisbot-mysql-data`.
- Il login Azure richiede una configurazione coerente di `backend_base_url`, `frontend_base_url` e `redirect_uri` nella sezione `Impostazioni > Accesso Portale`.
- In Docker Compose il frontend usa sempre il backend sul DNS interno `http://chrisbot:3000`, quindi non impostare `BACKEND_URL` verso un hostname esterno se non vuoi forzare quel comportamento.
- Alcune feature opzionali falliscono solo quando vengono invocate: il backend base puo' partire anche senza integrare OpenAI.

## Aggiungere routine legacy custom

Sono suppportate routine Node standalone. Per aggiungerne una:

1. crea un file in `scheduled/tasks/` che esporta una funzione async;
2. registra il nome in `scheduled/routine-handler.js`;
3. aggiungi il seed desiderato in `LEGACY_ROUTINE_DEFAULTS` dentro `database/db_legacy_routines.js`.
