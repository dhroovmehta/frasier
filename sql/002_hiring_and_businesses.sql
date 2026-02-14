-- ============================================================
-- Frasier — Migration #2: Hiring System & Businesses
-- Created: Feb 11, 2026
-- IMPORTANT: No ALTER TABLE on existing tables (avoids PGRST204 cache bug).
-- Two new tables only: businesses, hiring_proposals.
-- ============================================================

-- ============================================================
-- BUSINESSES (multi-business scaffolding)
-- ============================================================

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | paused | archived
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the first business
INSERT INTO businesses (id, name, description, status)
VALUES ('nerv', 'NERV', 'Primary business unit', 'active');

-- ============================================================
-- HIRING PROPOSALS (stateful hiring lifecycle)
-- ============================================================

CREATE TABLE hiring_proposals (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,                         -- e.g. "Content Creator"
  title TEXT,                                 -- formal title for the new agent
  team_id TEXT REFERENCES teams(id),
  business_id TEXT REFERENCES businesses(id) DEFAULT 'nerv',
  justification TEXT,                         -- why this hire is needed
  triggering_proposal_id BIGINT REFERENCES mission_proposals(id),  -- the stalled task
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | completed | rejected
  approved_by TEXT,                           -- who approved (e.g. 'zero')
  created_agent_id TEXT REFERENCES agents(id),  -- filled when agent is created
  announced BOOLEAN DEFAULT FALSE,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for polling: pending + unannounced (discord announcements)
CREATE INDEX idx_hiring_proposals_announce ON hiring_proposals (status, announced)
  WHERE status = 'pending' AND announced = false;

-- Index for processing: approved + unprocessed (heartbeat pickup)
CREATE INDEX idx_hiring_proposals_process ON hiring_proposals (status, processed)
  WHERE status = 'approved' AND processed = false;
