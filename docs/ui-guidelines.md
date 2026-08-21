# Linee guida UI

## Campi di testo e form

- I campi di testo devono essere disposti in modo simmetrico: usa griglie coerenti, allineamenti prevedibili e colonne bilanciate tra loro.
- Un campo deve occupare solo lo spazio necessario al tipo di contenuto atteso. Evita `w-full` come scelta automatica quando il valore e breve o strutturato.
- Usa larghezze massime esplicite per campi brevi e medi, per esempio username, slug, porta, URL, token corto, modello, ID, etichetta, numero o selezione.
- Riserva l'intera larghezza disponibile solo ai contenuti realmente lunghi: prompt, descrizioni, testo libero, JSON, log, liste multilinea o editor.
- Quando piu campi sono correlati, preferisci una griglia responsiva con colonne della stessa dimensione visiva invece di un singolo campo allungato a tutta pagina.
- Su mobile i campi possono andare a una colonna, ma devono mantenere padding, altezza e larghezza leggibili senza dare l'impressione di riempire spazio inutilmente.
