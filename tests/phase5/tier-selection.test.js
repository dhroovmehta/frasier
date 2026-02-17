// Phase 5C: Auto Tier Selection Tests
// Tests for the enhanced selectTier() that auto-routes tasks to the right LLM tier.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';

const createMockSupabase = require('../mocks/supabase');
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const { selectTier } = require('../../src/lib/models');

describe('selectTier() — enhanced auto-routing', () => {
  test('research tasks → tier2', () => {
    expect(selectTier(false, 'Conduct market research on AI SaaS competitors')).toBe('tier2');
  });

  test('strategy/analysis → tier2', () => {
    expect(selectTier(false, 'Develop a comprehensive business plan for Q3')).toBe('tier2');
  });

  test('financial/business plan → tier2', () => {
    expect(selectTier(false, 'Create a financial model with revenue projections')).toBe('tier2');
  });

  test('isComplex=true → tier2', () => {
    expect(selectTier(true, 'simple task')).toBe('tier2');
  });

  test('simple tasks → tier1', () => {
    expect(selectTier(false, 'Respond to a greeting')).toBe('tier1');
  });

  test('requirements/design tasks → tier2', () => {
    expect(selectTier(false, 'Define detailed requirements for the user dashboard')).toBe('tier2');
  });

  test('long-form content → tier2', () => {
    expect(selectTier(false, 'Write a comprehensive detailed report on competitor pricing')).toBe('tier2');
  });

  test('final step in multi-step mission → tier2', () => {
    const stepContext = { isFinalStep: true };
    expect(selectTier(false, 'Compile findings into final deliverable', stepContext)).toBe('tier2');
  });

  test('non-final step with simple task → tier1', () => {
    const stepContext = { isFinalStep: false };
    expect(selectTier(false, 'Gather some data', stepContext)).toBe('tier1');
  });

  test('empty description defaults to tier1', () => {
    expect(selectTier(false, '')).toBe('tier1');
  });
});
