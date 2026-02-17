// Phase 5B: Persona-as-Rubric Tests
// Tests for quality rubric generation and persona enhancement.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';

const createMockSupabase = require('../mocks/supabase');
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const agents = require('../../src/lib/agents');

beforeEach(() => {
  mockSupabase.__reset();
});

// ============================================================
// QUALITY RUBRIC GENERATION
// ============================================================

describe('buildQualityRubric()', () => {
  test('generates rubric for Research Analyst role', () => {
    const rubric = agents.buildQualityRubric('Research Analyst');
    expect(rubric).toContain('Quality Standards');
    expect(rubric).toContain('NEVER');
    expect(rubric).toContain('sources');
    expect(rubric).toContain('data points');
  });

  test('generates rubric for Strategy Lead role', () => {
    const rubric = agents.buildQualityRubric('Strategy Lead');
    expect(rubric).toContain('Quality Standards');
    expect(rubric).toContain('roadmap');
    expect(rubric).toContain('metrics');
  });

  test('generates rubric for Content Creator role', () => {
    const rubric = agents.buildQualityRubric('Content Creator');
    expect(rubric).toContain('Quality Standards');
    expect(rubric).toContain('audience');
  });

  test('generates rubric for QA Engineer role', () => {
    const rubric = agents.buildQualityRubric('QA Engineer');
    expect(rubric).toContain('Quality Standards');
  });

  test('generates generic rubric for unknown roles', () => {
    const rubric = agents.buildQualityRubric('Random Specialist');
    expect(rubric).toContain('Quality Standards');
    expect(rubric).toContain('NEVER');
  });

  test('research rubric includes "NEVER deliver without primary data sources"', () => {
    const rubric = agents.buildQualityRubric('Research Analyst');
    expect(rubric).toMatch(/NEVER.*deliver.*without.*source/i);
  });

  test('strategy rubric includes "NEVER deliver without quantified projections"', () => {
    const rubric = agents.buildQualityRubric('Strategy Lead');
    expect(rubric).toMatch(/NEVER.*deliver.*without.*quantif/i);
  });
});

// ============================================================
// PERSONA UPGRADE WITH RUBRIC
// ============================================================

describe('upgradePersonaWithRubric()', () => {
  test('appends rubric to existing persona full_sep_prompt', async () => {
    const existingPersona = {
      id: 1,
      agent_id: 'agent-gendo-123',
      agent_md: 'Gendo is a research analyst',
      soul_md: 'Analytical mind',
      skills_md: 'Market research',
      identity_md: 'Senior analyst',
      full_sep_prompt: 'You are Gendo, a Research Analyst.\n\nYour expertise is in market analysis.'
    };

    mockSupabase.__setData('agents', [
      { id: 'agent-gendo-123', display_name: 'Gendo', role: 'Research Analyst', status: 'active', persona_id: 1, team_id: 'team-research', agent_type: 'sub_agent' }
    ]);
    mockSupabase.__setData('agent_personas', [existingPersona]);

    const upgraded = await agents.upgradePersonaWithRubric('agent-gendo-123');
    expect(upgraded).toBeTruthy();

    // New persona should be saved (check store)
    const personas = mockSupabase.__getData('agent_personas');
    const newest = personas[personas.length - 1];
    expect(newest.full_sep_prompt).toContain('Quality Standards');
    expect(newest.full_sep_prompt).toContain('You are Gendo'); // preserves original
    expect(newest.full_sep_prompt).toContain('NEVER');
  });

  test('does not duplicate rubric if already present', async () => {
    const existingPersona = {
      id: 1,
      agent_id: 'agent-gendo-123',
      agent_md: 'Gendo',
      soul_md: 'Soul',
      skills_md: 'Skills',
      identity_md: 'Identity',
      full_sep_prompt: 'You are Gendo.\n\n## Quality Standards (Non-Negotiable)\n- Already has rubric'
    };

    mockSupabase.__setData('agents', [
      { id: 'agent-gendo-123', display_name: 'Gendo', role: 'Research Analyst', status: 'active', persona_id: 1, team_id: 'team-research', agent_type: 'sub_agent' }
    ]);
    mockSupabase.__setData('agent_personas', [existingPersona]);

    const upgraded = await agents.upgradePersonaWithRubric('agent-gendo-123');
    // Should return null (no upgrade needed)
    expect(upgraded).toBeNull();
  });
});
