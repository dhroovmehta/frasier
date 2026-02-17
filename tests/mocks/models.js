// Mock for src/lib/models.js — no real HTTP calls, returns configurable canned responses

const mockCallLLM = jest.fn().mockResolvedValue({
  content: 'Mock LLM response',
  model: 'mock',
  tier: 'tier1',
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  error: null
});

const mockSelectTier = jest.fn().mockReturnValue('tier1');

const mockGetModelCosts = jest.fn().mockResolvedValue({
  tier1: { calls: 0, cost: 0, tokens: 0 },
  tier2: { calls: 0, cost: 0, tokens: 0 },
  tier3: { calls: 0, cost: 0, tokens: 0 },
  total: { calls: 0, cost: 0, tokens: 0 }
});

module.exports = {
  callLLM: mockCallLLM,
  selectTier: mockSelectTier,
  getModelCosts: mockGetModelCosts,
  MODELS: {
    tier1: { name: 'minimax', tier: 'tier1', maxTokens: 4096 },
    tier2: { name: 'manus', tier: 'tier2', maxTokens: 8192 },
    tier3: { name: 'claude-opus-4.5', tier: 'tier3', maxTokens: 4096 }
  },
  COMPLEX_KEYWORDS: [
    'strategy', 'analysis', 'architecture', 'financial', 'research',
    'deep dive', 'multi-step', 'persona generation', 'competitive',
    'business plan', 'market analysis', 'code review', 'security audit',
    'long-form', 'comprehensive', 'detailed report'
  ]
};
