-- 005_linear_integration.sql
-- WHY: Track the mapping between Frasier missions/steps and Linear projects/issues.
-- Follows the same pattern as notion_sync and gdrive_sync (001_initial_schema.sql:303-329).

CREATE TABLE IF NOT EXISTS linear_sync (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,           -- 'project' | 'issue'
  entity_id TEXT NOT NULL,             -- Linear project/issue UUID
  entity_identifier TEXT,              -- Human-readable ID like "FRA-123"
  entity_url TEXT,                     -- Full Linear URL
  mission_id BIGINT REFERENCES missions(id),
  mission_step_id BIGINT REFERENCES mission_steps(id),
  sync_type TEXT NOT NULL,             -- 'mission_to_project' | 'step_to_issue' | 'inbound_issue'
  status TEXT DEFAULT 'synced',        -- 'synced' | 'error'
  error_message TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_linear_mission ON linear_sync(mission_id);
CREATE INDEX IF NOT EXISTS idx_linear_step ON linear_sync(mission_step_id);
CREATE INDEX IF NOT EXISTS idx_linear_entity ON linear_sync(entity_id);

-- RLS
ALTER TABLE linear_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_linear_sync" ON linear_sync
  FOR ALL TO service_role USING (true) WITH CHECK (true);
