-- Schema MySQL per Chrisbot
-- Assicurati di usare utf8mb4 e MySQL 8+

CREATE DATABASE IF NOT EXISTS `chrisbot`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE `chrisbot`;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  description VARCHAR(255) NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(128) NOT NULL PRIMARY KEY,
  value_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inbox_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_username VARCHAR(255) NOT NULL,
  status ENUM('open', 'pending_user', 'pending_agent', 'resolved', 'dismissed') NOT NULL DEFAULT 'open',
  priority ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  title VARCHAR(255) NOT NULL,
  description LONGTEXT NULL,
  category VARCHAR(255) NULL,
  agent_id BIGINT UNSIGNED NULL,
  chat_id VARCHAR(255) NULL,
  agent_run_id BIGINT UNSIGNED NULL,
  task_id BIGINT UNSIGNED NULL,
  task_run_id BIGINT UNSIGNED NULL,
  requires_reply TINYINT(1) NOT NULL DEFAULT 0,
  requires_confirmation TINYINT(1) NOT NULL DEFAULT 0,
  confirmation_state ENUM('pending', 'approved', 'rejected') NULL,
  item_key VARCHAR(255) NULL,
  metadata_json JSON NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  last_message_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_inbox_item_key (item_key),
  INDEX idx_inbox_items_owner (owner_username, status, last_message_at),
  INDEX idx_inbox_items_task (task_id),
  INDEX idx_inbox_items_chat (chat_id),
  INDEX idx_inbox_items_agent (agent_id),
  INDEX idx_inbox_items_category (category),
  INDEX idx_inbox_items_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inbox_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inbox_item_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'agent', 'system') NOT NULL DEFAULT 'system',
  message_type ENUM('message', 'status_update', 'decision') NOT NULL DEFAULT 'message',
  agent_id BIGINT UNSIGNED NULL,
  username VARCHAR(255) NULL,
  content LONGTEXT NOT NULL,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_inbox_messages_item (inbox_item_id, created_at, id),
  INDEX idx_inbox_messages_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS legacy_routines (
  name VARCHAR(128) NOT NULL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  cron_expression VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  is_running TINYINT(1) NOT NULL DEFAULT 0,
  last_run_id BIGINT UNSIGNED NULL,
  last_started_at DATETIME(3) NULL,
  last_finished_at DATETIME(3) NULL,
  last_status VARCHAR(32) NULL,
  last_error TEXT NULL,
  last_triggered_by VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_legacy_routines_active (is_active),
  INDEX idx_legacy_routines_status (last_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS routine_definitions (
  name VARCHAR(128) NOT NULL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  entrypoint VARCHAR(512) NOT NULL,
  runtime VARCHAR(64) NOT NULL DEFAULT 'node20',
  template_id VARCHAR(128) NULL,
  checksum VARCHAR(128) NULL,
  config_json JSON NULL,
  permissions_json JSON NULL,
  sync_status VARCHAR(32) NOT NULL DEFAULT 'missing',
  last_sync_error TEXT NULL,
  version INT NOT NULL DEFAULT 1,
  created_by VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_routine_definitions_sync_status (sync_status),
  INDEX idx_routine_definitions_runtime (runtime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  kind ENUM('worker', 'orchestrator') NOT NULL DEFAULT 'worker',
  user_description TEXT NULL,
  allowed_group_names_csv TEXT NULL,
  system_prompt LONGTEXT NOT NULL,
  default_model_provider VARCHAR(32) NOT NULL DEFAULT 'ollama',
  default_model_name VARCHAR(128) NOT NULL DEFAULT 'qwen3.5',
  default_ollama_server_id VARCHAR(128) NULL,
  guardrails_json JSON NULL,
  visibility_scope ENUM('public', 'restricted', 'private') NOT NULL DEFAULT 'public',
  direct_chat_enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_alive TINYINT(1) NOT NULL DEFAULT 0,
  alive_loop_seconds INT NOT NULL DEFAULT 60,
  alive_prompt LONGTEXT NULL,
  alive_context_messages INT NOT NULL DEFAULT 12,
  alive_include_goals TINYINT(1) NOT NULL DEFAULT 0,
  goals LONGTEXT NULL,
  memories LONGTEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_agents_kind (kind),
  INDEX idx_agents_visibility (visibility_scope),
  INDEX idx_agents_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_tool_bindings (
  agent_id BIGINT UNSIGNED NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_id, tool_name),
  INDEX idx_agent_tool_bindings_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_relations (
  orchestrator_agent_id BIGINT UNSIGNED NOT NULL,
  worker_agent_id BIGINT UNSIGNED NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  routing_hint VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (orchestrator_agent_id, worker_agent_id),
  INDEX idx_agent_relations_orchestrator (orchestrator_agent_id),
  INDEX idx_agent_relations_worker (worker_agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_permissions (
  agent_id BIGINT UNSIGNED NOT NULL,
  subject_type VARCHAR(32) NOT NULL DEFAULT 'user',
  subject_id VARCHAR(255) NOT NULL,
  role ENUM('chat', 'manage') NOT NULL DEFAULT 'chat',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_id, subject_type, subject_id, role),
  INDEX idx_agent_permissions_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_chats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL UNIQUE,
  agent_id BIGINT UNSIGNED NOT NULL,
  owner_username VARCHAR(255) NULL,
  title VARCHAR(255) NULL,
  config_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_agent_chats_agent (agent_id),
  INDEX idx_agent_chats_owner (owner_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL,
  agent_id BIGINT UNSIGNED NULL,
  role VARCHAR(32) NOT NULL,
  event_type VARCHAR(32) NOT NULL DEFAULT 'message',
  content LONGTEXT NOT NULL,
  metadata_json JSON NULL,
  reasoning LONGTEXT NULL,
  total_tokens INT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_agent_messages_chat (chat_id, created_at, id),
  INDEX idx_agent_messages_agent (agent_id),
  INDEX idx_agent_messages_unread (chat_id, role, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL,
  agent_id BIGINT UNSIGNED NOT NULL,
  parent_run_id BIGINT UNSIGNED NULL,
  status ENUM('running', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'running',
  model_name VARCHAR(128) NOT NULL DEFAULT 'qwen3.5',
  model_provider VARCHAR(32) NOT NULL DEFAULT 'ollama',
  depth INT NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  last_error TEXT NULL,
  guardrail_result_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_agent_runs_chat (chat_id),
  INDEX idx_agent_runs_agent (agent_id),
  INDEX idx_agent_runs_status (status),
  INDEX idx_agent_runs_parent (parent_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS alive_agent_chats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL UNIQUE,
  agent_id BIGINT UNSIGNED NOT NULL UNIQUE,
  config_json JSON NULL,
  loop_status ENUM('play', 'pause') NOT NULL DEFAULT 'pause',
  is_processing TINYINT(1) NOT NULL DEFAULT 0,
  next_loop_at DATETIME(3) NULL,
  last_error TEXT NULL,
  last_started_at DATETIME(3) NULL,
  last_finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_alive_agent_chats_loop (loop_status, next_loop_at),
  INDEX idx_alive_agent_chats_processing (is_processing)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS alive_agent_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL,
  agent_id BIGINT UNSIGNED NULL,
  role VARCHAR(32) NOT NULL,
  event_type VARCHAR(32) NOT NULL DEFAULT 'message',
  content LONGTEXT NOT NULL,
  metadata_json JSON NULL,
  reasoning LONGTEXT NULL,
  total_tokens INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_alive_agent_messages_chat (chat_id, created_at, id),
  INDEX idx_alive_agent_messages_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS telegram_user_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject_type ENUM('user', 'upn') NOT NULL DEFAULT 'user',
  subject_id VARCHAR(255) NOT NULL,
  telegram_user_id VARCHAR(64) NOT NULL,
  receive_notifications TINYINT(1) NOT NULL DEFAULT 0,
  telegram_username VARCHAR(255) NULL,
  telegram_first_name VARCHAR(255) NULL,
  telegram_last_name VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_telegram_subject (subject_type, subject_id),
  UNIQUE KEY uniq_telegram_user_id (telegram_user_id),
  INDEX idx_telegram_subject_id (subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS telegram_group_targets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  telegram_chat_id VARCHAR(64) NOT NULL UNIQUE,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS telegram_chat_sessions (
  telegram_chat_id VARCHAR(64) NOT NULL PRIMARY KEY,
  telegram_user_id VARCHAR(64) NOT NULL,
  subject_type ENUM('user', 'upn') NOT NULL DEFAULT 'user',
  subject_id VARCHAR(255) NOT NULL,
  active_agent_chat_id VARCHAR(255) NULL,
  active_agent_id BIGINT UNSIGNED NULL,
  last_command VARCHAR(64) NULL,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_telegram_session_user (telegram_user_id),
  INDEX idx_telegram_session_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status ENUM('draft', 'pending', 'scheduled', 'running', 'needs_confirmation', 'blocked', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'draft',
  priority ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  schedule_json JSON NULL,
  owner_agent_id BIGINT UNSIGNED NULL,
  worker_agent_id BIGINT UNSIGNED NULL,
  payload_json JSON NULL,
  notification_type VARCHAR(255) NULL,
  notifications_enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  needs_confirmation TINYINT(1) NOT NULL DEFAULT 0,
  confirmation_request_json JSON NULL,
  legacy_source VARCHAR(64) NULL,
  legacy_source_id BIGINT UNSIGNED NULL,
  created_by VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_tasks_status (status),
  INDEX idx_tasks_priority (priority),
  INDEX idx_tasks_owner_agent (owner_agent_id),
  INDEX idx_tasks_worker_agent (worker_agent_id),
  INDEX idx_tasks_created_by (created_by),
  INDEX idx_tasks_legacy_source (legacy_source, legacy_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  agent_id BIGINT UNSIGNED NULL,
  status ENUM('queued', 'running', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
  trigger_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  last_error TEXT NULL,
  chat_id VARCHAR(255) NULL,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_task_runs_task (task_id),
  INDEX idx_task_runs_status (status),
  INDEX idx_task_runs_agent (agent_id),
  INDEX idx_task_runs_chat (chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  task_run_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_type VARCHAR(32) NULL,
  actor_id VARCHAR(255) NULL,
  content TEXT NULL,
  payload_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_task_events_task (task_id, created_at),
  INDEX idx_task_events_run (task_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_assignments (
  task_id BIGINT UNSIGNED NOT NULL,
  subject_type VARCHAR(32) NOT NULL DEFAULT 'user',
  subject_id VARCHAR(255) NOT NULL,
  role ENUM('owner', 'assignee', 'viewer') NOT NULL DEFAULT 'viewer',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_id, subject_type, subject_id, role),
  INDEX idx_task_assignments_subject (subject_type, subject_id),
  INDEX idx_task_assignments_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
