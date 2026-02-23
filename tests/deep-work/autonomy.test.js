// Autonomy Tests (TDD — written BEFORE implementation)
// Tests policy-driven auto-approval of intermediate mission steps.
//
// WHY: Currently every step requires QA → Team Lead approval, forcing Dhroov
// to shepherd every mission. Intermediate steps with high critique scores
// should auto-approve so only the final deliverable needs human review.

const createMockSupabase = require('../mocks/supabase');
const { makeStep, resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const autonomy = require('../../src/lib/autonomy');

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Seed default autonomy policy
  mockSupabase.__setData('policy', [
    {
      id: 1,
      policy_type: 'autonomy',
      name: 'Step Auto-Approval',
      rules: {
        auto_approve_threshold: 4.0,
        qa_only_threshold: 3.0,
        always_review_final: true,
        always_review_tier3: true,
        enabled: true
      }
    }
  ]);
});

// ============================================================
// shouldAutoApprove()
// ============================================================

describe('autonomy.shouldAutoApprove()', () => {

  test('auto-approves intermediate step with critique score >= 4.0', async () => {
    const step = makeStep({
      id: 1, mission_id: 10, status: 'completed', model_tier: 'tier2',
      step_order: 1
    });

    // Seed critique phase with high score
    mockSupabase.__setData('pipeline_phases', [
      { id: 1, mission_step_id: 1, phase_name: 'critique', phase_order: 4, score: 4.2, output_content: '{}' }
    ]);

    // Seed mission with multiple steps (so step 1 is not final)
    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(true);
    expect(result.score).toBe(4.2);
    expect(result.reason).toContain('auto-approve');
  });

  test('QA-only for intermediate step with score >= 3.0 but < 4.0', async () => {
    const step = makeStep({
      id: 1, mission_id: 10, status: 'completed', model_tier: 'tier2',
      step_order: 1
    });

    mockSupabase.__setData('pipeline_phases', [
      { id: 1, mission_step_id: 1, phase_name: 'critique', phase_order: 4, score: 3.5, output_content: '{}' }
    ]);

    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.qaOnly).toBe(true);
    expect(result.reason).toContain('QA-only');
  });

  test('full review for intermediate step with score < 3.0', async () => {
    const step = makeStep({
      id: 1, mission_id: 10, status: 'completed', model_tier: 'tier2',
      step_order: 1
    });

    mockSupabase.__setData('pipeline_phases', [
      { id: 1, mission_step_id: 1, phase_name: 'critique', phase_order: 4, score: 2.5, output_content: '{}' }
    ]);

    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.qaOnly).toBe(false);
    expect(result.reason).toContain('full review');
  });

  test('always full review for FINAL step regardless of score', async () => {
    const step = makeStep({
      id: 2, mission_id: 10, status: 'completed', model_tier: 'tier2',
      step_order: 2
    });

    mockSupabase.__setData('pipeline_phases', [
      { id: 1, mission_step_id: 2, phase_name: 'critique', phase_order: 4, score: 5.0, output_content: '{}' }
    ]);

    // Only 2 steps — step 2 is the final step
    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'completed' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.qaOnly).toBe(false);
    expect(result.reason).toContain('final step');
  });

  test('always full review for tier3 steps regardless of score', async () => {
    const step = makeStep({
      id: 1, mission_id: 10, status: 'completed', model_tier: 'tier3',
      step_order: 1
    });

    mockSupabase.__setData('pipeline_phases', [
      { id: 1, mission_step_id: 1, phase_name: 'critique', phase_order: 4, score: 5.0, output_content: '{}' }
    ]);

    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.reason).toContain('tier3');
  });

  test('respects enabled=false policy (no auto-approve)', async () => {
    mockSupabase.__setData('policy', [
      {
        id: 1,
        policy_type: 'autonomy',
        name: 'Step Auto-Approval',
        rules: {
          auto_approve_threshold: 4.0,
          qa_only_threshold: 3.0,
          always_review_final: true,
          always_review_tier3: true,
          enabled: false
        }
      }
    ]);

    const step = makeStep({ id: 1, mission_id: 10, status: 'completed', model_tier: 'tier2', step_order: 1 });

    mockSupabase.__setData('pipeline_phases', [
      { id: 1, mission_step_id: 1, phase_name: 'critique', phase_order: 4, score: 5.0, output_content: '{}' }
    ]);

    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  test('handles missing critique phase (no pipeline data)', async () => {
    const step = makeStep({ id: 1, mission_id: 10, status: 'completed', model_tier: 'tier2', step_order: 1 });

    // No pipeline_phases data — step was executed before pipeline upgrade
    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.reason).toContain('no critique');
  });

  test('handles missing policy row gracefully', async () => {
    mockSupabase.__reset(); // Clear all data including policy

    const step = makeStep({ id: 1, status: 'completed', model_tier: 'tier2', step_order: 1 });

    const result = await autonomy.shouldAutoApprove(step);
    expect(result.autoApprove).toBe(false);
    expect(result.reason).toContain('no policy');
  });
});

// ============================================================
// isFinalStep()
// ============================================================

describe('autonomy.isFinalStep()', () => {

  test('returns true for the last step in a mission', async () => {
    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'completed' },
      { id: 3, mission_id: 10, step_order: 3, status: 'completed' }
    ]);

    const isFinal = await autonomy.isFinalStep({ id: 3, mission_id: 10, step_order: 3 });
    expect(isFinal).toBe(true);
  });

  test('returns false for non-final step', async () => {
    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' },
      { id: 2, mission_id: 10, step_order: 2, status: 'pending' }
    ]);

    const isFinal = await autonomy.isFinalStep({ id: 1, mission_id: 10, step_order: 1 });
    expect(isFinal).toBe(false);
  });

  test('single-step mission: step is always final', async () => {
    mockSupabase.__setData('mission_steps', [
      { id: 1, mission_id: 10, step_order: 1, status: 'completed' }
    ]);

    const isFinal = await autonomy.isFinalStep({ id: 1, mission_id: 10, step_order: 1 });
    expect(isFinal).toBe(true);
  });
});
