// worker.js — Task execution engine (PM2 process #3)
// WHY: This is the "hands" of the system. It picks up pending mission steps,
// constructs the agent's full prompt (identity + memory + task), calls the LLM,
// saves the result, and triggers the approval chain.
//
// Polling loop: every 10 seconds, check for pending steps.
// One step at a time to stay within 1GB RAM.

require('dotenv').config();
const memory = require('./lib/memory');
const models = require('./lib/models');
const missions = require('./lib/missions');
const conversations = require('./lib/conversations');
const events = require('./lib/events');

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
// STEP PROCESSING
// ============================================================

async function processNextStep() {
  // Get one pending step
  const pendingSteps = await missions.getPendingSteps(1);
  if (pendingSteps.length === 0) return; // Nothing to do

  const step = pendingSteps[0];

  // Claim the step (prevents double-processing)
  const claimed = await missions.claimStep(step.id);
  if (!claimed) {
    console.log(`[worker] Step #${step.id} already claimed, skipping`);
    return;
  }

  console.log(`[worker] Processing step #${step.id}: "${step.description.substring(0, 60)}..."`);
  console.log(`[worker]   Agent: ${step.assigned_agent_id}, Tier: ${step.model_tier}`);

  try {
    // Build the agent's full prompt (identity + memory)
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
      // Handle Manus credits exhausted — needs Tier 3 approval
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
// HELPERS
// ============================================================

/**
 * Extract topic tags from a task description for memory retrieval.
 * Simple keyword extraction — good enough for matching.
 */
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

// Graceful shutdown
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
