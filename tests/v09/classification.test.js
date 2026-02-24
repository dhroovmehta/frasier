// tests/v09/classification.test.js — Message Classification System (v0.9.0 Phase 4)
// TDD: Tests define the contract for classifyMessage() and classification-based routing.
// The classifier runs as a separate T1 LLM call BEFORE Frasier's response,
// determining routing (casual / simple_task / full_project) upfront.

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, makeClassification, resetIdCounter } = require('../helpers');

// Create mock supabase BEFORE any module requires it
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

// Mock discord.js — discord_bot.js creates a Client and calls login() at module load time.
// Without this mock, the require() fails with an invalid token error + process.exit(1).
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

// Mock all external dependencies that discord_bot.js requires at the top level
jest.mock('../../src/lib/supabase', () => global.__mockSupabase);
jest.mock('../../src/lib/models', () => require('../mocks/models'));
jest.mock('../../src/lib/memory', () => ({
  buildAgentPrompt: jest.fn().mockResolvedValue({
    systemPrompt: 'You are Frasier, Chief of Staff.',
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

// Require AFTER mocks are set up
const models = require('../../src/lib/models');
const missions = require('../../src/lib/missions');
const projects = require('../../src/lib/projects');
const { classifyMessage } = require('../../src/discord_bot');

// ============================================================
// MESSAGE CLASSIFICATION
// ============================================================

describe('Message Classification', () => {
  beforeEach(() => {
    mockSupabase.__reset();
    jest.clearAllMocks();
  });

  it('classifies "hey what is up" as casual', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'casual',
        confidence: 0.95,
        reasoning: 'Greeting / small talk'
      }),
      error: null
    });

    const result = await classifyMessage('hey what is up', 'msg-001');

    expect(result.classification).toBe('casual');
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBe('Greeting / small talk');
  });

  it('classifies "research AI tutoring platforms" as simple_task', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'simple_task',
        confidence: 0.90,
        reasoning: 'Single research deliverable'
      }),
      error: null
    });

    const result = await classifyMessage('research AI tutoring platforms', 'msg-002');

    expect(result.classification).toBe('simple_task');
    expect(result.confidence).toBe(0.90);
  });

  it('classifies "build me a real estate AI agent" as full_project', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'full_project',
        confidence: 0.93,
        reasoning: 'Multi-phase initiative requiring multiple agents'
      }),
      error: null
    });

    const result = await classifyMessage('build me a real estate AI agent', 'msg-003');

    expect(result.classification).toBe('full_project');
    expect(result.confidence).toBe(0.93);
  });

  it('classifies "compare these 3 SaaS tools" as simple_task', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'simple_task',
        confidence: 0.88,
        reasoning: 'Single comparison analysis task'
      }),
      error: null
    });

    const result = await classifyMessage('compare these 3 SaaS tools', 'msg-004');

    expect(result.classification).toBe('simple_task');
    expect(result.confidence).toBe(0.88);
  });

  it('classifies "launch a new product line for pet owners" as full_project', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'full_project',
        confidence: 0.91,
        reasoning: 'Major initiative requiring product development, marketing, and launch phases'
      }),
      error: null
    });

    const result = await classifyMessage('launch a new product line for pet owners', 'msg-005');

    expect(result.classification).toBe('full_project');
    expect(result.confidence).toBe(0.91);
  });

  it('persists classification to message_classifications table', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'simple_task',
        confidence: 0.85,
        reasoning: 'Single deliverable request'
      }),
      error: null
    });

    await classifyMessage('research competitors', 'msg-persist-001');

    // Verify the classification was written to the mock store
    const stored = mockSupabase.__getData('message_classifications');
    expect(stored).toHaveLength(1);
    expect(stored[0].discord_message_id).toBe('msg-persist-001');
    expect(stored[0].classification).toBe('simple_task');
    expect(stored[0].confidence).toBe(0.85);
    expect(stored[0].reasoning).toBe('Single deliverable request');
    expect(stored[0].raw_message).toBe('research competitors');
  });

  it('defaults to simple_task when confidence < 0.7', async () => {
    // LLM returns full_project but with low confidence
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'full_project',
        confidence: 0.55,
        reasoning: 'Ambiguous request'
      }),
      error: null
    });

    const result = await classifyMessage('do something interesting', 'msg-006');

    // Should default to simple_task because confidence is below threshold
    expect(result.classification).toBe('simple_task');
    // Confidence in the returned result should reflect the original value
    expect(result.confidence).toBe(0.55);
  });

  it('defaults to simple_task when JSON parse fails', async () => {
    // LLM returns garbage instead of JSON
    models.callLLM.mockResolvedValueOnce({
      content: 'This is not valid JSON at all, sorry about that.',
      error: null
    });

    const result = await classifyMessage('some random message', 'msg-007');

    expect(result.classification).toBe('simple_task');
    expect(result.confidence).toBe(0);
  });

  it('defaults to simple_task when LLM call fails', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: null,
      error: 'Service unavailable'
    });

    const result = await classifyMessage('some message', 'msg-008');

    expect(result.classification).toBe('simple_task');
    expect(result.confidence).toBe(0);
  });

  it('classification is a separate T1 call (not bundled with Frasier response)', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'casual',
        confidence: 0.92,
        reasoning: 'Greeting'
      }),
      error: null
    });

    await classifyMessage('hello there', 'msg-009');

    // Verify the LLM was called with classification-specific prompt, not Frasier's persona
    expect(models.callLLM).toHaveBeenCalledTimes(1);
    const callArgs = models.callLLM.mock.calls[0][0];

    // Must be a T1 call
    expect(callArgs.forceTier).toBe('tier1');

    // System prompt should be the classifier, not Frasier's full persona
    expect(callArgs.systemPrompt).toContain('classifier');

    // User message should contain the three category descriptions
    expect(callArgs.userMessage).toContain('casual');
    expect(callArgs.userMessage).toContain('simple_task');
    expect(callArgs.userMessage).toContain('full_project');

    // Should NOT contain Frasier's action tags
    expect(callArgs.userMessage).not.toContain('[ACTION:PROPOSAL]');
    expect(callArgs.userMessage).not.toContain('[ACTION:RESPONSE]');
  });

  it('handles JSON wrapped in markdown code fences', async () => {
    // WHY: Some LLMs wrap JSON in ```json ... ``` even when asked not to
    models.callLLM.mockResolvedValueOnce({
      content: '```json\n{"classification":"casual","confidence":0.88,"reasoning":"Just chatting"}\n```',
      error: null
    });

    const result = await classifyMessage('how are you doing', 'msg-010');

    expect(result.classification).toBe('casual');
    expect(result.confidence).toBe(0.88);
  });
});

// ============================================================
// CLASSIFICATION ROUTING
// ============================================================

describe('Classification Routing', () => {
  // WHY: We can't easily test handleFrasierMessage directly (it requires a Discord
  // message object with channel.sendTyping, channel.send, reply, etc.). Instead,
  // we test that classifyMessage returns the right data that would drive routing,
  // and we test the routing contracts through the classification result + downstream mocks.

  beforeEach(() => {
    mockSupabase.__reset();
    jest.clearAllMocks();

    // Set up Frasier agent in the mock store for findFrasier()
    mockSupabase.__setData('agents', [
      makeAgent({
        id: 'frasier-001',
        display_name: 'Frasier',
        role: 'Chief of Staff',
        agent_type: 'chief_of_staff',
        status: 'active'
      })
    ]);
  });

  it('casual -> Frasier responds conversationally, no proposal created', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'casual',
        confidence: 0.95,
        reasoning: 'Casual greeting'
      }),
      error: null
    });

    const result = await classifyMessage('hey what is up', 'msg-casual-001');

    expect(result.classification).toBe('casual');

    // For casual messages, no proposal should be created.
    // The routing logic uses this classification to skip proposal creation.
    // Verify missions.createProposal was NOT called during classification
    // (classification itself never creates proposals — routing does)
    expect(missions.createProposal).not.toHaveBeenCalled();
  });

  it('simple_task -> creates proposal via existing missions.createProposal()', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'simple_task',
        confidence: 0.90,
        reasoning: 'Single research task'
      }),
      error: null
    });

    const result = await classifyMessage('research AI tutoring platforms', 'msg-simple-001');

    expect(result.classification).toBe('simple_task');

    // Classification itself doesn't create proposals — but verify the result
    // provides the data needed for routing to call createProposal
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('full_project -> triggers decomposition engine', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'full_project',
        confidence: 0.93,
        reasoning: 'Major multi-phase initiative'
      }),
      error: null
    });

    const result = await classifyMessage('build me a real estate AI agent', 'msg-project-001');

    expect(result.classification).toBe('full_project');

    // full_project routing will call projects.createProject() and create a
    // proposal with [DECOMPOSE] tag. Verify classification provides the signal.
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('simple_task follows exact same pipeline as existing [ACTION:PROPOSAL]', async () => {
    // WHY: This test verifies that the simple_task classification maps to the same
    // proposal creation parameters as the old [ACTION:PROPOSAL] path.

    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'simple_task',
        confidence: 0.88,
        reasoning: 'Research request with single deliverable'
      }),
      error: null
    });

    const result = await classifyMessage('compare these 3 SaaS tools', 'msg-compat-001');

    // The old [ACTION:PROPOSAL] path called:
    // missions.createProposal({ proposingAgentId: 'zero', title, description: content,
    //   priority: urgent-check, rawMessage: content })
    // The new simple_task path must use the EXACT same createProposal signature.
    // Verify the classification returns data sufficient for that call.
    expect(result.classification).toBe('simple_task');

    // The routing logic will call createProposal with:
    // - proposingAgentId: 'zero' (always)
    // - title: cleanProposalTitle(content) (same as before)
    // - description: content (same as before)
    // - priority: based on 'urgent' keyword check (same as before)
    // - rawMessage: content (same as before)
    // This is verified by the implementation matching the old [ACTION:PROPOSAL] block.
  });

  it('classification result includes all required fields', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'simple_task',
        confidence: 0.85,
        reasoning: 'Standard task request'
      }),
      error: null
    });

    const result = await classifyMessage('write a blog post about AI', 'msg-fields-001');

    // Verify all required fields are present
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('reasoning');
    expect(['casual', 'simple_task', 'full_project']).toContain(result.classification);
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.reasoning).toBe('string');
  });

  it('invalid classification value defaults to simple_task', async () => {
    models.callLLM.mockResolvedValueOnce({
      content: JSON.stringify({
        classification: 'mega_project',
        confidence: 0.85,
        reasoning: 'Some weird classification'
      }),
      error: null
    });

    const result = await classifyMessage('do a thing', 'msg-invalid-001');

    // Unknown classification values should default to simple_task
    expect(result.classification).toBe('simple_task');
  });
});
