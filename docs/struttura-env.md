# Struttura env

Questa guida raccoglie le variabili ambiente usate dal progetto. Per il bootstrap locale parti da `.env.example`; molte impostazioni applicative vengono poi salvate dal portale nel database e non richiedono env dedicate.

## Minime obbligatorie

Con `docker compose` e MySQL incluso:

- `ACCESS_TOKEN_SECRET`: stringa lunga casuale. Obbligatoria per JWT e cifratura impostazioni sensibili.
- `COMPOSE_PROFILES`: impostare a `local-mysql` per avviare il container MySQL incluso.
- `MYSQL_ROOT_PASSWORD`: password dell'utente `root` del container MySQL.
- `MYSQL_USER`: utente applicativo MySQL. Default consigliato: `chrisbot`.
- `MYSQL_PASSWORD`: password dell'utente applicativo MySQL.
- `MYSQL_DATABASE`: nome database applicativo. Default consigliato: `chrisbot`.

Con MySQL esterno:

- `ACCESS_TOKEN_SECRET`
- `COMPOSE_PROFILES`: lasciare vuoto o non impostare, cosi' Docker Compose non crea il container MySQL incluso.
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`

## Core application

- `PORT`: porta del backend. Intero positivo. Default: `3000`.
- `TZ`: timezone del processo. Stringa IANA, ad esempio `Europe/Rome`. Default: `Europe/Rome`.
- `ACCESS_TOKEN_SECRET`: secret applicativo. Stringa non vuota.

## Frontend e proxy backend

- `NEXT_PUBLIC_API_URL`: URL API esposto al frontend quando non si usa il proxy standard. URL assoluto o vuoto.
- `BACKEND_URL`: URL del backend usato dal proxy server-side del frontend. URL assoluto o vuoto. In compose standard è `http://chrisbot:3000`.
- `BACKEND_INSECURE_SKIP_TLS_VERIFY`: abilita skip della verifica TLS verso `BACKEND_URL`. Valori accettati: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`. Default: `false`.
- `BACKEND_CA_CERT`: CA custom per il proxy backend. Testo PEM o percorso serializzato dalla tua pipeline.
- `PUBLIC_BACKEND_URL`: URL pubblico usato per precompilare i default delle impostazioni portale/Azure. Default: `http://127.0.0.1:${PORT}`.
- `FRONTEND_BASE_URL`: URL pubblico del frontend usato per i default applicativi. Default: `http://127.0.0.1:3001`.
- `NEXT_PUBLIC_LOCAL_LOGIN_ENABLED`: flag build-time del frontend Docker. Valori booleani come sopra. Usato come build arg/variabile compose.

## MySQL

- `MYSQL_HOST`: hostname MySQL. In compose: `mysql`. In backend standalone il codice fallback è `localhost`.
- `MYSQL_PORT`: porta MySQL. Intero positivo. Default: `3306`.
- `MYSQL_USER`: utente applicativo.
- `MYSQL_PASSWORD`: password utente applicativo.
- `MYSQL_DATABASE`: nome database applicativo.
- `MYSQL_CONNECTION_LIMIT`: limite connessioni del pool. Intero positivo. Default: `10`.
- `MYSQL_TZ`: timezone MySQL per il driver. Valori tipici: `Z`, `local`, offset SQL. Default: `Z`.

Variabili usate solo da Docker Compose:

- `COMPOSE_PROFILES`: profili Compose da attivare. Usa `local-mysql` quando vuoi il container MySQL incluso. Aggiungi `local-neo4j` quando vuoi avviare anche il container Neo4j locale del Memory Engine. Lascialo vuoto con database esterni.
- `MYSQL_ROOT_PASSWORD`: password root del container MySQL.
- `MYSQL_HOST_PORT`: porta host pubblicata per MySQL. Intero positivo. Default: `3307`.

## Neo4j locale per Memory Engine

Il container Neo4j locale e' opzionale e viene avviato solo se `COMPOSE_PROFILES` contiene `local-neo4j`.

Esempi:

- `COMPOSE_PROFILES=local-mysql`: avvia MySQL locale, non avvia Neo4j.
- `COMPOSE_PROFILES=local-mysql,local-neo4j`: avvia MySQL locale e Neo4j locale.
- `COMPOSE_PROFILES=local-neo4j`: usa MySQL esterno e avvia solo Neo4j locale.
- `COMPOSE_PROFILES=`: non avvia database locali.

Variabili:

- `NEO4J_USER`: username del container Neo4j locale. Default consigliato: `neo4j`.
- `NEO4J_PASSWORD`: password del container Neo4j locale. Deve essere non vuota. Default esempio: `change-me-neo4j`.
- `NEO4J_HTTP_HOST_PORT`: porta HTTP pubblicata sull'host per Neo4j Browser. Default: `7474`.
- `NEO4J_BOLT_HOST_PORT`: porta Bolt pubblicata sull'host. Default: `7687`.

Configurazione minima per avviare Neo4j locale insieme a MySQL locale:

```env
COMPOSE_PROFILES=local-mysql,local-neo4j
NEO4J_USER=neo4j
NEO4J_PASSWORD=change-me-neo4j
```

Le porte possono essere omesse: Docker Compose usa `7474` per HTTP e `7687` per Bolt.

Configurazione minima per avviare solo Neo4j locale usando un MySQL esterno:

```env
COMPOSE_PROFILES=local-neo4j
NEO4J_USER=neo4j
NEO4J_PASSWORD=change-me-neo4j
```

Nel network Docker interno il backend raggiunge Neo4j locale con:

- `bolt://neo4j:7687`

Il portale non avvia o spegne direttamente Docker: l'ON/OFF del container locale si gestisce con `COMPOSE_PROFILES`. La futura tab `Impostazioni > Memorie` gestira' invece l'abilitazione applicativa del Memory Engine, le credenziali operative e il test connessione.

## Scheduler e routine

- `TASK_SCHEDULER_RECONCILE_MS`: intervallo di riconciliazione scheduler task. Intero positivo. Default: `15000`.
- `ROUTINES_BASE_DIR`: directory sorgente delle routine dinamiche. In locale default `runtime/routines`, nei container `/app/runtime/routines`.
- `ROUTINE_EXEC_TIMEOUT_MS`: timeout massimo di esecuzione di una routine. Intero positivo in millisecondi. Default applicativo: `300000`.
- `LOG_NOTIF_DELETE`: flag diagnostico per log su delete notifiche. Valori booleani/`0`-`1`.

## Web Push

- `WEB_PUSH_VAPID_SUBJECT`: subject VAPID, tipicamente `mailto:...` o URL.
- `WEB_PUSH_VAPID_PUBLIC_KEY`: chiave pubblica VAPID.
- `WEB_PUSH_VAPID_PRIVATE_KEY`: chiave privata VAPID.

Sono richieste solo se abiliti le notifiche Web Push.

## Rete container

- `CHRISBOT_DNS_1`: DNS primario per `chrisbot` e `chrisbot-fe`. IP o vuoto.
- `CHRISBOT_DNS_2`: DNS secondario per `chrisbot` e `chrisbot-fe`. IP o vuoto.

Se omesse, Docker Compose usa:

- `8.8.8.8`
- `8.8.4.4`

## Debug e variabili tecniche

- `DEBUG`
- `DEBUG_PROXY`
- `NODE_TLS_REJECT_UNAUTHORIZED`

Non sono richieste per il funzionamento standard. Sono utili solo per debug o troubleshooting in ambienti specifici.

## Dove si configurano le integrazioni applicative

Queste integrazioni non dipendono da env dedicate nel bootstrap standard: si configurano dal portale e vengono salvate nel database cifrate quando serve.

- Autenticazione locale/Azure
- OpenAI
- Server Ollama
- Server MCP
- Telegram

## Note pratiche

- `.env.example` contiene solo il set minimo per il bootstrap locale.
- In produzione i workflow GitHub Actions scrivono `.env` a runtime dai secret del runner.
- Le routine create dal portale non devono stare nella repo: in Docker vengono salvate in un volume persistente dedicato.
