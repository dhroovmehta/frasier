// decomposition.js — Task Decomposition Engine (v0.9.0)
// WHY: Frasier breaks full-project directives into parallel/sequential task DAGs.
// A single directive becomes a structured plan with dependency management,
// proactive hiring, and escalation handling — enabling autonomous execution.

const supabase = require('./supabase');
const models = require('./models');
const agents = require('./agents');
const approachMemory = require('./approach_memory');
const missions = require('./missions');
const linear = require('./linear');
const events = require('./events');

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
      missionStepId: 0,
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

    const step = await missions.createStep({
      mission_id: missionId,
      description,
      assigned_agent_id: agentMap[task.required_role] || null,
      model_tier: 'tier2',
      step_order: task.parallel_group
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

function buildDecompositionPrompt(directive, roster, approachHints) {
  let prompt = `Decompose this directive into a structured task plan:

DIRECTIVE: ${directive}

AVAILABLE AGENTS:
${roster || '(No agents currently active)'}
`;

  if (approachHints) {
    prompt += `\nAPPROACH HINTS FROM SIMILAR PAST WORK:\n${approachHints}\n`;
  }

  prompt += `
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

module.exports = {
  decomposeProject,
  validateDependencyGraph,
  createStepsFromPlan
};
