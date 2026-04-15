# Chrisbot

Laborarorio di agenti AI.
Applicazione Node.js/Express + Next.js con autenticazione locale/Azure, persistenza MySQL, scheduler task e integrazioni Ollama e OpenAI.

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

4. Al primo avvio verrà chiesto di creare un utente locale admin. 
    Successivamente sarà possibile configurare login con Azure e disattivare utenti locali.

## Impostazioni base
- Impostazioni/Modelli AI: configura una api key OpenAI o i server Ollama necessari(necessario avviare ollama e attivare dalle impostazioni "Expose ollama to the network").
- Impostazioni/Server MCP: aggiungi i tuoi server MCP per importare i tool da rendere disponibili agli agenti.
- Agenti: Crea worker o orchestratori in base alle esigenze, assegna permessi, toll MCP e collegali tra loro.

## Servizi esposti

- Backend: `http://127.0.0.1:3000`
- Frontend: `http://127.0.0.1:3001`
- MySQL: `127.0.0.1:3307`

## ENV
Se `MYSQL_HOST` e' lasciato a `mysql` o non impostato, Docker Compose usa il container MySQL incluso e crea automaticamente database e utente applicativo usando `MYSQL_DATABASE`, `MYSQL_USER` e `MYSQL_PASSWORD`.
Se invece imposti `MYSQL_HOST` verso un server esterno, backend e deploy useranno quel database.

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
- `CHRISBOT_DNS_1`, `CHRISBOT_DNS_2`: DNS opzionali per i container applicativi. Se non impostati, Docker Compose usa `8.8.8.8` e `8.8.4.4`.

## Env ancora lette dal progetto


Note sul `.env.example` root:

- `MYSQL_ROOT_PASSWORD` e `MYSQL_HOST_PORT` restano utili al solo `docker compose`, ma non vengono lette direttamente dal backend Node

## DNS dei container

I servizi `chrisbot` e `chrisbot-fe` possono usare DNS specifici tramite le variabili opzionali del file `.env`:

```env
CHRISBOT_DNS_1=10.0.123.2
CHRISBOT_DNS_2=10.0.123.3
```

Se queste variabili non sono impostate, Docker Compose usa automaticamente i DNS pubblici di fallback:

```text
8.8.8.8
8.8.4.4
```

Per applicare la modifica ai container gia' esistenti:

```bash
docker compose up -d --force-recreate chrisbot chrisbot-fe
```

Per verificare i DNS effettivamente usati dal container:

```bash
docker compose exec chrisbot cat /etc/resolv.conf
docker compose exec chrisbot getent hosts google.com
docker compose exec chrisbot getent hosts nomehost.interno
```


## Aggiungere routine legacy custom

Sono suppportate routine Node standalone. Per aggiungerne una:

1. crea un file in `scheduled/tasks/` che esporta una funzione async;
2. registra il nome in `scheduled/routine-handler.js`;
3. aggiungi il seed desiderato in `LEGACY_ROUTINE_DEFAULTS` dentro `database/db_legacy_routines.js`.
