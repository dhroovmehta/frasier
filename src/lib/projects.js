// projects.js — Project lifecycle management
// WHY: Without this, every message creates an isolated mission with no cross-mission linking.
// Projects group missions into lifecycle phases that auto-advance when work completes.
//
// Lifecycle: discovery → requirements → design → build → test → deploy → completed

const supabase = require('./supabase');
const events = require('./events');

// Phase sequence — ordered, cannot skip or reverse
const PHASES = ['discovery', 'requirements', 'design', 'build', 'test', 'deploy'];

// Stop words to exclude from keyword matching
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
  'or', 'if', 'while', 'about', 'up', 'it', 'its', 'this', 'that',
  'what', 'which', 'who', 'whom', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they',
  'them', 'their', 'continue', 'work', 'make', 'get', 'want', 'need'
]);

// ============================================================
// PROJECT CRUD
// ============================================================

/**
 * Create a new project.
 * @param {Object} params
 * @param {string} params.name - Project name
 * @param {string} [params.description] - Project description
 * @param {string} [params.originalMessage] - Zero's original request
 * @param {string} [params.businessId] - Business unit (default: 'nerv')
 * @returns {Object|null} Created project
 */
async function createProject({
  name,
  description = null,
  originalMessage = null,
  businessId = 'nerv'
}) {
  const { data, error } = await supabase
    .from('projects')
    .insert({
      name,
      description,
      original_message: originalMessage,
      business_id: businessId,
      status: 'active',
      phase: 'discovery'
    })
    .select()
    .single();

  if (error) {
    console.error('[projects] Failed to create project:', error.message);
    return null;
  }

  console.log(`[projects] Project #${data.id} created: "${name}" (phase: discovery)`);
  return data;
}

/**
 * Get a project by ID.
 */
async function getProject(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();

  if (error) return null;
  return data;
}

/**
 * Get all active projects.
 */
async function getActiveProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[projects] Failed to get active projects:', error.message);
    return [];
  }
  return data || [];
}

// ============================================================
// PHASE MANAGEMENT
// ============================================================

/**
 * Advance a project to the next phase in the sequence.
 * discovery → requirements → design → build → test → deploy → completed
 *
 * @param {number} projectId
 * @returns {Object|null} Updated project, or null on error
 */
async function advanceProjectPhase(projectId) {
  const project = await getProject(projectId);
  if (!project) return null;

  const currentIndex = PHASES.indexOf(project.phase);

  // If on last phase (deploy), mark as completed
  if (currentIndex === PHASES.length - 1) {
    const { data } = await supabase
      .from('projects')
      .update({
        phase: 'completed',
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', projectId)
      .select()
      .single();

    console.log(`[projects] Project #${projectId} completed!`);

    // Log project_completed event for Discord announcements
    await events.logEvent({
      eventType: 'project_completed',
      severity: 'info',
      description: `Project "${project.name}" completed — all phases delivered`,
      data: { projectId, projectName: project.name }
    });

    return data;
  }

  // If already completed or phase not found, can't advance
  if (currentIndex === -1) return null;

  const nextPhase = PHASES[currentIndex + 1];
  const { data } = await supabase
    .from('projects')
    .update({
      phase: nextPhase,
      updated_at: new Date().toISOString()
    })
    .eq('id', projectId)
    .select()
    .single();

  console.log(`[projects] Project #${projectId} advanced: ${project.phase} → ${nextPhase}`);

  // Log phase advancement event for Discord announcements
  await events.logEvent({
    eventType: 'project_phase_advanced',
    severity: 'info',
    description: `Project "${project.name}" advanced from ${project.phase} to ${nextPhase}`,
    data: { projectId, fromPhase: project.phase, toPhase: nextPhase }
  });

  return data;
}

/**
 * Set a project to a specific phase (only forward movement allowed).
 * Returns null if trying to go backwards.
 *
 * @param {number} projectId
 * @param {string} targetPhase
 * @returns {Object|null} Updated project, or null if invalid
 */
async function setProjectPhase(projectId, targetPhase) {
  const project = await getProject(projectId);
  if (!project) return null;

  const currentIndex = PHASES.indexOf(project.phase);
  const targetIndex = PHASES.indexOf(targetPhase);

  // Can't go backwards
  if (targetIndex <= currentIndex) return null;

  const { data } = await supabase
    .from('projects')
    .update({
      phase: targetPhase,
      updated_at: new Date().toISOString()
    })
    .eq('id', projectId)
    .select()
    .single();

  return data;
}

// ============================================================
// MISSION LINKING
// ============================================================

/**
 * Link a mission to a project phase.
 */
async function linkMissionToProject(projectId, missionId, phase) {
  const { data, error } = await supabase
    .from('project_missions')
    .insert({
      project_id: projectId,
      mission_id: missionId,
      phase
    })
    .select()
    .single();

  if (error) {
    console.error(`[projects] Failed to link mission #${missionId} to project #${projectId}:`, error.message);
    return null;
  }

  console.log(`[projects] Mission #${missionId} linked to project #${projectId} (phase: ${phase})`);
  return data;
}

/**
 * Get all missions linked to a project.
 */
async function getProjectMissions(projectId) {
  const { data, error } = await supabase
    .from('project_missions')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[projects] Failed to get project missions:', error.message);
    return [];
  }
  return data || [];
}

// ============================================================
// PROJECT CONTEXT (accumulated knowledge)
// ============================================================

/**
 * Save context from a completed mission phase.
 */
async function saveProjectContext({
  projectId,
  phase,
  contextType,
  content,
  sourceMissionId = null,
  sourceStepId = null
}) {
  const { data, error } = await supabase
    .from('project_context')
    .insert({
      project_id: projectId,
      phase,
      context_type: contextType,
      content,
      source_mission_id: sourceMissionId,
      source_step_id: sourceStepId
    })
    .select()
    .single();

  if (error) {
    console.error('[projects] Failed to save project context:', error.message);
    return null;
  }
  return data;
}

/**
 * Get all context for a project (all phases).
 */
async function getProjectContext(projectId) {
  const { data, error } = await supabase
    .from('project_context')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[projects] Failed to get project context:', error.message);
    return [];
  }
  return data || [];
}

// ============================================================
// PROJECT DETECTION (match messages to existing projects)
// ============================================================

/**
 * Detect if a message relates to an existing active project.
 * Uses keyword overlap between the message and project name/description.
 *
 * @param {string} message - The incoming message to match
 * @returns {Object|null} Best matching project, or null if no match
 */
async function detectExistingProject(message) {
  const activeProjects = await getActiveProjects();
  if (activeProjects.length === 0) return null;

  const messageWords = extractKeywords(message);
  if (messageWords.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const project of activeProjects) {
    const projectWords = extractKeywords(
      `${project.name} ${project.description || ''} ${project.original_message || ''}`
    );

    // Count overlapping keywords
    const overlap = messageWords.filter(w => projectWords.includes(w)).length;
    const score = overlap / Math.max(messageWords.length, 1);

    if (score > bestScore && overlap >= 2) {
      bestScore = score;
      bestMatch = project;
    }
  }

  return bestMatch;
}

/**
 * Extract meaningful keywords from text (excluding stop words).
 */
function extractKeywords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ============================================================
// PROMPT CONTEXT BUILDER
// ============================================================

/**
 * Build formatted project context for injection into agent prompts.
 * Includes project name, current phase, and accumulated context from prior phases.
 *
 * @param {number} projectId
 * @returns {string} Formatted project context, or empty string if not found
 */
async function buildProjectContextForPrompt(projectId) {
  const project = await getProject(projectId);
  if (!project) return '';

  const contexts = await getProjectContext(projectId);

  const parts = [
    `## PROJECT CONTEXT: ${project.name}`,
    `Current Phase: ${project.phase}`,
    `Status: ${project.status}`
  ];

  if (project.original_message) {
    parts.push(`\nOriginal Request: "${project.original_message}"`);
  }

  if (contexts.length > 0) {
    parts.push('\n### Prior Phase Outputs');
    for (const ctx of contexts) {
      parts.push(`\n**[${ctx.phase}] ${ctx.context_type}:**`);
      parts.push(ctx.content.substring(0, 2000));
    }
  }

  return parts.join('\n');
}

// ============================================================
// PHASE COMPLETION CHECK
// ============================================================

/**
 * Check if all missions in the current project phase are completed.
 * If so, advance to the next phase.
 *
 * @param {number} projectId
 * @returns {boolean} true if phase was advanced
 */
async function checkPhaseCompletion(projectId) {
  const project = await getProject(projectId);
  if (!project || project.status !== 'active') return false;

  // Get all missions in the current phase
  const phaseMissions = await getProjectMissions(projectId);
  const currentPhaseMissions = phaseMissions.filter(pm => pm.phase === project.phase);

  if (currentPhaseMissions.length === 0) return false;

  // Check if all missions in this phase are completed
  for (const pm of currentPhaseMissions) {
    const { data: mission } = await supabase
      .from('missions')
      .select('status')
      .eq('id', pm.mission_id)
      .single();

    if (!mission || (mission.status !== 'completed' && mission.status !== 'failed')) {
      return false;
    }
  }

  // All done — advance phase
  await advanceProjectPhase(projectId);
  return true;
}

module.exports = {
  PHASES,
  createProject,
  getProject,
  getActiveProjects,
  advanceProjectPhase,
  setProjectPhase,
  linkMissionToProject,
  getProjectMissions,
  saveProjectContext,
  getProjectContext,
  detectExistingProject,
  buildProjectContextForPrompt,
  checkPhaseCompletion
};
