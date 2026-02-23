// Linear Webhook Tests (TDD — written BEFORE implementation)
// Tests the webhook handler: signature validation, payload processing, loop prevention.
//
// WHY: The webhook is the Linear → Frasier direction. When Dhroov creates an issue
// in Linear, Frasier picks it up as a mission proposal. These tests ensure correctness
// and prevent infinite loops (Frasier creating issues that Frasier picks up again).

const crypto = require('crypto');
const createMockSupabase = require('../mocks/supabase');
const { resetIdCounter } = require('../helpers');

// Set up mocks BEFORE requiring modules
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock models.js for title polishing
const mockCallLLM = jest.fn();
jest.mock('../../src/lib/models', () => ({
  callLLM: mockCallLLM,
  MODELS: {
    tier1: { name: 'minimax', tier: 'tier1', maxTokens: 4096 },
    tier2: { name: 'claude-sonnet', tier: 'tier2', maxTokens: 8192 },
    tier3: { name: 'claude-opus', tier: 'tier3', maxTokens: 4096 }
  }
}));

// Mock fetch for Linear API
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock missions.js
const mockCreateProposal = jest.fn();
jest.mock('../../src/lib/missions', () => ({
  createProposal: mockCreateProposal
}));

// Mock events.js
const mockLogEvent = jest.fn();
jest.mock('../../src/lib/events', () => ({
  logEvent: mockLogEvent
}));

const { processLinearWebhook, validateWebhookSignature, pollForNewIssues, __resetPollTime } = require('../../src/lib/linear');

// ============================================================
// TEST HELPERS
// ============================================================

function makeWebhookPayload(overrides = {}) {
  return {
    action: 'create',
    type: 'Issue',
    data: {
      id: 'issue-uuid-1',
      title: 'Research AI newsletter tools',
      description: 'Look into the top tools used by AI newsletters',
      identifier: 'FRA-42',
      url: 'https://linear.app/frasier/issue/FRA-42',
      creatorId: 'dhroov-user-id',
      projectId: 'proj-uuid-1',
      labelIds: [],
      ...overrides.data
    },
    ...overrides
  };
}

function signPayload(payload, secret) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return { body, signature };
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  resetIdCounter();
  mockSupabase.__reset();
  mockCallLLM.mockReset();
  mockFetch.mockReset();
  mockCreateProposal.mockReset();
  mockLogEvent.mockReset();

  process.env.LINEAR_API_KEY = 'lin_test_key_123';
  process.env.LINEAR_WEBHOOK_SECRET = 'webhook-secret-123';
  process.env.LINEAR_API_USER_ID = 'frasier-api-user-id';

  __resetPollTime();
});

afterEach(() => {
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_WEBHOOK_SECRET;
  delete process.env.LINEAR_API_USER_ID;
});

// ============================================================
// Webhook Signature Validation
// ============================================================

describe('validateWebhookSignature()', () => {
  test('valid signature returns true', () => {
    const payload = makeWebhookPayload();
    const { body, signature } = signPayload(payload, 'webhook-secret-123');

    const result = validateWebhookSignature(body, signature, 'webhook-secret-123');
    expect(result).toBe(true);
  });

  test('invalid signature returns false', () => {
    const payload = makeWebhookPayload();
    const { body } = signPayload(payload, 'webhook-secret-123');

    const result = validateWebhookSignature(body, 'bad-signature', 'webhook-secret-123');
    expect(result).toBe(false);
  });

  test('missing signature returns false', () => {
    const result = validateWebhookSignature('{}', null, 'webhook-secret-123');
    expect(result).toBe(false);
  });
});

// ============================================================
// Webhook Processing
// ============================================================

describe('processLinearWebhook()', () => {
  test('Issue created by Dhroov creates mission_proposal with polished title', async () => {
    const payload = makeWebhookPayload();

    // Mock LLM polish
    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "AI Newsletter Tool Analysis", "description": "Research and compare top tools used by AI newsletters."}',
      error: null
    });

    mockCreateProposal.mockResolvedValueOnce({ id: 1, title: 'AI Newsletter Tool Analysis' });
    mockLogEvent.mockResolvedValueOnce({ data: { id: 1 }, error: null });

    await processLinearWebhook(payload);

    expect(mockCreateProposal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'AI Newsletter Tool Analysis',
      description: expect.stringContaining('Research and compare')
    }));

    // Should save inbound sync record
    const syncRows = mockSupabase.__getData('linear_sync');
    expect(syncRows.length).toBe(1);
    expect(syncRows[0].sync_type).toBe('inbound_issue');
    expect(syncRows[0].entity_id).toBe('issue-uuid-1');
  });

  test('Issue created by Frasier API is ignored (loop prevention)', async () => {
    const payload = makeWebhookPayload({
      data: { creatorId: 'frasier-api-user-id' }
    });

    await processLinearWebhook(payload);

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('Issue with frasier-managed label is ignored (second loop prevention layer)', async () => {
    const payload = makeWebhookPayload({
      data: {
        creatorId: 'some-other-user',
        labelIds: ['frasier-managed-label-id']
      }
    });

    // Set cached label ID for frasier-managed
    const linear = require('../../src/lib/linear');
    linear.__setCache({
      labels: { 'frasier-managed': 'frasier-managed-label-id' }
    });

    await processLinearWebhook(payload);

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('non-Issue webhook types are ignored', async () => {
    const payload = makeWebhookPayload({ type: 'Project' });

    await processLinearWebhook(payload);

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('non-create actions are ignored', async () => {
    const payload = makeWebhookPayload({ action: 'update' });

    await processLinearWebhook(payload);

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('missing data fields are handled gracefully', async () => {
    const payload = {
      action: 'create',
      type: 'Issue',
      data: {}
    };

    // Should not throw
    await processLinearWebhook(payload);

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('logs event for Discord announcement on successful inbound', async () => {
    const payload = makeWebhookPayload();

    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "Test Title", "description": "Test desc."}',
      error: null
    });
    mockCreateProposal.mockResolvedValueOnce({ id: 1, title: 'Test Title' });
    mockLogEvent.mockResolvedValueOnce({ data: { id: 1 }, error: null });

    await processLinearWebhook(payload);

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'linear_inbound_issue'
    }));
  });
});

// ============================================================
// Polling (Linear → Frasier without webhooks)
// ============================================================

describe('pollForNewIssues()', () => {
  function mockLinearIssuesResponse(issues) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: { nodes: issues }
        }
      })
    });
  }

  function makeIssue(overrides = {}) {
    return {
      id: 'issue-poll-1',
      title: 'Research AI tools',
      description: 'Compare the top AI writing tools',
      identifier: 'FRA-99',
      url: 'https://linear.app/nerv/issue/FRA-99',
      creator: { id: 'dhroov-user-id' },
      labels: { nodes: [] },
      ...overrides
    };
  }

  test('creates proposal for new issue from Dhroov', async () => {
    mockLinearIssuesResponse([makeIssue()]);

    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "AI Tool Comparison", "description": "Compare top AI writing tools."}',
      error: null
    });
    mockCreateProposal.mockResolvedValueOnce({ id: 1, title: 'AI Tool Comparison' });
    mockLogEvent.mockResolvedValueOnce({ data: { id: 1 }, error: null });

    await pollForNewIssues();

    expect(mockCreateProposal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'AI Tool Comparison'
    }));

    const syncRows = mockSupabase.__getData('linear_sync');
    expect(syncRows.length).toBe(1);
    expect(syncRows[0].sync_type).toBe('inbound_issue');
    expect(syncRows[0].entity_id).toBe('issue-poll-1');
  });

  test('skips issues created by Frasier API user (loop prevention)', async () => {
    mockLinearIssuesResponse([
      makeIssue({ creator: { id: 'frasier-api-user-id' } })
    ]);

    await pollForNewIssues();

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('skips issues with frasier-managed label (loop prevention)', async () => {
    mockLinearIssuesResponse([
      makeIssue({
        labels: { nodes: [{ id: 'lbl-1', name: 'frasier-managed' }] }
      })
    ]);

    await pollForNewIssues();

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('skips already-synced issues (dedup via linear_sync)', async () => {
    // Pre-seed linear_sync with this issue
    mockSupabase.__setData('linear_sync', [
      { id: 1, entity_id: 'issue-poll-1', entity_type: 'issue', sync_type: 'inbound_issue' }
    ]);

    mockLinearIssuesResponse([makeIssue()]);

    await pollForNewIssues();

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('handles empty response gracefully', async () => {
    mockLinearIssuesResponse([]);

    await pollForNewIssues();

    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('does nothing when LINEAR_API_KEY is not set', async () => {
    delete process.env.LINEAR_API_KEY;

    await pollForNewIssues();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('logs event for Discord announcement on successful inbound', async () => {
    mockLinearIssuesResponse([makeIssue()]);

    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "Test Title", "description": "Test desc."}',
      error: null
    });
    mockCreateProposal.mockResolvedValueOnce({ id: 1, title: 'Test Title' });
    mockLogEvent.mockResolvedValueOnce({ data: { id: 1 }, error: null });

    await pollForNewIssues();

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'linear_inbound_issue'
    }));
  });
});
