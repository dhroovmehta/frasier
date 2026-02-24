-- 006_task_decomposition.sql — v0.9.0 Autonomous Team Execution
-- WHY: Enables Frasier to decompose complex requests into parallel/sequential
-- task graphs that agents execute autonomously. Adds message classification,
-- dependency DAG, decomposition plans, and escalation tracking.

-- ============================================================
-- MESSAGE CLASSIFICATIONS
-- WHY: Separates classification from Frasier's response. Each Discord message
-- gets classified as casual/simple_task/full_project, determining the routing
-- path (conversation vs proposal vs decomposition).
-- ============================================================

CREATE TABLE IF NOT EXISTS message_classifications (
  id BIGSERIAL PRIMARY KEY,
  discord_message_id TEXT,
  sender_id TEXT DEFAULT 'zero',
  raw_message TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('casual', 'simple_task', 'full_project')),
  confidence DECIMAL(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  reasoning TEXT,
  action_taken TEXT CHECK (action_taken IN ('response', 'proposal', 'decomposition')),
  proposal_id BIGINT REFERENCES mission_proposals(id),
  project_id BIGINT REFERENCES projects(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_classifications_discord_id
  ON message_classifications(discord_message_id);
CREATE INDEX IF NOT EXISTS idx_message_classifications_classification
  ON message_classifications(classification);

-- ============================================================
-- STEP DEPENDENCIES (DAG edges)
-- WHY: Replaces the linear step_order chain with a proper dependency graph.
-- Enables parallel execution: steps with no unsatisfied dependencies run
-- simultaneously, while dependent steps wait for predecessors.
-- ============================================================

CREATE TABLE IF NOT EXISTS step_dependencies (
  id BIGSERIAL PRIMARY KEY,
  step_id BIGINT NOT NULL REFERENCES mission_steps(id) ON DELETE CASCADE,
  depends_on_step_id BIGINT NOT NULL REFERENCES mission_steps(id) ON DELETE CASCADE,
  dependency_type TEXT DEFAULT 'blocks' CHECK (dependency_type IN ('blocks', 'informs')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(step_id, depends_on_step_id),
  CHECK (step_id != depends_on_step_id)  -- no self-dependencies
);

CREATE INDEX IF NOT EXISTS idx_step_dependencies_step_id
  ON step_dependencies(step_id);
CREATE INDEX IF NOT EXISTS idx_step_dependencies_depends_on
  ON step_dependencies(depends_on_step_id);

-- ============================================================
-- DECOMPOSITION PLANS
-- WHY: Records the full structured plan Frasier produces when decomposing
-- a project. Enables plan auditing, refinement tracking, and approach memory
-- for future decompositions of similar projects.
-- ============================================================

CREATE TABLE IF NOT EXISTS decomposition_plans (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id),
  mission_id BIGINT REFERENCES missions(id),
  plan_json JSONB NOT NULL,
  task_count INT,
  parallel_groups INT,
  estimated_phases INT,
  end_state TEXT CHECK (end_state IN ('production_docs', 'working_prototype', 'hybrid')),
  decomposed_by TEXT DEFAULT 'frasier',
  approach_memory_used BOOLEAN DEFAULT FALSE,
  refinement_count INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decomposition_plans_project_id
  ON decomposition_plans(project_id);
CREATE INDEX IF NOT EXISTS idx_decomposition_plans_mission_id
  ON decomposition_plans(mission_id);
CREATE INDEX IF NOT EXISTS idx_decomposition_plans_status
  ON decomposition_plans(status);

-- ============================================================
-- ESCALATION LOG
-- WHY: When Frasier encounters something that genuinely needs founder input
-- (budget decisions, brand-sensitive choices, capability gaps), it logs the
-- escalation here rather than silently proceeding or blocking forever.
-- ============================================================

CREATE TABLE IF NOT EXISTS escalation_log (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id),
  mission_id BIGINT REFERENCES missions(id),
  step_id BIGINT REFERENCES mission_steps(id),
  escalation_type TEXT NOT NULL CHECK (escalation_type IN ('budget', 'strategic', 'brand', 'capability_gap', 'ambiguity')),
  reason TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalation_log_project_id
  ON escalation_log(project_id);
CREATE INDEX IF NOT EXISTS idx_escalation_log_resolved
  ON escalation_log(resolved);

-- ============================================================
-- DECOMPOSITION POLICY (in existing ops_policy table)
-- WHY: Configurable limits for decomposition behavior — max tasks per project,
-- max parallel groups, escalation thresholds.
-- ============================================================

INSERT INTO policy (policy_type, name, rules)
VALUES (
  'decomposition',
  'Task decomposition engine configuration',
  '{
    "max_tasks_per_project": 12,
    "max_parallel_groups": 4,
    "max_refinement_rounds": 2,
    "escalation_threshold_budget": 100,
    "auto_hire_enabled": true,
    "expert_refinement_enabled": true
  }'::jsonb
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- RLS POLICIES (matching existing pattern)
-- ============================================================

ALTER TABLE message_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE decomposition_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_log ENABLE ROW LEVEL SECURITY;

-- Service role has full access (same pattern as all other tables)
CREATE POLICY "service_role_message_classifications" ON message_classifications
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_step_dependencies" ON step_dependencies
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_decomposition_plans" ON decomposition_plans
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_escalation_log" ON escalation_log
  FOR ALL USING (auth.role() = 'service_role');
