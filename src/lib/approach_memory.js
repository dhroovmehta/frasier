// approach_memory.js — "What worked before" for agent task decomposition
// WHY: When an agent decomposes a new task, knowing which search queries produced
// good data and which decomposition strategies scored well on similar tasks makes
// the agent sharper from day one. Agents accumulate judgment, not just facts.
//
// This is ZERO additional LLM calls — pure database retrieval + insertion.
// Uses PostgreSQL array overlap on topic_tags (same pattern as memory.js:257-273).

const supabase = require('./supabase');

const MAX_TASK_SUMMARY_LENGTH = 500;

// ============================================================
// SAVE APPROACH
// ============================================================

/**
 * Save a completed approach to approach_memory after a step finishes.
 * Called at the end of pipeline execution — captures what the agent did
 * and how well it worked (critique score).
 *
 * @param {Object} params
 * @param {string} params.agentId
 * @param {number} params.missionStepId
 * @param {string} params.taskSummary - Truncated task description
 * @param {string[]} params.topicTags - Tags for similarity matching
 * @param {Object} params.decomposition - Sub-questions identified
 * @param {string[]} params.searchQueries - All queries used
 * @param {string[]} params.effectiveQueries - Queries that produced useful data
 * @param {number} params.critiqueScore - How well the approach worked (1-5)
 * @param {string} [params.approachNotes] - Optional notes
 */
async function save({
  agentId,
  missionStepId,
  taskSummary,
  topicTags = [],
  decomposition = {},
  searchQueries = [],
  effectiveQueries = [],
  critiqueScore,
  approachNotes = null
}) {
  // Truncate task summary to prevent bloating the table
  const truncatedSummary = taskSummary.length > MAX_TASK_SUMMARY_LENGTH
    ? taskSummary.substring(0, MAX_TASK_SUMMARY_LENGTH)
    : taskSummary;

  const { error } = await supabase.from('approach_memory').insert({
    agent_id: agentId,
    mission_step_id: missionStepId,
    task_summary: truncatedSummary,
    topic_tags: topicTags,
    decomposition,
    search_queries: searchQueries,
    effective_queries: effectiveQueries,
    critique_score: critiqueScore,
    approach_notes: approachNotes
  });

  if (error) {
    console.error(`[approach_memory] Failed to save approach for agent ${agentId}, step #${missionStepId}: ${error.message}`);
  } else {
    console.log(`[approach_memory] Saved approach for agent ${agentId} (score: ${critiqueScore})`);
  }
}

// ============================================================
// FIND SIMILAR APPROACHES
// ============================================================

/**
 * Find past approaches with overlapping topic tags for the same agent.
 * Returns the best-performing approaches first (highest critique score).
 *
 * @param {Object} params
 * @param {string} params.agentId
 * @param {string[]} params.topicTags - Tags to match against
 * @param {number} [params.limit=3] - Max approaches to return
 * @returns {Array} Matching approaches, best scores first
 */
async function findSimilar({ agentId, topicTags = [], limit = 3 }) {
  if (topicTags.length === 0) return [];

  const { data, error } = await supabase
    .from('approach_memory')
    .select()
    .eq('agent_id', agentId)
    .overlaps('topic_tags', topicTags)
    .order('critique_score', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[approach_memory] Failed to find similar approaches: ${error.message}`);
    return [];
  }

  return data || [];
}

// ============================================================
// FORMAT FOR PROMPT INJECTION
// ============================================================

/**
 * Format approach memory results as text that can be injected into
 * the decompose prompt. Gives the agent context about what worked before.
 *
 * @param {Array} approaches - Results from findSimilar()
 * @returns {string} Formatted text for prompt injection, or empty string
 */
function formatForPrompt(approaches) {
  if (!approaches || approaches.length === 0) return '';

  const lines = ['Here are approaches that worked well on similar tasks:\n'];

  for (const approach of approaches) {
    lines.push(`**Task:** ${approach.task_summary}`);
    lines.push(`**Score:** ${approach.critique_score}/5`);

    if (approach.decomposition && approach.decomposition.subQuestions) {
      lines.push(`**Sub-questions used:** ${approach.decomposition.subQuestions.join('; ')}`);
    }

    if (approach.effective_queries && approach.effective_queries.length > 0) {
      lines.push(`**Search queries that produced good data:** ${approach.effective_queries.join('; ')}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  save,
  findSimilar,
  formatForPrompt
};
