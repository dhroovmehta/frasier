// models.js — Tiered LLM routing: MiniMax → Sonnet 4.5 → Claude Opus
// WHY tiered: MiniMax is cheapest for simple tasks, Sonnet handles complex reasoning,
// Opus handles PM/planning work (product requirements, design docs, etc.).
//
// Every call is logged to model_usage for cost tracking.
// Fallback chain: T3→T2→T1 (always degrade gracefully, never fail silently).

const supabase = require('./supabase');

// ============================================================
// MODEL CONFIGURATION
// ============================================================

const MODELS = {
  tier1: {
    name: 'minimax',
    tier: 'tier1',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'minimax/minimax-01',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    maxTokens: 4096,
    costPer1kInput: 0.0004,   // approximate, varies
    costPer1kOutput: 0.0016
  },
  tier2: {
    name: 'claude-sonnet-4.5',
    tier: 'tier2',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-sonnet-4.5',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    maxTokens: 8192,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015
  },
  tier3: {
    name: 'claude-opus-4.5',
    tier: 'tier3',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-opus-4',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    maxTokens: 4096,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075
  }
};

// Task complexity keywords that trigger Tier 2 (Sonnet)
const COMPLEX_KEYWORDS = [
  'strategy', 'analysis', 'architecture', 'financial', 'research',
  'deep dive', 'multi-step', 'persona generation', 'competitive',
  'business plan', 'market analysis', 'code review', 'security audit',
  'long-form', 'comprehensive', 'detailed report',
  'requirements', 'specification',
  'go-to-market', 'pricing model', 'revenue model',
  'technical design', 'system design'
];

// High-stakes deliverable keywords that trigger Tier 3 (Opus)
const TIER3_KEYWORDS = [
  'product requirements', 'product specification', 'design document',
  'final deliverable', 'executive report', 'project plan',
  'product roadmap', 'business case', 'investment memo'
];

// ============================================================
// CORE LLM CALL
// ============================================================

/**
 * Call an LLM with the tiered routing system.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt - Full system prompt (identity + memory)
 * @param {string} params.userMessage - The task/question for the agent
 * @param {string} [params.agentId] - Agent making the call (for logging)
 * @param {number} [params.missionStepId] - Mission step (for logging)
 * @param {string} [params.forceTier] - Override auto-routing: 'tier1' | 'tier2' | 'tier3'
 * @param {boolean} [params.isComplex] - Flag from Team Lead or Frasier
 * @param {string} [params.taskDescription] - Used for auto-complexity detection
 * @returns {Object} { content, model, tier, usage, error }
 */
async function callLLM({
  systemPrompt,
  userMessage,
  agentId = null,
  missionStepId = null,
  forceTier = null,
  isComplex = false,
  taskDescription = ''
}) {
  // Determine which tier to use
  const tier = forceTier || selectTier(isComplex, taskDescription);
  const modelConfig = MODELS[tier];

  // Tier 3 info log (no approval gate — auto-routed by keywords)
  if (tier === 'tier3') {
    console.log(`[models] 🔷 TIER 3 (Opus) call by ${agentId} for high-stakes deliverable.`);
  }

  const startTime = Date.now();

  try {
    const result = await makeAPICall(modelConfig, systemPrompt, userMessage);
    const responseTimeMs = Date.now() - startTime;

    // Log usage
    await logModelUsage({
      agentId,
      missionStepId,
      modelName: modelConfig.name,
      modelTier: modelConfig.tier,
      inputTokens: result.usage?.prompt_tokens || 0,
      outputTokens: result.usage?.completion_tokens || 0,
      estimatedCost: estimateCost(modelConfig, result.usage),
      responseTimeMs,
      success: true
    });

    console.log(`[models] ${modelConfig.name} responded in ${responseTimeMs}ms (${result.usage?.total_tokens || '?'} tokens)`);

    return {
      content: result.content,
      model: modelConfig.name,
      tier: modelConfig.tier,
      usage: result.usage,
      error: null
    };
  } catch (err) {
    const responseTimeMs = Date.now() - startTime;

    // Log failure
    await logModelUsage({
      agentId,
      missionStepId,
      modelName: modelConfig.name,
      modelTier: modelConfig.tier,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      responseTimeMs,
      success: false,
      errorMessage: err.message
    });

    // If Tier 1 fails, retry once after 5 seconds
    if (tier === 'tier1' && !forceTier) {
      console.log(`[models] Tier 1 failed: ${err.message}. Retrying in 5s...`);
      await sleep(5000);
      try {
        const retryResult = await makeAPICall(modelConfig, systemPrompt, userMessage);
        const retryTime = Date.now() - startTime;

        await logModelUsage({
          agentId,
          missionStepId,
          modelName: modelConfig.name,
          modelTier: modelConfig.tier,
          inputTokens: retryResult.usage?.prompt_tokens || 0,
          outputTokens: retryResult.usage?.completion_tokens || 0,
          estimatedCost: estimateCost(modelConfig, retryResult.usage),
          responseTimeMs: retryTime,
          success: true,
          errorMessage: null,
          metadata: { retry: true }
        });

        return {
          content: retryResult.content,
          model: modelConfig.name,
          tier: modelConfig.tier,
          usage: retryResult.usage,
          error: null
        };
      } catch (retryErr) {
        console.error(`[models] Tier 1 retry also failed: ${retryErr.message}`);
      }
    }

    // If Tier 3 fails, fall back to Tier 2, then Tier 1
    if (tier === 'tier3') {
      console.log(`[models] Tier 3 (${modelConfig.name}) failed: ${err.message}. Falling back to tier2...`);
      try {
        const t2Config = MODELS['tier2'];
        const t2Result = await makeAPICall(t2Config, systemPrompt, userMessage);
        const t2Time = Date.now() - startTime;

        await logModelUsage({
          agentId,
          missionStepId,
          modelName: t2Config.name,
          modelTier: 'tier2',
          inputTokens: t2Result.usage?.prompt_tokens || 0,
          outputTokens: t2Result.usage?.completion_tokens || 0,
          estimatedCost: estimateCost(t2Config, t2Result.usage),
          responseTimeMs: t2Time,
          success: true,
          errorMessage: null,
          metadata: { fallbackFrom: 'tier3' }
        });

        return {
          content: t2Result.content,
          model: t2Config.name,
          tier: 'tier2',
          usage: t2Result.usage,
          error: null
        };
      } catch (t2Err) {
        console.log(`[models] Tier 2 fallback also failed: ${t2Err.message}. Falling back to tier1...`);
        try {
          const t1Config = MODELS['tier1'];
          const t1Result = await makeAPICall(t1Config, systemPrompt, userMessage);
          const t1Time = Date.now() - startTime;

          await logModelUsage({
            agentId,
            missionStepId,
            modelName: t1Config.name,
            modelTier: 'tier1',
            inputTokens: t1Result.usage?.prompt_tokens || 0,
            outputTokens: t1Result.usage?.completion_tokens || 0,
            estimatedCost: estimateCost(t1Config, t1Result.usage),
            responseTimeMs: t1Time,
            success: true,
            errorMessage: null,
            metadata: { fallbackFrom: 'tier3_via_tier2' }
          });

          return {
            content: t1Result.content,
            model: t1Config.name,
            tier: 'tier1',
            usage: t1Result.usage,
            error: null
          };
        } catch (t1Err) {
          console.error(`[models] Tier 1 fallback also failed: ${t1Err.message}`);
        }
      }
    }

    // If Tier 2 fails, fall back to Tier 1
    // WHY: Always fall back — failing is worse than using a cheaper model
    if (tier === 'tier2') {
      console.log(`[models] Tier 2 (${modelConfig.name}) failed: ${err.message}. Falling back to tier1...`);
      try {
        const fallbackConfig = MODELS['tier1'];
        const fallbackResult = await makeAPICall(fallbackConfig, systemPrompt, userMessage);
        const fallbackTime = Date.now() - startTime;

        await logModelUsage({
          agentId,
          missionStepId,
          modelName: fallbackConfig.name,
          modelTier: 'tier1',
          inputTokens: fallbackResult.usage?.prompt_tokens || 0,
          outputTokens: fallbackResult.usage?.completion_tokens || 0,
          estimatedCost: estimateCost(fallbackConfig, fallbackResult.usage),
          responseTimeMs: fallbackTime,
          success: true,
          errorMessage: null,
          metadata: { fallbackFrom: 'tier2' }
        });

        return {
          content: fallbackResult.content,
          model: fallbackConfig.name,
          tier: 'tier1',
          usage: fallbackResult.usage,
          error: null
        };
      } catch (fallbackErr) {
        console.error(`[models] Tier 1 fallback also failed: ${fallbackErr.message}`);
      }
    }

    console.error(`[models] ${modelConfig.name} failed: ${err.message}`);
    return {
      content: null,
      model: modelConfig.name,
      tier: modelConfig.tier,
      usage: null,
      error: err.message
    };
  }
}

// ============================================================
// TIER SELECTION
// ============================================================

/**
 * Auto-select the appropriate tier based on complexity flags, keywords, and step context.
 * Routing: T3 keywords → tier3, isComplex/T2 keywords → tier2, default → tier1.
 *
 * @param {boolean} isComplex - Explicit complexity flag
 * @param {string} taskDescription - Task text for keyword matching
 * @param {Object} [stepContext] - Optional step context
 * @param {boolean} [stepContext.isFinalStep] - If true, upgrades to tier2 for quality
 * @returns {string} 'tier1' | 'tier2' | 'tier3'
 */
function selectTier(isComplex, taskDescription = '', stepContext = {}) {
  if (isComplex) return 'tier2';

  // Final step in multi-step mission → always tier2 for quality
  if (stepContext && stepContext.isFinalStep) return 'tier2';

  const lower = taskDescription.toLowerCase();

  // Check T3 keywords first (high-stakes deliverables)
  for (const keyword of TIER3_KEYWORDS) {
    if (lower.includes(keyword)) {
      return 'tier3';
    }
  }

  // Check T2 keywords (complex reasoning tasks)
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lower.includes(keyword)) {
      return 'tier2';
    }
  }

  return 'tier1';
}

// ============================================================
// API CALL (OpenRouter-compatible)
// ============================================================

/**
 * Make the actual HTTP call to the LLM endpoint.
 * Uses OpenRouter format (OpenAI-compatible) for Tier 1 and Tier 3.
 * Manus uses its own format (to be configured when API details are provided).
 */
async function makeAPICall(modelConfig, systemPrompt, userMessage) {
  const apiKey = process.env[modelConfig.apiKeyEnv];

  if (!apiKey) {
    throw new Error(`Missing API key: ${modelConfig.apiKeyEnv}`);
  }

  const endpoint = modelConfig.endpoint;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  // OpenRouter requires HTTP-Referer and X-Title
  if (endpoint.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://frasier.ai';
    headers['X-Title'] = 'Frasier';
  }

  const body = {
    model: modelConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: modelConfig.maxTokens,
    temperature: 0.7
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  if (!data.choices || data.choices.length === 0) {
    throw new Error('No choices returned from LLM');
  }

  return {
    content: data.choices[0].message.content,
    usage: data.usage || null
  };
}

// ============================================================
// COST TRACKING
// ============================================================

function estimateCost(modelConfig, usage) {
  if (!usage) return 0;
  const inputCost = (usage.prompt_tokens || 0) / 1000 * modelConfig.costPer1kInput;
  const outputCost = (usage.completion_tokens || 0) / 1000 * modelConfig.costPer1kOutput;
  return inputCost + outputCost;
}

async function logModelUsage({
  agentId,
  missionStepId,
  modelName,
  modelTier,
  inputTokens,
  outputTokens,
  estimatedCost,
  responseTimeMs,
  success,
  errorMessage = null,
  metadata = {}
}) {
  // WHY: model_usage.agent_id has a FK to agents(id). Internal calls use
  // agentId='system' which doesn't exist in agents table → constraint violation.
  // Sanitize to null for non-agent callers (ISS-017).
  const sanitizedAgentId = (agentId && agentId !== 'system') ? agentId : null;

  const { error } = await supabase
    .from('model_usage')
    .insert({
      agent_id: sanitizedAgentId,
      mission_step_id: missionStepId,
      model_name: modelName,
      model_tier: modelTier,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimatedCost,
      response_time_ms: responseTimeMs,
      success,
      error_message: errorMessage,
      metadata
    });

  if (error) {
    console.error(`[models] Failed to log model usage:`, error.message);
  }
}

/**
 * Get cumulative model costs for a time period.
 * Used by Frasier for daily summaries.
 */
async function getModelCosts(since) {
  const { data, error } = await supabase
    .from('model_usage')
    .select('model_tier, estimated_cost_usd, input_tokens, output_tokens')
    .gte('created_at', since)
    .eq('success', true);

  if (error) {
    console.error(`[models] Failed to get costs:`, error.message);
    return null;
  }

  const summary = {
    tier1: { calls: 0, cost: 0, tokens: 0 },
    tier2: { calls: 0, cost: 0, tokens: 0 },
    tier3: { calls: 0, cost: 0, tokens: 0 },
    total: { calls: 0, cost: 0, tokens: 0 }
  };

  for (const row of (data || [])) {
    const tier = row.model_tier;
    if (summary[tier]) {
      summary[tier].calls++;
      summary[tier].cost += parseFloat(row.estimated_cost_usd) || 0;
      summary[tier].tokens += (row.input_tokens || 0) + (row.output_tokens || 0);
    }
    summary.total.calls++;
    summary.total.cost += parseFloat(row.estimated_cost_usd) || 0;
    summary.total.tokens += (row.input_tokens || 0) + (row.output_tokens || 0);
  }

  return summary;
}

// ============================================================
// HELPERS
// ============================================================

function isCreditExhausted(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('credit') || msg.includes('quota') || msg.includes('exceeded') || msg.includes('insufficient');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  callLLM,
  selectTier,
  getModelCosts,
  MODELS,
  COMPLEX_KEYWORDS,
  TIER3_KEYWORDS
};
