-- ============================================================
-- Frasier — Complete Database Schema v2.1
-- Created: Feb 11, 2026
-- IMPORTANT: Create ALL tables and columns upfront.
-- Adding columns later risks Supabase PGRST204 cache bug.
-- ============================================================

-- ============================================================
-- CORE TABLES
-- ============================================================

-- Teams: 3 business teams + ability to add more
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'dormant',  -- active | dormant
  lead_agent_id TEXT,  -- FK set after agents table exists
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agents: all agent profiles (Frasier, leads, sub-agents)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,  -- anime character name
  role TEXT NOT NULL,
  title TEXT,
  team_id TEXT REFERENCES teams(id),
  agent_type TEXT NOT NULL DEFAULT 'sub_agent',  -- chief_of_staff | team_lead | sub_agent | qa
  status TEXT NOT NULL DEFAULT 'active',  -- active | dormant | retired
  persona_id BIGINT,  -- FK to agent_personas
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);

-- Add FK from teams to agents now that agents table exists
ALTER TABLE teams ADD CONSTRAINT fk_teams_lead FOREIGN KEY (lead_agent_id) REFERENCES agents(id);

-- Agent Personas: full SEP prompt storage (static identity)
CREATE TABLE agent_personas (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  agent_md TEXT,       -- who the agent is (name, role, archetype)
  soul_md TEXT,        -- core personality, values, communication style
  skills_md TEXT,      -- domain expertise, methodologies, mental models
  identity_md TEXT,    -- credentials, background, experience
  full_sep_prompt TEXT, -- the complete system prompt sent to LLM
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add FK from agents to agent_personas
ALTER TABLE agents ADD CONSTRAINT fk_agents_persona FOREIGN KEY (persona_id) REFERENCES agent_personas(id);

-- Name Pool: anime character names available for assignment
CREATE TABLE name_pool (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,  -- cowboy_bebop | evangelion | gundam_wing
  assigned BOOLEAN DEFAULT FALSE,
  assigned_to_agent_id TEXT REFERENCES agents(id),
  assigned_at TIMESTAMPTZ
);

-- ============================================================
-- MISSION TABLES
-- ============================================================

-- Mission Proposals: queue for new missions from Zero
CREATE TABLE mission_proposals (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  proposing_agent_id TEXT NOT NULL DEFAULT 'zero',  -- 'zero' for founder
  title TEXT NOT NULL,
  description TEXT,
  raw_message TEXT,  -- original Discord message
  discord_message_id TEXT,  -- Discord message ID for reference
  assigned_team_id TEXT REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected | assigned
  priority TEXT DEFAULT 'normal',  -- low | normal | high | urgent
  announced BOOLEAN DEFAULT FALSE,
  processed BOOLEAN DEFAULT FALSE
);

-- Missions: active work derived from proposals
CREATE TABLE missions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  proposal_id BIGINT REFERENCES mission_proposals(id),
  team_id TEXT REFERENCES teams(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | failed | paused
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mission Steps: individual tasks assigned to agents
CREATE TABLE mission_steps (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  mission_id BIGINT REFERENCES missions(id),
  description TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES agents(id),
  model_tier TEXT DEFAULT 'tier1',  -- tier1 (MiniMax) | tier2 (Manus) | tier3 (Claude)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | completed | failed | in_review
  result TEXT,
  result_format TEXT DEFAULT 'text',  -- text | markdown | json | code
  step_order INT DEFAULT 0,
  parent_step_id BIGINT REFERENCES mission_steps(id),  -- for sub-tasks
  announced BOOLEAN DEFAULT FALSE,
  processed BOOLEAN DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- APPROVAL CHAIN TABLES
-- ============================================================

-- Approval Chain: tracks QA → Lead review per deliverable
CREATE TABLE approval_chain (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  mission_step_id BIGINT REFERENCES mission_steps(id),
  reviewer_agent_id TEXT REFERENCES agents(id),
  review_type TEXT NOT NULL,  -- qa | team_lead
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  feedback TEXT,
  revision_number INT DEFAULT 1,
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MEMORY TABLES (THE #1 REQUIREMENT — NEVER DELETE ROWS)
-- ============================================================

-- Agent Memories: cumulative memory entries per agent
CREATE TABLE agent_memories (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  memory_type TEXT NOT NULL,  -- conversation | decision | task | lesson | relationship | observation
  content TEXT NOT NULL,
  summary TEXT,  -- brief summary for quick retrieval
  topic_tags TEXT[] DEFAULT '{}',  -- array of topic tags for retrieval
  importance INT DEFAULT 5,  -- 1-10 scale, higher = more important
  source_type TEXT,  -- mission | conversation | review | standup | autonomous
  source_id TEXT,  -- reference to source (mission_id, conversation_id, etc.)
  related_agent_ids TEXT[] DEFAULT '{}',  -- other agents involved
  metadata JSONB DEFAULT '{}'  -- flexible extra data
);

-- Create indexes for memory retrieval performance
CREATE INDEX idx_memories_agent_id ON agent_memories(agent_id);
CREATE INDEX idx_memories_created_at ON agent_memories(created_at DESC);
CREATE INDEX idx_memories_topic_tags ON agent_memories USING GIN(topic_tags);
CREATE INDEX idx_memories_importance ON agent_memories(agent_id, importance DESC);
CREATE INDEX idx_memories_type ON agent_memories(agent_id, memory_type);

-- Conversation History: every message between any parties
CREATE TABLE conversation_history (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  conversation_id TEXT NOT NULL,  -- groups messages in same conversation
  conversation_type TEXT NOT NULL,  -- work_review | qa_feedback | standup | directive | personal_assistant
  sender_agent_id TEXT NOT NULL,  -- agent ID or 'zero' for founder
  recipient_agent_id TEXT,  -- NULL for broadcast
  team_id TEXT REFERENCES teams(id),
  content TEXT NOT NULL,
  context TEXT,  -- what this message is about
  mission_step_id BIGINT REFERENCES mission_steps(id),  -- if related to a task
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_conversations_conv_id ON conversation_history(conversation_id);
CREATE INDEX idx_conversations_sender ON conversation_history(sender_agent_id, created_at DESC);
CREATE INDEX idx_conversations_team ON conversation_history(team_id, created_at DESC);

-- Lessons Learned: extracted insights from past work
CREATE TABLE lessons_learned (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lesson TEXT NOT NULL,
  context TEXT,  -- what happened that led to this lesson
  category TEXT,  -- quality | process | technical | communication | strategy
  importance INT DEFAULT 5,  -- 1-10, higher = more important
  applied_count INT DEFAULT 0,  -- how many times this lesson was referenced
  source_mission_id BIGINT REFERENCES missions(id),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_lessons_agent ON lessons_learned(agent_id, importance DESC);

-- Decisions Log: every decision made by every agent
CREATE TABLE decisions_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  decision TEXT NOT NULL,
  reasoning TEXT,
  alternatives_considered TEXT,
  outcome TEXT,  -- filled in later when outcome is known
  mission_id BIGINT REFERENCES missions(id),
  team_id TEXT REFERENCES teams(id),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_decisions_agent ON decisions_log(agent_id, created_at DESC);

-- ============================================================
-- SYSTEM TABLES
-- ============================================================

-- Events: every system event logged
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,  -- mission_created | task_completed | agent_hired | error | health_check | backup | etc.
  agent_id TEXT,
  team_id TEXT,
  severity TEXT DEFAULT 'info',  -- debug | info | warning | error | critical
  description TEXT,
  data JSONB DEFAULT '{}',
  processed BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_events_type ON events(event_type, created_at DESC);
CREATE INDEX idx_events_severity ON events(severity, created_at DESC);

-- Policy: governance rules
CREATE TABLE policy (
  id BIGSERIAL PRIMARY KEY,
  policy_type TEXT NOT NULL,  -- spending_limit | approval_threshold | routing_rule | operating_hours
  name TEXT NOT NULL,
  rules JSONB NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Model Usage: LLM cost tracking
CREATE TABLE model_usage (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  agent_id TEXT REFERENCES agents(id),
  mission_step_id BIGINT REFERENCES mission_steps(id),
  model_name TEXT NOT NULL,  -- minimax | manus | claude-opus-4.5
  model_tier TEXT NOT NULL,  -- tier1 | tier2 | tier3
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  estimated_cost_usd DECIMAL(10,6) DEFAULT 0,
  response_time_ms INT,
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_model_usage_date ON model_usage(created_at DESC);
CREATE INDEX idx_model_usage_agent ON model_usage(agent_id, created_at DESC);

-- Health Checks: system health monitoring
CREATE TABLE health_checks (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  check_type TEXT NOT NULL,  -- db_connection | api_keys | memory_write | integration | daily_rollup
  component TEXT NOT NULL,  -- supabase | discord | notion | gdrive | github | openrouter | manus
  status TEXT NOT NULL,  -- pass | fail | warning
  response_time_ms INT,
  details TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_health_checks_type ON health_checks(check_type, created_at DESC);

-- Agent Skills: skill registry per agent
CREATE TABLE agent_skills (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  skill_name TEXT NOT NULL,
  proficiency INT DEFAULT 1,  -- 1-10
  usage_count INT DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, skill_name)
);

CREATE INDEX idx_skills_agent ON agent_skills(agent_id);

-- ============================================================
-- INTEGRATION TABLES
-- ============================================================

-- Notion Sync: tracks publications to Notion
CREATE TABLE notion_sync (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  mission_step_id BIGINT REFERENCES mission_steps(id),
  team_id TEXT REFERENCES teams(id),
  notion_page_id TEXT,
  notion_page_url TEXT,
  sync_type TEXT NOT NULL,  -- deliverable | standup | task_board
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  error_message TEXT,
  synced_at TIMESTAMPTZ
);

-- Google Drive Sync: tracks publications to Drive
CREATE TABLE gdrive_sync (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  mission_step_id BIGINT REFERENCES mission_steps(id),
  team_id TEXT REFERENCES teams(id),
  gdrive_file_id TEXT,
  gdrive_file_url TEXT,
  sync_type TEXT NOT NULL,  -- deliverable | standup | backup
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  error_message TEXT,
  synced_at TIMESTAMPTZ
);

-- GitHub Sync: tracks code/state pushes
CREATE TABLE github_sync (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sync_type TEXT NOT NULL,  -- code | agent_state | documentation
  commit_sha TEXT,
  commit_message TEXT,
  files_changed TEXT[],
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  error_message TEXT,
  synced_at TIMESTAMPTZ
);

-- Social Accounts: brand social media accounts
CREATE TABLE social_accounts (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  team_id TEXT REFERENCES teams(id),
  platform TEXT NOT NULL,  -- twitter | instagram | linkedin | tiktok | youtube
  account_name TEXT,
  account_url TEXT,
  managed_by_agent_id TEXT REFERENCES agents(id),
  posting_method TEXT DEFAULT 'buffer',  -- buffer | manual | api
  status TEXT DEFAULT 'active',  -- active | paused
  metadata JSONB DEFAULT '{}'
);

-- Backups: daily backup tracking
CREATE TABLE backups (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  backup_type TEXT NOT NULL DEFAULT 'daily',  -- daily | manual
  gdrive_file_id TEXT,
  gdrive_file_url TEXT,
  file_size_bytes BIGINT,
  tables_backed_up TEXT[],
  row_counts JSONB DEFAULT '{}',  -- { "agent_memories": 1234, ... }
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  error_message TEXT,
  completed_at TIMESTAMPTZ
);

-- ============================================================
-- ROW LEVEL SECURITY (permissive for server-side access)
-- ============================================================

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE name_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lessons_learned ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE notion_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE gdrive_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;

-- Allow all operations for service_role (server-side only)
CREATE POLICY "service_role_all" ON teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON agent_personas FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON name_pool FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON mission_proposals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON missions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON mission_steps FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON approval_chain FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON agent_memories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON conversation_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON lessons_learned FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON decisions_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON policy FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON model_usage FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON health_checks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON agent_skills FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON notion_sync FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON gdrive_sync FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON github_sync FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON social_accounts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON backups FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- SEED DATA: Name Pool
-- ============================================================

-- Cowboy Bebop
INSERT INTO name_pool (name, source) VALUES
  ('Jet', 'cowboy_bebop'),
  ('Edward', 'cowboy_bebop'),
  ('Faye', 'cowboy_bebop'),
  ('Spike', 'cowboy_bebop'),
  ('Ein', 'cowboy_bebop'),
  ('Vicious', 'cowboy_bebop'),
  ('Julia', 'cowboy_bebop'),
  ('Gren', 'cowboy_bebop'),
  ('Punch', 'cowboy_bebop'),
  ('Judy', 'cowboy_bebop'),
  ('Annie', 'cowboy_bebop'),
  ('Lin', 'cowboy_bebop'),
  ('Shin', 'cowboy_bebop');

-- Neon Genesis Evangelion
INSERT INTO name_pool (name, source) VALUES
  ('Shinji', 'evangelion'),
  ('Asuka', 'evangelion'),
  ('Rei', 'evangelion'),
  ('Misato', 'evangelion'),
  ('Gendo', 'evangelion'),
  ('Ritsuko', 'evangelion'),
  ('Kaji', 'evangelion'),
  ('Kaworu', 'evangelion'),
  ('Toji', 'evangelion'),
  ('Kensuke', 'evangelion'),
  ('Hikari', 'evangelion'),
  ('Maya', 'evangelion'),
  ('Hyuga', 'evangelion'),
  ('Aoba', 'evangelion'),
  ('Fuyutsuki', 'evangelion'),
  ('Sachiel', 'evangelion'),
  ('Shamshel', 'evangelion'),
  ('Ramiel', 'evangelion'),
  ('Gaghiel', 'evangelion'),
  ('Israfel', 'evangelion'),
  ('Sandalphon', 'evangelion'),
  ('Matarael', 'evangelion'),
  ('Sahaquiel', 'evangelion'),
  ('Ireul', 'evangelion'),
  ('Leliel', 'evangelion'),
  ('Bardiel', 'evangelion'),
  ('Zeruel', 'evangelion'),
  ('Arael', 'evangelion'),
  ('Armisael', 'evangelion'),
  ('Tabris', 'evangelion'),
  ('Lilith', 'evangelion');

-- Gundam Wing
INSERT INTO name_pool (name, source) VALUES
  ('Heero', 'gundam_wing'),
  ('Duo', 'gundam_wing'),
  ('Trowa', 'gundam_wing'),
  ('Quatre', 'gundam_wing'),
  ('Wufei', 'gundam_wing'),
  ('Zechs', 'gundam_wing'),
  ('Treize', 'gundam_wing'),
  ('Noin', 'gundam_wing'),
  ('Relena', 'gundam_wing'),
  ('Hilde', 'gundam_wing'),
  ('Sally', 'gundam_wing'),
  ('Dorothy', 'gundam_wing'),
  ('Catherine', 'gundam_wing'),
  ('Howard', 'gundam_wing'),
  ('Otto', 'gundam_wing');

-- ============================================================
-- SEED DATA: Default Policies
-- ============================================================

INSERT INTO policy (policy_type, name, rules) VALUES
  ('spending_limit', 'Zero Approval Required', '{"threshold_usd": 0.01, "approver": "zero", "description": "Any spending requires Zero approval"}'),
  ('model_routing', 'Tiered Model Routing', '{"tier1": {"model": "minimax", "provider": "openrouter", "default": true}, "tier2": {"model": "manus", "provider": "manus_api"}, "tier3": {"model": "claude-opus-4.5", "provider": "openrouter", "requires_approval": true}}'),
  ('daily_summary', 'Daily Summary Schedule', '{"time": "09:30", "timezone": "America/New_York", "channel": "daily-summary"}'),
  ('cost_alert', 'Daily Cost Alert', '{"daily_threshold_usd": 10, "notify": "zero", "channel": "frasier_dm"}'),
  ('operating_hours', 'Zero Operating Hours', '{"start": "09:00", "end": "21:00", "timezone": "America/New_York"}'),
  ('backup_schedule', 'Daily Backup', '{"time": "03:00", "timezone": "America/New_York", "destination": "gdrive", "retention_days": 30}');

-- ============================================================
-- SEED DATA: Teams (dormant until activated)
-- ============================================================

INSERT INTO teams (id, name, description, status) VALUES
  ('team-research', 'Business Idea & Concept Research', 'Research team: strategist, research analyst, financial/business analyst. Identifies viable revenue-generating business ideas.', 'active'),
  ('team-execution', 'Business Startup & Execution', 'Execution team: broad team of sub-agents handling day-to-day business operations.', 'dormant'),
  ('team-advisory', 'SMB Advisory', 'Advisory team: M&A advisory, CIM review, deal structuring, financing expert.', 'dormant');
