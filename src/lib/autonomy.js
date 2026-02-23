// autonomy.js — Policy-driven auto-approval for mission steps
// WHY: Currently every step requires QA → Team Lead approval (heartbeat.js:614-678),
// forcing Dhroov to shepherd every mission. This module checks whether a step can
// auto-approve based on its self-critique score and whether it's the final step.
//
// RULES (from policy table):
// - Intermediate step + critique >= 4.0 → auto-approve (skip all review)
// - Intermediate step + critique >= 3.0 → QA-only (skip Team Lead)
// - Final step → always full review (QA + Team Lead)
// - Tier 3 step → always full review
// - Policy disabled → no auto-approve
//
// Integration: ~15 lines at top of heartbeat.js:processApprovals()

const supabase = require('./supabase');

// ============================================================
// IS FINAL STEP
// ============================================================

/**
 * Determine if a step is the last step in its mission.
 * Final steps always get full review — Dhroov sees the completed deliverable.
 *
 * @param {Object} step - The mission step { id, mission_id, step_order }
 * @returns {boolean}
 */
async function isFinalStep(step) {
  const { data, error } = await supabase
    .from('mission_steps')
    .select()
    .eq('mission_id', step.mission_id)
    .order('step_order', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return true; // Safe default: treat as final

  return data[0].id === step.id;
}

// ============================================================
// GET AUTONOMY POLICY
// ============================================================

/**
 * Fetch the autonomy policy from the policy table.
 * Returns null if no policy exists.
 */
async function getPolicy() {
  const { data, error } = await supabase
    .from('policy')
    .select()
    .eq('policy_type', 'autonomy')
    .maybeSingle();

  if (error || !data) return null;
  return data.rules;
}

// ============================================================
// GET CRITIQUE SCORE
// ============================================================

/**
 * Get the critique score for a step from pipeline_phases.
 * Returns null if no critique phase exists (step ran before pipeline upgrade).
 */
async function getCritiqueScore(stepId) {
  const { data, error } = await supabase
    .from('pipeline_phases')
    .select()
    .eq('mission_step_id', stepId)
    .eq('phase_name', 'critique')
    .maybeSingle();

  if (error || !data) return null;
  return data.score;
}

// ============================================================
// SHOULD AUTO-APPROVE
// ============================================================

/**
 * Determine whether a completed step should auto-approve, get QA-only review,
 * or go through the full review chain.
 *
 * @param {Object} step - The completed mission step
 * @returns {{ autoApprove: boolean, qaOnly: boolean, score: number|null, reason: string }}
 */
async function shouldAutoApprove(step) {
  // 1. Check policy exists and is enabled
  const policy = await getPolicy();
  if (!policy) {
    return { autoApprove: false, qaOnly: false, score: null, reason: 'no policy found' };
  }
  if (!policy.enabled) {
    return { autoApprove: false, qaOnly: false, score: null, reason: 'autonomy disabled' };
  }

  // 2. Always full review for tier3 (high-stakes) steps
  if (policy.always_review_tier3 && step.model_tier === 'tier3') {
    return { autoApprove: false, qaOnly: false, score: null, reason: 'tier3 step — always full review' };
  }

  // 3. Always full review for final step
  if (policy.always_review_final) {
    const final = await isFinalStep(step);
    if (final) {
      return { autoApprove: false, qaOnly: false, score: null, reason: 'final step — always full review' };
    }
  }

  // 4. Check critique score
  const score = await getCritiqueScore(step.id);
  if (score === null) {
    return { autoApprove: false, qaOnly: false, score: null, reason: 'no critique score — full review' };
  }

  // 5. Apply thresholds
  if (score >= policy.auto_approve_threshold) {
    return { autoApprove: true, qaOnly: false, score, reason: `auto-approve (score ${score} >= ${policy.auto_approve_threshold})` };
  }

  if (score >= policy.qa_only_threshold) {
    return { autoApprove: false, qaOnly: true, score, reason: `QA-only review (score ${score} >= ${policy.qa_only_threshold})` };
  }

  return { autoApprove: false, qaOnly: false, score, reason: `full review (score ${score} < ${policy.qa_only_threshold})` };
}

module.exports = {
  shouldAutoApprove,
  isFinalStep
};
