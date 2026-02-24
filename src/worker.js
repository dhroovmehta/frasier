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
const skills = require('./lib/skills');
const web = require('./lib/web');
const social = require('./lib/social');
const agents = require('./lib/agents');
const context = require('./lib/context');
const pipeline = require('./lib/pipeline');
const approachMemory = require('./lib/approach_memory');
const linear = require('./lib/linear');
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
  // Claim up to 3 eligible steps per tick (v0.9.0 parallel execution)
  const pendingSteps = await missions.getPendingSteps(3);
  if (pendingSteps.length === 0) return;

  // Claim all eligible steps, then execute sequentially (not Promise.all — 1GB RAM)
  const claimedSteps = [];
  for (const step of pendingSteps) {
    const claimed = await missions.claimStep(step.id);
    if (claimed) {
      claimedSteps.push(step);
    } else {
      console.log(`[worker] Step #${step.id} already claimed, skipping`);
    }
  }

  if (claimedSteps.length === 0) return;
  console.log(`[worker] Claimed ${claimedSteps.length} step(s) this tick`);

  for (const step of claimedSteps) {
    await executeStep(step);
  }
}

/**
 * Execute a single claimed step. Extracted from processNextStep for
 * sequential multi-step execution (v0.9.0).
 */
async function executeStep(step) {
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

    // PRE-FETCH: Auto-fetch any URLs in the task description before the LLM call.
    // WHY: If Zero pastes a tweet or article link, the agent needs the actual content,
    // not the URL string. Twitter/X URLs get rewritten to fxtwitter for access.
    const { enrichedText } = await web.prefetchUrls(step.description);

    // Get the agent's role for context enrichment
    const agent = await agents.getAgent(step.assigned_agent_id);
    const agentRole = agent ? agent.role : 'General';

    // CONTEXT ENRICHMENT: Build rich task context with Zero's original request,
    // domain-specific quality mandates, output templates, and quality standards.
    // This replaces raw task description with a structured, role-aware prompt.
    const enrichedStep = { ...step, description: enrichedText };
    let userMessage = await context.buildTaskContext(enrichedStep, agentRole);

    // CHAIN CONTEXT: Inject predecessor outputs for context continuity.
    // v0.9.0 DAG path: multiple predecessors via step_dependencies table.
    // Legacy path: single parent via parent_step_id column.
    const predecessorOutputs = await missions.getPredecessorOutputs(step.id);
    if (predecessorOutputs.length > 0) {
      // DAG path — inject all predecessor outputs
      const contextParts = predecessorOutputs.map(p =>
        `## PREDECESSOR OUTPUT (from ${p.agentName})\n${p.result}`
      );
      userMessage = `${contextParts.join('\n\n---\n\n')}\n\n---\n\n${userMessage}`;
      console.log(`[worker] Step #${step.id}: Injected ${predecessorOutputs.length} DAG predecessor context(s)`);
    } else if (step.parent_step_id) {
      // Legacy path — single parent step
      const parentData = await missions.getParentStepResult(step.parent_step_id);
      if (parentData) {
        const truncatedResult = parentData.result.substring(0, 6000);
        userMessage = `## PREVIOUS PHASE OUTPUT (from ${parentData.agentName})\nThe following is the completed output from the previous phase. Use it as foundation:\n---\n${truncatedResult}\n---\n\n${userMessage}`;
        console.log(`[worker] Step #${step.id}: Injected parent step #${step.parent_step_id} context (${truncatedResult.length} chars)`);
      }
    }

    // AUTO TIER SELECTION: Upgrade tier based on task complexity if step uses default tier.
    // Only override if step was assigned tier1 (the default) — explicit tier2/tier3 assignments are respected.
    let effectiveTier = step.model_tier;
    if (step.model_tier === 'tier1') {
      const isFinalStep = await isLastStepInMission(step);
      const autoTier = models.selectTier(false, step.description, { isFinalStep });
      if (autoTier === 'tier2') {
        effectiveTier = 'tier2';
        console.log(`[worker] Step #${step.id}: Auto-upgraded to tier2 (${isFinalStep ? 'final step' : 'complex task'})`);
      }
    }

    // DEEP WORK PIPELINE: Multi-phase execution replaces the old single LLM call.
    // WHY: Single-shot calls produced hallucinated, surface-level output. The pipeline
    // forces: decompose → web research → synthesize → self-critique → (revise if needed).
    // Config determines which phases run based on task type.
    const pipelineConfig = determinePipelineConfig(step, agentRole);
    console.log(`[worker] Step #${step.id}: Pipeline config: ${JSON.stringify(pipelineConfig)}`);

    const pipelineResult = await pipeline.execute({
      step,
      promptData,
      userMessage,
      effectiveTier,
      config: pipelineConfig
    });

    if (pipelineResult.error) {
      await missions.failStep(step.id, pipelineResult.error);
      await events.logEvent({
        eventType: 'task_failed',
        agentId: step.assigned_agent_id,
        severity: 'error',
        description: `Step #${step.id} failed: ${pipelineResult.error}`,
        data: { stepId: step.id }
      });
      return;
    }

    let finalContent = pipelineResult.content;

    // SOCIAL MEDIA: Check if the agent wants to post content via [SOCIAL_POST:] tags
    // WHY: Agents (especially Faye) can create social content and queue it to Buffer.
    await social.resolveSocialTags(finalContent, step.assigned_agent_id);

    // Save the result (goes to in_review status for approval chain)
    await missions.completeStep(step.id, finalContent, 'text');

    // Save to agent's memory
    await memory.saveMemory({
      agentId: step.assigned_agent_id,
      memoryType: 'task',
      content: `Completed task: ${step.description}\n\nResult: ${finalContent.substring(0, 500)}`,
      summary: `Completed: ${step.description.substring(0, 150)}`,
      topicTags,
      importance: 6,
      sourceType: 'mission',
      sourceId: String(step.mission_id)
    });

    // Track skill usage — agent grows through doing
    await skills.trackSkillUsage(step.assigned_agent_id, step.description);

    // LESSON + APPROACH MEMORY: Extract lesson from self-critique (no extra LLM call)
    // and save approach memory for future task decomposition.
    // WHY: Old system only learned every 5th task via an extra LLM call.
    // Now every task learns from its own self-critique, for free.
    await generateLessonFromCritique(step, pipelineResult, topicTags);
    await saveApproachMemory(step, pipelineResult, topicTags);

    await events.logEvent({
      eventType: 'task_completed',
      agentId: step.assigned_agent_id,
      severity: 'info',
      description: `Step #${step.id} completed (${effectiveTier}, critique: ${pipelineResult.critiqueScore || 'n/a'}, revised: ${pipelineResult.revised})`,
      data: { stepId: step.id, tier: effectiveTier, critiqueScore: pipelineResult.critiqueScore, revised: pipelineResult.revised, phases: pipelineResult.phases?.length }
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

    // ENHANCED REVIEW: Inject Zero's original request and use rubric-based scoring.
    // WHY: Old reviews were shallow pass/fail. New reviews score 5 criteria and
    // auto-reject on low scores, even if the reviewer says "approve".
    const originalMessage = await context.getOriginalMessage(step.mission_id);
    const reviewPrompt = conversations.buildEnhancedReviewPrompt(
      author?.display_name || step.assigned_agent_id,
      step.result,
      step.description,
      originalMessage
    );

    // Team Lead reviews use tier2 for better quality judgment; QA uses tier1
    const reviewTier = approval.review_type === 'team_lead' ? 'tier2' : 'tier1';
    const result = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage: reviewPrompt,
      agentId: approval.reviewer_agent_id,
      forceTier: reviewTier
    });

    if (result.error) {
      console.error(`[worker] Review LLM failed: ${result.error}. Auto-approving.`);
      await missions.submitReview(approval.id, { status: 'approved', feedback: 'Auto-approved: review LLM failed' });
      await missions.approveStep(step.id);
      return;
    }

    // Parse the structured review — extracts scores, verdict, and feedback
    const parsedReview = conversations.parseEnhancedReview(result.content);
    const isRejected = parsedReview.verdict === 'reject';

    if (parsedReview.autoRejected) {
      console.log(`[worker] Review #${approval.id}: Auto-rejected (overall score ${parsedReview.overallScore}/5 < 3)`);
    }

    if (isRejected) {
      // 3-STRIKE REVISION CAP: Count past rejections before recording this one.
      // WHY: Without a cap, QA can reject indefinitely (e.g., mission #75 looped 3+ times).
      // After 3 total rejections, fail the step and escalate to the founder.
      const pastRejections = await missions.countStepRejections(step.id);
      const totalRejections = pastRejections + 1; // including this rejection

      // Post rejection feedback as a comment on the Linear ticket
      // WHY: Dhroov wants each rejection visible in Linear, not just Discord
      const rejectionComment = `**Rejection #${totalRejections}** (${approval.review_type})\n\n${result.content.substring(0, 1500)}`;
      linear.addIssueComment(step.id, rejectionComment).catch(err =>
        console.error(`[linear] Rejection comment failed (non-blocking): ${err.message}`)
      );

      // Record the review (always — for audit trail)
      await missions.submitReview(approval.id, {
        status: 'rejected',
        feedback: result.content
      });

      if (totalRejections >= 3) {
        // CAP REACHED: submitReview already sent back for revision (via sendBackForRevision),
        // so we override by immediately failing the step. One extra DB write, but correct.
        await missions.failStep(step.id, `Revision cap reached (${totalRejections} rejections). Escalating to founder.`);

        await events.logEvent({
          eventType: 'revision_cap_reached',
          agentId: step.assigned_agent_id,
          severity: 'warning',
          description: `Step #${step.id} failed after ${totalRejections} rejections. Task: "${step.description.substring(0, 100)}"`,
          data: { stepId: step.id, missionId: step.mission_id, rejectionCount: totalRejections }
        });

        console.log(`[worker] Review #${approval.id}: REJECTED (${totalRejections}x). REVISION CAP REACHED. Step failed, escalating.`);

      } else {
        // Normal rejection flow — save memories and lessons
        await memory.saveMemory({
          agentId: approval.reviewer_agent_id,
          memoryType: 'decision',
          content: `Rejected deliverable for step #${step.id}: ${result.content.substring(0, 300)}`,
          summary: `Rejected step #${step.id} — sent back for revision (${totalRejections}/3)`,
          topicTags: ['qa-review', 'rejection'],
          importance: 6,
          sourceType: 'review'
        });

        // LESSON FROM REJECTION: The original agent learns from the feedback.
        // WHY: Rejection feedback is the highest-value learning signal.
        await generateLessonFromRejection(
          step.assigned_agent_id,
          step.description,
          result.content
        );

        // PERSONA UPSKILLING: If an agent fails 5+ times on the same step, their persona
        // is permanently upgraded with new expertise. (With 3-strike cap, this naturally
        // never triggers — but kept for safety in case the cap is raised later.)
        await maybeUpskillAgent(step.id, step.assigned_agent_id, step.description);

        console.log(`[worker] Review #${approval.id}: REJECTED (${totalRejections}/3). Step sent back for revision.`);
      }

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

      // Track reviewer's skill growth — reviewing builds QA expertise
      await skills.trackSkillUsage(approval.reviewer_agent_id, 'quality review audit validate');
    }

  } catch (err) {
    console.error(`[worker] Error processing review #${approval.id}:`, err.message);
    // Auto-approve on error to prevent blocking
    await missions.submitReview(approval.id, { status: 'approved', feedback: `Auto-approved: error during review (${err.message})` });
    await missions.approveStep(step.id);
  }
}

// ============================================================
// LESSON GENERATION (how agents get smarter over time)
// ============================================================

/**
 * Every 5th completed task, ask the agent to reflect and distill a lesson.
 * Lessons are always included in future prompts (top 5 by importance),
 * so they compound — the agent genuinely improves over time.
 *
 * Cheap: one Tier 1 call (~$0.001) per 5 tasks.
 */
async function maybeGenerateLesson(agentId, taskDescription, taskResult, promptData) {
  try {
    // Count this agent's task memories
    const { count, error } = await supabase
      .from('agent_memories')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('memory_type', 'task');

    if (error || !count) return;

    // Only reflect every 5th task
    if (count % 5 !== 0) return;

    console.log(`[worker] ${agentId} has ${count} tasks — triggering reflection...`);

    const reflectionPrompt = `You just completed your ${count}th task. Take a moment to reflect.

Your most recent task was:
"${taskDescription}"

Your output (summary):
"${taskResult.substring(0, 600)}"

Based on your accumulated experience (not just this task), distill ONE concise lesson you've learned. This lesson will be remembered permanently and influence all your future work.

Format: Start with the lesson in one sentence, then optionally add 1-2 sentences of context.
Example: "Always include competitor pricing when doing market analysis — without it, the research feels incomplete and gets sent back for revision."

Your lesson:`;

    const result = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage: reflectionPrompt,
      agentId,
      forceTier: 'tier1'
    });

    if (result.error || !result.content) return;

    // Extract the lesson (first sentence or first 300 chars)
    const lessonText = result.content.trim();
    const firstSentence = lessonText.split(/[.!?]\s/)[0] + '.';

    await memory.saveLesson({
      agentId,
      lesson: lessonText.substring(0, 500),
      context: `Reflected after ${count} completed tasks. Last task: "${taskDescription.substring(0, 150)}"`,
      category: extractTopicTags(taskDescription)[0] || 'general',
      importance: 7
    });

    console.log(`[worker] Lesson saved for ${agentId}: "${firstSentence.substring(0, 80)}..."`);

  } catch (err) {
    // Lesson generation is non-critical — never fail the task over it
    console.error(`[worker] Lesson generation failed for ${agentId}: ${err.message}`);
  }
}

/**
 * When QA rejects an agent's work, distill the feedback into a lesson.
 * No extra LLM call needed — the rejection feedback IS the lesson.
 * These are high-value: "my research lacked X" prevents the same mistake.
 */
async function generateLessonFromRejection(agentId, taskDescription, rejectionFeedback) {
  try {
    // Extract the key criticism from the rejection
    const lesson = `Work rejected: "${taskDescription.substring(0, 100)}". Feedback: ${rejectionFeedback.substring(0, 400)}`;

    await memory.saveLesson({
      agentId,
      lesson,
      context: `QA rejection feedback for task: "${taskDescription.substring(0, 150)}"`,
      category: 'quality',
      importance: 8 // Higher importance — rejection lessons are the most valuable
    });

    console.log(`[worker] Rejection lesson saved for ${agentId}`);

  } catch (err) {
    console.error(`[worker] Rejection lesson failed for ${agentId}: ${err.message}`);
  }
}

// ============================================================
// PERSONA UPSKILLING (how agents permanently grow through failure)
// ============================================================

/**
 * After each rejection, check if this step has been rejected 5+ times.
 * If so, analyze all rejection feedback, identify the skill gap, and
 * append new expertise directly to the agent's SEP persona prompt.
 *
 * WHY persona modification instead of lessons:
 * - The persona is ALWAYS in the system prompt (100% retrieval rate)
 * - Lessons compete for the top 5 slots out of potentially hundreds
 * - The persona defines WHO the agent IS — upgrading it changes their identity
 * - An agent who "is" an expert behaves differently than one who "remembers" a tip
 *
 * Cost: One Tier 1 LLM call (~$0.001) per upskill event. Rare — only triggers
 * after 5 rejections on the same step, which should be uncommon.
 */
async function maybeUpskillAgent(stepId, agentId, taskDescription) {
  try {
    // Count how many times this specific step has been rejected
    const { data: rejections, error } = await supabase
      .from('approval_chain')
      .select('feedback')
      .eq('mission_step_id', stepId)
      .eq('status', 'rejected')
      .order('reviewed_at', { ascending: true });

    if (error || !rejections || rejections.length < 5) return;

    // Only trigger on exactly the 5th rejection (not 6th, 7th, etc.)
    // WHY: One upskill per step is enough. The upgraded persona should fix it.
    if (rejections.length !== 5) return;

    console.log(`[worker] Step #${stepId} rejected 5 times. Upskilling ${agentId}...`);

    // Fetch the agent's current persona
    const personaData = await memory.getAgentPersona(agentId);
    if (!personaData || !personaData.persona) {
      console.error(`[worker] Cannot upskill ${agentId}: no persona found`);
      return;
    }

    // Combine all 5 rejection feedbacks for analysis
    const feedbackSummary = rejections
      .map((r, i) => `Rejection ${i + 1}: ${(r.feedback || 'No feedback').substring(0, 300)}`)
      .join('\n\n');

    // Ask LLM to analyze the pattern and identify the skill gap
    const analysisPrompt = `You are analyzing repeated quality failures for an AI agent.

The agent "${personaData.agent.display_name}" (role: ${personaData.agent.role}) has failed the same task 5 times.

TASK: "${taskDescription}"

REJECTION FEEDBACK (all 5 attempts):
${feedbackSummary}

Based on these rejections, identify:
1. The specific skill gap or knowledge area the agent is missing
2. A concise expertise addition (2-4 sentences) that would fix this gap

Format your response EXACTLY like this:
SKILL_GAP: [one-line description of what's missing]
EXPERTISE_ADDITION: [2-4 sentences describing the new expertise to add to the agent's persona. Write in second person ("You have expertise in..."). Be specific and actionable.]`;

    const analysis = await models.callLLM({
      systemPrompt: 'You are a talent development specialist. Analyze failure patterns and prescribe precise skill upgrades.',
      userMessage: analysisPrompt,
      agentId: 'system',
      forceTier: 'tier1'
    });

    if (analysis.error || !analysis.content) {
      console.error(`[worker] Upskill analysis failed for ${agentId}: ${analysis.error}`);
      return;
    }

    // Parse the LLM response
    const skillGapMatch = analysis.content.match(/SKILL_GAP:\s*(.+)/i);
    const expertiseMatch = analysis.content.match(/EXPERTISE_ADDITION:\s*([\s\S]+?)(?=$|\n\n)/i);

    const skillGap = skillGapMatch ? skillGapMatch[1].trim() : 'unspecified skill gap';
    const expertiseAddition = expertiseMatch
      ? expertiseMatch[1].trim()
      : analysis.content.substring(0, 300); // Fallback: use raw response

    // Append the new expertise to the existing persona
    const currentSep = personaData.persona.full_sep_prompt;
    const upskillBlock = `\n\n═══════════════════════════════════════════════
LEARNED EXPERTISE (acquired through experience)
═══════════════════════════════════════════════
[Upskilled: ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}]
${expertiseAddition}`;

    const upgradedSep = currentSep + upskillBlock;

    // Save as new persona row (preserves history — old persona still exists)
    const newPersona = await agents.savePersona({
      agentId,
      agentMd: personaData.persona.agent_md,
      soulMd: personaData.persona.soul_md,
      skillsMd: (personaData.persona.skills_md || '') + `\n- ${skillGap}`,
      identityMd: personaData.persona.identity_md,
      fullSepPrompt: upgradedSep
    });

    if (!newPersona) {
      console.error(`[worker] Failed to save upgraded persona for ${agentId}`);
      return;
    }

    // Log event so Discord picks it up and notifies Zero
    await events.logEvent({
      eventType: 'agent_upskilled',
      agentId,
      severity: 'info',
      description: `${personaData.agent.display_name} upskilled: ${skillGap}. Persona upgraded, retrying task.`,
      data: {
        stepId,
        skillGap,
        expertiseAddition,
        rejectionCount: 5,
        oldPersonaId: personaData.persona.id,
        newPersonaId: newPersona.id
      }
    });

    // Save to agent's memory so they "remember" the growth
    await memory.saveMemory({
      agentId,
      memoryType: 'lesson',
      content: `I was upskilled after struggling with: "${taskDescription.substring(0, 100)}". My persona was upgraded with new expertise in: ${skillGap}. I should now approach similar tasks with this stronger foundation.`,
      summary: `Upskilled in: ${skillGap}`,
      topicTags: ['upskill', 'growth', 'persona-upgrade'],
      importance: 9, // High importance — this is a defining moment
      sourceType: 'review'
    });

    console.log(`[worker] ✓ ${personaData.agent.display_name} upskilled in "${skillGap}". New persona #${newPersona.id} active.`);

  } catch (err) {
    // Upskilling is non-critical — never fail the review process over it
    console.error(`[worker] Upskill failed for ${agentId}: ${err.message}`);
  }
}

// ============================================================
// DEEP WORK PIPELINE HELPERS
// ============================================================

/**
 * Determine pipeline configuration based on step type and agent role.
 * WHY: Research tasks need full pipeline, engineering tasks skip web research,
 * and trivial tasks skip the pipeline entirely.
 */
function determinePipelineConfig(step, agentRole) {
  const desc = (step.description || '').toLowerCase();
  const role = (agentRole || '').toLowerCase();

  // Simple/trivial tasks — skip entire pipeline (legacy single-shot)
  const simplePatterns = ['greet', 'respond to', 'acknowledge', 'thank', 'confirm'];
  if (simplePatterns.some(p => desc.startsWith(p)) && desc.length < 100) {
    return { skipPipeline: true };
  }

  // Engineering tasks — skip web research
  if (role.includes('engineer') || ['code', 'build', 'deploy', 'api', 'database', 'debug', 'fix'].some(kw => desc.includes(kw))) {
    return { skipResearch: true };
  }

  // Content/creative tasks — skip web research
  if (role.includes('content') || role.includes('creative')) {
    return { skipResearch: true };
  }

  // Default: full pipeline (research, analysis, strategy, etc.)
  return {};
}

/**
 * Extract a lesson from the pipeline's self-critique and save it.
 * WHY: Old system needed an extra LLM call every 5th task. Now every task
 * learns from its own critique output — zero additional cost.
 */
async function generateLessonFromCritique(step, pipelineResult, topicTags) {
  try {
    if (!pipelineResult.critiqueLesson) return;

    await memory.saveLesson({
      agentId: step.assigned_agent_id,
      lesson: pipelineResult.critiqueLesson,
      context: `Self-critique after task: "${step.description.substring(0, 150)}" (score: ${pipelineResult.critiqueScore}/5)`,
      category: topicTags[0] || 'general',
      importance: 7
    });

    console.log(`[worker] Critique lesson saved for ${step.assigned_agent_id}: "${pipelineResult.critiqueLesson.substring(0, 80)}..."`);
  } catch (err) {
    // Non-critical — never fail the task over lesson extraction
    console.error(`[worker] Critique lesson failed for ${step.assigned_agent_id}: ${err.message}`);
  }
}

/**
 * Save approach memory after a step completes — "what worked before."
 * WHY: Future decompositions benefit from knowing which search queries
 * and task breakdowns produced high-scoring results on similar tasks.
 */
async function saveApproachMemory(step, pipelineResult, topicTags) {
  try {
    if (!pipelineResult.critiqueScore) return; // No critique = no approach to save

    await approachMemory.save({
      agentId: step.assigned_agent_id,
      missionStepId: step.id,
      taskSummary: step.description,
      topicTags,
      decomposition: {}, // Pipeline doesn't expose decomposition details yet
      searchQueries: [],
      effectiveQueries: [],
      critiqueScore: pipelineResult.critiqueScore
    });
  } catch (err) {
    // Non-critical — never fail the task over approach memory
    console.error(`[worker] Approach memory save failed for step #${step.id}: ${err.message}`);
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Check if a step is the last (highest step_order) in its mission.
 * Used for auto tier selection — final deliverables get tier2 for quality.
 */
async function isLastStepInMission(step) {
  if (!step.mission_id) return false;

  const { data: steps } = await supabase
    .from('mission_steps')
    .select('step_order')
    .eq('mission_id', step.mission_id)
    .order('step_order', { ascending: false })
    .limit(1);

  if (!steps || steps.length === 0) return true;

  // This step is the last if its step_order matches the highest
  return step.step_order >= (steps[0].step_order || 0);
}

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
