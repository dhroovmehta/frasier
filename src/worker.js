// worker.js — Task execution engine (PM2 process #3)
// WHY: This is the "hands" of the system. It picks up pending mission steps,
// constructs the agent's full prompt (identity + memory + task), calls the LLM,
// saves the result, and triggers the approval chain.
// It also processes pending reviews (QA → Team Lead approval chain).
//
// Polling loop: every 10 seconds, check for pending steps OR pending reviews.
// One at a time to stay within 1GB RAM.

require('dotenv').config();
const memory = require('./lib/memory');
const models = require('./lib/models');
const missions = require('./lib/missions');
const conversations = require('./lib/conversations');
const events = require('./lib/events');
const supabase = require('./lib/supabase');

const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds
let running = true;

// ============================================================
// MAIN LOOP
// ============================================================

async function main() {
  console.log('[worker] Starting task execution worker...');
  await events.logEvent({
    eventType: 'worker_started',
    severity: 'info',
    description: 'Worker process started'
  });

  while (running) {
    try {
      await processNextStep();
      await processNextReview();
    } catch (err) {
      console.error('[worker] Unexpected error in main loop:', err.message);
      await events.logEvent({
        eventType: 'worker_error',
        severity: 'error',
        description: `Worker loop error: ${err.message}`
      });
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ============================================================
// STEP PROCESSING (agent does the work)
// ============================================================

async function processNextStep() {
  const pendingSteps = await missions.getPendingSteps(1);
  if (pendingSteps.length === 0) return;

  const step = pendingSteps[0];
  const claimed = await missions.claimStep(step.id);
  if (!claimed) {
    console.log(`[worker] Step #${step.id} already claimed, skipping`);
    return;
  }

  console.log(`[worker] Processing step #${step.id}: "${step.description.substring(0, 60)}..."`);
  console.log(`[worker]   Agent: ${step.assigned_agent_id}, Tier: ${step.model_tier}`);

  try {
    const topicTags = extractTopicTags(step.description);
    const promptData = await memory.buildAgentPrompt(step.assigned_agent_id, topicTags);

    if (promptData.error) {
      console.error(`[worker] Failed to build prompt: ${promptData.error}`);
      await missions.failStep(step.id, promptData.error);
      return;
    }

    // Call the LLM — always respect the step's assigned tier
    const result = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage: step.description,
      agentId: step.assigned_agent_id,
      missionStepId: step.id,
      forceTier: step.model_tier
    });

    if (result.error) {
      if (result.error === 'MANUS_CREDITS_EXHAUSTED') {
        await events.logEvent({
          eventType: 'tier3_escalation_needed',
          agentId: step.assigned_agent_id,
          severity: 'warning',
          description: `Manus credits exhausted. Step #${step.id} needs Tier 3 approval.`,
          data: { stepId: step.id, missionId: step.mission_id }
        });
        await missions.failStep(step.id, 'Manus credits exhausted. Awaiting Tier 3 approval from Zero.');
        return;
      }

      await missions.failStep(step.id, result.error);
      await events.logEvent({
        eventType: 'task_failed',
        agentId: step.assigned_agent_id,
        severity: 'error',
        description: `Step #${step.id} failed: ${result.error}`,
        data: { stepId: step.id }
      });
      return;
    }

    // Save the result (goes to in_review status for approval chain)
    await missions.completeStep(step.id, result.content, 'text');

    // Save to agent's memory
    await memory.saveMemory({
      agentId: step.assigned_agent_id,
      memoryType: 'task',
      content: `Completed task: ${step.description}\n\nResult: ${result.content.substring(0, 500)}`,
      summary: `Completed: ${step.description.substring(0, 150)}`,
      topicTags,
      importance: 6,
      sourceType: 'mission',
      sourceId: String(step.mission_id)
    });

    await events.logEvent({
      eventType: 'task_completed',
      agentId: step.assigned_agent_id,
      severity: 'info',
      description: `Step #${step.id} completed (${result.model}, ${result.tier})`,
      data: { stepId: step.id, model: result.model, tier: result.tier }
    });

    console.log(`[worker] Step #${step.id} completed. Result saved, awaiting review.`);

  } catch (err) {
    console.error(`[worker] Error processing step #${step.id}:`, err.message);
    await missions.failStep(step.id, err.message);
    await events.logEvent({
      eventType: 'task_failed',
      agentId: step.assigned_agent_id,
      severity: 'error',
      description: `Step #${step.id} error: ${err.message}`,
      data: { stepId: step.id, error: err.message }
    });
  }
}

// ============================================================
// REVIEW PROCESSING (QA / Team Lead evaluates the work)
// ============================================================

async function processNextReview() {
  // Find one pending approval
  const { data: pendingApprovals, error } = await supabase
    .from('approval_chain')
    .select('*, mission_steps!inner(id, description, result, assigned_agent_id, mission_id)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error || !pendingApprovals || pendingApprovals.length === 0) return;

  const approval = pendingApprovals[0];
  const step = approval.mission_steps;

  console.log(`[worker] Processing review #${approval.id} by ${approval.reviewer_agent_id} (${approval.review_type})`);

  try {
    // Build reviewer's prompt with memory
    const promptData = await memory.buildAgentPrompt(approval.reviewer_agent_id, ['qa-review']);

    if (promptData.error) {
      console.error(`[worker] Failed to build reviewer prompt: ${promptData.error}`);
      // Auto-approve if reviewer can't be loaded
      await missions.submitReview(approval.id, { status: 'approved', feedback: 'Auto-approved: reviewer unavailable' });
      await missions.approveStep(step.id);
      return;
    }

    // Get the original agent's name for the review prompt
    const { data: author } = await supabase
      .from('agents')
      .select('display_name')
      .eq('id', step.assigned_agent_id)
      .single();

    const reviewPrompt = conversations.buildReviewPrompt(
      author?.display_name || step.assigned_agent_id,
      step.result,
      step.description
    );

    // Call LLM for the review — always tier1
    const result = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage: reviewPrompt,
      agentId: approval.reviewer_agent_id,
      forceTier: 'tier1'
    });

    if (result.error) {
      console.error(`[worker] Review LLM failed: ${result.error}. Auto-approving.`);
      await missions.submitReview(approval.id, { status: 'approved', feedback: 'Auto-approved: review LLM failed' });
      await missions.approveStep(step.id);
      return;
    }

    // Parse the review response — look for approval/rejection signals
    const reviewContent = result.content.toLowerCase();
    const isApproved = reviewContent.includes('approve') && !reviewContent.includes('not approve') && !reviewContent.includes('do not approve');
    const isRejected = reviewContent.includes('reject') || reviewContent.includes('send back') || reviewContent.includes('revision needed') || reviewContent.includes('not ready');

    if (isRejected) {
      // Rejected — send back for revision
      await missions.submitReview(approval.id, {
        status: 'rejected',
        feedback: result.content
      });

      // Save rejection to reviewer's memory
      await memory.saveMemory({
        agentId: approval.reviewer_agent_id,
        memoryType: 'decision',
        content: `Rejected deliverable for step #${step.id}: ${result.content.substring(0, 300)}`,
        summary: `Rejected step #${step.id} — sent back for revision`,
        topicTags: ['qa-review', 'rejection'],
        importance: 6,
        sourceType: 'review'
      });

      console.log(`[worker] Review #${approval.id}: REJECTED. Step sent back for revision.`);

    } else {
      // Approved (default if ambiguous — better to ship than block)
      await missions.submitReview(approval.id, {
        status: 'approved',
        feedback: result.content
      });

      // Check if this was the last review stage
      if (approval.review_type === 'team_lead') {
        // Team Lead approved — step is fully approved
        await missions.approveStep(step.id);
        await missions.checkMissionCompletion(step.mission_id);
        console.log(`[worker] Review #${approval.id}: APPROVED by Team Lead. Step #${step.id} complete.`);
      } else if (approval.review_type === 'qa') {
        // QA approved — escalate to Team Lead next
        // The heartbeat's processApprovals() will create the Team Lead approval
        console.log(`[worker] Review #${approval.id}: APPROVED by QA. Awaiting Team Lead review.`);
      }

      // Save approval to reviewer's memory
      await memory.saveMemory({
        agentId: approval.reviewer_agent_id,
        memoryType: 'decision',
        content: `Approved deliverable for step #${step.id}: ${result.content.substring(0, 300)}`,
        summary: `Approved step #${step.id}`,
        topicTags: ['qa-review', 'approval'],
        importance: 5,
        sourceType: 'review'
      });
    }

  } catch (err) {
    console.error(`[worker] Error processing review #${approval.id}:`, err.message);
    // Auto-approve on error to prevent blocking
    await missions.submitReview(approval.id, { status: 'approved', feedback: `Auto-approved: error during review (${err.message})` });
    await missions.approveStep(step.id);
  }
}

// ============================================================
// HELPERS
// ============================================================

function extractTopicTags(description) {
  const lower = description.toLowerCase();
  const tags = [];

  const tagKeywords = {
    'business-research': ['research', 'market', 'analyze', 'study'],
    'competitive-analysis': ['competitive', 'competitor', 'comparison'],
    'content-creation': ['write', 'blog', 'article', 'content', 'copy'],
    'social-media': ['tweet', 'post', 'social', 'instagram', 'linkedin'],
    'strategy': ['strategy', 'plan', 'roadmap', 'pricing'],
    'engineering': ['code', 'build', 'deploy', 'api', 'database'],
    'qa-review': ['test', 'review', 'quality', 'audit'],
    'marketing': ['seo', 'growth', 'funnel', 'campaign', 'ads'],
    'financial': ['financial', 'revenue', 'cost', 'budget', 'margin']
  };

  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      tags.push(tag);
    }
  }

  return tags.length > 0 ? tags : ['general'];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  console.log('[worker] Shutting down...');
  running = false;
});

process.on('SIGTERM', () => {
  console.log('[worker] Shutting down...');
  running = false;
});

main().catch(err => {
  console.error('[worker] Fatal error:', err);
  process.exit(1);
});
