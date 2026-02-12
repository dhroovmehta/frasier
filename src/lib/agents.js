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
  getNamePoolStats
};
