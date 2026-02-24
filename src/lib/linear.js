// linear.js — Two-way Linear sync for mission/step lifecycle
// WHY: Gives Dhroov a real-time project management view in Linear of what all agents
// are working on, without replacing Discord. Both channels stay in sync regardless
// of where work originates.
//
// PATTERN: Follows notion.js — raw fetch() for API calls, no SDK.
// All sync functions are fire-and-forget safe: catch errors, return null, never throw.
// Linear sync failure must NEVER block mission execution.

const crypto = require('crypto');
const supabase = require('./supabase');
const models = require('./models');

const LINEAR_API_URL = 'https://api.linear.app/graphql';

// Agent labels: every agent that can be assigned work
const AGENT_LABELS = [
  'Frasier', 'Gendo', 'Sahaquiel', 'Toji', 'Kaworu', 'Ritsuko',
  'Armisael', 'Shamshel', 'Zechs', 'Zeruel', 'Jet', 'Rei'
];

// Work type labels: derived from EXPERTISE_MAP in missions.js
const WORK_TYPE_LABELS = [
  'Research', 'Strategy', 'Content', 'Engineering', 'QA', 'Marketing', 'Knowledge'
];

const SYSTEM_LABELS = ['frasier-managed'];

// Work type keyword mapping (mirrors missions.js EXPERTISE_MAP)
const WORK_TYPE_MAP = {
  research: 'Research',
  strategy: 'Strategy',
  content: 'Content',
  engineering: 'Engineering',
  qa: 'QA',
  marketing: 'Marketing',
  knowledge: 'Knowledge'
};

// Module-level cache for IDs resolved at startup
let cache = null;

// WHY: Worker process is a separate PM2 process from heartbeat. Heartbeat calls
// initialize() on startup, but worker never does. Every updateIssueStatus() from
// worker failed with "Unknown workflow state" because cache was empty.
// ensureInitialized() lazily populates the cache on first use from any process.
let initialized = false;

// Timestamp of last poll — ensures no issues are missed between ticks
let lastPollTime = null;

// ============================================================
// CORE API
// ============================================================

/**
 * Send a GraphQL request to Linear's API.
 * Returns parsed data or null on any error.
 */
async function linearRequest(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[linear] API ${response.status}: ${error}`);
      return null;
    }

    const result = await response.json();
    if (result.errors) {
      console.error('[linear] GraphQL errors:', JSON.stringify(result.errors));
      return null;
    }

    return result.data;
  } catch (err) {
    console.error(`[linear] Request failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Truncate a string to fit Linear's 255 character limit for descriptions.
 * WHY: Linear's API rejects project descriptions > 255 chars (ISS-017).
 */
function truncateForLinear(str, max = 255) {
  if (!str || str.length <= max) return str || '';
  return str.substring(0, max - 3) + '...';
}

// ============================================================
// LLM TITLE POLISHING
// ============================================================

/**
 * Rewrite raw task text into a clean, professional title + description.
 * Uses tier-1 (MiniMax) — cheapest model for a simple formatting task.
 */
async function polishTitleAndDescription(rawText) {
  const truncated = (rawText || '').substring(0, 500);

  try {
    const result = await models.callLLM({
      systemPrompt: 'You are a project management assistant. Rewrite raw task descriptions into clean, professional titles and descriptions for a project management tool.',
      userMessage: `Rewrite this into a professional ticket.\n\nRaw text: "${truncated}"\n\nRespond ONLY with JSON:\n{"title": "concise title (max 80 chars)", "description": "organized 1-3 sentence description"}`,
      agentId: 'system',
      forceTier: 'tier1',
      taskDescription: 'linear title polish'
    });

    if (result.error || !result.content) {
      return { title: truncated.substring(0, 80), description: truncated };
    }

    const cleaned = result.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      title: (parsed.title || truncated).substring(0, 80),
      description: parsed.description || truncated
    };
  } catch (e) {
    // JSON parse failed or any other error — fall back to raw text
    return { title: truncated.substring(0, 80), description: truncated };
  }
}

// ============================================================
// FRASIER → LINEAR SYNC
// ============================================================

/**
 * Create a Linear Project for a Frasier mission.
 * Polishes the title via LLM, creates the project, saves sync record.
 */
async function syncMissionToLinear(mission) {
  if (!process.env.LINEAR_API_KEY) return null;

  try {
    // Idempotency: check if a Linear project already exists for this mission.
    // WHY: createMission() and decomposeProject() both call syncMissionToLinear.
    // Without this check, two Linear projects would be created for one mission.
    const { data: existingSync } = await supabase
      .from('linear_sync')
      .select('entity_id, entity_url')
      .eq('mission_id', mission.id)
      .eq('sync_type', 'mission_to_project')
      .limit(1)
      .maybeSingle();

    if (existingSync) {
      console.log(`[linear] Mission #${mission.id} already synced → skipping duplicate project creation`);
      return { id: existingSync.entity_id, url: existingSync.entity_url };
    }

    const polished = await polishTitleAndDescription(
      `${mission.title || ''}\n${mission.description || ''}`.trim()
    );

    const teamId = process.env.LINEAR_TEAM_ID;
    const data = await linearRequest(
      `mutation ProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { id url slugId }
        }
      }`,
      {
        input: {
          name: polished.title,
          description: truncateForLinear(polished.description),
          teamIds: teamId ? [teamId] : []
        }
      }
    );

    if (!data?.projectCreate?.success) return null;

    const project = data.projectCreate.project;

    // Save sync record
    await supabase.from('linear_sync').insert({
      entity_type: 'project',
      entity_id: project.id,
      entity_url: project.url,
      mission_id: mission.id,
      sync_type: 'mission_to_project',
      status: 'synced',
      synced_at: new Date().toISOString()
    });

    console.log(`[linear] Mission #${mission.id} synced → Project ${project.url}`);
    return project;
  } catch (err) {
    console.error(`[linear] syncMissionToLinear failed: ${err.message}`);
    return null;
  }
}

/**
 * Create a Linear Issue for a Frasier mission step.
 * Links to parent project, adds agent + work-type + system labels.
 */
async function syncStepToLinear(step) {
  if (!process.env.LINEAR_API_KEY) return null;
  await ensureInitialized();

  try {
    // Look up parent project from linear_sync
    const { data: projectSync } = await supabase
      .from('linear_sync')
      .select('entity_id')
      .eq('mission_id', step.mission_id)
      .eq('entity_type', 'project')
      .maybeSingle();

    const polished = await polishTitleAndDescription(step.description || '');

    // Build label IDs
    const labelIds = [];
    if (cache?.labels) {
      // Agent label — agent IDs are "agent-{name}-{timestamp}", extract the name
      const agentName = (step.assigned_agent_id || '').split('-')[1] || '';
      const capitalizedAgent = agentName.charAt(0).toUpperCase() + agentName.slice(1);
      if (cache.labels[capitalizedAgent]) {
        labelIds.push(cache.labels[capitalizedAgent]);
      }

      // Work type label
      const workType = detectWorkType(step.description || '');
      if (workType && cache.labels[workType]) {
        labelIds.push(cache.labels[workType]);
      }

      // System label
      if (cache.labels['frasier-managed']) {
        labelIds.push(cache.labels['frasier-managed']);
      }
    }

    const input = {
      title: polished.title,
      description: polished.description,
      teamId: process.env.LINEAR_TEAM_ID
    };

    if (projectSync?.entity_id) {
      input.projectId = projectSync.entity_id;
    }
    if (labelIds.length > 0) {
      input.labelIds = labelIds;
    }

    const data = await linearRequest(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { input }
    );

    if (!data?.issueCreate?.success) return null;

    const issue = data.issueCreate.issue;

    // Save sync record
    await supabase.from('linear_sync').insert({
      entity_type: 'issue',
      entity_id: issue.id,
      entity_identifier: issue.identifier,
      entity_url: issue.url,
      mission_id: step.mission_id,
      mission_step_id: step.id,
      sync_type: 'step_to_issue',
      status: 'synced',
      synced_at: new Date().toISOString()
    });

    console.log(`[linear] Step #${step.id} synced → Issue ${issue.identifier}`);
    return issue;
  } catch (err) {
    console.error(`[linear] syncStepToLinear failed: ${err.message}`);
    return null;
  }
}

/**
 * Update a Linear issue's workflow state.
 * Looks up the Linear issue ID from linear_sync by step ID.
 */
async function updateIssueStatus(stepId, stateName) {
  if (!process.env.LINEAR_API_KEY) return null;
  await ensureInitialized();

  try {
    const issueId = await getLinearIssueId(stepId);
    if (!issueId) return null;

    const stateId = cache?.workflowStates?.[stateName];
    if (!stateId) {
      console.error(`[linear] Unknown workflow state: ${stateName}`);
      return null;
    }

    const data = await linearRequest(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id state { name } }
        }
      }`,
      { id: issueId, input: { stateId } }
    );

    return data?.issueUpdate?.success ? data.issueUpdate.issue : null;
  } catch (err) {
    console.error(`[linear] updateIssueStatus failed: ${err.message}`);
    return null;
  }
}

/**
 * Update a custom field on a Linear issue.
 * Supports number fields (Self-Critique Score) and text/date fields.
 */
async function updateIssueCustomField(stepId, fieldName, value) {
  if (!process.env.LINEAR_API_KEY) return null;
  await ensureInitialized();

  try {
    const issueId = await getLinearIssueId(stepId);
    if (!issueId) return null;

    const fieldId = cache?.customFields?.[fieldName];
    if (!fieldId) {
      // WHY: Custom fields are not yet created in Linear (ISS-017).
      // Silent skip instead of error log to avoid polluting worker output.
      return null;
    }

    // Linear custom field values differ by type
    let fieldValue;
    if (typeof value === 'number') {
      fieldValue = { number: value };
    } else {
      fieldValue = { text: String(value) };
    }

    const data = await linearRequest(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }`,
      {
        id: issueId,
        input: {
          customFields: [{ id: fieldId, value: fieldValue }]
        }
      }
    );

    return data?.issueUpdate?.success ? { success: true } : null;
  } catch (err) {
    console.error(`[linear] updateIssueCustomField failed: ${err.message}`);
    return null;
  }
}

/**
 * Post a comment on a Linear issue (used for deliverable links).
 */
async function addIssueComment(stepId, commentBody) {
  if (!process.env.LINEAR_API_KEY) return null;
  await ensureInitialized();

  try {
    const issueId = await getLinearIssueId(stepId);
    if (!issueId) return null;

    const data = await linearRequest(
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }`,
      { input: { issueId, body: commentBody } }
    );

    return data?.commentCreate?.success ? data.commentCreate.comment : null;
  } catch (err) {
    console.error(`[linear] addIssueComment failed: ${err.message}`);
    return null;
  }
}

/**
 * Mark a Linear project as completed.
 */
async function completeProject(missionId) {
  if (!process.env.LINEAR_API_KEY) return null;

  try {
    const projectId = await getLinearProjectId(missionId);
    if (!projectId) return null;

    const data = await linearRequest(
      `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: projectId, input: { state: 'completed' } }
    );

    return data?.projectUpdate?.success ? { success: true } : null;
  } catch (err) {
    console.error(`[linear] completeProject failed: ${err.message}`);
    return null;
  }
}

/**
 * Mark a Linear project as canceled.
 */
async function cancelProject(missionId) {
  if (!process.env.LINEAR_API_KEY) return null;

  try {
    const projectId = await getLinearProjectId(missionId);
    if (!projectId) return null;

    const data = await linearRequest(
      `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: projectId, input: { state: 'canceled' } }
    );

    return data?.projectUpdate?.success ? { success: true } : null;
  } catch (err) {
    console.error(`[linear] cancelProject failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch self-critique score from pipeline_phases and update the Linear custom field.
 */
async function syncCritiqueScore(stepId) {
  if (!process.env.LINEAR_API_KEY) return null;

  try {
    const { data: critiquePhase } = await supabase
      .from('pipeline_phases')
      .select('score')
      .eq('mission_step_id', stepId)
      .eq('phase_name', 'critique')
      .maybeSingle();

    if (!critiquePhase || critiquePhase.score == null) return null;

    return await updateIssueCustomField(stepId, 'Self-Critique Score', critiquePhase.score);
  } catch (err) {
    console.error(`[linear] syncCritiqueScore failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// DECOMPOSED PROJECT SYNC (v0.9.0)
// ============================================================

/**
 * Sync a decomposed project to Linear: 1 project + N issues.
 * Fire-and-forget safe — never throws, never blocks execution.
 *
 * @param {Object} params
 * @param {number} params.missionId
 * @param {string} params.title - Project title
 * @param {Object} params.plan - Decomposition plan with tasks array
 * @param {Array} params.steps - Created mission steps
 */
async function syncDecomposedProjectToLinear({ missionId, title, plan, steps }) {
  if (!process.env.LINEAR_API_KEY) return null;
  await ensureInitialized();

  try {
    // 1. Create Linear project
    const polishedProject = await polishTitleAndDescription(title);

    const teamId = process.env.LINEAR_TEAM_ID;
    // WHY: Linear's API rejects descriptions > 255 chars.
    // Truncate with ellipsis after appending metadata.
    const fullDescription = `${polishedProject.description}\n\nEnd state: ${plan.end_state || 'production_docs'}\nTasks: ${plan.tasks.length}\nParallel groups: ${[...new Set(plan.tasks.map(t => t.parallel_group))].length}`;
    const linearDescription = truncateForLinear(fullDescription);

    const projectData = await linearRequest(
      `mutation ProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { id url slugId }
        }
      }`,
      {
        input: {
          name: polishedProject.title,
          description: linearDescription,
          teamIds: teamId ? [teamId] : []
        }
      }
    );

    if (!projectData?.projectCreate?.success) return null;

    const project = projectData.projectCreate.project;

    // Save project sync record
    await supabase.from('linear_sync').insert({
      entity_type: 'project',
      entity_id: project.id,
      entity_url: project.url,
      mission_id: missionId,
      sync_type: 'decomposed_project',
      status: 'synced',
      synced_at: new Date().toISOString()
    });

    console.log(`[linear] Decomposed project synced → ${project.url} (${plan.tasks.length} tasks)`);

    // 2. Create one Linear issue per task
    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      const step = steps[i];

      try {
        const polished = await polishTitleAndDescription(
          `${task.description}\n\nAcceptance Criteria: ${task.acceptance_criteria}`
        );

        // Build labels: agent + work type + parallel group + system
        const labelIds = [];
        if (cache?.labels) {
          // Work type label from required_role
          const workType = WORK_TYPE_MAP[task.required_role];
          if (workType && cache.labels[workType]) {
            labelIds.push(cache.labels[workType]);
          }

          // System label
          if (cache.labels['frasier-managed']) {
            labelIds.push(cache.labels['frasier-managed']);
          }
        }

        const input = {
          title: `[Wave ${task.parallel_group}] ${polished.title}`,
          description: polished.description,
          teamId,
          projectId: project.id
        };

        if (labelIds.length > 0) {
          input.labelIds = labelIds;
        }

        const issueData = await linearRequest(
          `mutation IssueCreate($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { id identifier url }
            }
          }`,
          { input }
        );

        if (issueData?.issueCreate?.success) {
          const issue = issueData.issueCreate.issue;

          await supabase.from('linear_sync').insert({
            entity_type: 'issue',
            entity_id: issue.id,
            entity_identifier: issue.identifier,
            entity_url: issue.url,
            mission_id: missionId,
            mission_step_id: step?.id || null,
            sync_type: 'decomposed_task',
            status: 'synced',
            synced_at: new Date().toISOString()
          });
        }
      } catch (issueErr) {
        // Individual issue sync failure doesn't block others
        console.error(`[linear] Issue sync failed for task ${task.id}: ${issueErr.message}`);
      }
    }

    // 3. Create dependency relations between Linear issues (fire-and-forget)
    createDependencyRelations(missionId).catch(err =>
      console.error(`[linear] Dependency relations failed (non-blocking): ${err.message}`)
    );

    return project;
  } catch (err) {
    console.error(`[linear] syncDecomposedProjectToLinear failed: ${err.message}`);
    return null;
  }
}

/**
 * Create blocking/blocked-by relations in Linear for DAG dependencies.
 * WHY: Decomposed projects have step_dependencies but the Linear issues
 * aren't linked. This makes the dependency graph visible in Linear's board.
 * Called at end of syncDecomposedProjectToLinear().
 *
 * @param {number} missionId - The mission whose steps to link
 * @returns {{ created: number } | null}
 */
async function createDependencyRelations(missionId) {
  if (!process.env.LINEAR_API_KEY) return null;

  try {
    // Get all steps for this mission
    const { data: steps } = await supabase
      .from('mission_steps')
      .select('id')
      .eq('mission_id', missionId);

    if (!steps || steps.length === 0) return null;

    const stepIds = steps.map(s => s.id);

    // Get all DAG dependencies between these steps
    const { data: deps } = await supabase
      .from('step_dependencies')
      .select('step_id, depends_on_step_id')
      .in('step_id', stepIds);

    if (!deps || deps.length === 0) return { created: 0 };

    let created = 0;
    for (const dep of deps) {
      // Look up Linear issue IDs from linear_sync
      const { data: blockerSync } = await supabase
        .from('linear_sync')
        .select('entity_id')
        .eq('mission_step_id', dep.depends_on_step_id)
        .eq('entity_type', 'issue')
        .maybeSingle();

      const { data: blockedSync } = await supabase
        .from('linear_sync')
        .select('entity_id')
        .eq('mission_step_id', dep.step_id)
        .eq('entity_type', 'issue')
        .maybeSingle();

      // Skip if either side missing — sync record may not exist yet
      if (!blockerSync?.entity_id || !blockedSync?.entity_id) continue;

      const result = await linearRequest(
        `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) { success }
        }`,
        {
          input: {
            issueId: blockedSync.entity_id,
            relatedIssueId: blockerSync.entity_id,
            type: 'blocks'
          }
        }
      );

      if (result?.issueRelationCreate?.success) created++;
    }

    console.log(`[linear] Created ${created} dependency relations for mission #${missionId}`);
    return { created };
  } catch (err) {
    console.error(`[linear] createDependencyRelations failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// LINEAR → FRASIER (WEBHOOK)
// ============================================================

/**
 * Validate webhook HMAC-SHA256 signature.
 */
function validateWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (err) {
    return false;
  }
}

/**
 * Process an inbound Linear webhook payload.
 * Only handles Issue creation by Dhroov — everything else is ignored.
 */
async function processLinearWebhook(payload) {
  // Only process Issue creation
  if (payload.action !== 'create' || payload.type !== 'Issue') {
    console.log(`[linear] Webhook ignored: ${payload.action} ${payload.type}`);
    return;
  }

  const data = payload.data || {};

  // Loop prevention layer 1: ignore Frasier's own API user
  const linearApiUserId = process.env.LINEAR_API_USER_ID;
  if (linearApiUserId && data.creatorId === linearApiUserId) {
    console.log('[linear] Webhook ignored: created by Frasier API');
    return;
  }

  // Loop prevention layer 2: ignore issues with frasier-managed label
  const labelIds = data.labelIds || [];
  const frasierManagedId = cache?.labels?.['frasier-managed'];
  if (frasierManagedId && labelIds.includes(frasierManagedId)) {
    console.log('[linear] Webhook ignored: frasier-managed label present');
    return;
  }

  const rawText = `${data.title || ''}\n${data.description || ''}`.trim();
  if (!rawText) {
    console.log('[linear] Webhook ignored: empty issue');
    return;
  }

  console.log(`[linear] Webhook: new issue "${data.title}" by external user`);

  // Polish title/description via LLM
  const polished = await polishTitleAndDescription(rawText);

  // Create mission proposal
  const missions = require('./missions');
  const proposal = await missions.createProposal({
    proposingAgentId: 'zero',
    title: polished.title,
    description: polished.description,
    priority: 'normal',
    rawMessage: rawText
  });

  if (proposal) {
    // Save inbound sync record
    await supabase.from('linear_sync').insert({
      entity_type: 'issue',
      entity_id: data.id || 'unknown',
      entity_identifier: data.identifier || null,
      entity_url: data.url || null,
      sync_type: 'inbound_issue',
      status: 'synced',
      synced_at: new Date().toISOString()
    });

    // Log event for Discord announcement
    const events = require('./events');
    const linearUrl = data.url || '';
    await events.logEvent({
      eventType: 'linear_inbound_issue',
      severity: 'info',
      description: `New mission from Linear: "${polished.title}"${linearUrl ? ` (${linearUrl})` : ''}`,
      data: { proposalId: proposal.id, linearIssueId: data.id }
    });
  }
}

// ============================================================
// LINEAR → FRASIER (POLLING)
// WHY: Linear webhooks require HTTPS. Our VPS is HTTP-only.
// Instead of adding a reverse proxy + SSL cert, we poll the Linear API
// every heartbeat tick (30s) for new issues. Same logic as the webhook
// handler, but pull-based instead of push-based.
// The webhook code stays in place for future HTTPS activation.
// ============================================================

/**
 * Poll Linear for new issues created by Dhroov (not Frasier).
 * Called every heartbeat tick (30s). Deduplicates via linear_sync table.
 */
async function pollForNewIssues() {
  if (!process.env.LINEAR_API_KEY) return;

  try {
    // First poll: look back 60 seconds. Subsequent: since last poll.
    const since = lastPollTime || new Date(Date.now() - 60000).toISOString();
    lastPollTime = new Date().toISOString();

    const teamId = process.env.LINEAR_TEAM_ID;
    const filter = { createdAt: { gte: since } };
    if (teamId) filter.team = { id: { eq: teamId } };

    const data = await linearRequest(`
      query RecentIssues($filter: IssueFilter!) {
        issues(filter: $filter, first: 50) {
          nodes {
            id
            title
            description
            identifier
            url
            creator { id }
            labels { nodes { id name } }
          }
        }
      }
    `, { filter });

    if (!data?.issues?.nodes?.length) return;

    for (const issue of data.issues.nodes) {
      // Loop prevention: skip issues created by Frasier's API user
      const linearApiUserId = process.env.LINEAR_API_USER_ID;
      if (linearApiUserId && issue.creator?.id === linearApiUserId) continue;

      // Loop prevention: skip issues with frasier-managed label
      const labelNames = (issue.labels?.nodes || []).map(l => l.name);
      if (labelNames.includes('frasier-managed')) continue;

      // Dedup: skip if already in linear_sync
      const { data: existing } = await supabase
        .from('linear_sync')
        .select('id')
        .eq('entity_id', issue.id)
        .maybeSingle();
      if (existing) continue;

      console.log(`[linear] Poll: new issue "${issue.title}" (${issue.identifier})`);

      const rawText = `${issue.title || ''}\n${issue.description || ''}`.trim();
      if (!rawText) continue;

      const polished = await polishTitleAndDescription(rawText);

      const missions = require('./missions');
      const proposal = await missions.createProposal({
        proposingAgentId: 'zero',
        title: polished.title,
        description: polished.description,
        priority: 'normal',
        rawMessage: rawText
      });

      if (proposal) {
        await supabase.from('linear_sync').insert({
          entity_type: 'issue',
          entity_id: issue.id,
          entity_identifier: issue.identifier,
          entity_url: issue.url,
          sync_type: 'inbound_issue',
          status: 'synced',
          synced_at: new Date().toISOString()
        });

        const events = require('./events');
        await events.logEvent({
          eventType: 'linear_inbound_issue',
          severity: 'info',
          description: `New mission from Linear: "${polished.title}"${issue.url ? ` (${issue.url})` : ''}`,
          data: { proposalId: proposal.id, linearIssueId: issue.id }
        });
      }
    }
  } catch (err) {
    console.error(`[linear] pollForNewIssues failed: ${err.message}`);
  }
}

// ============================================================
// STARTUP INITIALIZATION
// ============================================================

/**
 * Ensure all required labels exist in Linear. Idempotent.
 */
async function ensureLabelsExist() {
  if (!process.env.LINEAR_API_KEY) return;

  const allLabels = [...AGENT_LABELS, ...WORK_TYPE_LABELS, ...SYSTEM_LABELS];

  // Fetch existing labels
  const data = await linearRequest(`
    query { issueLabels(first: 100) { nodes { id name } } }
  `);

  if (!data) return;

  const existing = new Map(
    (data.issueLabels?.nodes || []).map(l => [l.name, l.id])
  );

  // Cache existing labels
  if (!cache) cache = {};
  if (!cache.labels) cache.labels = {};
  for (const [name, id] of existing) {
    cache.labels[name] = id;
  }

  // Create missing labels
  const teamId = process.env.LINEAR_TEAM_ID;
  for (const labelName of allLabels) {
    if (existing.has(labelName)) continue;

    const result = await linearRequest(
      `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      { input: { name: labelName, teamId } }
    );

    if (result?.issueLabelCreate?.success) {
      cache.labels[labelName] = result.issueLabelCreate.issueLabel.id;
      console.log(`[linear] Created label: ${labelName}`);
    }
  }
}

/**
 * Ensure custom fields exist in Linear. Idempotent.
 */
async function ensureCustomFieldsExist() {
  if (!process.env.LINEAR_API_KEY) return;
  // Custom field creation is done via Linear's settings API
  // For now, we assume custom fields are created manually or via the Linear UI
  // and we cache their IDs at startup
  if (!cache) cache = {};
  if (!cache.customFields) cache.customFields = {};
  console.log('[linear] Custom fields should be created via Linear UI or API');
}

/**
 * Ensure the "In Review" workflow state exists. Idempotent.
 */
async function ensureWorkflowStatesExist() {
  if (!process.env.LINEAR_API_KEY || !process.env.LINEAR_TEAM_ID) return;

  const data = await linearRequest(`
    query Team($id: String!) {
      team(id: $id) {
        states { nodes { id name type } }
      }
    }
  `, { id: process.env.LINEAR_TEAM_ID });

  if (!data?.team?.states?.nodes) return;

  if (!cache) cache = {};
  cache.workflowStates = {};

  for (const state of data.team.states.nodes) {
    cache.workflowStates[state.name] = state.id;
  }

  // Create "In Review" if missing
  if (!cache.workflowStates['In Review']) {
    const result = await linearRequest(
      `mutation WorkflowStateCreate($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) {
          success
          workflowState { id name }
        }
      }`,
      {
        input: {
          name: 'In Review',
          type: 'started',
          teamId: process.env.LINEAR_TEAM_ID
        }
      }
    );

    if (result?.workflowStateCreate?.success) {
      cache.workflowStates['In Review'] = result.workflowStateCreate.workflowState.id;
      console.log('[linear] Created workflow state: In Review');
    }
  }
}

/**
 * Lazily initialize the Linear cache on first use.
 * WHY: Worker.js is a separate PM2 process that never calls initialize().
 * This ensures any function that reads from cache triggers initialization
 * automatically, regardless of which process it's running in.
 */
async function ensureInitialized() {
  if (initialized) return;
  if (!process.env.LINEAR_API_KEY) return;

  console.log('[linear] Auto-initializing (lazy init from worker/other process)...');
  await ensureWorkflowStatesExist();
  await ensureLabelsExist();
  initialized = true;
  console.log('[linear] Lazy init complete');
}

/**
 * Initialize Linear integration: labels, workflow states, custom fields.
 * Called once on heartbeat startup.
 */
async function initialize() {
  if (!process.env.LINEAR_API_KEY) {
    console.log('[linear] LINEAR_API_KEY not set, Linear sync disabled');
    return false;
  }

  console.log('[linear] Initializing Linear integration...');

  await ensureLabelsExist();
  await ensureWorkflowStatesExist();
  await ensureCustomFieldsExist();

  initialized = true;
  console.log('[linear] Initialization complete');
  return true;
}

// ============================================================
// QUERY HELPERS
// ============================================================

/**
 * Get the Linear issue UUID for a Frasier step (from linear_sync).
 */
async function getLinearIssueId(stepId) {
  const { data: sync } = await supabase
    .from('linear_sync')
    .select('entity_id')
    .eq('mission_step_id', stepId)
    .eq('entity_type', 'issue')
    .maybeSingle();

  return sync?.entity_id || null;
}

/**
 * Get the Linear project UUID for a Frasier mission (from linear_sync).
 */
async function getLinearProjectId(missionId) {
  const { data: sync } = await supabase
    .from('linear_sync')
    .select('entity_id')
    .eq('mission_id', missionId)
    .eq('entity_type', 'project')
    .maybeSingle();

  return sync?.entity_id || null;
}

/**
 * Get the Linear project URL for a Frasier mission (from linear_sync).
 * Used by discord_bot.js to add Linear link to announcements.
 */
async function getProjectUrl(missionId) {
  const { data: sync } = await supabase
    .from('linear_sync')
    .select('entity_url')
    .eq('mission_id', missionId)
    .eq('entity_type', 'project')
    .maybeSingle();

  return sync?.entity_url || null;
}

/**
 * Detect work type from task description using keyword matching.
 */
function detectWorkType(description) {
  const lower = (description || '').toLowerCase();
  for (const [keywords, workType] of Object.entries(WORK_TYPE_MAP)) {
    if (lower.includes(keywords)) return workType;
  }
  return null;
}

/**
 * Get cached label ID by name (used for webhook loop prevention).
 */
function getCachedLabelId(name) {
  return cache?.labels?.[name] || null;
}

// ============================================================
// TEST HELPERS (only used by tests)
// ============================================================

function __resetCache() {
  cache = null;
  initialized = false;
}

function __resetInitialized() {
  initialized = false;
}

function __setCache(newCache) {
  if (!cache) cache = {};
  Object.assign(cache, newCache);
  // WHY: If cache is manually populated (by tests or initialize()), no lazy init needed.
  // Without this, ensureInitialized() would trigger even when cache has valid data,
  // consuming mock fetch responses intended for the actual test.
  initialized = true;
}

function __resetPollTime() {
  lastPollTime = null;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  linearRequest,
  polishTitleAndDescription,
  syncMissionToLinear,
  syncStepToLinear,
  updateIssueStatus,
  updateIssueCustomField,
  addIssueComment,
  completeProject,
  cancelProject,
  syncCritiqueScore,
  syncDecomposedProjectToLinear,
  createDependencyRelations,
  ensureLabelsExist,
  ensureCustomFieldsExist,
  ensureWorkflowStatesExist,
  ensureInitialized,
  initialize,
  validateWebhookSignature,
  processLinearWebhook,
  pollForNewIssues,
  getProjectUrl,
  getCachedLabelId,
  __resetCache,
  __setCache,
  __resetPollTime,
  __resetInitialized
};
