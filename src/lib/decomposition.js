// decomposition.js — Task Decomposition Engine (v0.10.0)
// WHY: Frasier breaks full-project directives into parallel/sequential task DAGs.
// A single directive becomes a structured plan with dependency management,
// proactive hiring, and escalation handling — enabling autonomous execution.
//
// v0.10.0: Capability-aware decomposition. The planner now receives a full manifest
// of what agents can and cannot do, preventing infeasible acceptance criteria.
// A feasibility gate validates the plan before execution (max 1 re-decomposition).

const supabase = require('./supabase');
const models = require('./models');
const agents = require('./agents');
const approachMemory = require('./approach_memory');
const missions = require('./missions');
const projects = require('./projects');
const linear = require('./linear');
const events = require('./events');
const capabilities = require('./capabilities');

// ============================================================
// DECOMPOSE PROJECT
// ============================================================

/**
 * Break a project directive into a structured task plan with dependency DAG.
 * Frasier orchestrates: fetch roster → approach memory → LLM decomposition →
 * validate graph → persist → hire if needed → escalate or create steps.
 */
async function decomposeProject({ projectId, missionId, directive, frasierAgentId }) {
  try {
    // 1. Fetch active agents for roster context in the LLM prompt
    const { data: activeAgents } = await supabase
      .from('agents')
      .select()
      .eq('status', 'active');

    const roster = (activeAgents || [])
      .map(a => `- ${a.display_name || a.name} (${a.role})`)
      .join('\n');

    // 2. Retrieve approach memory hints for similar past work
    const topicTags = directive.toLowerCase().split(/\s+/).slice(0, 5);
    const approaches = await approachMemory.findSimilar({
      agentId: frasierAgentId,
      topicTags
    });
    const approachHints = approachMemory.formatForPrompt(approaches);

    // 3. T2 LLM call — strategic work gets Sonnet-tier reasoning
    // WHY buildDecompositionPrompt now includes capability manifest: agents were getting
    // tasks they couldn't complete (e.g., "mine 50 Reddit threads" with no scraping tools).
    const userMessage = buildDecompositionPrompt(directive, roster, approachHints);

    const llmResult = await models.callLLM({
      systemPrompt: 'You are Frasier Crane, Chief of Staff at NERV. Decompose project directives into structured task plans. Respond with valid JSON only.',
      userMessage,
      agentId: frasierAgentId,
      forceTier: 'tier2'
    });

    // 4. Parse LLM response — fallback to single task on JSON failure
    let plan;
    let fallback = false;

    try {
      let content = llmResult.content.trim();
      // Strip markdown fences if LLM wraps in ```json blocks
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      plan = JSON.parse(content);
    } catch (parseErr) {
      console.log(`[decomposition] JSON parse failed, using fallback single-task plan: ${parseErr.message}`);
      plan = {
        tasks: [{
          id: 'T1',
          description: directive,
          required_role: 'research',
          parallel_group: 1,
          depends_on: [],
          acceptance_criteria: 'Complete the requested work'
        }],
        end_state: 'production_docs',
        escalation_needed: false,
        hiring_needed: []
      };
      fallback = true;
    }

    // 5. Validate dependency graph — reject cycles before persisting
    if (!fallback && plan.tasks.length > 1) {
      validateDependencyGraph(plan.tasks);
    }

    // 5b. Feasibility validation gate — check plan against agent capabilities
    // WHY: Prevents infeasible tasks from entering execution. A cheap T1 LLM reviews
    // each step against the capability manifest. If issues found, re-decompose once
    // with the feedback. Skip for fallback plans (already degraded) and escalations.
    if (!fallback && !plan.escalation_needed) {
      const feasibility = await capabilities.validatePlanFeasibility(plan, frasierAgentId);

      if (!feasibility.feasible) {
        console.log(`[decomposition] Feasibility issues found (${feasibility.issues.length}), re-decomposing...`);

        // Build feedback string from issues for the re-decomposition prompt
        const feedbackText = feasibility.issues
          .map(i => `- [${i.taskId}]: ${i.issue}\n  Suggestion: ${i.suggestion}`)
          .join('\n');

        // Re-decompose with feasibility feedback (max 1 retry)
        const retryMessage = buildDecompositionPrompt(directive, roster, approachHints, feedbackText);

        const retryResult = await models.callLLM({
          systemPrompt: 'You are Frasier Crane, Chief of Staff at NERV. Decompose project directives into structured task plans. Respond with valid JSON only.',
          userMessage: retryMessage,
          agentId: frasierAgentId,
          forceTier: 'tier2'
        });

        try {
          let retryContent = retryResult.content.trim();
          if (retryContent.startsWith('```')) {
            retryContent = retryContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }
          const retryPlan = JSON.parse(retryContent);

          // Validate the revised plan's dependency graph
          if (retryPlan.tasks && retryPlan.tasks.length > 1) {
            validateDependencyGraph(retryPlan.tasks);
          }

          // Re-validate feasibility on the revised plan
          const retryFeasibility = await capabilities.validatePlanFeasibility(retryPlan, frasierAgentId);

          if (retryFeasibility.feasible) {
            plan = retryPlan;
            console.log('[decomposition] Re-decomposition passed feasibility check');
          } else {
            // Still infeasible after retry — proceed with best effort
            plan = retryPlan;
            console.log(`[decomposition] Re-decomposition still has ${retryFeasibility.issues.length} issues, proceeding with best plan`);
          }
        } catch (retryParseErr) {
          // Re-decomposition JSON failed — keep original plan
          console.log(`[decomposition] Re-decomposition parse failed, keeping original plan: ${retryParseErr.message}`);
        }
      }
    }

    // 6. Persist decomposition plan for audit trail + Linear sync
    const parallelGroups = [...new Set(plan.tasks.map(t => t.parallel_group))].length;

    await supabase.from('decomposition_plans').insert({
      project_id: projectId,
      mission_id: missionId,
      plan_json: plan,
      task_count: plan.tasks.length,
      parallel_groups: parallelGroups,
      estimated_phases: parallelGroups,
      end_state: plan.end_state,
      decomposed_by: 'frasier',
      approach_memory_used: approaches.length > 0,
      status: 'active'
    });

    // 7. Proactive hiring — hire BEFORE creating steps so agents are ready
    if (plan.hiring_needed && plan.hiring_needed.length > 0) {
      for (const hire of plan.hiring_needed) {
        try {
          await agents.autoHireGapAgent(hire.role_title);
          console.log(`[decomposition] Hired agent for role: ${hire.role_title}`);
        } catch (hireErr) {
          console.error(`[decomposition] Failed to hire for ${hire.role_title}: ${hireErr.message}`);
        }
      }
    }

    // 8. Escalation — log and return early (no steps created)
    if (plan.escalation_needed) {
      const escalationType = determineEscalationType(plan.escalation_reason || '');

      await supabase.from('escalation_log').insert({
        project_id: projectId,
        mission_id: missionId,
        escalation_type: escalationType,
        reason: plan.escalation_reason || 'Escalation required'
      });

      await events.logEvent({
        type: 'escalation',
        projectId,
        missionId,
        details: { reason: plan.escalation_reason }
      });

      return { plan, error: null, fallback, escalated: true };
    }

    // 9. Build agent map — find best agent for each required role
    const uniqueRoles = [...new Set(plan.tasks.map(t => t.required_role))];
    const agentMap = {};

    for (const role of uniqueRoles) {
      const agent = await agents.findBestAgentAcrossTeams(role);
      if (agent) {
        agentMap[role] = agent.id;
      }
    }

    // 10. Create mission steps from plan
    await createStepsFromPlan(missionId, plan, agentMap);

    // 11. Sync to Linear (fire-and-forget — failure doesn't block execution)
    // WHY: syncMissionToLinear expects a mission object ({id, title, description}),
    // not just the ID. Fetch the full row so Linear gets a proper project name.
    const { data: missionObj } = await supabase
      .from('missions')
      .select('id, title, description')
      .eq('id', missionId)
      .single();
    if (missionObj) {
      linear.syncMissionToLinear(missionObj).catch(err =>
        console.error(`[linear] Mission sync failed (non-blocking): ${err.message}`)
      );
    }

    // 12. Save approach memory for future decompositions
    await approachMemory.save({
      agentId: frasierAgentId,
      missionStepId: null,  // WHY: Decomposition-level memory isn't tied to a specific step. 0 triggers FK violation.
      taskSummary: directive,
      topicTags,
      decomposition: { taskCount: plan.tasks.length, parallelGroups },
      searchQueries: [],
      effectiveQueries: [],
      critiqueScore: 0
    });

    return { plan, error: null, fallback };
  } catch (err) {
    console.error(`[decomposition] Failed to decompose project ${projectId}: ${err.message}`);
    return { plan: null, error: err.message, fallback: false };
  }
}

// ============================================================
// VALIDATE DEPENDENCY GRAPH — Kahn's Algorithm
// ============================================================

/**
 * Topological sort via Kahn's algorithm to detect cycles.
 * WHY: Cyclic dependencies would cause infinite blocking in the worker.
 * If any nodes remain unprocessed after the sort, a cycle exists.
 */
function validateDependencyGraph(tasks) {
  const inDegree = {};
  const adj = {};

  for (const task of tasks) {
    inDegree[task.id] = 0;
    adj[task.id] = [];
  }

  for (const task of tasks) {
    for (const dep of (task.depends_on || [])) {
      if (adj[dep]) {
        adj[dep].push(task.id);
        inDegree[task.id]++;
      }
    }
  }

  // Process zero-degree nodes, decrement neighbors
  const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
  let processed = 0;

  while (queue.length > 0) {
    const node = queue.shift();
    processed++;
    for (const neighbor of (adj[node] || [])) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processed < tasks.length) {
    throw new Error('Dependency cycle detected in task graph');
  }
}

// ============================================================
// CREATE STEPS FROM PLAN
// ============================================================

/**
 * Two-pass step creation:
 * Pass 1: Create all mission_steps (step_order = parallel_group)
 * Pass 2: Create step_dependencies rows using taskId→stepId map
 */
async function createStepsFromPlan(missionId, plan, agentMap) {
  const taskIdToStepId = {};

  // Pass 1: create one mission_step per task
  for (const task of plan.tasks) {
    const description = `${task.description}\n\nAcceptance Criteria: ${task.acceptance_criteria}`;

    // WHY camelCase: createStep() destructures {missionId, assignedAgentId, modelTier, stepOrder}.
    // Snake_case keys silently become undefined in JS destructuring → steps created with null fields.
    const step = await missions.createStep({
      missionId,
      description,
      assignedAgentId: agentMap[task.required_role] || null,
      modelTier: 'tier2',
      stepOrder: task.parallel_group
    });

    taskIdToStepId[task.id] = step.id;
  }

  // Pass 2: create step_dependencies rows from depends_on references
  for (const task of plan.tasks) {
    for (const dep of (task.depends_on || [])) {
      const stepId = taskIdToStepId[task.id];
      const dependsOnStepId = taskIdToStepId[dep];

      if (stepId !== undefined && dependsOnStepId !== undefined) {
        await supabase.from('step_dependencies').insert({
          step_id: stepId,
          depends_on_step_id: dependsOnStepId,
          dependency_type: 'blocks'
        });
      }
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

function buildDecompositionPrompt(directive, roster, approachHints, feasibilityFeedback) {
  const capabilityManifest = capabilities.buildCapabilityManifest();

  let prompt = `Decompose this directive into a structured task plan:

DIRECTIVE: ${directive}

AVAILABLE AGENTS:
${roster || '(No agents currently active)'}

${capabilityManifest}
`;

  if (approachHints) {
    prompt += `\nAPPROACH HINTS FROM SIMILAR PAST WORK:\n${approachHints}\n`;
  }

  // WHY: When re-decomposing after feasibility failure, inject the specific issues
  // so the LLM knows exactly what to fix and how to adapt.
  if (feasibilityFeedback) {
    prompt += `\n## PREVIOUS PLAN REJECTED — FEASIBILITY ISSUES FOUND
The previous decomposition included tasks that agents cannot accomplish with their available tools.
Fix these issues by adapting the approach creatively — same goals, achievable methods:

${feasibilityFeedback}
`;
  }

  prompt += `
## CRITICAL PLANNING RULES
- Every task MUST be achievable using ONLY the assigned role's listed tools and capabilities
- Acceptance criteria MUST be realistic for the agent's tools — do not require capabilities they lack
- If the directive requires capabilities no agent has, adapt the approach creatively: find alternative paths to the same outcome using available tools
- Be inventive: "mine 50 Reddit threads" becomes "search for Reddit discussions via Brave Search and compile findings"
- Never create tasks that assume web scraping, API access, or tools not listed in the manifest above

Respond with JSON matching this schema:
{
  "tasks": [
    {
      "id": "T1",
      "description": "Task description",
      "required_role": "research|engineering|strategy|content|qa|marketing|knowledge",
      "parallel_group": 1,
      "depends_on": [],
      "acceptance_criteria": "Clear criteria for task completion"
    }
  ],
  "end_state": "production_docs|working_prototype|hybrid",
  "escalation_needed": false,
  "escalation_reason": "",
  "hiring_needed": []
}`;

  return prompt;
}

/**
 * Infer escalation type from reason text.
 * WHY: The LLM returns a reason string but the escalation_log table
 * needs a categorical type for filtering and routing.
 */
function determineEscalationType(reason) {
  const lower = reason.toLowerCase();
  if (lower.includes('budget') || lower.includes('cost') || lower.includes('$')) return 'budget';
  if (lower.includes('strategic') || lower.includes('direction')) return 'strategic';
  if (lower.includes('brand') || lower.includes('reputation')) return 'brand';
  if (lower.includes('capability') || lower.includes('skill gap')) return 'capability_gap';
  return 'ambiguity';
}

// ============================================================
// HANDLE NEW PROJECT DECOMPOSITION
// ============================================================

/**
 * Orchestrate the full decomposition flow for a new project.
 * Called from discord_bot's [ACTION:NEW_PROJECT] handler.
 *
 * WHY this exists: decomposeProject() needs a mission to already exist
 * (it creates steps on it). This function bridges project creation
 * and decomposition by: creating mission → linking to project → decomposing.
 *
 * Returns { success, missionId, taskCount, parallelGroups, plan, error, escalated }
 */
async function handleNewProjectDecomposition({ projectId, projectName, content, frasierAgentId }) {
  // 1. Create mission directly — bypass the proposal→heartbeat→accept flow
  // WHY: Decomposed projects don't need heartbeat arbitration. Frasier already
  // decided this is a full project. Creating the mission immediately lets us
  // attach decomposed steps right away instead of waiting for the next heartbeat cycle.
  const mission = await missions.createMission({
    title: `[PROJECT:${projectId}] ${projectName}`,
    description: content,
    teamId: 'team-research'
  });

  if (!mission) {
    return { success: false, error: 'Mission creation failed' };
  }

  // 2. Link mission to project via join table (discovery phase)
  await projects.linkMissionToProject(projectId, mission.id, 'discovery');

  // 3. Decompose — LLM breaks directive into a DAG of parallel/sequential tasks
  const result = await decomposeProject({
    projectId,
    missionId: mission.id,
    directive: content,
    frasierAgentId
  });

  if (result.error) {
    return { success: false, missionId: mission.id, error: result.error };
  }

  if (result.escalated) {
    return { success: true, escalated: true, missionId: mission.id, plan: result.plan };
  }

  return {
    success: true,
    missionId: mission.id,
    taskCount: result.plan.tasks.length,
    parallelGroups: [...new Set(result.plan.tasks.map(t => t.parallel_group))].length,
    plan: result.plan
  };
}

module.exports = {
  decomposeProject,
  handleNewProjectDecomposition,
  validateDependencyGraph,
  createStepsFromPlan
};
