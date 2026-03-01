-- Migration 0003: Multi-tenant support for CloudClaw integration

-- Tenant API keys for authenticating tenant hook requests
CREATE TABLE tenant_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE UNIQUE INDEX idx_tenant_api_keys_key ON tenant_api_keys(api_key);
CREATE INDEX idx_tenant_api_keys_tenant ON tenant_api_keys(tenant_id, is_active);

-- Add tenant_id column to sessions for multi-tenant scoping
ALTER TABLE sessions ADD COLUMN tenant_id TEXT;
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id, started_at);

-- Add tenant_id column to tool_events for multi-tenant scoping
ALTER TABLE tool_events ADD COLUMN tenant_id TEXT;
CREATE INDEX idx_tool_events_tenant ON tool_events(tenant_id, created_at);

-- Add tenant_id column to prompts for multi-tenant scoping
ALTER TABLE prompts ADD COLUMN tenant_id TEXT;
