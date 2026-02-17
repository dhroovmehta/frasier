// models.js — Tiered LLM routing: MiniMax → Manus → Claude Opus 4.5
// WHY tiered: MiniMax is cheapest for simple tasks, Manus handles complex reasoning,
// Claude is emergency fallback only (expensive + rate limits).
//
// Every call is logged to model_usage for cost tracking.
// Tier 3 (Claude) requires explicit founder approval via Discord.

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
    name: 'manus',
    tier: 'tier2',
    endpoint: null, // Set when Manus API details provided
    model: 'manus',
    apiKeyEnv: 'MANUS_API_KEY',
    maxTokens: 8192,
    costPer1kInput: 0,  // Per Manus plan (not per-token)
    costPer1kOutput: 0
  },
  tier3: {
    name: 'claude-opus-4.5',
    tier: 'tier3',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-opus-4-20250514',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    maxTokens: 4096,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075
  }
};

// Task complexity keywords that trigger Tier 2
const COMPLEX_KEYWORDS = [
  'strategy', 'analysis', 'architecture', 'financial', 'research',
  'deep dive', 'multi-step', 'persona generation', 'competitive',
  'business plan', 'market analysis', 'code review', 'security audit',
  'long-form', 'comprehensive', 'detailed report',
  'requirements', 'specification', 'design document',
  'go-to-market', 'pricing model', 'revenue model',
  'technical design', 'system design'
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

  // Tier 3 guard: should have been pre-approved
  if (tier === 'tier3') {
    console.log(`[models] ⚠ TIER 3 (Claude) call by ${agentId}. This should have founder approval.`);
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

    // If Manus fails with credits exhausted, flag for Tier 3 escalation
    if (tier === 'tier2' && isCreditExhausted(err)) {
      console.log(`[models] Manus credits exhausted. Tier 3 escalation needed.`);
      return {
        content: null,
        model: modelConfig.name,
        tier: modelConfig.tier,
        usage: null,
        error: 'MANUS_CREDITS_EXHAUSTED'
      };
    }

    // If Tier 2 fails (not credit exhaustion), fall back to Tier 1
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
 * Default is always Tier 1 (MiniMax). Complex tasks route to Tier 2 (Manus).
 *
 * @param {boolean} isComplex - Explicit complexity flag
 * @param {string} taskDescription - Task text for keyword matching
 * @param {Object} [stepContext] - Optional step context
 * @param {boolean} [stepContext.isFinalStep] - If true, upgrades to tier2 for quality
 * @returns {string} 'tier1' | 'tier2'
 */
function selectTier(isComplex, taskDescription = '', stepContext = {}) {
  // Don't upgrade to tier2 if Manus isn't configured — stay on tier1
  const manusAvailable = MODELS.tier2.endpoint && process.env[MODELS.tier2.apiKeyEnv];
  if (!manusAvailable) return 'tier1';

  if (isComplex) return 'tier2';

  // Final step in multi-step mission → always tier2 for quality
  if (stepContext && stepContext.isFinalStep) return 'tier2';

  // Auto-detect complexity from task description
  const lower = taskDescription.toLowerCase();
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

  // Manus has its own endpoint format — handled separately when configured
  if (modelConfig.name === 'manus' && !modelConfig.endpoint) {
    throw new Error('Manus API endpoint not configured. Set MANUS_API_ENDPOINT in .env');
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
  const { error } = await supabase
    .from('model_usage')
    .insert({
      agent_id: agentId,
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
  COMPLEX_KEYWORDS
};
