// Phase 6: Enhanced Reviews Tests
// Tests for buildEnhancedReviewPrompt() and structured review parsing.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';

const createMockSupabase = require('../mocks/supabase');
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

const conversations = require('../../src/lib/conversations');

beforeEach(() => {
  mockSupabase.__reset();
});

// ============================================================
// ENHANCED REVIEW PROMPT
// ============================================================

describe('buildEnhancedReviewPrompt()', () => {
  const deliverable = 'Here is my research on the AI SaaS market...';
  const taskDescription = 'Research AI SaaS competitors';
  const authorName = 'Gendo';

  test('includes Zero\'s original message when provided', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription, 'Build me a Real Estate AI Agent'
    );
    expect(prompt).toContain('Build me a Real Estate AI Agent');
    expect(prompt).toContain("ZERO'S ORIGINAL REQUEST");
  });

  test('includes 5-criterion rubric', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription
    );
    expect(prompt).toContain('Relevance');
    expect(prompt).toContain('Depth');
    expect(prompt).toContain('Actionability');
    expect(prompt).toContain('Accuracy');
    expect(prompt).toContain('Executive Quality');
  });

  test('requires SCORES section in response format', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription
    );
    expect(prompt).toContain('SCORES');
  });

  test('requires VERDICT tag in response format', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription
    );
    expect(prompt).toContain('[APPROVE]');
    expect(prompt).toContain('[REJECT]');
  });

  test('requires FEEDBACK section in response format', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription
    );
    expect(prompt).toContain('FEEDBACK');
  });

  test('includes task description', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription
    );
    expect(prompt).toContain(taskDescription);
  });

  test('includes deliverable content', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription
    );
    expect(prompt).toContain(deliverable);
  });

  test('works without original message', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      authorName, deliverable, taskDescription, null
    );
    expect(prompt).not.toContain("ZERO'S ORIGINAL REQUEST");
    expect(prompt).toContain('SCORES');
    expect(prompt).toContain('[APPROVE]');
  });
});

// ============================================================
// REVIEW RESPONSE PARSING
// ============================================================

describe('parseEnhancedReview()', () => {
  test('parses approved review with scores', () => {
    const reviewContent = `## SCORES
- Relevance: 4/5
- Depth: 4/5
- Actionability: 3/5
- Accuracy: 5/5
- Executive Quality: 4/5
- Overall: 4/5

## VERDICT
[APPROVE]

## FEEDBACK
Good research with solid data points. Could improve actionability with more specific next steps.`;

    const result = conversations.parseEnhancedReview(reviewContent);
    expect(result.verdict).toBe('approve');
    expect(result.overallScore).toBe(4);
    expect(result.scores.relevance).toBe(4);
    expect(result.scores.depth).toBe(4);
    expect(result.feedback).toContain('Good research');
  });

  test('parses rejected review', () => {
    const reviewContent = `## SCORES
- Relevance: 2/5
- Depth: 1/5
- Actionability: 1/5
- Accuracy: 3/5
- Executive Quality: 1/5
- Overall: 1.6/5

## VERDICT
[REJECT]

## FEEDBACK
This deliverable is too shallow. No competitor names, no data sources, no market sizing.`;

    const result = conversations.parseEnhancedReview(reviewContent);
    expect(result.verdict).toBe('reject');
    expect(result.overallScore).toBeLessThan(3);
    expect(result.feedback).toContain('too shallow');
  });

  test('auto-rejects when overall score < 3 even if verdict says APPROVE', () => {
    const reviewContent = `## SCORES
- Relevance: 2/5
- Depth: 2/5
- Actionability: 2/5
- Accuracy: 2/5
- Executive Quality: 2/5
- Overall: 2/5

## VERDICT
[APPROVE]

## FEEDBACK
It's okay I guess.`;

    const result = conversations.parseEnhancedReview(reviewContent);
    expect(result.verdict).toBe('reject');
    expect(result.autoRejected).toBe(true);
  });

  test('defaults to approve when verdict parsing fails', () => {
    const reviewContent = 'This looks fine, good work overall.';
    const result = conversations.parseEnhancedReview(reviewContent);
    expect(result.verdict).toBe('approve');
    expect(result.overallScore).toBe(3); // default
  });

  test('handles malformed scores gracefully', () => {
    const reviewContent = `## SCORES
some random text

## VERDICT
[APPROVE]

## FEEDBACK
Looks good.`;

    const result = conversations.parseEnhancedReview(reviewContent);
    expect(result.verdict).toBe('approve');
    expect(result.feedback).toContain('Looks good');
  });
});
