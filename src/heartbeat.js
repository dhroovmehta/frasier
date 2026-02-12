// heartbeat.js — Orchestration engine (PM2 process #2)
// WHY: This is the "brain" that keeps the system running.
// Polls every 30 seconds for state changes and triggers actions:
//   - Picks up new proposals → creates missions → assigns steps to agents
//   - Schedules daily standups (9:00am ET)
//   - Routes steps through the approval chain (QA → Team Lead)
//   - Checks mission completion
//   - Monitors for errors and triggers alerts
//
// No WebSockets. No pub/sub. Just polling. It's simpler and it works.

require('dotenv').config();
const missions = require('./lib/missions');
const agents = require('./lib/agents');
const conversations = require('./lib/conversations');
const memory = require('./lib/memory');
const models = require('./lib/models');
const events = require('./lib/events');
const policy = require('./lib/policy');

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
let running = true;
let lastStandupDate = null; // Track if standup ran today

// ============================================================
// MAIN LOOP
// ============================================================

async function main() {
  console.log('[heartbeat] Starting orchestration engine...');
  await events.logEvent({
    eventType: 'heartbeat_started',
    severity: 'info',
    description: 'Heartbeat orchestration engine started'
  });

  while (running) {
    try {
      await tick();
    } catch (err) {
      console.error('[heartbeat] Unexpected error in tick:', err.message);
      await events.logEvent({
        eventType: 'heartbeat_error',
        severity: 'error',
        description: `Heartbeat tick error: ${err.message}`
      });
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * One tick of the heartbeat. Runs all checks in sequence.
 */
async function tick() {
  // 1. Process new proposals → missions (with gap detection for hiring)
  await processProposals();

  // 2. Process approved hires → create agents, re-queue stalled proposals
  await processApprovedHires();

  // 3. Route steps through approval chain
  await processApprovals();

  // 4. Check for completed missions
  await checkMissions();

  // 5. Schedule daily standup (time-based trigger)
  await checkDailyStandup();
}

// ============================================================
// PROPOSAL PROCESSING
// ============================================================

/**
 * Pick up pending proposals, create missions, break into steps, assign to agents.
 * GAP DETECTION: If no agent can handle the task's role, defer the proposal
 * and create a hiring proposal instead. Frasier proposes, Zero approves via Discord.
 */
async function processProposals() {
  const proposals = await missions.getPendingProposals();
  if (proposals.length === 0) return;

  console.log(`[heartbeat] Processing ${proposals.length} pending proposal(s)...`);

  for (const proposal of proposals) {
    try {
      // Determine target team
      const teamId = proposal.assigned_team_id || 'team-research'; // Default to research team

      // Check team is active
      const team = await agents.getTeam(teamId);
      if (!team || team.status !== 'active') {
        console.log(`[heartbeat] Team ${teamId} not active. Proposal #${proposal.id} deferred.`);
        continue;
      }

      // Get team agents for assignment
      const teamAgents = await agents.getTeamAgents(teamId);

      // Route task to best-fit role category
      const taskDescription = proposal.description || proposal.title;
      const bestRole = missions.routeByKeywords(taskDescription);

      // GAP DETECTION: check if the team can actually handle this role
      const { canHandle, matchedAgent } = missions.canTeamHandle(teamAgents, bestRole);

      if (!canHandle) {
        // No agent can handle this role — propose a hire
        const roleTitle = missions.ROLE_TITLES[bestRole] || bestRole;
        console.log(`[heartbeat] No ${roleTitle} on team ${teamId}. Proposing hire for proposal #${proposal.id}.`);

        await agents.createHiringProposal({
          role: roleTitle,
          teamId,
          justification: `Task "${proposal.title}" requires a ${roleTitle}, but no agent with that role exists on ${teamId}.`,
          triggeringProposalId: proposal.id
        });

        // Defer the proposal — prevents heartbeat from re-processing it every tick
        await deferProposal(proposal.id);

        await events.logEvent({
          eventType: 'hiring_proposed',
          teamId,
          severity: 'info',
          description: `Hiring proposal created for ${roleTitle} on ${teamId} (triggered by proposal #${proposal.id})`,
          data: { proposalId: proposal.id, role: roleTitle }
        });

        continue;
      }

      // Normal flow: accept proposal and create mission
      const mission = await missions.acceptProposal(proposal.id, teamId);
      if (!mission) continue;

      const assignee = matchedAgent || teamAgents[0];

      // Determine model tier
      const isComplex = proposal.priority === 'urgent';
      const modelTier = isComplex ? 'tier2' : 'tier1';

      // Create the step
      await missions.createStep({
        missionId: mission.id,
        description: taskDescription,
        assignedAgentId: assignee.id,
        modelTier,
        stepOrder: 1
      });

      await events.logEvent({
        eventType: 'mission_created',
        agentId: assignee.id,
        teamId,
        severity: 'info',
        description: `Mission #${mission.id}: "${proposal.title}" assigned to ${assignee.display_name}`,
        data: { missionId: mission.id, proposalId: proposal.id }
      });

      console.log(`[heartbeat] Mission #${mission.id} created, assigned to ${assignee.display_name} (${modelTier})`);

    } catch (err) {
      console.error(`[heartbeat] Error processing proposal #${proposal.id}:`, err.message);
    }
  }
}

/**
 * Defer a mission proposal (waiting for a hire).
 * Sets status='deferred' so it won't be picked up again by getPendingProposals().
 * When the hire completes, processApprovedHires() sets it back to pending.
 */
async function deferProposal(proposalId) {
  const supabase = require('./lib/supabase');
  const { error } = await supabase
    .from('mission_proposals')
    .update({ status: 'deferred' })
    .eq('id', proposalId);

  if (error) {
    console.error(`[heartbeat] Failed to defer proposal #${proposalId}:`, error.message);
  }
}

// ============================================================
// APPROVED HIRE PROCESSING (create agent + re-queue stalled proposal)
// ============================================================

/**
 * Process approved hiring proposals: create the agent, generate persona,
 * mark hiring complete, and re-queue the stalled mission proposal.
 */
async function processApprovedHires() {
  const approvedHires = await agents.getApprovedHires(1); // One at a time
  if (approvedHires.length === 0) return;

  const hire = approvedHires[0];
  console.log(`[heartbeat] Processing approved hire #${hire.id}: ${hire.role} for ${hire.team_id}`);

  try {
    // Step 1: Create the agent (random anime name, assigned to team)
    const newAgent = await agents.createAgent({
      role: hire.role,
      title: hire.title || hire.role,
      teamId: hire.team_id,
      agentType: 'sub_agent'
    });

    if (!newAgent) {
      // Mark hire as processed to prevent infinite retry (likely name pool exhausted)
      console.error(`[heartbeat] Failed to create agent for hire #${hire.id}. Marking as failed.`);
      const supabase = require('./lib/supabase');
      await supabase.from('hiring_proposals').update({ processed: true, status: 'rejected', updated_at: new Date().toISOString() }).eq('id', hire.id);
      await events.logEvent({
        eventType: 'hiring_failed',
        teamId: hire.team_id,
        severity: 'error',
        description: `Failed to create agent for hire #${hire.id} (${hire.role}). Name pool may be exhausted.`
      });
      return;
    }

    // Step 2: Generate persona via LLM
    const persona = await generatePersona(newAgent, hire);

    if (persona) {
      await agents.savePersona({
        agentId: newAgent.id,
        agentMd: persona.agentMd,
        soulMd: persona.soulMd,
        skillsMd: persona.skillsMd,
        identityMd: persona.identityMd,
        fullSepPrompt: persona.fullSepPrompt
      });
    }

    // Step 3: Mark hiring proposal as completed
    await agents.completeHiringProposal(hire.id, newAgent.id);

    // Step 4: Re-queue the stalled mission proposal (if one triggered this hire)
    if (hire.triggering_proposal_id) {
      await reQueueProposal(hire.triggering_proposal_id);
      console.log(`[heartbeat] Re-queued stalled proposal #${hire.triggering_proposal_id}`);
    }

    await events.logEvent({
      eventType: 'agent_hired',
      agentId: newAgent.id,
      teamId: hire.team_id,
      severity: 'info',
      description: `${newAgent.display_name} hired as ${hire.role} on ${hire.team_id} (hire #${hire.id})`,
      data: { hiringProposalId: hire.id, agentId: newAgent.id }
    });

    console.log(`[heartbeat] Agent ${newAgent.display_name} (${hire.role}) created and ready on ${hire.team_id}`);

  } catch (err) {
    console.error(`[heartbeat] Error processing hire #${hire.id}:`, err.message);
  }
}

/**
 * Re-queue a deferred mission proposal so the next tick picks it up.
 * Sets status back to 'pending' and processed=false.
 */
async function reQueueProposal(proposalId) {
  const supabase = require('./lib/supabase');
  const { error } = await supabase
    .from('mission_proposals')
    .update({
      status: 'pending',
      processed: false
    })
    .eq('id', proposalId);

  if (error) {
    console.error(`[heartbeat] Failed to re-queue proposal #${proposalId}:`, error.message);
  }
}

/**
 * Generate a full SEP persona for a new agent via LLM (Tier 1).
 * Includes agent identity, soul, skills, and the complete system prompt.
 * Falls back to a hardcoded basic persona if LLM fails.
 */
async function generatePersona(agent, hire) {
  // Get team context: who are the colleagues?
  const teamAgents = await agents.getTeamAgents(hire.team_id);
  const colleagues = teamAgents
    .filter(a => a.id !== agent.id)
    .map(a => `${a.display_name} (${a.role})`)
    .join(', ') || 'none yet';

  const prompt = `You are the Persona Architect for VoxYZ Agent World. Generate a complete Structured Enhancement Protocol (SEP) persona for a new AI agent.

AGENT DETAILS:
- Name: ${agent.display_name}
- Role: ${hire.role}
- Team: ${hire.team_id}
- Colleagues: ${colleagues}
- Hiring justification: ${hire.justification || 'General team need'}

Generate the persona in this EXACT format (use the exact delimiters):

===AGENT_MD===
Who this agent is: their name, role, and archetype. 2-3 sentences.
===END_AGENT_MD===

===SOUL_MD===
Core personality traits, communication style, values, and quirks. How they interact with others. What motivates them. 3-5 sentences.
===END_SOUL_MD===

===SKILLS_MD===
Domain expertise, methodologies, tools, and mental models. What makes them excellent at their role. 3-5 sentences.
===END_SKILLS_MD===

===IDENTITY_MD===
Fictional credentials and background. Past experience, education, notable achievements. 3-5 sentences.
===END_IDENTITY_MD===

Make the persona distinct, memorable, and anime-inspired. The agent should feel like a real character, not a generic AI. Their personality should influence how they approach their work.`;

  try {
    const result = await models.callLLM({
      systemPrompt: 'You are the Persona Architect. Generate detailed, creative agent personas in the exact format requested.',
      userMessage: prompt,
      agentId: agent.id,
      forceTier: 'tier1',
      taskDescription: 'persona generation'
    });

    if (result.error || !result.content) {
      console.error(`[heartbeat] Persona LLM call failed for ${agent.display_name}: ${result.error}`);
      return buildFallbackPersona(agent, hire);
    }

    // Parse the structured output
    const parsed = parsePersonaOutput(result.content, agent, hire);
    return parsed;

  } catch (err) {
    console.error(`[heartbeat] Persona generation error for ${agent.display_name}:`, err.message);
    return buildFallbackPersona(agent, hire);
  }
}

/**
 * Parse LLM persona output into structured sections.
 */
function parsePersonaOutput(content, agent, hire) {
  const extract = (tag) => {
    const regex = new RegExp(`===${tag}===\\s*([\\s\\S]*?)===END_${tag}===`);
    const match = content.match(regex);
    return match ? match[1].trim() : null;
  };

  const agentMd = extract('AGENT_MD') || `${agent.display_name} is a ${hire.role} on ${hire.team_id}.`;
  const soulMd = extract('SOUL_MD') || `Professional and dedicated to quality work in ${hire.role.toLowerCase()}.`;
  const skillsMd = extract('SKILLS_MD') || `Expert in ${hire.role.toLowerCase()} with broad domain knowledge.`;
  const identityMd = extract('IDENTITY_MD') || `Experienced professional with a track record in ${hire.role.toLowerCase()}.`;

  const fullSepPrompt = `# ${agent.display_name} — ${hire.role}

## Identity
${agentMd}

## Soul
${soulMd}

## Skills
${skillsMd}

## Background
${identityMd}

## Operating Rules
- You are ${agent.display_name}, a ${hire.role} on ${hire.team_id}.
- Respond in character. Your personality influences your work output.
- Be concise and action-oriented. Deliver results, not filler.
- Reference your memory and past experiences when relevant.`;

  return { agentMd, soulMd, skillsMd, identityMd, fullSepPrompt };
}

/**
 * Hardcoded fallback persona if LLM fails. Agent is still functional.
 */
function buildFallbackPersona(agent, hire) {
  const agentMd = `${agent.display_name} is a ${hire.role} recently hired to ${hire.team_id}.`;
  const soulMd = `Dedicated and professional. Approaches every task with focus and precision.`;
  const skillsMd = `Expert in ${hire.role.toLowerCase()}. Brings fresh perspective and strong execution skills.`;
  const identityMd = `Experienced ${hire.role.toLowerCase()} with a passion for delivering quality work.`;

  const fullSepPrompt = `# ${agent.display_name} — ${hire.role}

## Identity
${agentMd}

## Soul
${soulMd}

## Skills
${skillsMd}

## Background
${identityMd}

## Operating Rules
- You are ${agent.display_name}, a ${hire.role} on ${hire.team_id}.
- Respond in character. Be concise and action-oriented.
- Reference your memory and past experiences when relevant.`;

  console.log(`[heartbeat] Using fallback persona for ${agent.display_name}`);
  return { agentMd, soulMd, skillsMd, identityMd, fullSepPrompt };
}

// ============================================================
// APPROVAL CHAIN PROCESSING
// ============================================================

/**
 * Find steps in review that need approvals created,
 * and route them through the QA → Team Lead chain.
 */
async function processApprovals() {
  const stepsNeedingReview = await missions.getStepsNeedingReview();
  if (stepsNeedingReview.length === 0) return;

  for (const step of stepsNeedingReview) {
    try {
      // Get the team for this step's mission
      const { data: missionData } = await require('./lib/supabase')
        .from('missions')
        .select('team_id')
        .eq('id', step.mission_id)
        .single();

      if (!missionData) continue;

      const teamAgents = await agents.getTeamAgents(missionData.team_id);

      // Find QA agent on the team
      const qaAgent = teamAgents.find(a => a.agent_type === 'qa' || a.role?.toLowerCase().includes('qa'));

      // Find team lead
      const teamLead = teamAgents.find(a => a.agent_type === 'team_lead');

      if (qaAgent) {
        // Route to QA first
        await missions.createApproval({
          missionStepId: step.id,
          reviewerAgentId: qaAgent.id,
          reviewType: 'qa'
        });
        console.log(`[heartbeat] Step #${step.id} sent to QA (${qaAgent.display_name})`);
      } else if (teamLead) {
        // No QA? Go straight to team lead
        await missions.createApproval({
          missionStepId: step.id,
          reviewerAgentId: teamLead.id,
          reviewType: 'team_lead'
        });
        console.log(`[heartbeat] Step #${step.id} sent to Team Lead (${teamLead.display_name})`);
      } else {
        // No reviewers available — auto-approve
        await missions.approveStep(step.id);
        console.log(`[heartbeat] Step #${step.id} auto-approved (no reviewers on team)`);
      }
    } catch (err) {
      console.error(`[heartbeat] Error processing approval for step #${step.id}:`, err.message);
    }
  }
}

// ============================================================
// MISSION COMPLETION CHECK
// ============================================================

async function checkMissions() {
  const activeMissions = await missions.getActiveMissions();

  for (const mission of activeMissions) {
    const completed = await missions.checkMissionCompletion(mission.id);
    if (completed) {
      await events.logEvent({
        eventType: 'mission_completed',
        teamId: mission.team_id,
        severity: 'info',
        description: `Mission #${mission.id}: "${mission.title}" completed`,
        data: { missionId: mission.id }
      });
    }
  }
}

// ============================================================
// DAILY STANDUP (time-based trigger)
// ============================================================

async function checkDailyStandup() {
  const schedule = await policy.getDailySummarySchedule();
  const tz = schedule.timezone || 'America/New_York';
  const [targetH, targetM] = (schedule.time || '09:00').split(':').map(Number);

  // Get current time in target timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(now);
  const currentDate = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
  const hour = parseInt(parts.find(p => p.type === 'hour').value);
  const minute = parseInt(parts.find(p => p.type === 'minute').value);

  // Check if it's standup time (within 5-minute window) and hasn't run today
  if (hour === targetH && minute >= targetM && minute < targetM + 5 && lastStandupDate !== currentDate) {
    lastStandupDate = currentDate;
    console.log(`[heartbeat] Triggering daily standup for ${currentDate}...`);
    await runDailyStandup();
  }
}

/**
 * Run the daily standup for all active agents.
 * Each agent gets a standup prompt, responds via LLM.
 */
async function runDailyStandup() {
  const activeAgents = await agents.getAllActiveAgents();
  if (activeAgents.length === 0) {
    console.log('[heartbeat] No active agents for standup');
    return;
  }

  const standupConv = conversations.startConversation({
    type: 'standup',
    initiatorAgentId: 'system',
    context: `Daily standup — ${new Date().toLocaleDateString('en-US')}`
  });

  for (const agent of activeAgents) {
    try {
      // Build agent prompt with memory
      const promptData = await memory.buildAgentPrompt(agent.id, ['standup', 'daily-update']);
      if (promptData.error) continue;

      const standupPrompt = conversations.buildStandupPrompt(agent.display_name);

      // Call LLM for standup response
      const result = await models.callLLM({
        systemPrompt: promptData.systemPrompt,
        userMessage: standupPrompt,
        agentId: agent.id,
        forceTier: 'tier1' // Standups always use cheapest model
      });

      if (result.content) {
        // Save standup turn
        await conversations.addTurn({
          conversationId: standupConv.conversationId,
          conversationType: 'standup',
          senderAgentId: agent.id,
          teamId: agent.team_id,
          content: result.content,
          context: 'Daily standup'
        });

        // Save to memory
        await memory.saveMemory({
          agentId: agent.id,
          memoryType: 'conversation',
          content: `Daily standup: ${result.content}`,
          summary: `Standup update`,
          topicTags: ['standup', 'daily-update'],
          importance: 4,
          sourceType: 'standup'
        });

        console.log(`[heartbeat] ${agent.display_name} standup: ${result.content.substring(0, 80)}...`);
      }
    } catch (err) {
      console.error(`[heartbeat] Standup error for ${agent.display_name}:`, err.message);
    }
  }

  await events.logEvent({
    eventType: 'daily_standup',
    severity: 'info',
    description: `Daily standup completed with ${activeAgents.length} agents`
  });
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[heartbeat] Shutting down...');
  running = false;
});

process.on('SIGTERM', () => {
  console.log('[heartbeat] Shutting down...');
  running = false;
});

main().catch(err => {
  console.error('[heartbeat] Fatal error:', err);
  process.exit(1);
});
