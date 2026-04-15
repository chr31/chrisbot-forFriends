// scheduled/routine-handler.js

/**
 * Questo file agisce come un registro per tutte le routine eseguibili.
 * Carica dinamicamente i file di routine "just-in-time" per evitare dipendenze circolari.
 */

// Registro delle routine disponibili. Aggiungi qui una nuova voce dopo aver creato il file in scheduled/tasks/.
const routinesMap = Object.freeze({
});

/**
 * Esegue una routine basata sul suo nome, caricandola dinamicamente.
 * @param {string} routineName - Il nome della routine da eseguire (deve corrispondere a una chiave in routinesMap).
 */
async function executeRoutine(routineName) {
  const routinePath = routinesMap[routineName];

  if (routinePath) {
    try {
      // 2. Carichiamo il modulo SOLO quando serve, rompendo il ciclo di dipendenze all'avvio.
      const routineFunction = require(routinePath);
      
      if (typeof routineFunction === 'function') {
        console.log(`[RoutineHandler] Esecuzione routine: ${routineName}`);
        await routineFunction();
      } else {
        throw new Error(`Il file '${routinePath}' non esporta una funzione valida.`);
      }
    } catch (error) {
      console.error(`[RoutineHandler] Errore durante il caricamento o l'esecuzione della routine '${routineName}':`, error);
      throw error;
    }
  } else {
    const error = new Error(`Nessuna routine trovata con il nome '${routineName}'. Assicurati che sia mappata in routine-handler.js`);
    console.error(`[RoutineHandler] Attenzione: ${error.message}`);
    throw error;
  }
}

module.exports = { executeRoutine, routinesMap };
