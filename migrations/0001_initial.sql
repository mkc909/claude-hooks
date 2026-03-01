-- claude-hooks: Core schema
-- Sessions, tool events, policies, prompts, project status, actions, worktrees

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  device_id TEXT,
  hostname TEXT,
  cwd TEXT,
  project TEXT,
  permission_mode TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  end_reason TEXT,
  total_tool_calls INTEGER DEFAULT 0,
  total_tokens_est INTEGER DEFAULT 0,
  summary TEXT,
  metadata TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, started_at);
CREATE INDEX idx_sessions_project ON sessions(project, started_at);

CREATE TABLE tool_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  input_summary TEXT,
  output_summary TEXT,
  file_path TEXT,
  decision TEXT,
  decision_reason TEXT,
  policy_id TEXT,
  duration_ms INTEGER,
  success INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_tool_events_session ON tool_events(session_id, created_at);
CREATE INDEX idx_tool_events_tool ON tool_events(tool_name, created_at);
CREATE INDEX idx_tool_events_file ON tool_events(file_path);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  event_type TEXT NOT NULL,
  tool_matcher TEXT,
  condition_type TEXT NOT NULL,
  condition_config TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'deny',
  action_config TEXT,
  priority INTEGER DEFAULT 100,
  is_active INTEGER DEFAULT 1,
  tenant_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_policies_event ON policies(event_type, is_active);
CREATE INDEX idx_policies_tenant ON policies(tenant_id);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_text TEXT,
  prompt_length INTEGER,
  blocked INTEGER DEFAULT 0,
  block_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE project_status (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  files_modified TEXT,
  issues_referenced TEXT,
  commits TEXT,
  tests_passed INTEGER,
  tests_failed INTEGER,
  typecheck_errors INTEGER,
  deploy_status TEXT,
  extracted_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_project_status_project ON project_status(project, extracted_at);

CREATE TABLE action_log (
  id TEXT PRIMARY KEY,
  trigger_event TEXT NOT NULL,
  trigger_session_id TEXT,
  action_type TEXT NOT NULL,
  action_target TEXT,
  action_config TEXT,
  result TEXT,
  result_detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE action_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_event TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_config TEXT NOT NULL,
  cooldown_seconds INTEGER DEFAULT 300,
  is_active INTEGER DEFAULT 1,
  tenant_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT,
  branch TEXT,
  base_branch TEXT,
  path TEXT NOT NULL,
  project TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  removed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Seed: dangerous command block policies (migrated from block-dangerous-commands.js)
INSERT INTO policies (id, name, description, event_type, tool_matcher, condition_type, condition_config, action, action_config, priority) VALUES
  ('pol_seed_01', 'Block rm -rf /', 'Prevent recursive root deletion', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["rm\\s+-rf\\s+/"]}', 'deny', '{"reason":"Blocked: recursive root deletion"}', 10),
  ('pol_seed_02', 'Block rm -rf ~', 'Prevent home directory deletion', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["rm\\s+-rf\\s+~"]}', 'deny', '{"reason":"Blocked: home directory deletion"}', 10),
  ('pol_seed_03', 'Block rm -rf .', 'Prevent current directory deletion', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["rm\\s+-rf\\s+\\\\."]}', 'deny', '{"reason":"Blocked: current directory deletion"}', 10),
  ('pol_seed_04', 'Block force push to main', 'Prevent force push to main/master', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["git\\s+push\\s+--force.*main","git\\s+push\\s+--force.*master","git\\s+push\\s+-f.*main","git\\s+push\\s+-f.*master"]}', 'deny', '{"reason":"Blocked: force push to protected branch"}', 10),
  ('pol_seed_05', 'Block git reset --hard', 'Prevent hard reset', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["git\\s+reset\\s+--hard"]}', 'deny', '{"reason":"Blocked: git reset --hard can destroy uncommitted work"}', 10),
  ('pol_seed_06', 'Block DROP TABLE/DATABASE', 'Prevent SQL data destruction', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["DROP\\s+TABLE","DROP\\s+DATABASE"]}', 'deny', '{"reason":"Blocked: destructive SQL operation"}', 10),
  ('pol_seed_07', 'Block fork bomb', 'Prevent fork bomb execution', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":[":\\(\\)\\{\\s*:\\|:\\&\\s*\\}\\;:"]}', 'deny', '{"reason":"Blocked: fork bomb detected"}', 10),
  ('pol_seed_08', 'Block mkfs', 'Prevent filesystem format', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["mkfs\\\\."]}', 'deny', '{"reason":"Blocked: filesystem format command"}', 10),
  ('pol_seed_09', 'Block dd if=', 'Prevent raw disk write', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["dd\\s+if="]}', 'deny', '{"reason":"Blocked: raw disk write"}', 10),
  ('pol_seed_10', 'Block chmod 777', 'Prevent recursive permission change', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["chmod\\s+-R\\s+777"]}', 'deny', '{"reason":"Blocked: recursive chmod 777 is a security risk"}', 10),
  ('pol_seed_11', 'Block write to /dev/sda', 'Prevent disk overwrite', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":[">\\s*/dev/sda"]}', 'deny', '{"reason":"Blocked: write to block device"}', 10),
  ('pol_seed_12', 'Block shutdown/reboot', 'Prevent system shutdown', 'PreToolUse', 'Bash', 'block_pattern', '{"patterns":["shutdown","reboot"]}', 'deny', '{"reason":"Blocked: system shutdown/reboot command"}', 10);
