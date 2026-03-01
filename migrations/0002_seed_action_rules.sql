-- Seed default action rules for the action engine

-- Track all wrangler deploys in analytics
INSERT INTO action_rules (id, name, description, trigger_event, trigger_condition, action_type, action_config, cooldown_seconds) VALUES
(
  'ar_seed_01',
  'Track deploys',
  'Send deploy events to analytics dashboard when wrangler deploy is run',
  'PostToolUse',
  '{"tool_name":"Bash","input_contains":"wrangler deploy"}',
  'track_event',
  '{"event_name":"deploy","site_id":"claude-hooks"}',
  60
);

-- Track session ends in analytics
INSERT INTO action_rules (id, name, description, trigger_event, trigger_condition, action_type, action_config, cooldown_seconds) VALUES
(
  'ar_seed_02',
  'Track session end',
  'Send session end events to analytics dashboard',
  'SessionEnd',
  '{}',
  'track_event',
  '{"event_name":"session_end","site_id":"claude-hooks"}',
  0
);
