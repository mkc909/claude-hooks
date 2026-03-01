CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log(trigger_session_id);
CREATE INDEX IF NOT EXISTS idx_action_rules_trigger ON action_rules(trigger_event, is_active);
CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status, path);
CREATE INDEX IF NOT EXISTS idx_project_status_session ON project_status(session_id);
