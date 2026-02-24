// tests/v09/schema.test.js — Verify v0.9.0 schema tables + test helpers
// TDD: These tests define the contract for the 4 new tables.
// Run first to confirm test infrastructure supports the new schema.

const createMockSupabase = require('../mocks/supabase');
const {
  makeClassification,
  makeDependency,
  makeDecompositionPlan,
  makeEscalation,
  makeStep,
  makeMission,
  resetIdCounter
} = require('../helpers');

let supabase;

beforeEach(() => {
  supabase = createMockSupabase();
  resetIdCounter();
});

// ============================================================
// MESSAGE CLASSIFICATIONS
// ============================================================

describe('message_classifications table', () => {
  it('creates and retrieves a classification', () => {
    const classification = makeClassification({
      raw_message: 'build me a real estate AI agent',
      classification: 'full_project',
      confidence: 0.92
    });

    supabase.__setData('message_classifications', [classification]);
    const { data } = supabase.from('message_classifications')
      .select()
      .eq('classification', 'full_project');

    expect(data).toHaveLength(1);
    expect(data[0].raw_message).toBe('build me a real estate AI agent');
    expect(data[0].confidence).toBe(0.92);
  });

  it('supports all three classification types', () => {
    const casual = makeClassification({ classification: 'casual', raw_message: 'hey' });
    const simple = makeClassification({ classification: 'simple_task', raw_message: 'research AI' });
    const project = makeClassification({ classification: 'full_project', raw_message: 'build product' });

    supabase.__setData('message_classifications', [casual, simple, project]);

    const { data: allRows } = supabase.from('message_classifications').select();
    expect(allRows).toHaveLength(3);

    const types = allRows.map(r => r.classification).sort();
    expect(types).toEqual(['casual', 'full_project', 'simple_task']);
  });

  it('tracks action_taken for routing audit', () => {
    const c = makeClassification({
      classification: 'full_project',
      action_taken: 'decomposition',
      project_id: 42
    });

    supabase.__setData('message_classifications', [c]);
    const { data } = supabase.from('message_classifications')
      .select()
      .eq('action_taken', 'decomposition');

    expect(data).toHaveLength(1);
    expect(data[0].project_id).toBe(42);
  });

  it('inserts a new classification via mock', () => {
    const result = supabase.from('message_classifications').insert({
      raw_message: 'compare SaaS tools',
      classification: 'simple_task',
      confidence: 0.88,
      action_taken: 'proposal'
    }).select().single();

    expect(result.data).toBeTruthy();
    expect(result.data.classification).toBe('simple_task');

    const stored = supabase.__getData('message_classifications');
    expect(stored).toHaveLength(1);
  });
});

// ============================================================
// STEP DEPENDENCIES
// ============================================================

describe('step_dependencies table', () => {
  it('creates a dependency between two steps', () => {
    const step1 = makeStep({ id: 101, mission_id: 1, step_order: 1 });
    const step2 = makeStep({ id: 102, mission_id: 1, step_order: 2 });
    const dep = makeDependency({ step_id: 102, depends_on_step_id: 101 });

    supabase.__setData('mission_steps', [step1, step2]);
    supabase.__setData('step_dependencies', [dep]);

    const { data } = supabase.from('step_dependencies')
      .select()
      .eq('step_id', 102);

    expect(data).toHaveLength(1);
    expect(data[0].depends_on_step_id).toBe(101);
    expect(data[0].dependency_type).toBe('blocks');
  });

  it('supports diamond dependencies (T3 depends on T1 AND T2)', () => {
    const dep1 = makeDependency({ step_id: 103, depends_on_step_id: 101 });
    const dep2 = makeDependency({ step_id: 103, depends_on_step_id: 102 });

    supabase.__setData('step_dependencies', [dep1, dep2]);

    const { data } = supabase.from('step_dependencies')
      .select()
      .eq('step_id', 103);

    expect(data).toHaveLength(2);
    const depIds = data.map(d => d.depends_on_step_id).sort();
    expect(depIds).toEqual([101, 102]);
  });

  it('supports informs dependency type', () => {
    const dep = makeDependency({
      step_id: 102,
      depends_on_step_id: 101,
      dependency_type: 'informs'
    });

    supabase.__setData('step_dependencies', [dep]);
    const { data } = supabase.from('step_dependencies')
      .select()
      .eq('dependency_type', 'informs');

    expect(data).toHaveLength(1);
  });
});

// ============================================================
// DECOMPOSITION PLANS
// ============================================================

describe('decomposition_plans table', () => {
  it('creates and retrieves a decomposition plan', () => {
    const plan = makeDecompositionPlan({
      project_id: 1,
      mission_id: 10,
      plan_json: {
        tasks: [
          { id: 'T1', description: 'Research', parallel_group: 1 },
          { id: 'T2', description: 'Design', parallel_group: 2, depends_on: ['T1'] }
        ]
      },
      task_count: 2,
      parallel_groups: 2,
      end_state: 'production_docs'
    });

    supabase.__setData('decomposition_plans', [plan]);

    const { data } = supabase.from('decomposition_plans')
      .select()
      .eq('project_id', 1)
      .single();

    expect(data.plan_json.tasks).toHaveLength(2);
    expect(data.task_count).toBe(2);
    expect(data.end_state).toBe('production_docs');
  });

  it('tracks refinement count', () => {
    const plan = makeDecompositionPlan({ refinement_count: 2 });
    supabase.__setData('decomposition_plans', [plan]);

    const { data } = supabase.from('decomposition_plans').select().single();
    expect(data.refinement_count).toBe(2);
  });

  it('tracks approach_memory_used flag', () => {
    const plan = makeDecompositionPlan({ approach_memory_used: true });
    supabase.__setData('decomposition_plans', [plan]);

    const { data } = supabase.from('decomposition_plans').select().single();
    expect(data.approach_memory_used).toBe(true);
  });

  it('supports status transitions', () => {
    const plan = makeDecompositionPlan({ id: 1, status: 'active' });
    supabase.__setData('decomposition_plans', [plan]);

    const { error } = supabase.from('decomposition_plans').update({ status: 'superseded' }).eq('id', 1);
    expect(error).toBeNull();

    const stored = supabase.__getData('decomposition_plans');
    expect(stored[0].status).toBe('superseded');
  });
});

// ============================================================
// ESCALATION LOG
// ============================================================

describe('escalation_log table', () => {
  it('creates an escalation entry', () => {
    const esc = makeEscalation({
      project_id: 1,
      escalation_type: 'budget',
      reason: 'Estimated cost exceeds $100 threshold'
    });

    supabase.__setData('escalation_log', [esc]);

    const { data } = supabase.from('escalation_log')
      .select()
      .eq('escalation_type', 'budget');

    expect(data).toHaveLength(1);
    expect(data[0].reason).toBe('Estimated cost exceeds $100 threshold');
    expect(data[0].resolved).toBe(false);
  });

  it('supports all escalation types', () => {
    const types = ['budget', 'strategic', 'brand', 'capability_gap', 'ambiguity'];
    const escalations = types.map(t => makeEscalation({ escalation_type: t, reason: `${t} escalation` }));

    supabase.__setData('escalation_log', escalations);

    const { data } = supabase.from('escalation_log').select();
    expect(data).toHaveLength(5);
  });

  it('tracks resolution', () => {
    const esc = makeEscalation({
      id: 1,
      resolved: false,
      escalation_type: 'ambiguity',
      reason: 'Unclear scope'
    });

    supabase.__setData('escalation_log', [esc]);

    const { error } = supabase.from('escalation_log').update({
      resolved: true,
      resolution: 'Zero clarified: focus on residential only',
      resolved_at: new Date().toISOString()
    }).eq('id', 1);
    expect(error).toBeNull();

    const stored = supabase.__getData('escalation_log');
    expect(stored[0].resolved).toBe(true);
    expect(stored[0].resolution).toContain('residential');
  });

  it('filters unresolved escalations', () => {
    const resolved = makeEscalation({ resolved: true, escalation_type: 'budget', reason: 'done' });
    const unresolved = makeEscalation({ resolved: false, escalation_type: 'strategic', reason: 'pending' });

    supabase.__setData('escalation_log', [resolved, unresolved]);

    const { data } = supabase.from('escalation_log')
      .select()
      .eq('resolved', false);

    expect(data).toHaveLength(1);
    expect(data[0].escalation_type).toBe('strategic');
  });
});

// ============================================================
// CROSS-TABLE: Helpers integration
// ============================================================

describe('Test helper factory integration', () => {
  it('makeClassification defaults are sensible', () => {
    const c = makeClassification();
    expect(c.classification).toBe('simple_task');
    expect(c.confidence).toBe(0.85);
    expect(c.sender_id).toBe('zero');
    expect(c.created_at).toBeTruthy();
  });

  it('makeDependency defaults are sensible', () => {
    const d = makeDependency();
    expect(d.dependency_type).toBe('blocks');
    expect(d.step_id).toBeNull();
    expect(d.depends_on_step_id).toBeNull();
  });

  it('makeDecompositionPlan defaults are sensible', () => {
    const p = makeDecompositionPlan();
    expect(p.status).toBe('active');
    expect(p.decomposed_by).toBe('frasier');
    expect(p.refinement_count).toBe(0);
    expect(p.plan_json).toEqual({ tasks: [], metadata: {} });
  });

  it('makeEscalation defaults are sensible', () => {
    const e = makeEscalation();
    expect(e.escalation_type).toBe('ambiguity');
    expect(e.resolved).toBe(false);
    expect(e.resolution).toBeNull();
  });
});
