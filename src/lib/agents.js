// agents.js — Agent lifecycle management
// WHY separate from memory: memory is what agents remember.
// This module is who agents ARE — creation, naming, team assignment, status.
// Frasier uses this to hire/fire/reassign agents.

const supabase = require('./supabase');

// ============================================================
// AGENT CREATION (Frasier's hiring system)
// ============================================================

/**
 * Create a new agent with a randomly assigned anime name.
 * Names are drawn from name_pool (Cowboy Bebop, Evangelion, Gundam Wing)
 * and marked as assigned so they can't be reused.
 *
 * @param {Object} params
 * @param {string} params.role - The agent's functional role (e.g. "Research Analyst")
 * @param {string} [params.title] - Formal title
 * @param {string} params.teamId - Team to assign to
 * @param {string} [params.agentType] - sub_agent | team_lead | qa (default: sub_agent)
 * @param {string} [params.preferredSource] - Prefer names from a specific anime
 * @returns {Object} The created agent row, or null on failure
 */
async function createAgent({
  role,
  title = null,
  teamId,
  agentType = 'sub_agent',
  preferredSource = null
}) {
  // Step 1: Pick a random unassigned name
  const name = await assignRandomName(preferredSource);
  if (!name) {
    console.error('[agents] No available names in the pool');
    return null;
  }

  // Step 2: Generate a unique ID
  const agentId = `agent-${name.name.toLowerCase()}-${Date.now()}`;

  // Step 3: Create the agent
  const { data: agent, error } = await supabase
    .from('agents')
    .insert({
      id: agentId,
      name: `${name.name} (${role})`,
      display_name: name.name,
      role,
      title: title || role,
      team_id: teamId,
      agent_type: agentType,
      status: 'active'
    })
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to create agent:`, error.message);
    // Release the name back to the pool
    await supabase
      .from('name_pool')
      .update({ assigned: false, assigned_to_agent_id: null, assigned_at: null })
      .eq('id', name.id);
    return null;
  }

  // Step 4: Mark the name as assigned to this agent
  await supabase
    .from('name_pool')
    .update({
      assigned: true,
      assigned_to_agent_id: agentId,
      assigned_at: new Date().toISOString()
    })
    .eq('id', name.id);

  console.log(`[agents] Created agent ${name.name} (${role}) on team ${teamId}`);
  return agent;
}

/**
 * Pick a random unassigned name from the pool.
 * Optionally prefers a specific anime source.
 */
async function assignRandomName(preferredSource = null) {
  let query = supabase
    .from('name_pool')
    .select('*')
    .eq('assigned', false);

  if (preferredSource) {
    query = query.eq('source', preferredSource);
  }

  const { data: available, error } = await query;

  if (error || !available || available.length === 0) {
    // If preferred source exhausted, try any source
    if (preferredSource) {
      return assignRandomName(null);
    }
    console.error('[agents] Name pool exhausted');
    return null;
  }

  // Pick randomly
  const idx = Math.floor(Math.random() * available.length);
  return available[idx];
}

// ============================================================
// AGENT PERSONA (linking SEP prompts to agents)
// ============================================================

/**
 * Save a generated SEP persona for an agent.
 * Called after Frasier generates a persona using the Persona Architect prompt.
 *
 * @param {Object} params
 * @param {string} params.agentId
 * @param {string} params.agentMd - Who the agent is
 * @param {string} params.soulMd - Core personality
 * @param {string} params.skillsMd - Domain expertise
 * @param {string} params.identityMd - Credentials, background
 * @param {string} params.fullSepPrompt - Complete system prompt
 * @returns {Object} The created persona
 */
async function savePersona({
  agentId,
  agentMd,
  soulMd,
  skillsMd,
  identityMd,
  fullSepPrompt
}) {
  const { data: persona, error } = await supabase
    .from('agent_personas')
    .insert({
      agent_id: agentId,
      agent_md: agentMd,
      soul_md: soulMd,
      skills_md: skillsMd,
      identity_md: identityMd,
      full_sep_prompt: fullSepPrompt
    })
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to save persona for ${agentId}:`, error.message);
    return null;
  }

  // Link persona to agent
  await supabase
    .from('agents')
    .update({ persona_id: persona.id })
    .eq('id', agentId);

  console.log(`[agents] Persona saved for ${agentId} (persona #${persona.id})`);
  return persona;
}

// ============================================================
// AGENT STATUS MANAGEMENT
// ============================================================

/**
 * Get an agent by ID.
 */
async function getAgent(agentId) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single();

  if (error) {
    console.error(`[agents] Failed to get agent ${agentId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Get all agents on a team.
 */
async function getTeamAgents(teamId) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('team_id', teamId)
    .neq('status', 'retired')
    .order('agent_type')
    .order('created_at');

  if (error) {
    console.error(`[agents] Failed to get team agents:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Get all active agents across all teams.
 */
async function getAllActiveAgents() {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('status', 'active')
    .order('team_id')
    .order('agent_type');

  if (error) {
    console.error(`[agents] Failed to get active agents:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Set an agent's status (active, dormant, retired).
 */
async function setAgentStatus(agentId, status) {
  const updates = { status, updated_at: new Date().toISOString() };
  if (status === 'retired') {
    updates.retired_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('agents')
    .update(updates)
    .eq('id', agentId)
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to update status for ${agentId}:`, error.message);
    return null;
  }

  // If retiring, release the name back to the pool
  if (status === 'retired') {
    await supabase
      .from('name_pool')
      .update({ assigned: false, assigned_to_agent_id: null, assigned_at: null })
      .eq('assigned_to_agent_id', agentId);
    console.log(`[agents] Retired ${agentId}, name released back to pool`);
  }

  return data;
}

// ============================================================
// TEAM MANAGEMENT
// ============================================================

/**
 * Get a team by ID.
 */
async function getTeam(teamId) {
  // WHY: Prevents noisy Supabase queries and "Cannot coerce" errors when
  // agents without a team assignment are matched (e.g. Frasier, test agents)
  if (!teamId) return null;

  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .eq('id', teamId)
    .single();

  if (error) {
    console.error(`[agents] Failed to get team ${teamId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Get all teams.
 */
async function getAllTeams() {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .order('status')
    .order('name');

  if (error) {
    console.error(`[agents] Failed to get teams:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Activate or deactivate a team.
 * When deactivating, all team agents go dormant (zero LLM cost).
 * When activating, agents resume from where they left off.
 */
async function setTeamStatus(teamId, status) {
  const { error: teamErr } = await supabase
    .from('teams')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', teamId);

  if (teamErr) {
    console.error(`[agents] Failed to update team ${teamId}:`, teamErr.message);
    return false;
  }

  // Cascade status to all non-retired agents on the team
  const agentStatus = status === 'active' ? 'active' : 'dormant';
  const { error: agentErr } = await supabase
    .from('agents')
    .update({ status: agentStatus, updated_at: new Date().toISOString() })
    .eq('team_id', teamId)
    .neq('status', 'retired');

  if (agentErr) {
    console.error(`[agents] Failed to cascade status to team agents:`, agentErr.message);
    return false;
  }

  console.log(`[agents] Team ${teamId} set to ${status}, agents set to ${agentStatus}`);
  return true;
}

/**
 * Set the team lead for a team.
 */
async function setTeamLead(teamId, agentId) {
  const { error } = await supabase
    .from('teams')
    .update({ lead_agent_id: agentId, updated_at: new Date().toISOString() })
    .eq('id', teamId);

  if (error) {
    console.error(`[agents] Failed to set team lead:`, error.message);
    return false;
  }

  console.log(`[agents] ${agentId} set as lead for team ${teamId}`);
  return true;
}

// ============================================================
// BUSINESS MANAGEMENT (multi-business scaffolding)
// ============================================================

/**
 * Create a new business unit.
 */
async function createBusiness({ id, name, description = null }) {
  const { data, error } = await supabase
    .from('businesses')
    .insert({ id, name, description })
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to create business ${id}:`, error.message);
    return null;
  }

  console.log(`[agents] Business "${name}" (${id}) created`);
  return data;
}

/**
 * Get all businesses.
 */
async function getAllBusinesses() {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .order('created_at');

  if (error) {
    console.error('[agents] Failed to get businesses:', error.message);
    return [];
  }
  return data || [];
}

// ============================================================
// HIRING PROPOSALS (on-demand agent hiring lifecycle)
// ============================================================

/**
 * Create a hiring proposal. Called when a task arrives that no agent can handle.
 * Duplicate detection: won't create a second proposal for the same role+team if one is pending.
 *
 * @param {Object} params
 * @param {string} params.role - Human-readable role title (e.g. "Content Creator")
 * @param {string} params.teamId - Team that needs the hire
 * @param {string} params.justification - Why this hire is needed
 * @param {number} [params.triggeringProposalId] - The mission_proposal that triggered this
 * @param {string} [params.businessId] - Business unit (default: 'nerv')
 * @returns {Object|null} The created hiring proposal, or null if duplicate/error
 */
async function createHiringProposal({
  role,
  teamId,
  justification,
  triggeringProposalId = null,
  businessId = 'nerv'
}) {
  // Duplicate detection: skip if pending proposal already exists for same role+team
  const existing = await checkDuplicateHiringProposal(role, teamId);
  if (existing) {
    console.log(`[agents] Hiring proposal for ${role} on ${teamId} already pending (#${existing.id}). Skipping.`);
    return null;
  }

  const { data, error } = await supabase
    .from('hiring_proposals')
    .insert({
      role,
      title: role,
      team_id: teamId,
      business_id: businessId,
      justification,
      triggering_proposal_id: triggeringProposalId,
      status: 'pending'
    })
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to create hiring proposal:`, error.message);
    return null;
  }

  console.log(`[agents] Hiring proposal #${data.id} created: ${role} for team ${teamId}`);
  return data;
}

/**
 * Check if a pending hiring proposal already exists for a role+team.
 */
async function checkDuplicateHiringProposal(role, teamId) {
  const { data } = await supabase
    .from('hiring_proposals')
    .select('*')
    .eq('role', role)
    .eq('team_id', teamId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  return data || null;
}

/**
 * Get approved but unprocessed hiring proposals (for heartbeat to pick up).
 */
async function getApprovedHires(limit = 1) {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .select('*')
    .eq('status', 'approved')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[agents] Failed to get approved hires:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get pending, unannounced hiring proposals (for Discord bot to announce).
 */
async function getPendingHiringProposals() {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .select('*')
    .eq('status', 'pending')
    .eq('announced', false)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[agents] Failed to get pending hiring proposals:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Approve a hiring proposal. Called when Zero runs !hire <id>.
 */
async function approveHiringProposal(proposalId, approvedBy = 'zero') {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .update({
      status: 'approved',
      approved_by: approvedBy,
      updated_at: new Date().toISOString()
    })
    .eq('id', proposalId)
    .eq('status', 'pending')
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to approve hiring proposal #${proposalId}:`, error.message);
    return null;
  }

  console.log(`[agents] Hiring proposal #${proposalId} approved by ${approvedBy}`);
  return data;
}

/**
 * Reject a hiring proposal.
 */
async function rejectHiringProposal(proposalId, rejectedBy = 'zero') {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .update({
      status: 'rejected',
      approved_by: rejectedBy,
      processed: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', proposalId)
    .eq('status', 'pending')
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to reject hiring proposal #${proposalId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Mark a hiring proposal as completed after agent creation.
 * Links the new agent and re-queues the stalled mission proposal.
 */
async function completeHiringProposal(proposalId, createdAgentId) {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .update({
      status: 'completed',
      processed: true,
      created_agent_id: createdAgentId,
      updated_at: new Date().toISOString()
    })
    .eq('id', proposalId)
    .select()
    .single();

  if (error) {
    console.error(`[agents] Failed to complete hiring proposal #${proposalId}:`, error.message);
    return null;
  }

  console.log(`[agents] Hiring proposal #${proposalId} completed, agent ${createdAgentId} created`);
  return data;
}

/**
 * Mark a hiring proposal as announced (Discord posted).
 */
async function markHiringProposalAnnounced(proposalId) {
  const { error } = await supabase
    .from('hiring_proposals')
    .update({ announced: true })
    .eq('id', proposalId);

  if (error) {
    console.error(`[agents] Failed to mark hiring proposal #${proposalId} as announced:`, error.message);
  }
}

/**
 * Get a hiring proposal by ID.
 */
async function getHiringProposal(proposalId) {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .select('*')
    .eq('id', proposalId)
    .single();

  if (error) {
    console.error(`[agents] Failed to get hiring proposal #${proposalId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Get all non-rejected hiring proposals (for !roster display).
 */
async function getAllHiringProposals() {
  const { data, error } = await supabase
    .from('hiring_proposals')
    .select('*')
    .neq('status', 'rejected')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[agents] Failed to get all hiring proposals:', error.message);
    return [];
  }
  return data || [];
}

// ============================================================
// NAME POOL STATS
// ============================================================

/**
 * Get name pool statistics (how many names available per source).
 */
async function getNamePoolStats() {
  const { data, error } = await supabase
    .from('name_pool')
    .select('source, assigned');

  if (error) {
    console.error('[agents] Failed to get name pool stats:', error.message);
    return null;
  }

  const stats = {};
  for (const row of (data || [])) {
    if (!stats[row.source]) {
      stats[row.source] = { total: 0, available: 0, assigned: 0 };
    }
    stats[row.source].total++;
    if (row.assigned) {
      stats[row.source].assigned++;
    } else {
      stats[row.source].available++;
    }
  }
  return stats;
}

// ============================================================
// ROSTER (formatted team/agent summary for prompt injection)
// ============================================================

/**
 * Build a formatted roster section for injection into Frasier's prompt.
 * Lists all active agents grouped by team with "Name (Role)" format.
 * WHY: Frasier needs to know who's on each team to route tasks correctly
 * and reference agents by name. Without this, Frasier has no idea who exists.
 *
 * @returns {string} Formatted roster markdown section
 */
async function buildRosterSection() {
  const teams = await getAllTeams();
  const lines = ['## Current Roster'];

  for (const team of teams) {
    const teamAgents = await getTeamAgents(team.id);
    lines.push(`\n### ${team.name} [${team.status}]`);

    if (teamAgents.length === 0) {
      lines.push('- No agents assigned');
      continue;
    }

    for (const agent of teamAgents) {
      const typeTag = agent.agent_type === 'team_lead' ? ' (Lead)' :
        agent.agent_type === 'qa' ? ' (QA)' : '';
      lines.push(`- ${agent.display_name} (${agent.role})${typeTag}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// QUALITY RUBRIC (persona-as-rubric for enforcing output quality)
// ============================================================

// Role-specific quality rubrics appended to personas.
// WHY in persona instead of lessons: persona is ALWAYS in the system prompt (100% retrieval).
// Lessons compete for top 5 slots. Quality standards must never be optional.
const QUALITY_RUBRICS = {
  research: `## Quality Standards (Non-Negotiable)
- You NEVER deliver research without: named sources, specific data points, quantified estimates
- You NEVER make claims without evidence or clear reasoning
- You NEVER use filler phrases like "in today's fast-paced world" or "it's important to note that"
- You ALWAYS include a Risk Assessment section with probability and impact ratings
- You ALWAYS provide at least 3 specific, actionable recommendations
- If you lack data, you STATE what's missing rather than filling with generic text
- Every competitor mentioned includes at least one differentiating data point`,

  strategy: `## Quality Standards (Non-Negotiable)
- You NEVER deliver strategy without quantified projections and measurable outcomes
- You NEVER present a plan without a 90-day implementation roadmap with milestones
- You NEVER skip resource requirements — budget, tools, and people with specific estimates
- You ALWAYS include success metrics with specific KPI targets and timeframes
- You ALWAYS include risk mitigation for the top 3 risks
- If you lack data for projections, you STATE assumptions explicitly
- Every recommendation includes expected ROI or measurable impact`,

  content: `## Quality Standards (Non-Negotiable)
- You NEVER publish content without a hook that passes the "would I click this?" test
- You NEVER use generic marketing speak — every sentence must be audience-specific
- You NEVER make claims without backing them with a data point or real example
- You ALWAYS include a clear CTA with measurable expected outcome
- You ALWAYS recommend 2-3 distribution channels with rationale
- If content lacks depth, you research more rather than padding with filler`,

  engineering: `## Quality Standards (Non-Negotiable)
- You NEVER deliver code without error handling at every external boundary
- You NEVER skip test cases for happy path, edge cases, and error scenarios
- You NEVER write pseudocode when working code is expected
- You ALWAYS include inline comments explaining WHY, not WHAT
- You ALWAYS include deployment instructions and rollback plan
- You handle null/undefined defensively at all system boundaries`,

  qa: `## Quality Standards (Non-Negotiable)
- You NEVER approve deliverables without verifying specific pass/fail criteria
- You NEVER skip edge cases and boundary conditions in your review
- You ALWAYS check for security implications and flag them
- You ALWAYS provide specific, actionable feedback — not vague "needs improvement"
- You ALWAYS include a clear APPROVE or REJECT verdict with evidence
- Your reviews reference specific sections of the deliverable, not generalities`,

  marketing: `## Quality Standards (Non-Negotiable)
- You NEVER deliver marketing plans without channel-specific conversion rate estimates
- You NEVER skip budget allocation or ROI projections
- You ALWAYS include A/B test recommendations with success criteria
- You ALWAYS include competitive positioning analysis
- You ALWAYS provide a 30/60/90 day implementation timeline
- Every tactic includes expected measurable outcomes`,

  knowledge: `## Quality Standards (Non-Negotiable)
- You NEVER deliver documentation without clear categorization and tagging
- You NEVER skip cross-references to related documents
- You ALWAYS include a summary of key insights, not just raw data
- You ALWAYS identify gaps in existing knowledge
- You ALWAYS recommend next steps for knowledge improvement`,

  default: `## Quality Standards (Non-Negotiable)
- You NEVER deliver work without specific evidence, data, or clear reasoning
- You NEVER use filler phrases or AI slop — every sentence must add value
- You NEVER make vague claims like "significant growth" — use specific numbers
- You ALWAYS structure output with clear sections and headings
- You ALWAYS provide actionable recommendations
- If you lack information, you STATE what's missing rather than filling with generic text`
};

// Map roles to rubric categories (same mapping as context.js ROLE_TO_DOMAIN)
const ROLE_TO_RUBRIC = {
  'research analyst': 'research',
  'research': 'research',
  'analyst': 'research',
  'strategy lead': 'strategy',
  'strategist': 'strategy',
  'strategy': 'strategy',
  'content creator': 'content',
  'content writer': 'content',
  'copywriter': 'content',
  'content': 'content',
  'full-stack engineer': 'engineering',
  'engineer': 'engineering',
  'developer': 'engineering',
  'engineering': 'engineering',
  'qa engineer': 'qa',
  'qa': 'qa',
  'quality assurance': 'qa',
  'tester': 'qa',
  'growth marketer': 'marketing',
  'marketing': 'marketing',
  'knowledge curator': 'knowledge',
  'knowledge': 'knowledge'
};

/**
 * Build a quality rubric for a given agent role.
 * This gets appended to the agent's persona (system prompt) so it's always present.
 *
 * @param {string} role - Agent's role string (e.g. "Research Analyst")
 * @returns {string} Quality rubric markdown section
 */
function buildQualityRubric(role) {
  const lower = (role || '').toLowerCase();

  // Try exact match
  if (ROLE_TO_RUBRIC[lower]) {
    return QUALITY_RUBRICS[ROLE_TO_RUBRIC[lower]];
  }

  // Try partial match
  for (const [roleKey, rubricKey] of Object.entries(ROLE_TO_RUBRIC)) {
    if (lower.includes(roleKey) || roleKey.includes(lower)) {
      return QUALITY_RUBRICS[rubricKey];
    }
  }

  return QUALITY_RUBRICS.default;
}

/**
 * Upgrade an existing agent's persona with a quality rubric.
 * Reads current persona, appends rubric, saves as new persona version.
 * No-op if rubric already present.
 *
 * @param {string} agentId
 * @returns {Object|null} New persona if upgraded, null if already has rubric or error
 */
async function upgradePersonaWithRubric(agentId) {
  // Get agent and current persona
  const agent = await getAgent(agentId);
  if (!agent || !agent.persona_id) return null;

  const { data: persona } = await supabase
    .from('agent_personas')
    .select('*')
    .eq('id', agent.persona_id)
    .single();

  if (!persona || !persona.full_sep_prompt) return null;

  // Skip if already has a quality rubric
  if (persona.full_sep_prompt.includes('Quality Standards (Non-Negotiable)')) {
    return null;
  }

  // Build and append rubric
  const rubric = buildQualityRubric(agent.role);
  const upgradedPrompt = persona.full_sep_prompt + '\n\n' + rubric;

  // Save as new persona version (preserves old one as history)
  const newPersona = await savePersona({
    agentId,
    agentMd: persona.agent_md,
    soulMd: persona.soul_md,
    skillsMd: persona.skills_md,
    identityMd: persona.identity_md,
    fullSepPrompt: upgradedPrompt
  });

  return newPersona;
}

// ============================================================
// SMART ROUTING (cross-team agent matching)
// ============================================================

// Keywords for matching agents to role categories
const SMART_ROLE_KEYWORDS = {
  research: ['research', 'analyst', 'intelligence', 'data'],
  strategy: ['strategy', 'lead', 'strategist', 'business'],
  content: ['content', 'writer', 'creator', 'copywriter', 'copy'],
  engineering: ['engineer', 'developer', 'architect', 'full-stack'],
  qa: ['qa', 'quality', 'tester', 'testing'],
  marketing: ['marketing', 'growth', 'seo', 'marketer'],
  knowledge: ['knowledge', 'documentation', 'curator', 'wiki']
};

// Maps role categories to standing teams
const ROLE_TO_TEAM = {
  research: 'team-research',
  strategy: 'team-research',
  knowledge: 'team-research',
  engineering: 'team-execution',
  content: 'team-execution',
  qa: 'team-execution',
  marketing: 'team-execution'
};

/**
 * Find the best agent across ALL teams for a given role category.
 * WHY: Previous routing only looked at the target team. If a research agent
 * exists on team-research but the proposal targets team-execution, it was missed.
 *
 * @param {string} roleCategory - e.g. 'research', 'content', 'engineering'
 * @returns {Object|null} Best matching agent, or null
 */
async function findBestAgentAcrossTeams(roleCategory) {
  const allAgents = await getAllActiveAgents();
  const keywords = SMART_ROLE_KEYWORDS[roleCategory] || [];

  for (const agent of allAgents) {
    // WHY: Agents without a team (Frasier, test agents) can't receive missions
    // — they have no team to route through, causing infinite heartbeat loops
    if (!agent.team_id) continue;

    const agentRole = (agent.role || '').toLowerCase();
    if (keywords.some(kw => agentRole.includes(kw))) {
      return agent;
    }
  }

  return null;
}

/**
 * Get the standing team for a role category.
 * @param {string} roleCategory
 * @returns {string} Team ID
 */
function getStandingTeamForRole(roleCategory) {
  return ROLE_TO_TEAM[roleCategory] || 'team-research';
}

/**
 * Auto-hire a gap agent for a missing role.
 * Creates the agent on the correct standing team with no approval needed.
 *
 * @param {string} roleTitle - Human-readable role (e.g. "Content Creator")
 * @param {string} roleCategory - Category key (e.g. "content")
 * @param {Object} [options] - Optional project context for persona generation
 * @param {string} [options.projectDescription] - Project description for industry-specific persona
 * @param {string} [options.projectName] - Project name
 * @returns {Object|null} Created agent, or null on failure
 */
async function autoHireGapAgent(roleTitle, roleCategory, options = {}) {
  const teamId = getStandingTeamForRole(roleCategory);

  const agent = await createAgent({
    role: roleTitle,
    teamId,
    agentType: 'sub_agent'
  });

  if (agent) {
    // Attach project context so persona generation can use it
    if (options.projectDescription || options.projectName) {
      agent._pendingPersonaContext = {
        projectDescription: options.projectDescription,
        projectName: options.projectName
      };
    }
    console.log(`[agents] Gap-fill agent ${agent.display_name} (${roleTitle}) auto-hired for ${teamId}`);
  }

  return agent;
}

const VALID_CATEGORIES = ['research', 'strategy', 'content', 'engineering', 'qa', 'marketing', 'knowledge'];

const ROLE_TITLES_FALLBACK = {
  research: 'Research Analyst',
  strategy: 'Strategy Lead',
  content: 'Content Creator',
  engineering: 'Full-Stack Engineer',
  qa: 'QA Engineer',
  marketing: 'Growth Marketer',
  knowledge: 'Knowledge Curator'
};

/**
 * Determine what roles a project needs using an LLM call.
 * Returns free-form role titles tailored to the project's industry/domain.
 * Falls back to keyword matching if LLM fails.
 *
 * @param {string} description - Project description
 * @returns {Object[]} Array of { title, category, reason }
 */
async function determineDynamicProjectRoles(description) {
  const models = require('./models');

  try {
    const result = await models.callLLM({
      systemPrompt: 'You determine what expert roles a project needs. Return ONLY valid JSON.',
      userMessage: `Analyze this project and determine what specialist roles are needed.

PROJECT: "${description}"

Return a JSON array of 2-5 roles. Each role should be a SPECIALIST with domain expertise
specific to this project's industry. Do NOT use generic titles like "Research Analyst" —
use industry-specific titles like "Real Estate Market Analyst" or "Healthcare Compliance Specialist".

For each role, also provide the closest general category from this list for team routing:
research, strategy, content, engineering, qa, marketing, knowledge

JSON format (no markdown, no backticks, ONLY the JSON array):
[
  { "title": "Real Estate Market Analyst", "category": "research", "reason": "Deep market research on real estate AI tools and lead gen" },
  { "title": "AI Product Architect", "category": "engineering", "reason": "Design the AI agent architecture and integrations" }
]`,
      agentId: 'system',
      forceTier: 'tier1'
    });

    if (result.error || !result.content) {
      return keywordFallbackRoles(description);
    }

    const jsonStr = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const roles = JSON.parse(jsonStr);

    if (Array.isArray(roles) && roles.length > 0) {
      return roles.map(r => ({
        title: r.title || 'Specialist',
        category: VALID_CATEGORIES.includes(r.category) ? r.category : 'research',
        reason: r.reason || ''
      }));
    }
  } catch (parseErr) {
    console.error(`[agents] Failed to parse dynamic roles: ${parseErr.message}`);
  }

  return keywordFallbackRoles(description);
}

/**
 * Convert keyword-matched categories to { title, category, reason } format.
 */
function keywordFallbackRoles(description) {
  const categories = determineProjectRoles(description);
  return categories.map(cat => ({
    title: ROLE_TITLES_FALLBACK[cat] || cat,
    category: cat,
    reason: 'Keyword-matched fallback'
  }));
}

/**
 * Determine which roles are needed for a project based on its description.
 * Returns an array of role category keys (e.g. ['research', 'engineering', 'content']).
 * @deprecated Use determineDynamicProjectRoles() instead.
 *
 * @param {string} description - Project description
 * @returns {string[]} Array of role categories needed
 */
function determineProjectRoles(description) {
  const lower = (description || '').toLowerCase();
  const roles = new Set();

  const EXPERTISE_KEYWORDS = {
    research: ['research', 'analysis', 'market', 'competitive', 'trends', 'intelligence', 'data', 'report', 'analyze'],
    strategy: ['strategy', 'business plan', 'roadmap', 'pricing', 'financial', 'revenue', 'growth plan'],
    content: ['content', 'copywriting', 'blog', 'social media', 'tweet', 'post', 'brand', 'write', 'article'],
    engineering: ['code', 'build', 'api', 'deploy', 'architecture', 'database', 'backend', 'frontend'],
    qa: ['test', 'quality', 'review', 'audit', 'security'],
    marketing: ['seo', 'distribution', 'funnel', 'ads', 'campaign', 'conversion', 'marketing'],
    knowledge: ['document', 'summarize', 'knowledge', 'wiki', 'organize']
  };

  for (const [role, keywords] of Object.entries(EXPERTISE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      roles.add(role);
    }
  }

  if (roles.size === 0) roles.add('research');

  return Array.from(roles);
}

module.exports = {
  // Agent lifecycle
  createAgent,
  savePersona,
  getAgent,
  getTeamAgents,
  getAllActiveAgents,
  setAgentStatus,
  // Team management
  getTeam,
  getAllTeams,
  setTeamStatus,
  setTeamLead,
  // Business management
  createBusiness,
  getAllBusinesses,
  // Hiring proposals
  createHiringProposal,
  checkDuplicateHiringProposal,
  getApprovedHires,
  getPendingHiringProposals,
  approveHiringProposal,
  rejectHiringProposal,
  completeHiringProposal,
  markHiringProposalAnnounced,
  getHiringProposal,
  getAllHiringProposals,
  // Name pool
  getNamePoolStats,
  // Roster
  buildRosterSection,
  // Quality rubrics
  buildQualityRubric,
  upgradePersonaWithRubric,
  // Smart routing
  findBestAgentAcrossTeams,
  getStandingTeamForRole,
  autoHireGapAgent,
  determineProjectRoles,
  determineDynamicProjectRoles
};
