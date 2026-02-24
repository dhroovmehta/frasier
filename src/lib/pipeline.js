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
 *
 * WHY structured sources section: Agents need an explicit, enumerated list of
 * available sources so they can cite them precisely. The anti-hallucination
 * instruction ("Use ONLY these sources") prevents fabricated data.
 */
function buildSynthesizePrompt(taskDescription, researchData, subQuestions) {
  let prompt = `## SYNTHESIZE — Produce the deliverable

**Task:** ${taskDescription}`;

  if (researchData && researchData.length > 0) {
    // Structured source reference list — gives the LLM a clear inventory to cite from
    prompt += '\n\n## AVAILABLE SOURCES\n';
    for (let i = 0; i < researchData.length; i++) {
      const item = researchData[i];
      prompt += `\n**[${i + 1}]** ${item.title || item.url}\n- URL: ${item.url}\n- Key data: ${(item.content || '').slice(0, 200)}...\n`;
    }

    // Full source content for deep reference
    prompt += '\n\n## RESEARCH DATA (full source content)\n';
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
- Use ONLY these sources for factual claims. If data is not available in these sources, state "data not available" — never fabricate.
- Use SPECIFIC data from the research sources above — cite URLs
- If data is unavailable for a claim, explicitly state "data not found" rather than inventing numbers
- Produce the ACTUAL deliverable, not a description of what it should contain
- Every claim must be backed by evidence from the research data or clearly marked as an estimate`;

  return prompt;
}

/**
 * Build the self-critique prompt. Agent evaluates its own work.
 * WHY citationScore param: Phase 2 research quality produces an automated citation
 * score (0-1). We inject it here so the LLM factors hard data into its accuracy
 * assessment rather than relying purely on vibes.
 */
function buildCritiquePrompt(taskDescription, deliverable, citationScore) {
  let prompt = `## CRITIQUE YOUR OWN WORK

You just produced the following deliverable. Now evaluate it honestly.

**Original Task:** ${taskDescription}

**Your Deliverable:**
${deliverable}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "scores": {
    "completeness": <1-5>,
    "accuracy": <1-5>,
    "actionability": <1-5>,
    "depth": <1-5>
  },
  "overallScore": <average of above, one decimal>,
  "gaps": ["specific gap 1", "specific gap 2"],
  "lesson": "one sentence about what to do differently next time"
}

## SCORING RUBRIC — Use these anchors for each dimension:

**DEPTH:**
- 1.0: generic, could be from any AI
- 2.0: some specifics but mostly surface
- 3.0: solid domain knowledge, specific examples
- 4.0: expert-level analysis with novel connections
- 5.0: groundbreaking insight, publishable quality

**ACCURACY:**
- 1.0: fabricated facts or hallucinated data
- 2.0: some claims unverified
- 3.0: most claims sourced or reasonable
- 4.0: all claims cross-referenced, sources cited
- 5.0: every claim verified with primary sources

**ACTIONABILITY:**
- 1.0: vague advice, no specifics
- 2.0: some recommendations but lacks detail
- 3.0: clear next steps with owners
- 4.0: detailed playbook with timelines and metrics
- 5.0: ready-to-execute blueprint with contingencies

**COMPLETENESS:**
- 1.0: addresses less than 50% of requirements
- 2.0: major sections missing
- 3.0: all sections present, some thin
- 4.0: comprehensive, minor gaps only
- 5.0: exhaustive, anticipates follow-up questions

CALIBRATION: 3.0 is GOOD work. 4.0 is EXCELLENT. 5.0 is rare — reserve for truly exceptional output. Average output should score 2.5-3.0. Be BRUTALLY HONEST — inflated scores help nobody.`;

  if (citationScore !== undefined && citationScore !== null) {
    prompt += `\n\nNOTE: Automated citation check found citation_score: ${citationScore}. Factor this into your ACCURACY scoring.`;
  }

  return prompt;
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
 * Execute a single round of web research for the given search queries.
 * Returns raw results — counting and retry logic handled by runResearch().
 */
async function executeSearchRound(step, searchQueries) {
  const results = [];
  let totalFetches = 0;
  const MAX_FETCHES = 8;

  for (const query of searchQueries.slice(0, 4)) {
    if (totalFetches >= MAX_FETCHES) break;

    const searchResult = await web.searchWeb(query, 3);
    if (searchResult.error || searchResult.results.length === 0) {
      console.log(`[pipeline] Step #${step.id}: Search "${query}" returned no results`);
      continue;
    }

    for (const result of searchResult.results.slice(0, 2)) {
      if (totalFetches >= MAX_FETCHES) break;

      const page = await web.fetchPage(result.url, 6000);
      totalFetches++;

      if (page.error || !page.content) {
        console.log(`[pipeline] Step #${step.id}: Fetch failed for ${result.url}: ${page.error}`);
        continue;
      }

      results.push({
        title: page.title || result.title,
        url: result.url,
        content: page.content,
        snippet: result.snippet
      });
    }
  }

  return { results, totalFetches };
}

/**
 * Count "substantive" sources — pages with >500 chars of content.
 * Thin pages (listicles, error pages, paywalled stubs) don't count.
 */
function countSubstantiveSources(researchData) {
  const SUBSTANTIVE_THRESHOLD = 500;
  return researchData.filter(r => (r.content || '').length >= SUBSTANTIVE_THRESHOLD).length;
}

/**
 * Build structured source list with metadata for each source.
 * Used by research phase logging and synthesis prompt injection.
 */
function buildStructuredSources(researchData) {
  return researchData.map(r => ({
    url: r.url,
    title: r.title || r.url,
    charCount: (r.content || '').length,
    keyDataPoints: (r.content || '').slice(0, 200)
  }));
}

/**
 * Ask the LLM to generate refined search queries when initial research is insufficient.
 * Uses T1 (cheap) since this is meta-work.
 */
async function generateRefinedQueries(step, originalQueries, taskDescription) {
  const result = await models.callLLM({
    systemPrompt: 'You are a search query optimization assistant. Respond only with valid JSON.',
    userMessage: `## REFINE_QUERIES — Generate better search queries

The following queries did not return enough substantive results:
${originalQueries.map(q => `- "${q}"`).join('\n')}

Original task: ${taskDescription}

Generate 2-3 refined queries that are more specific and likely to return data-rich results.
Respond with ONLY JSON: {"refinedQueries": ["query1", "query2"]}`,
    agentId: step.assigned_agent_id,
    missionStepId: step.id,
    forceTier: 'tier1'
  });

  if (result.error) return [];

  try {
    const cleaned = result.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed.refinedQueries || [];
  } catch (e) {
    return [];
  }
}

/**
 * Execute the research phase. Searches the web, validates source quality,
 * and retries with refined queries if insufficient substantive sources found.
 *
 * WHY retry logic: The original research phase accepted whatever came back,
 * even if it was all thin/paywalled content. Now we require >= 3 substantive
 * sources (>500 chars) and retry up to 2 times with LLM-refined queries.
 *
 * @returns {{ researchData, structuredSources, substantiveSources, retriesAttempted, durationMs }}
 */
async function runResearch(step, searchQueries, taskDescription) {
  const startTime = Date.now();
  const MIN_SUBSTANTIVE = 3;
  const MAX_RETRIES = 2;

  let researchData = [];
  let retriesAttempted = 0;
  let currentQueries = searchQueries;

  // Initial search round
  const initial = await executeSearchRound(step, currentQueries);
  researchData = initial.results;

  // WHY: Retry with refined queries when sources are insufficient.
  // Thin content (paywalled, stubs, error pages) doesn't count as substantive.
  let substantiveCount = countSubstantiveSources(researchData);
  while (substantiveCount < MIN_SUBSTANTIVE && retriesAttempted < MAX_RETRIES) {
    retriesAttempted++;
    console.log(`[pipeline] Step #${step.id}: Only ${substantiveCount} substantive sources, retrying (${retriesAttempted}/${MAX_RETRIES})`);

    const refinedQueries = await generateRefinedQueries(step, currentQueries, taskDescription || '');
    if (refinedQueries.length === 0) break;

    currentQueries = refinedQueries;
    const retry = await executeSearchRound(step, refinedQueries);
    // Merge new results (dedup by URL)
    const existingUrls = new Set(researchData.map(r => r.url));
    for (const result of retry.results) {
      if (!existingUrls.has(result.url)) {
        researchData.push(result);
        existingUrls.add(result.url);
      }
    }
    substantiveCount = countSubstantiveSources(researchData);
  }

  const structuredSources = buildStructuredSources(researchData);
  const durationMs = Date.now() - startTime;
  console.log(`[pipeline] Step #${step.id}: Research phase found ${researchData.length} sources (${substantiveCount} substantive, ${retriesAttempted} retries)`);

  return { researchData, structuredSources, substantiveSources: substantiveCount, retriesAttempted, durationMs };
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
 * @param {Object} step - The mission step being evaluated
 * @param {string} taskDescription - The original task description
 * @param {string} deliverable - The deliverable content to critique
 * @param {number} [citationScore] - Optional citation score from Phase 2 research quality (0-1)
 * @returns {{ overallScore, scores, gaps, lesson, raw, tokens, durationMs }}
 */
async function runCritique(step, taskDescription, deliverable, citationScore) {
  const startTime = Date.now();
  const prompt = buildCritiquePrompt(taskDescription, deliverable, citationScore);

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
      scores: { completeness: 3, accuracy: 3, actionability: 3, depth: 3 },
      overallScore: 3.0,
      gaps: [],
      lesson: null
    };
  }

  // WHY: Backward compatibility — the old prompt used "dataBacked" but we
  // renamed to "accuracy" for clarity. If the LLM returns the old field name,
  // normalize it so downstream code always sees "accuracy".
  const scores = parsed.scores || {};
  if (scores.dataBacked !== undefined && scores.accuracy === undefined) {
    scores.accuracy = scores.dataBacked;
    delete scores.dataBacked;
  }

  return {
    overallScore: parsed.overallScore || 3.0,
    scores,
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
// CITATION VALIDATION
// ============================================================

/**
 * Validate that URLs cited in the output actually came from research sources.
 * Computes a citation score (0-1) based on how many factual paragraphs have citations.
 *
 * WHY: Agents sometimes hallucinate URLs or cite sources not in the research data.
 * This is a zero-LLM-cost check (string matching only) that catches fabrication.
 *
 * @param {string} output - The synthesized deliverable content
 * @param {Array<{url: string}>} researchSources - Structured source list from research phase
 * @returns {{ citedUrls, uncitedUrls, citationScore, citedClaims, totalFactualClaims }}
 */
function validateSourceCitations(output, researchSources) {
  const sourceUrls = new Set((researchSources || []).map(s => s.url));

  // Extract all URLs mentioned in the output (in [Source: URL] or [URL] patterns, or bare URLs)
  const urlPattern = /https?:\/\/[^\s\])"]+/g;
  const foundUrls = [...new Set((output.match(urlPattern) || []))];

  const citedUrls = foundUrls.filter(url => sourceUrls.has(url));
  const uncitedUrls = foundUrls.filter(url => !sourceUrls.has(url));

  // Count factual paragraphs: non-empty lines that aren't just headers or whitespace
  const paragraphs = output.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return false; // Headers
    if (trimmed.startsWith('---')) return false; // Dividers
    if (trimmed.startsWith('- **[')) return false; // Source list items
    return trimmed.length > 30; // Substantive paragraphs only
  });

  const totalFactualClaims = paragraphs.length;

  // Count paragraphs that contain at least one cited URL
  const citedClaims = paragraphs.filter(para => {
    return citedUrls.some(url => para.includes(url));
  }).length;

  const citationScore = totalFactualClaims > 0 ? citedClaims / totalFactualClaims : 0;

  return { citedUrls, uncitedUrls, citationScore, citedClaims, totalFactualClaims };
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
  // PHASE 2: RESEARCH (skippable, with retry logic)
  // ──────────────────────────────────────────────
  let researchData = [];
  let structuredSources = [];
  if (!config.skipResearch) {
    console.log(`[pipeline] Step #${step.id}: Starting RESEARCH phase (${decompose.searchQueries.length} queries)`);
    const research = await runResearch(step, decompose.searchQueries, userMessage);
    researchData = research.researchData;
    structuredSources = research.structuredSources;

    await logPhase(step.id, 'research', 2, {
      content: researchData.map(r => `[${r.title}](${r.url})`).join('\n'),
      modelTier: null,
      durationMs: research.durationMs,
      metadata: {
        queriesExecuted: decompose.searchQueries.length,
        sourcesFound: researchData.length,
        substantiveSources: research.substantiveSources,
        retriesAttempted: research.retriesAttempted,
        structuredSources: research.structuredSources
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
  // CITATION VALIDATION (zero LLM cost — string matching)
  // ──────────────────────────────────────────────
  let citationScore = config.citationScore !== undefined ? config.citationScore : null;
  if (citationScore === null && structuredSources.length > 0) {
    const citationResult = validateSourceCitations(synthesize.content, structuredSources);
    citationScore = citationResult.citationScore;
  }

  // ──────────────────────────────────────────────
  // PHASE 4: SELF-CRITIQUE + REVISION LOOP (max 2 revisions)
  // WHY: New revision triggers — ANY dimension < 3.0 OR average < 3.5.
  // Re-critiques after each revision to verify improvement.
  // ──────────────────────────────────────────────
  const MAX_REVISIONS = 2;
  let currentContent = synthesize.content;
  let finalCritique = null;
  let revised = false;
  let revisionCount = 0;

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt++) {
    console.log(`[pipeline] Step #${step.id}: Starting CRITIQUE phase${attempt > 0 ? ` (post-revision ${attempt})` : ''}`);
    const critique = await runCritique(step, userMessage, currentContent, citationScore);

    const critiqueMetadata = {
      scores: critique.scores,
      gaps: critique.gaps
    };
    if (citationScore !== null) {
      critiqueMetadata.citationScore = citationScore;
    }

    await logPhase(step.id, 'critique', 4 + (attempt * 2), {
      content: critique.raw,
      modelTier: 'tier1',
      tokens: critique.tokens,
      durationMs: critique.durationMs,
      score: critique.overallScore,
      metadata: critiqueMetadata
    });
    phases.push({ name: 'critique', durationMs: critique.durationMs });

    console.log(`[pipeline] Step #${step.id}: Critique score: ${critique.overallScore}/5`);
    finalCritique = critique;

    // WHY: Check both per-dimension and average thresholds.
    // ANY single weak dimension drags the whole deliverable down.
    const scores = critique.scores || {};
    const dimValues = Object.values(scores).filter(v => typeof v === 'number');
    const anyDimBelowThreshold = dimValues.some(v => v < 3.0);
    const avgScore = dimValues.length > 0
      ? dimValues.reduce((a, b) => a + b, 0) / dimValues.length
      : critique.overallScore;
    const needsRevision = anyDimBelowThreshold || avgScore < 3.5;

    if (!needsRevision || attempt >= MAX_REVISIONS) break;

    // ── REVISE ──
    revisionCount++;
    console.log(`[pipeline] Step #${step.id}: Revision ${revisionCount}/${MAX_REVISIONS} — ${anyDimBelowThreshold ? 'dimension below 3.0' : 'average below 3.5'}`);
    const revise = await runRevise(
      step, promptData, userMessage, currentContent,
      critique, researchData, effectiveTier
    );

    if (!revise.error && revise.content) {
      currentContent = revise.content;
      revised = true;

      await logPhase(step.id, 'revise', 5 + ((attempt) * 2), {
        content: revise.content,
        modelTier: effectiveTier,
        tokens: revise.tokens,
        durationMs: revise.durationMs
      });
      phases.push({ name: 'revise', durationMs: revise.durationMs });
    } else {
      console.log(`[pipeline] Step #${step.id}: Revise failed (${revise.error}), keeping current content`);
      break; // Revision failed, stop trying
    }
  }

  console.log(`[pipeline] Step #${step.id}: Pipeline complete (${phases.length} phases, score: ${finalCritique.overallScore}, revised: ${revised}, revisions: ${revisionCount})`);

  return {
    content: currentContent,
    critiqueScore: finalCritique.overallScore,
    critiqueLesson: finalCritique.lesson,
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
  getCritiquePhase,
  validateSourceCitations
};
