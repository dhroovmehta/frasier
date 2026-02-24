// missions.js — Mission lifecycle: proposal → mission → steps → execution → completion
// WHY this is the critical path: Every piece of work flows through this pipeline.
// Zero sends a request → proposal created → heartbeat picks it up → mission created →
// steps assigned to agents → worker executes → approval chain → result delivered.

const supabase = require('./supabase');
const linear = require('./linear');

// Agent expertise map for keyword-based routing
const EXPERTISE_MAP = {
  research: ['research', 'analysis', 'market', 'competitive', 'trends', 'intelligence', 'data', 'report'],
  strategy: ['strategy', 'business plan', 'roadmap', 'pricing', 'financial', 'revenue', 'growth plan'],
  content: ['content', 'copywriting', 'blog', 'social media', 'tweet', 'post', 'brand', 'storytelling', 'article'],
  engineering: ['code', 'architecture', 'deploy', 'build', 'api', 'database', 'backend', 'frontend', 'debug'],
  qa: ['test', 'quality', 'review', 'audit', 'security', 'bug', 'validate', 'verify'],
  marketing: ['seo', 'distribution', 'funnel', 'ads', 'campaign', 'conversion', 'traffic', 'growth'],
  knowledge: ['document', 'summarize', 'knowledge', 'wiki', 'organize', 'catalog', 'index']
};

// Human-readable role titles for hiring proposals
const ROLE_TITLES = {
  research: 'Research Analyst',
  strategy: 'Strategy Lead',
  content: 'Content Creator',
  engineering: 'Full-Stack Engineer',
  qa: 'QA Engineer',
  marketing: 'Growth Marketer',
  knowledge: 'Knowledge Curator'
};

// Keywords for matching agents to role categories (mirrors heartbeat.findBestAgent)
const ROLE_KEYWORDS = {
  research: ['research', 'analyst', 'intelligence'],
  strategy: ['strategy', 'lead', 'strategist'],
  content: ['content', 'writer', 'creator', 'copywriter'],
  engineering: ['engineer', 'developer', 'architect'],
  qa: ['qa', 'quality', 'tester'],
  marketing: ['marketing', 'growth', 'seo'],
  knowledge: ['knowledge', 'documentation', 'curator']
};

// ============================================================
// PROPOSALS (input queue)
// ============================================================

/**
 * Create a new mission proposal. Called when Zero sends a request via Discord,
 * or when an agent suggests work (e.g., follow-up from a completed mission).
 */
async function createProposal({
  proposingAgentId = 'zero',
  title,
  description = null,
  priority = 'normal',
  targetTeamId = null,
  rawMessage = null,
  discordMessageId = null
}) {
  const { data, error } = await supabase
    .from('mission_proposals')
    .insert({
      proposing_agent_id: proposingAgentId,
      title,
      description,
      priority,
      assigned_team_id: targetTeamId,
      raw_message: rawMessage,
      discord_message_id: discordMessageId
    })
    .select()
    .single();

  if (error) {
    console.error('[missions] Failed to create proposal:', error.message);
    return null;
  }

  console.log(`[missions] Proposal #${data.id} created: "${title}" (priority: ${priority})`);
  return data;
}

/**
 * Get unprocessed proposals (for heartbeat to pick up).
 */
async function getPendingProposals() {
  const { data, error } = await supabase
    .from('mission_proposals')
    .select('*')
    .eq('status', 'pending')
    .eq('processed', false)
    .order('priority', { ascending: true })  // urgent first
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[missions] Failed to get pending proposals:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Accept a proposal and create a mission from it.
 */
async function acceptProposal(proposalId, teamId) {
  // Mark proposal as accepted
  const { error: updateErr } = await supabase
    .from('mission_proposals')
    .update({
      status: 'accepted',
      processed: true
    })
    .eq('id', proposalId);

  if (updateErr) {
    console.error(`[missions] Failed to accept proposal #${proposalId}:`, updateErr.message);
    return null;
  }

  // Fetch proposal for mission creation
  const { data: proposal } = await supabase
    .from('mission_proposals')
    .select('*')
    .eq('id', proposalId)
    .single();

  if (!proposal) return null;

  // Create mission
  const mission = await createMission({
    proposalId,
    teamId,
    title: proposal.title,
    description: proposal.description
  });

  return mission;
}

/**
 * Reject a proposal.
 */
async function rejectProposal(proposalId, reason = null) {
  const { error } = await supabase
    .from('mission_proposals')
    .update({
      status: 'rejected',
      processed: true
    })
    .eq('id', proposalId);

  if (error) {
    console.error(`[missions] Failed to reject proposal #${proposalId}:`, error.message);
    return false;
  }
  return true;
}

// ============================================================
// MISSIONS (active work)
// ============================================================

/**
 * Create a mission from an accepted proposal.
 */
async function createMission({
  proposalId = null,
  teamId,
  title,
  description = null
}) {
  const { data, error } = await supabase
    .from('missions')
    .insert({
      proposal_id: proposalId,
      team_id: teamId,
      title,
      description
    })
    .select()
    .single();

  if (error) {
    console.error('[missions] Failed to create mission:', error.message);
    return null;
  }

  console.log(`[missions] Mission #${data.id} created: "${title}" for team ${teamId}`);

  // Sync to Linear (fire-and-forget)
  linear.syncMissionToLinear(data).catch(err =>
    console.error(`[linear] Mission sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Get all active missions for a team.
 */
async function getActiveMissions(teamId = null) {
  let query = supabase
    .from('missions')
    .select('*')
    .eq('status', 'in_progress')
    .order('created_at', { ascending: true });

  if (teamId) {
    query = query.eq('team_id', teamId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[missions] Failed to get active missions:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Complete a mission.
 */
async function completeMission(missionId) {
  const { data, error } = await supabase
    .from('missions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', missionId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to complete mission #${missionId}:`, error.message);
    return null;
  }

  console.log(`[missions] Mission #${missionId} completed`);

  // Sync to Linear (fire-and-forget)
  linear.completeProject(missionId).catch(err =>
    console.error(`[linear] Mission complete sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Fail a mission.
 */
async function failMission(missionId, reason = null) {
  const { data, error } = await supabase
    .from('missions')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', missionId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to mark mission #${missionId} as failed:`, error.message);
    return null;
  }

  // Sync to Linear (fire-and-forget)
  linear.cancelProject(missionId).catch(err =>
    console.error(`[linear] Mission fail sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

// ============================================================
// MISSION STEPS (individual tasks)
// ============================================================

/**
 * Create a mission step (task for an agent).
 */
async function createStep({
  missionId,
  description,
  assignedAgentId = null,
  modelTier = 'tier1',
  stepOrder = 0,
  parentStepId = null
}) {
  const { data, error } = await supabase
    .from('mission_steps')
    .insert({
      mission_id: missionId,
      description,
      assigned_agent_id: assignedAgentId,
      model_tier: modelTier,
      step_order: stepOrder,
      parent_step_id: parentStepId
    })
    .select()
    .single();

  if (error) {
    console.error('[missions] Failed to create step:', error.message);
    return null;
  }

  console.log(`[missions] Step #${data.id} created for mission #${missionId}: "${description.substring(0, 60)}..."`);

  // Sync to Linear (fire-and-forget)
  linear.syncStepToLinear(data).catch(err =>
    console.error(`[linear] Step sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Get pending steps ready for the worker to pick up.
 * Only returns steps assigned to active agents.
 * Multi-step blocking: steps with step_order > 1 are only eligible
 * if ALL prior steps in the same mission have status = 'completed'.
 */
async function getPendingSteps(limit = 5) {
  const { data, error } = await supabase
    .from('mission_steps')
    .select('*, missions!inner(status, team_id)')
    .eq('status', 'pending')
    .eq('processed', false)
    .eq('missions.status', 'in_progress')
    .order('step_order', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit * 2); // Fetch extra since some may be blocked

  if (error) {
    console.error('[missions] Failed to get pending steps:', error.message);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Post-fetch blocking check: DAG path (v0.9.0) or legacy step_order path
  const eligible = [];
  for (const step of data) {
    // Check DAG dependencies first (v0.9.0 decomposed missions)
    const dagResult = await areAllDependenciesMet(step.id);

    if (dagResult === true) {
      // DAG path: all deps met → eligible
      eligible.push(step);
    } else if (dagResult === false) {
      // DAG path: some deps not met → blocked
      continue;
    } else {
      // Legacy path (no DAG deps) — fall back to step_order check
      if (!step.step_order || step.step_order <= 1) {
        eligible.push(step);
      } else {
        const ready = await isPreviousStepComplete(step.mission_id, step.step_order);
        if (ready) {
          eligible.push(step);
        }
      }
    }

    if (eligible.length >= limit) break;
  }

  return eligible;
}

/**
 * Claim a step (set to in_progress). Prevents double-pickup.
 */
async function claimStep(stepId) {
  const { data, error } = await supabase
    .from('mission_steps')
    .update({
      status: 'in_progress',
      processed: true,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', stepId)
    .eq('status', 'pending')  // Only claim if still pending (idempotent)
    .select()
    .single();

  if (error) {
    // Likely already claimed by another worker
    return null;
  }

  // Sync to Linear (fire-and-forget)
  linear.updateIssueStatus(stepId, 'In Progress').catch(err =>
    console.error(`[linear] Claim sync failed (non-blocking): ${err.message}`)
  );
  linear.updateIssueCustomField(stepId, 'Started At', new Date().toISOString()).catch(err =>
    console.error(`[linear] Started At sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Complete a step with its result.
 */
async function completeStep(stepId, result, resultFormat = 'text') {
  const { data, error } = await supabase
    .from('mission_steps')
    .update({
      status: 'in_review',  // Goes to approval chain, not straight to completed
      result,
      result_format: resultFormat,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', stepId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to complete step #${stepId}:`, error.message);
    return null;
  }

  // Sync to Linear (fire-and-forget)
  linear.updateIssueStatus(stepId, 'In Review').catch(err =>
    console.error(`[linear] Review sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Fail a step.
 */
async function failStep(stepId, errorMessage) {
  const { data, error } = await supabase
    .from('mission_steps')
    .update({
      status: 'failed',
      result: `ERROR: ${errorMessage}`,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', stepId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to mark step #${stepId} as failed:`, error.message);
    return null;
  }

  // Sync to Linear (fire-and-forget)
  linear.updateIssueStatus(stepId, 'Canceled').catch(err =>
    console.error(`[linear] Fail sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Count how many times a step has been rejected in the approval chain.
 * WHY: Used by worker.js to enforce the 3-strike revision cap.
 * Only counts past rejections (already in DB), not the current review.
 *
 * @param {number} stepId
 * @returns {number}
 */
async function countStepRejections(stepId) {
  const { data, error } = await supabase
    .from('approval_chain')
    .select('id')
    .eq('mission_step_id', stepId)
    .eq('status', 'rejected');

  if (error) {
    console.error(`[missions] Failed to count rejections for step #${stepId}:`, error.message);
    return 0;
  }
  return data?.length || 0;
}

/**
 * Send a step back for revision (from QA or Team Lead rejection).
 */
async function sendBackForRevision(stepId) {
  const { data, error } = await supabase
    .from('mission_steps')
    .update({
      status: 'pending',
      processed: false,
      result: null,
      completed_at: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', stepId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to send step #${stepId} back:`, error.message);
    return null;
  }

  // Sync to Linear (fire-and-forget)
  linear.updateIssueStatus(stepId, 'Backlog').catch(err =>
    console.error(`[linear] Revision sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

/**
 * Mark a step as fully approved and completed.
 */
async function approveStep(stepId) {
  const { data, error } = await supabase
    .from('mission_steps')
    .update({
      status: 'completed',
      updated_at: new Date().toISOString()
    })
    .eq('id', stepId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to approve step #${stepId}:`, error.message);
    return null;
  }

  // Sync to Linear (fire-and-forget)
  linear.updateIssueStatus(stepId, 'Done').catch(err =>
    console.error(`[linear] Approve sync failed (non-blocking): ${err.message}`)
  );
  linear.updateIssueCustomField(stepId, 'Completed At', new Date().toISOString()).catch(err =>
    console.error(`[linear] Completed At sync failed (non-blocking): ${err.message}`)
  );
  linear.syncCritiqueScore(stepId).catch(err =>
    console.error(`[linear] Critique score sync failed (non-blocking): ${err.message}`)
  );

  return data;
}

// ============================================================
// APPROVAL CHAIN (QA → Team Lead)
// ============================================================

/**
 * Create an approval request for a completed step.
 */
async function createApproval({
  missionStepId,
  reviewerAgentId,
  reviewType  // 'qa' | 'team_lead'
}) {
  const { data, error } = await supabase
    .from('approval_chain')
    .insert({
      mission_step_id: missionStepId,
      reviewer_agent_id: reviewerAgentId,
      review_type: reviewType
    })
    .select()
    .single();

  if (error) {
    console.error('[missions] Failed to create approval:', error.message);
    return null;
  }
  return data;
}

/**
 * Submit a review (approve or reject with feedback).
 */
async function submitReview(approvalId, { status, feedback = null }) {
  const { data, error } = await supabase
    .from('approval_chain')
    .update({
      status,
      feedback,
      reviewed_at: new Date().toISOString()
    })
    .eq('id', approvalId)
    .select()
    .single();

  if (error) {
    console.error(`[missions] Failed to submit review #${approvalId}:`, error.message);
    return null;
  }

  // If rejected, send step back for revision
  if (status === 'rejected') {
    await sendBackForRevision(data.mission_step_id);
    console.log(`[missions] Step #${data.mission_step_id} sent back for revision (${data.review_type} rejected)`);
  }

  return data;
}

/**
 * Get pending approvals for a reviewer agent.
 */
async function getPendingApprovals(reviewerAgentId) {
  const { data, error } = await supabase
    .from('approval_chain')
    .select('*, mission_steps!inner(*)')
    .eq('reviewer_agent_id', reviewerAgentId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[missions] Failed to get pending approvals:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get steps in review that need approvals created.
 */
async function getStepsNeedingReview() {
  // Find steps that are in_review but don't have a pending approval yet
  const { data: stepsInReview, error: stepErr } = await supabase
    .from('mission_steps')
    .select('*')
    .eq('status', 'in_review')
    .order('completed_at', { ascending: true });

  if (stepErr || !stepsInReview) return [];

  const results = [];
  for (const step of stepsInReview) {
    // Check if there's already a pending approval for this step
    const { data: approvals } = await supabase
      .from('approval_chain')
      .select('*')
      .eq('mission_step_id', step.id)
      .eq('status', 'pending');

    if (!approvals || approvals.length === 0) {
      results.push(step);
    }
  }

  return results;
}

// ============================================================
// GAP DETECTION (can the team handle this role?)
// ============================================================

/**
 * Check if any agent on the team can handle a given role category.
 * Extracted from heartbeat.findBestAgent() for reuse in gap detection.
 *
 * @param {Array} teamAgents - Agents on the team (from agents.getTeamAgents)
 * @param {string} roleCategory - Role category from routeByKeywords()
 * @returns {{ canHandle: boolean, matchedAgent: Object|null, roleCategory: string }}
 */
function canTeamHandle(teamAgents, roleCategory) {
  const keywords = ROLE_KEYWORDS[roleCategory] || [];

  for (const agent of teamAgents) {
    const agentRole = (agent.role || '').toLowerCase();
    if (keywords.some(kw => agentRole.includes(kw))) {
      return { canHandle: true, matchedAgent: agent, roleCategory };
    }
  }

  // Fallback: team lead can handle anything (they're generalists)
  const teamLead = teamAgents.find(a => a.agent_type === 'team_lead');
  if (teamLead) {
    return { canHandle: true, matchedAgent: teamLead, roleCategory };
  }

  return { canHandle: false, matchedAgent: null, roleCategory };
}

// ============================================================
// MULTI-STEP MISSION HELPERS
// ============================================================

/**
 * Parse a [PHASES] block from mission description text.
 * Returns array of { description, role, tier } or empty array if no phases found.
 * Shared by discord_bot.js (when creating proposals) and heartbeat.js (when creating steps).
 * Graceful fallback: malformed input → empty array → single-step behavior.
 */
function parsePhases(text) {
  if (!text) return [];
  const match = text.match(/\[PHASES\]([\s\S]*?)\[\/PHASES\]/);
  if (!match) return [];
  return match[1].trim().split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/PHASE \d+:\s*(.+?)\s*\|\s*ROLE:\s*(\w+)\s*\|\s*TIER:\s*(\w+)/i);
    return m ? { description: m[1].trim(), role: m[2].trim().toLowerCase(), tier: m[3].trim().toLowerCase() } : null;
  }).filter(Boolean);
}

/**
 * Check if all previous steps in a mission are completed.
 * Used by getPendingSteps() to block chained steps until predecessors finish.
 *
 * @param {number} missionId - The mission ID
 * @param {number} currentStepOrder - The step_order of the step we're checking
 * @returns {boolean} true if all prior steps are completed (or no prior steps exist)
 */
async function isPreviousStepComplete(missionId, currentStepOrder) {
  const { data, error } = await supabase
    .from('mission_steps')
    .select('status')
    .eq('mission_id', missionId)
    .lt('step_order', currentStepOrder)
    .neq('status', 'completed');

  if (error) {
    console.error(`[missions] Error checking previous steps for mission #${missionId}:`, error.message);
    return false; // Block step on error — safer than running out of order
  }

  // If no rows returned, all predecessors are completed (or none exist)
  return !data || data.length === 0;
}

/**
 * Get the result from a parent step (for context injection in chained missions).
 *
 * @param {number} parentStepId - The parent_step_id to fetch
 * @returns {{ result: string, agentName: string } | null}
 */
async function getParentStepResult(parentStepId) {
  if (!parentStepId) return null;

  const { data, error } = await supabase
    .from('mission_steps')
    .select('result, assigned_agent_id')
    .eq('id', parentStepId)
    .single();

  if (error || !data || !data.result) return null;

  // Get agent display name for context header
  const { data: agent } = await supabase
    .from('agents')
    .select('display_name')
    .eq('id', data.assigned_agent_id)
    .single();

  return {
    result: data.result,
    agentName: agent?.display_name || data.assigned_agent_id
  };
}

// ============================================================
// DAG DEPENDENCY CHECKING (v0.9.0)
// ============================================================

/**
 * Check if all DAG dependencies for a step are satisfied.
 * Returns a tri-state:
 *   - true: all dependencies are completed → step is eligible
 *   - false: some dependencies are not completed → step is blocked
 *   - null: no DAG dependencies exist → caller should use legacy step_order check
 *
 * WHY tri-state: backward compatibility. Old missions use step_order chains.
 * New decomposed missions use step_dependencies rows. The null return lets
 * getPendingSteps know which path to take without a second query.
 */
async function areAllDependenciesMet(stepId) {
  const { data: deps, error } = await supabase
    .from('step_dependencies')
    .select('depends_on_step_id')
    .eq('step_id', stepId);

  if (error) {
    console.error(`[missions] Error checking DAG deps for step #${stepId}: ${error.message}`);
    return false; // Block on error — safer than running out of order
  }

  // No DAG dependencies → use legacy path
  if (!deps || deps.length === 0) return null;

  // Check each dependency
  for (const dep of deps) {
    const { data: depStep, error: stepErr } = await supabase
      .from('mission_steps')
      .select('status')
      .eq('id', dep.depends_on_step_id)
      .single();

    if (stepErr || !depStep || depStep.status !== 'completed') {
      return false;
    }
  }

  return true;
}

/**
 * Get completed outputs from all predecessor steps (via step_dependencies).
 * Replaces getParentStepResult() for DAG-based steps that may have multiple
 * upstream dependencies instead of a single parent.
 *
 * @param {number} stepId - The step to get predecessor outputs for
 * @returns {Array<{ agentName: string, result: string }>}
 */
async function getPredecessorOutputs(stepId) {
  const { data: deps, error } = await supabase
    .from('step_dependencies')
    .select('depends_on_step_id')
    .eq('step_id', stepId);

  if (error || !deps || deps.length === 0) return [];

  const outputs = [];
  for (const dep of deps) {
    const { data: depStep } = await supabase
      .from('mission_steps')
      .select('result, assigned_agent_id')
      .eq('id', dep.depends_on_step_id)
      .single();

    if (!depStep || !depStep.result) continue;

    // Get agent display name for context header
    const { data: agent } = await supabase
      .from('agents')
      .select('display_name')
      .eq('id', depStep.assigned_agent_id)
      .single();

    outputs.push({
      agentName: agent?.display_name || depStep.assigned_agent_id,
      result: depStep.result.substring(0, 6000) // RAM safety: 6KB per predecessor
    });
  }

  return outputs;
}

// ============================================================
// SMART ROUTING (keyword-based agent assignment)
// ============================================================

/**
 * Determine the best agent role for a task based on keywords.
 * Returns a role category (research, strategy, content, etc.).
 * The caller then finds an agent with that role on the target team.
 */
function routeByKeywords(taskDescription) {
  const lower = taskDescription.toLowerCase();
  const scores = {};

  for (const [role, keywords] of Object.entries(EXPERTISE_MAP)) {
    scores[role] = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        scores[role]++;
      }
    }
  }

  // Find highest scoring role
  let bestRole = null;
  let bestScore = 0;
  for (const [role, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestRole = role;
      bestScore = score;
    }
  }

  return bestRole || 'research'; // Default to research if no match
}

/**
 * Check if all steps for a mission are completed.
 * If so, mark the mission as completed.
 */
async function checkMissionCompletion(missionId) {
  const { data: steps, error } = await supabase
    .from('mission_steps')
    .select('status')
    .eq('mission_id', missionId);

  if (error || !steps) return false;
  if (steps.length === 0) return false;

  const allDone = steps.every(s => s.status === 'completed' || s.status === 'failed');
  if (allDone) {
    const anyFailed = steps.some(s => s.status === 'failed');
    if (anyFailed) {
      await failMission(missionId, 'One or more steps failed');
    } else {
      await completeMission(missionId);
    }
    return true;
  }
  return false;
}

module.exports = {
  // Proposals
  createProposal,
  getPendingProposals,
  acceptProposal,
  rejectProposal,
  // Missions
  createMission,
  getActiveMissions,
  completeMission,
  failMission,
  // Steps
  createStep,
  getPendingSteps,
  claimStep,
  completeStep,
  failStep,
  sendBackForRevision,
  approveStep,
  // Approval chain
  createApproval,
  submitReview,
  getPendingApprovals,
  getStepsNeedingReview,
  // Routing & gap detection
  routeByKeywords,
  canTeamHandle,
  checkMissionCompletion,
  // Revision cap
  countStepRejections,
  // Multi-step mission chains
  parsePhases,
  isPreviousStepComplete,
  getParentStepResult,
  // DAG dependency checking (v0.9.0)
  areAllDependenciesMet,
  getPredecessorOutputs,
  EXPERTISE_MAP,
  ROLE_TITLES,
  ROLE_KEYWORDS
};
