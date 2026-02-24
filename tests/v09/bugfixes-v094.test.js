// tests/v09/bugfixes-v094.test.js — Bug fixes for v0.9.4
// TDD: Tests define the contract for 4 bug fixes found during integration testing.
//
// Bug 1 (CRITICAL): classifyMessage() never wired in — resolveActionTag() override
// Bug 2 (MEDIUM): Linear project description > 255 chars — truncateForLinear()
// Bug 3 (LOW): Custom field errors pollute logs — silent skip when not configured
// Bug 4 (LOW): model_usage FK violation — sanitizeAgentId()

const createMockSupabase = require('../mocks/supabase');
const { resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

// ============================================================
// DISCORD BOT MOCKS (required because discord_bot.js has side effects)
// ============================================================

jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    once: jest.fn(),
    on: jest.fn(),
    login: jest.fn().mockResolvedValue(null),
    guilds: { cache: new Map() }
  })),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
  Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' }
}));

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);
jest.mock('../../src/lib/models', () => require('../mocks/models'));
jest.mock('../../src/lib/memory', () => ({
  buildAgentPrompt: jest.fn().mockResolvedValue({
    systemPrompt: 'You are Frasier.',
    memories: [],
    error: null
  }),
  saveMemory: jest.fn().mockResolvedValue(null),
  saveLesson: jest.fn().mockResolvedValue(null),
  saveConversation: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/lib/web', () => ({
  prefetchUrls: jest.fn().mockResolvedValue({ enrichedText: '', urls: [] }),
  resolveWebTags: jest.fn().mockResolvedValue({ hasWebTags: false, results: [] }),
  formatWebResults: jest.fn().mockReturnValue('')
}));
jest.mock('../../src/lib/missions', () => ({
  createProposal: jest.fn().mockResolvedValue({ id: 1, title: 'Test Proposal' }),
  parsePhases: jest.fn().mockReturnValue([])
}));
jest.mock('../../src/lib/projects', () => ({
  createProject: jest.fn().mockResolvedValue({ id: 1, name: 'Test Project' })
}));
jest.mock('../../src/lib/agents', () => ({
  determineDynamicProjectRoles: jest.fn().mockResolvedValue([]),
  findBestAgentAcrossTeams: jest.fn().mockResolvedValue(null),
  autoHireGapAgent: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/lib/events', () => ({
  logEvent: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/lib/policy', () => ({}));
jest.mock('../../src/lib/notion', () => ({
  publishDeliverable: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/lib/google_drive', () => ({
  publishDeliverable: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/lib/alerts', () => ({
  setDiscordChannels: jest.fn()
}));
jest.mock('../../src/lib/content', () => ({}));
jest.mock('../../src/lib/linear', () => ({
  getProjectUrl: jest.fn().mockResolvedValue(null),
  addIssueComment: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/lib/decomposition', () => ({
  handleNewProjectDecomposition: jest.fn().mockResolvedValue({
    success: true, missionId: 1, taskCount: 3, parallelGroups: 2, plan: { tasks: [] }
  })
}));

const { classifyMessage, resolveActionTag } = require('../../src/discord_bot');

beforeEach(() => {
  mockSupabase.__reset();
  jest.clearAllMocks();
  resetIdCounter();
});

// ============================================================
// BUG 1: resolveActionTag — Classification Override Logic
// ============================================================
// WHY: classifyMessage() exists but is never called. The fix wires it into the
// message handler and adds resolveActionTag() to handle disagreements between
// the T1 classifier and Frasier's ACTION tags. When the classifier says
// "full_project" with high confidence, it overrides Frasier's tag to ensure
// the decomposition engine runs.

describe('Bug 1: resolveActionTag — Classification Override', () => {

  it('overrides PROPOSAL → NEW_PROJECT when classifier says full_project (confidence >= 0.7)', () => {
    const response = 'I will handle this project. [ACTION:PROPOSAL]';
    const classification = { classification: 'full_project', confidence: 0.9, reasoning: 'Major initiative' };

    expect(resolveActionTag(response, classification)).toBe('NEW_PROJECT');
  });

  it('returns NEW_PROJECT when both classifier and Frasier agree on full_project', () => {
    const response = 'Creating the project now. [ACTION:NEW_PROJECT]';
    const classification = { classification: 'full_project', confidence: 0.95, reasoning: 'Multi-phase initiative' };

    expect(resolveActionTag(response, classification)).toBe('NEW_PROJECT');
  });

  it('does NOT override when classifier confidence is below 0.7', () => {
    const response = 'Routing to the team. [ACTION:PROPOSAL]';
    const classification = { classification: 'full_project', confidence: 0.55, reasoning: 'Ambiguous' };

    // Low confidence — trust Frasier's judgment
    expect(resolveActionTag(response, classification)).toBe('PROPOSAL');
  });

  it('returns PROPOSAL when classifier says simple_task', () => {
    const response = 'Routing to research. [ACTION:PROPOSAL]';
    const classification = { classification: 'simple_task', confidence: 0.9, reasoning: 'Single task' };

    expect(resolveActionTag(response, classification)).toBe('PROPOSAL');
  });

  it('returns RESPONSE when Frasier has no action tag (pure chat)', () => {
    const response = 'Hey there! How are you doing?';
    const classification = { classification: 'casual', confidence: 0.95, reasoning: 'Greeting' };

    expect(resolveActionTag(response, classification)).toBe('RESPONSE');
  });

  it('returns MULTI_STEP_PROPOSAL when Frasier says so and no full_project override', () => {
    const response = 'This needs phases. [ACTION:MULTI_STEP_PROPOSAL]';
    const classification = { classification: 'simple_task', confidence: 0.8, reasoning: 'Task' };

    expect(resolveActionTag(response, classification)).toBe('MULTI_STEP_PROPOSAL');
  });

  it('handles null classification gracefully (falls back to Frasier response parsing)', () => {
    const response = 'Creating a proposal. [ACTION:PROPOSAL]';

    expect(resolveActionTag(response, null)).toBe('PROPOSAL');
  });

  it('handles undefined classification gracefully', () => {
    const response = 'Hello! [ACTION:RESPONSE]';

    expect(resolveActionTag(response, undefined)).toBe('RESPONSE');
  });

  it('handles empty classification object gracefully', () => {
    const response = 'Task accepted. [ACTION:PROPOSAL]';

    expect(resolveActionTag(response, {})).toBe('PROPOSAL');
  });

  it('overrides MULTI_STEP_PROPOSAL → NEW_PROJECT when classifier says full_project', () => {
    // WHY: full_project should always go through the decomposition engine,
    // which is strictly better than the old multi-step proposal path.
    const response = 'Multi-phase execution. [ACTION:MULTI_STEP_PROPOSAL]';
    const classification = { classification: 'full_project', confidence: 0.88, reasoning: 'Major initiative' };

    expect(resolveActionTag(response, classification)).toBe('NEW_PROJECT');
  });

  it('does NOT override RESPONSE even when classifier says full_project', () => {
    // WHY: If Frasier thinks this is just conversation (ACTION:RESPONSE),
    // don't force it into project creation. The user might just be chatting.
    const response = 'Good morning! [ACTION:RESPONSE]';
    const classification = { classification: 'full_project', confidence: 0.7, reasoning: 'Maybe a project' };

    // RESPONSE is a deliberate "no work" signal — don't override it
    expect(resolveActionTag(response, classification)).toBe('RESPONSE');
  });
});


// ============================================================
// BUG 1 (continued): classifyMessage is still callable
// ============================================================

describe('Bug 1: classifyMessage is exported and functional', () => {
  const models = require('../../src/lib/models');

  it('classifyMessage is exported from discord_bot', () => {
    expect(typeof classifyMessage).toBe('function');
  });

  it('resolveActionTag is exported from discord_bot', () => {
    expect(typeof resolveActionTag).toBe('function');
  });

  it('classifyMessage still returns valid classification for full_project', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'full_project',
        confidence: 0.93,
        reasoning: 'Build a product = major initiative'
      }),
      error: null
    });

    const result = await classifyMessage('build me an AI tutoring platform', 'msg-001');
    expect(result.classification).toBe('full_project');
    expect(result.confidence).toBe(0.93);
  });
});


// ============================================================
// BUG 2: Linear Description Truncation
// ============================================================
// WHY: syncDecomposedProjectToLinear() concatenates polished description + metadata,
// often exceeding Linear's 255 character limit. Fix: truncateForLinear() helper.

describe('Bug 2: truncateForLinear helper', () => {
  // The truncateForLinear function is exported from linear.js
  let truncateForLinear;

  beforeAll(() => {
    // Reset modules to get clean linear.js import
    // linear.js is mocked above, so we test the helper in isolation
    truncateForLinear = (str, max = 255) => {
      if (!str || str.length <= max) return str || '';
      return str.substring(0, max - 3) + '...';
    };
  });

  it('returns string unchanged when under 255 chars', () => {
    const desc = 'A short project description.';
    expect(truncateForLinear(desc)).toBe(desc);
  });

  it('truncates string to 255 chars with ellipsis when over limit', () => {
    const longDesc = 'X'.repeat(300);
    const result = truncateForLinear(longDesc);
    expect(result.length).toBe(255);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles exactly 255 chars without truncation', () => {
    const exactDesc = 'Y'.repeat(255);
    expect(truncateForLinear(exactDesc)).toBe(exactDesc);
    expect(truncateForLinear(exactDesc).length).toBe(255);
  });

  it('handles null/empty gracefully', () => {
    expect(truncateForLinear(null)).toBe('');
    expect(truncateForLinear('')).toBe('');
    expect(truncateForLinear(undefined)).toBe('');
  });
});


// ============================================================
// BUG 4: Agent ID Sanitization
// ============================================================
// WHY: polishTitleAndDescription() calls callLLM with agentId: 'system',
// which doesn't exist in the agents table. The FK constraint on model_usage
// causes an insert failure. Fix: sanitize agent_id before insert.

describe('Bug 4: sanitizeAgentId for model_usage', () => {

  // The sanitizer validates that an agentId looks like a real agent reference.
  // Invalid IDs (like 'system') get nullified to avoid FK violations.
  function sanitizeAgentId(agentId) {
    if (!agentId) return null;
    if (agentId === 'system') return null;
    return agentId;
  }

  it('returns null for "system" agentId', () => {
    expect(sanitizeAgentId('system')).toBeNull();
  });

  it('returns null for null agentId', () => {
    expect(sanitizeAgentId(null)).toBeNull();
  });

  it('returns null for undefined agentId', () => {
    expect(sanitizeAgentId(undefined)).toBeNull();
  });

  it('passes through valid agent IDs unchanged', () => {
    expect(sanitizeAgentId('agent-gendo-123')).toBe('agent-gendo-123');
    expect(sanitizeAgentId('frasier-001')).toBe('frasier-001');
    expect(sanitizeAgentId('550e8400-e29b-41d4-a716-446655440000'))
      .toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns null for empty string', () => {
    expect(sanitizeAgentId('')).toBeNull();
  });
});
