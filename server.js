// server.js
require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const pushRoutes = require('./routes/pushRoutes');
const inboxRoutes = require('./routes/inboxRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const agentsRoutes = require('./routes/agentsRoutes');
const agentChatRoutes = require('./routes/agentChatRoutes');
const tasksRoutes = require('./routes/tasksRoutes');
const { initWebPushTables } = require('./database/db_web_push');
const { initAppSettingsTable } = require('./database/db_app_settings');
const { initTelegramTables } = require('./database/db_telegram');
const { initInboxTables } = require('./database/db_inbox');
const { initLegacyRoutineTables } = require('./database/db_legacy_routines');
const { initRoutineDefinitionsTable } = require('./database/db_routine_definitions');
const { initAgentsTables } = require('./database/db_agents');
const { initAgentChatsTables } = require('./database/db_agent_chats');
const { initAgentRunsTable } = require('./database/db_agent_runs');
const {
  initTasksTables,
  cleanupLegacyScheduledActionsTable,
  cleanupLegacyStructuredProcessesTables,
} = require('./database/db_tasks');
const { initializeTaskScheduler } = require('./scheduled/tasks');
const { initializeLegacyRoutineScheduler } = require('./services/legacyRoutineRunner');
const { initializeAppSettings } = require('./services/appSettings');
const { initializeWebPushScheduler } = require('./services/webPushScheduler');
const { initializeTelegramBot } = require('./services/telegramBot');


// Middleware per il parsing del body delle richieste
app.use(cors());
app.use(express.json());

// Rotte
app.use('/api/auth', authRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/agent-chats', agentChatRoutes);
app.use('/api/tasks', tasksRoutes);

async function bootstrap() {
  try {
    await initWebPushTables();
    await initAppSettingsTable();
    await initializeAppSettings();
    await initTelegramTables();
    await initInboxTables();
    await initLegacyRoutineTables();
    await initRoutineDefinitionsTable();
    await initAgentsTables();
    await initAgentChatsTables();
    await initAgentRunsTable();
    await initTasksTables();
    await cleanupLegacyScheduledActionsTable();
    await cleanupLegacyStructuredProcessesTables();
    await initializeTaskScheduler();
    await initializeLegacyRoutineScheduler();
    initializeWebPushScheduler();
    initializeTelegramBot();
    
    // Imposta una porta fissa per il backend
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Server backend in ascolto sulla porta ${PORT}`);
    });
  } catch (err) {
    console.error('Errore durante l\'inizializzazione del server:', err);
    process.exit(1);
  }
}

bootstrap();

module.exports = app;
