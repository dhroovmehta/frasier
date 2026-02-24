// tests/v09/phase-advancement.test.js — Phase Advancement Events (v0.9.3)
// TDD: Tests define the contract for enriched advanceProjectPhase() —
// phase transitions must log events so Discord can announce progress.
// WHY: Without this, projects advance silently — Dhroov never sees
// "Project X moved to build phase" or "Project X delivered!" (ISS-016).

const createMockSupabase = require('../mocks/supabase');
const { resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock events — verify logEvent calls
const mockLogEvent = jest.fn().mockResolvedValue(null);
jest.mock('../../src/lib/events', () => ({
  logEvent: mockLogEvent
}));

const projects = require('../../src/lib/projects');

// ============================================================
// SETUP
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();
});

// ============================================================
// advanceProjectPhase — event logging
// ============================================================

describe('advanceProjectPhase — event logging', () => {

  it('logs project_phase_advanced event when advancing to next phase', async () => {
    mockSupabase.__setData('projects', [
      { id: 1, name: 'TestProject', phase: 'discovery', status: 'active' }
    ]);

    await projects.advanceProjectPhase(1);

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'project_phase_advanced',
      severity: 'info'
    }));
    const eventArg = mockLogEvent.mock.calls[0][0];
    expect(eventArg.data.projectId).toBe(1);
    expect(eventArg.data.fromPhase).toBe('discovery');
    expect(eventArg.data.toPhase).toBe('requirements');
  });

  it('logs project_completed event when advancing from deploy (final phase)', async () => {
    // WHY: Deploy is the last phase. Advancing from it means the project is done.
    // We log project_completed (not project_phase_advanced) to avoid redundant messages.
    mockSupabase.__setData('projects', [
      { id: 1, name: 'ShippedProduct', phase: 'deploy', status: 'active' }
    ]);

    await projects.advanceProjectPhase(1);

    // Should log project_completed, NOT project_phase_advanced
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'project_completed'
    }));
    const eventArg = mockLogEvent.mock.calls[0][0];
    expect(eventArg.data.projectId).toBe(1);
    expect(eventArg.data.projectName).toBe('ShippedProduct');
  });

  it('does NOT log events when project not found', async () => {
    // No project data in store
    await projects.advanceProjectPhase(999);

    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('does NOT log events when phase is already completed', async () => {
    // WHY: 'completed' is not in the PHASES array, so indexOf returns -1.
    // advanceProjectPhase returns null immediately — no event needed.
    mockSupabase.__setData('projects', [
      { id: 1, name: 'DoneProject', phase: 'completed', status: 'completed' }
    ]);

    await projects.advanceProjectPhase(1);

    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});
