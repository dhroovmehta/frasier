-- 003_projects.sql — Project lifecycle tracking
-- WHY: Each message created an isolated mission. No cross-mission linking, no lifecycle phases.
-- This adds end-to-end project tracking with phase-based advancement.
--
-- IMPORTANT: All new tables via CREATE TABLE only (no ALTER TABLE).
-- Supabase PostgREST schema cache bug (PGRST204) means column additions via ALTER TABLE
-- may not be visible for 10-60 minutes.

-- Projects: top-level container linking multiple missions into a lifecycle
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'discovery',
  business_id TEXT REFERENCES businesses(id) DEFAULT 'nerv',
  created_by TEXT DEFAULT 'zero',
  original_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Project-Mission linking: which missions belong to which project phase
-- Using a linking table avoids ALTER TABLE on the existing missions table
CREATE TABLE IF NOT EXISTS project_missions (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  mission_id BIGINT NOT NULL REFERENCES missions(id),
  phase TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, mission_id)
);

-- Project context: accumulated knowledge from each phase
-- Deliverables, decisions, requirements, and notes carry forward
CREATE TABLE IF NOT EXISTS project_context (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  phase TEXT NOT NULL,
  context_type TEXT NOT NULL,  -- deliverable | decision | requirement | note
  content TEXT NOT NULL,
  source_mission_id BIGINT REFERENCES missions(id),
  source_step_id BIGINT REFERENCES mission_steps(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_project_missions_project ON project_missions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_missions_mission ON project_missions(mission_id);
CREATE INDEX IF NOT EXISTS idx_project_context_project ON project_context(project_id);
