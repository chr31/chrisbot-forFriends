# Agent guardrails

I guardrail per agente servono a mantenere ogni agente nel proprio dominio operativo.

## Regole

- Se non ci sono `allowed_intents` o `blocked_intents`, la verifica semantica non viene applicata.
- I `blocked_intents` vincono sempre.
- Se sono presenti `allowed_intents`, passa solo cio' che combacia con almeno un intent consentito.
- Se sono presenti solo `blocked_intents`, tutto il resto passa.
- Se una richiesta viene bloccata, il prompt originale non viene passato all'agente principale.
- Le richieste bloccate non avviano `afterMemory`, quindi non generano memorie riutilizzabili di dominio.
- La verifica usa il provider embedding configurato nel Memory Engine. Se i guardrail semantici sono attivi ma gli embedding non sono disponibili, la richiesta viene bloccata in modo restrittivo.
- Gli embedding degli intent configurati vengono cacheati per evitare di ricalcolare la policy a ogni richiesta.
- Per richieste lunghe o ambigue viene usato un LLM piccolo cieco, che estrae intent, azioni, topic e segnali di injection senza conoscere allow/block list.

## Campi in guardrails_json

```json
{
  "semantic_guardrails_enabled": true,
  "allowed_intents": ["cercare informazioni su utenti aziendali"],
  "blocked_intents": ["scrivere codice Python"],
  "blocked_message": "Questo agente non si occupa di questo argomento.",
  "unclear_message": "Puoi chiarire se la richiesta riguarda il dominio di questo agente?",
  "unclear_action": "block",
  "match_threshold": 0.72
}
```

Gli intent devono descrivere capability naturali, non solo nomi tecnici. Per esempio, per Active Directory usare anche frasi come `cercare informazioni su utenti aziendali` o `verificare appartenenza a gruppi`.

La vecchia area JSON libera e' dismessa: i guardrail supportati devono essere campi espliciti.
