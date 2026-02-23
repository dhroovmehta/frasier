-- 004_deep_work_pipeline.sql — Multi-phase task execution + approach memory
-- WHY: Agents were producing shallow, one-shot deliverables. The worker made exactly
-- 1 LLM call per step with no mandatory web research, no self-critique, and no
-- revision loop. This migration adds the tables needed for a deep work pipeline
-- (decompose → research → synthesize → critique → revise) and approach memory
-- ("what worked before" for similar tasks).
--
-- IMPORTANT: All new tables via CREATE TABLE only (no ALTER TABLE).
-- Supabase PostgREST schema cache bug (PGRST204) means column additions via ALTER TABLE
-- may not be visible for 10-60 minutes.

-- Pipeline phases: audit trail for every phase of every step execution
-- WHY: Full visibility into HOW agents produced each deliverable.
-- Each step generates 3-5 rows (decompose, research, synthesize, critique, revise).
CREATE TABLE IF NOT EXISTS pipeline_phases (
  id BIGSERIAL PRIMARY KEY,
  mission_step_id BIGINT NOT NULL REFERENCES mission_steps(id),
  phase_name TEXT NOT NULL,        -- decompose | research | synthesize | critique | revise
  phase_order INT NOT NULL,
  output_content TEXT,             -- full phase output
  model_tier TEXT,                 -- which tier was used (null for research phase)
  tokens_used INT DEFAULT 0,
  duration_ms INT DEFAULT 0,
  score DECIMAL(3,1),              -- critique phase: 1.0-5.0 overall score
  metadata JSONB DEFAULT '{}',     -- search queries, sub-questions, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_step ON pipeline_phases(mission_step_id, phase_order);
CREATE INDEX IF NOT EXISTS idx_pipeline_phase_name ON pipeline_phases(phase_name);

-- Approach memory: "what worked before" for similar tasks
-- WHY: When an agent decomposes a new task, knowing that "last time I researched
-- a market, these search queries produced good data" makes the decomposition
-- sharper from day one. Agents accumulate judgment, not just facts.
CREATE TABLE IF NOT EXISTS approach_memory (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mission_step_id BIGINT REFERENCES mission_steps(id),
  task_summary TEXT NOT NULL,          -- truncated task description
  topic_tags TEXT[] DEFAULT '{}',      -- for PostgreSQL array overlap matching
  decomposition JSONB,                 -- sub-questions identified
  search_queries TEXT[] DEFAULT '{}',  -- queries used
  effective_queries TEXT[] DEFAULT '{}', -- queries that actually produced useful data
  critique_score DECIMAL(3,1),         -- how well did the approach work (from self-critique)
  approach_notes TEXT,                 -- any special notes about the approach
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approach_agent ON approach_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_approach_tags ON approach_memory USING GIN(topic_tags);
CREATE INDEX IF NOT EXISTS idx_approach_score ON approach_memory(critique_score DESC);

-- Autonomy policy: configurable auto-approval rules
-- Uses existing policy table pattern — no new table needed
INSERT INTO policy (policy_type, name, rules)
SELECT 'autonomy', 'Step Auto-Approval', '{
  "auto_approve_threshold": 4.0,
  "qa_only_threshold": 3.0,
  "always_review_final": true,
  "always_review_tier3": true,
  "enabled": true
}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM policy WHERE policy_type = 'autonomy'
);

-- Enable RLS on new tables (matching existing pattern)
ALTER TABLE pipeline_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE approach_memory ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (matching existing pattern)
CREATE POLICY "service_role_pipeline_phases" ON pipeline_phases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_approach_memory" ON approach_memory
  FOR ALL TO service_role USING (true) WITH CHECK (true);
