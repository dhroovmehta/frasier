// pipeline.js — Deep work execution engine
// WHY: Replaces the single LLM call in worker.js:122-128 with a multi-phase pipeline
// that produces dramatically better output: decompose → research → synthesize →
// self-critique → (revise if needed). Each phase is logged to pipeline_phases for
// full audit trail.
//
// KEY DESIGN DECISIONS:
// - Runs inside existing worker process (no new PM2 process)
// - Phases run sequentially (safe for 1GB RAM VPS)
// - Web fetches capped at 8 per step (bounded latency)
// - Revise phase capped at 1 attempt (prevents loops)
// - skipResearch config for engineering/creative tasks
// - skipPipeline config for trivial tasks (legacy single-shot)

const supabase = require('./supabase');
const models = require('./models');
const web = require('./web');

// ============================================================
// PHASE PROMPTS
// ============================================================

/**
 * Build the decompose prompt. Asks the LLM to break a task into sub-questions
 * and generate targeted search queries.
 */
function buildDecomposePrompt(taskDescription, approachHints) {
  let prompt = `## DECOMPOSE THIS TASK

You are preparing to execute the following task. Before doing the work, break it down.

**Task:** ${taskDescription}

Respond with ONLY a JSON object (no markdown, no explanation) with this structure:
{
  "subQuestions": ["specific question 1", "specific question 2", ...],
  "searchQueries": ["web search query 1", "web search query 2", ...],
  "keyRequirements": ["what the final deliverable must include"]
}

Rules:
- 2-4 sub-questions that, once answered, fully address the task
- 2-4 web search queries designed to find REAL DATA (market reports, competitor info, statistics)
- Search queries should be specific and include the current year where relevant
- keyRequirements should list what makes a HIGH-QUALITY deliverable for this task`;

  if (approachHints) {
    prompt += `\n\n## PAST APPROACH (what worked before on similar tasks)\n${approachHints}`;
  }

  return prompt;
}

/**
 * Build the synthesize prompt. Combines task + research data + quality context
 * into a single prompt for producing the actual deliverable.
 */
function buildSynthesizePrompt(taskDescription, researchData, subQuestions) {
  let prompt = `## SYNTHESIZE — Produce the deliverable

**Task:** ${taskDescription}`;

  if (researchData && researchData.length > 0) {
    prompt += '\n\n## RESEARCH DATA (real web sources — cite these)\n';
    for (const item of researchData) {
      prompt += `\n### Source: ${item.title || item.url}\nURL: ${item.url}\n${item.content}\n`;
    }
  }

  if (subQuestions && subQuestions.length > 0) {
    prompt += '\n\n## SUB-QUESTIONS TO ADDRESS\n';
    for (const q of subQuestions) {
      prompt += `- ${q}\n`;
    }
  }

  prompt += `\n\n## CRITICAL REQUIREMENTS
- Use SPECIFIC data from the research sources above — cite URLs
- If data is unavailable for a claim, explicitly state "data not found" rather than inventing numbers
- Produce the ACTUAL deliverable, not a description of what it should contain
- Every claim must be backed by evidence from the research data or clearly marked as an estimate`;

  return prompt;
}

/**
 * Build the self-critique prompt. Agent evaluates its own work.
 */
function buildCritiquePrompt(taskDescription, deliverable) {
  return `## CRITIQUE YOUR OWN WORK

You just produced the following deliverable. Now evaluate it honestly.

**Original Task:** ${taskDescription}

**Your Deliverable:**
${deliverable}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "scores": {
    "completeness": <1-5>,
    "dataBacked": <1-5>,
    "actionability": <1-5>,
    "depth": <1-5>
  },
  "overallScore": <average of above, one decimal>,
  "gaps": ["specific gap 1", "specific gap 2"],
  "lesson": "one sentence about what to do differently next time"
}

Scoring guide:
- 5: Exceptional — executive-ready, all claims data-backed, actionable
- 4: Good — solid work with minor gaps
- 3: Acceptable — meets basic requirements but lacks depth
- 2: Below standard — missing key data or too generic
- 1: Unacceptable — hallucinated data, surface-level, or off-topic`;
}

/**
 * Build the revise prompt. Gives the agent its critique feedback + original research
 * to produce an improved deliverable.
 */
function buildRevisePrompt(taskDescription, originalDeliverable, critiqueData, researchData) {
  let prompt = `## REVISE YOUR DELIVERABLE

Your self-critique identified gaps. Fix them.

**Original Task:** ${taskDescription}

**Your Previous Output:**
${originalDeliverable}

**Self-Critique Feedback:**
- Overall Score: ${critiqueData.overallScore}/5
- Gaps: ${(critiqueData.gaps || []).join('; ')}`;

  if (researchData && researchData.length > 0) {
    prompt += '\n\n## RESEARCH DATA (available for revision)\n';
    for (const item of researchData) {
      prompt += `\n### Source: ${item.title || item.url}\nURL: ${item.url}\n${item.content}\n`;
    }
  }

  prompt += `\n\n## REVISION INSTRUCTIONS
- Address EVERY gap identified in the critique
- Do NOT remove good content from the original — improve it
- Add specific data and citations where the critique found gaps
- Produce the COMPLETE revised deliverable (not just the changes)`;

  return prompt;
}

// ============================================================
// PHASE EXECUTION
// ============================================================

/**
 * Execute the decompose phase. Breaks the task into sub-questions and search queries.
 * Uses tier1 (cheap) since this is meta-work, not the actual deliverable.
 *
 * @returns {{ subQuestions, searchQueries, keyRequirements, raw, durationMs }}
 */
async function runDecompose(step, taskDescription, approachHints) {
  const startTime = Date.now();
  const prompt = buildDecomposePrompt(taskDescription, approachHints);

  const result = await models.callLLM({
    systemPrompt: 'You are a task decomposition assistant. Respond only with valid JSON.',
    userMessage: prompt,
    agentId: step.assigned_agent_id,
    missionStepId: step.id,
    forceTier: 'tier1'
  });

  const durationMs = Date.now() - startTime;

  if (result.error) {
    return { error: result.error, durationMs };
  }

  // Parse the JSON response — handle malformed gracefully
  let parsed;
  try {
    // Strip markdown fences if the LLM wrapped the JSON
    const cleaned = result.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // LLM returned non-JSON — use defaults
    console.log(`[pipeline] Step #${step.id}: Decompose returned non-JSON, using defaults`);
    parsed = {
      subQuestions: [taskDescription],
      searchQueries: [taskDescription],
      keyRequirements: ['Complete the task as described']
    };
  }

  return {
    subQuestions: parsed.subQuestions || [taskDescription],
    searchQueries: parsed.searchQueries || [taskDescription],
    keyRequirements: parsed.keyRequirements || [],
    raw: result.content,
    tokens: result.usage,
    durationMs
  };
}

/**
 * Execute the research phase. Pure web search — no LLM calls.
 * Searches the web for each query from decompose, then fetches top pages.
 *
 * @returns {{ researchData: Array<{title, url, content}>, durationMs }}
 */
async function runResearch(step, searchQueries) {
  const startTime = Date.now();
  const researchData = [];
  let totalFetches = 0;
  const MAX_FETCHES = 8;

  for (const query of searchQueries.slice(0, 4)) {
    if (totalFetches >= MAX_FETCHES) break;

    const searchResult = await web.searchWeb(query, 3);
    if (searchResult.error || searchResult.results.length === 0) {
      console.log(`[pipeline] Step #${step.id}: Search "${query}" returned no results`);
      continue;
    }

    // Fetch top 2 pages per query
    for (const result of searchResult.results.slice(0, 2)) {
      if (totalFetches >= MAX_FETCHES) break;

      const page = await web.fetchPage(result.url, 6000);
      totalFetches++;

      if (page.error || !page.content) {
        console.log(`[pipeline] Step #${step.id}: Fetch failed for ${result.url}: ${page.error}`);
        continue;
      }

      researchData.push({
        title: page.title || result.title,
        url: result.url,
        content: page.content,
        snippet: result.snippet
      });
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`[pipeline] Step #${step.id}: Research phase found ${researchData.length} sources (${totalFetches} fetches)`);

  return { researchData, durationMs };
}

/**
 * Execute the synthesize phase. Produces the actual deliverable using the agent's
 * full persona/memory prompt + research data.
 *
 * @returns {{ content, tokens, durationMs }}
 */
async function runSynthesize(step, promptData, taskDescription, researchData, subQuestions, effectiveTier) {
  const startTime = Date.now();
  const userMessage = buildSynthesizePrompt(taskDescription, researchData, subQuestions);

  const result = await models.callLLM({
    systemPrompt: promptData.systemPrompt,
    userMessage,
    agentId: step.assigned_agent_id,
    missionStepId: step.id,
    forceTier: effectiveTier
  });

  const durationMs = Date.now() - startTime;

  if (result.error) {
    return { error: result.error, durationMs };
  }

  return {
    content: result.content,
    tokens: result.usage,
    durationMs
  };
}

/**
 * Execute the self-critique phase. Agent evaluates its own work.
 * Uses tier1 (cheap) since this is evaluation, not creation.
 *
 * @returns {{ overallScore, gaps, lesson, raw, tokens, durationMs }}
 */
async function runCritique(step, taskDescription, deliverable) {
  const startTime = Date.now();
  const prompt = buildCritiquePrompt(taskDescription, deliverable);

  const result = await models.callLLM({
    systemPrompt: 'You are a quality reviewer. Evaluate work honestly and respond only with valid JSON.',
    userMessage: prompt,
    agentId: step.assigned_agent_id,
    missionStepId: step.id,
    forceTier: 'tier1'
  });

  const durationMs = Date.now() - startTime;

  if (result.error) {
    // Critique failure is non-fatal — default to moderate score
    console.log(`[pipeline] Step #${step.id}: Critique LLM failed: ${result.error}, defaulting to score 3.0`);
    return {
      overallScore: 3.0,
      gaps: [],
      lesson: null,
      raw: null,
      tokens: result.usage,
      durationMs
    };
  }

  // Parse critique JSON — handle malformed gracefully
  let parsed;
  try {
    const cleaned = result.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Non-JSON critique — try to extract a score from the text
    console.log(`[pipeline] Step #${step.id}: Critique returned non-JSON, defaulting to score 3.0`);
    parsed = {
      scores: { completeness: 3, dataBacked: 3, actionability: 3, depth: 3 },
      overallScore: 3.0,
      gaps: [],
      lesson: null
    };
  }

  return {
    overallScore: parsed.overallScore || 3.0,
    scores: parsed.scores || {},
    gaps: parsed.gaps || [],
    lesson: parsed.lesson || null,
    raw: result.content,
    tokens: result.usage,
    durationMs
  };
}

/**
 * Execute the revise phase. Agent improves its deliverable based on critique feedback.
 * Uses the step's effective tier (same as synthesize).
 *
 * @returns {{ content, tokens, durationMs }}
 */
async function runRevise(step, promptData, taskDescription, originalContent, critiqueData, researchData, effectiveTier) {
  const startTime = Date.now();
  const userMessage = buildRevisePrompt(taskDescription, originalContent, critiqueData, researchData);

  const result = await models.callLLM({
    systemPrompt: promptData.systemPrompt,
    userMessage,
    agentId: step.assigned_agent_id,
    missionStepId: step.id,
    forceTier: effectiveTier
  });

  const durationMs = Date.now() - startTime;

  if (result.error) {
    return { error: result.error, durationMs };
  }

  return {
    content: result.content,
    tokens: result.usage,
    durationMs
  };
}

// ============================================================
// PHASE LOGGING
// ============================================================

/**
 * Save a phase record to the pipeline_phases table.
 */
async function logPhase(stepId, phaseName, phaseOrder, { content, modelTier, tokens, durationMs, score, metadata }) {
  const { error } = await supabase.from('pipeline_phases').insert({
    mission_step_id: stepId,
    phase_name: phaseName,
    phase_order: phaseOrder,
    output_content: content || null,
    model_tier: modelTier || null,
    tokens_used: (tokens?.prompt_tokens || 0) + (tokens?.completion_tokens || 0),
    duration_ms: durationMs || 0,
    score: score || null,
    metadata: metadata || {}
  });

  if (error) {
    console.error(`[pipeline] Failed to log phase ${phaseName} for step #${stepId}: ${error.message}`);
  }
}

// ============================================================
// MAIN EXECUTE FUNCTION
// ============================================================

/**
 * Execute the deep work pipeline for a mission step.
 *
 * @param {Object} params
 * @param {Object} params.step - The mission step being executed
 * @param {Object} params.promptData - Agent prompt data from memory.buildAgentPrompt()
 * @param {string} params.userMessage - The enriched task description
 * @param {string} params.effectiveTier - The LLM tier for substantive work
 * @param {Object} [params.config] - Pipeline configuration overrides
 * @param {boolean} [params.config.skipResearch] - Skip web research (engineering/creative)
 * @param {boolean} [params.config.skipPipeline] - Skip entire pipeline (simple/trivial)
 *
 * @returns {{ content, critiqueScore, critiqueLesson, revised, phases, error }}
 */
async function execute({ step, promptData, userMessage, effectiveTier, config = {} }) {
  const phases = [];

  // ──────────────────────────────────────────────
  // SKIP PIPELINE: Legacy single-shot for trivial tasks
  // ──────────────────────────────────────────────
  if (config.skipPipeline) {
    const startTime = Date.now();
    const result = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage,
      agentId: step.assigned_agent_id,
      missionStepId: step.id,
      forceTier: effectiveTier
    });

    if (result.error) {
      return { content: null, critiqueScore: null, critiqueLesson: null, revised: false, phases: [], error: result.error };
    }

    return {
      content: result.content,
      critiqueScore: null,
      critiqueLesson: null,
      revised: false,
      phases: [{ name: 'single-shot', durationMs: Date.now() - startTime }],
      error: null
    };
  }

  // ──────────────────────────────────────────────
  // PHASE 1: DECOMPOSE
  // ──────────────────────────────────────────────
  console.log(`[pipeline] Step #${step.id}: Starting DECOMPOSE phase`);
  const decompose = await runDecompose(step, userMessage, null);

  if (decompose.error) {
    return { content: null, critiqueScore: null, critiqueLesson: null, revised: false, phases: [], error: `Decompose failed: ${decompose.error}` };
  }

  await logPhase(step.id, 'decompose', 1, {
    content: decompose.raw,
    modelTier: 'tier1',
    tokens: decompose.tokens,
    durationMs: decompose.durationMs,
    metadata: {
      subQuestions: decompose.subQuestions,
      searchQueries: decompose.searchQueries,
      keyRequirements: decompose.keyRequirements
    }
  });
  phases.push({ name: 'decompose', durationMs: decompose.durationMs });

  // ──────────────────────────────────────────────
  // PHASE 2: RESEARCH (skippable)
  // ──────────────────────────────────────────────
  let researchData = [];
  if (!config.skipResearch) {
    console.log(`[pipeline] Step #${step.id}: Starting RESEARCH phase (${decompose.searchQueries.length} queries)`);
    const research = await runResearch(step, decompose.searchQueries);
    researchData = research.researchData;

    await logPhase(step.id, 'research', 2, {
      content: researchData.map(r => `[${r.title}](${r.url})`).join('\n'),
      modelTier: null,
      durationMs: research.durationMs,
      metadata: {
        queriesExecuted: decompose.searchQueries.length,
        sourcesFound: researchData.length
      }
    });
    phases.push({ name: 'research', durationMs: research.durationMs });
  }

  // ──────────────────────────────────────────────
  // PHASE 3: SYNTHESIZE
  // ──────────────────────────────────────────────
  console.log(`[pipeline] Step #${step.id}: Starting SYNTHESIZE phase (${effectiveTier})`);
  const synthesize = await runSynthesize(
    step, promptData, userMessage, researchData,
    decompose.subQuestions, effectiveTier
  );

  if (synthesize.error) {
    return { content: null, critiqueScore: null, critiqueLesson: null, revised: false, phases, error: `Synthesize failed: ${synthesize.error}` };
  }

  await logPhase(step.id, 'synthesize', 3, {
    content: synthesize.content,
    modelTier: effectiveTier,
    tokens: synthesize.tokens,
    durationMs: synthesize.durationMs
  });
  phases.push({ name: 'synthesize', durationMs: synthesize.durationMs });

  // ──────────────────────────────────────────────
  // PHASE 4: SELF-CRITIQUE
  // ──────────────────────────────────────────────
  console.log(`[pipeline] Step #${step.id}: Starting CRITIQUE phase`);
  const critique = await runCritique(step, userMessage, synthesize.content);

  await logPhase(step.id, 'critique', 4, {
    content: critique.raw,
    modelTier: 'tier1',
    tokens: critique.tokens,
    durationMs: critique.durationMs,
    score: critique.overallScore,
    metadata: {
      scores: critique.scores,
      gaps: critique.gaps
    }
  });
  phases.push({ name: 'critique', durationMs: critique.durationMs });

  console.log(`[pipeline] Step #${step.id}: Critique score: ${critique.overallScore}/5`);

  // ──────────────────────────────────────────────
  // PHASE 5: REVISE (conditional — only if score < 3)
  // ──────────────────────────────────────────────
  let finalContent = synthesize.content;
  let revised = false;

  if (critique.overallScore < 3) {
    console.log(`[pipeline] Step #${step.id}: Score ${critique.overallScore} < 3 — starting REVISE phase`);
    const revise = await runRevise(
      step, promptData, userMessage, synthesize.content,
      critique, researchData, effectiveTier
    );

    if (!revise.error && revise.content) {
      finalContent = revise.content;
      revised = true;

      await logPhase(step.id, 'revise', 5, {
        content: revise.content,
        modelTier: effectiveTier,
        tokens: revise.tokens,
        durationMs: revise.durationMs
      });
      phases.push({ name: 'revise', durationMs: revise.durationMs });
    } else {
      console.log(`[pipeline] Step #${step.id}: Revise failed (${revise.error}), using original synthesize output`);
    }
  }

  console.log(`[pipeline] Step #${step.id}: Pipeline complete (${phases.length} phases, score: ${critique.overallScore}, revised: ${revised})`);

  return {
    content: finalContent,
    critiqueScore: critique.overallScore,
    critiqueLesson: critique.lesson,
    revised,
    phases,
    error: null
  };
}

// ============================================================
// UTILITY: Get critique phase for a step (used by Phase 5 lesson extraction)
// ============================================================

/**
 * Retrieve the critique phase record for a given step.
 * Used by worker.js to extract lessons from the critique without an extra LLM call.
 *
 * @param {number} missionStepId
 * @returns {Object|null} The critique phase record, or null if not found
 */
async function getCritiquePhase(missionStepId) {
  const { data, error } = await supabase
    .from('pipeline_phases')
    .select()
    .eq('mission_step_id', missionStepId)
    .eq('phase_name', 'critique')
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

module.exports = {
  execute,
  getCritiquePhase
};
