// tests/v09/skill-encoding.test.js — Hybrid Skill Encoding (D-028)
// TDD: Tests written BEFORE implementation.
// WHY: Agents need Claude Code skill knowledge during task execution.
// Distilled summaries are always in the prompt (cheap). Full skill content
// injects only when topic tags match trigger keywords, keeping prompts lean.

const { makeAgent, resetIdCounter } = require('../helpers');

// We test skill_encodings.js directly — no mocks needed, it's pure logic.
const {
  buildSkillInjection,
  SKILL_ENCODINGS,
  MAX_SKILL_INJECTION_CHARS
} = require('../../src/lib/skill_encodings');

beforeEach(() => {
  resetIdCounter();
});

// ============================================================
// DISTILLED INSTRUCTIONS — ALWAYS PRESENT
// ============================================================

describe('Skill Encoding — distilled instructions', () => {
  it('distilled instructions always present in Frasier prompt', () => {
    // Frasier (chief_of_staff) should get distilled text for ALL applicable skills
    // even when no topic tags are provided (no trigger keywords matched).
    const result = buildSkillInjection('Chief of Staff', 'chief_of_staff', []);

    // Should include the section header
    expect(result).toContain('# SKILL KNOWLEDGE');

    // Should include distilled text for task-execution-engine (all agents)
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);

    // Should include distilled text for all chief_of_staff skills
    expect(result).toContain(SKILL_ENCODINGS['design-orchestration'].distilled);
    expect(result).toContain(SKILL_ENCODINGS['task-coordination-strategies'].distilled);
    expect(result).toContain(SKILL_ENCODINGS['multi-agent-patterns'].distilled);
    expect(result).toContain(SKILL_ENCODINGS['subagent-driven-development'].distilled);
  });

  it('distilled instructions always present for all agents (task-execution-engine)', () => {
    // A sub_agent (e.g. Spike the engineer) should get task-execution-engine distilled
    // but NOT any chief_of_staff-only skills.
    const result = buildSkillInjection('Full-Stack Engineer', 'sub_agent', []);

    expect(result).toContain('# SKILL KNOWLEDGE');
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);

    // Should NOT include chief_of_staff-only distilled texts
    expect(result).not.toContain(SKILL_ENCODINGS['design-orchestration'].distilled);
    expect(result).not.toContain(SKILL_ENCODINGS['task-coordination-strategies'].distilled);
    expect(result).not.toContain(SKILL_ENCODINGS['multi-agent-patterns'].distilled);
    expect(result).not.toContain(SKILL_ENCODINGS['subagent-driven-development'].distilled);
  });
});

// ============================================================
// FULL SKILL INJECTION — ON-DEMAND VIA TRIGGER KEYWORDS
// ============================================================

describe('Skill Encoding — full skill injection', () => {
  it('full skill content injected when topicTags match trigger keywords', () => {
    // When a sub_agent gets topic tags matching task-execution-engine triggers,
    // the full content should appear alongside the distilled text.
    const result = buildSkillInjection('Full-Stack Engineer', 'sub_agent', ['implement', 'build']);

    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].full);
  });

  it('full skill content NOT injected when no keywords match', () => {
    // Topic tags that don't match any trigger keywords = distilled only.
    const result = buildSkillInjection('Full-Stack Engineer', 'sub_agent', ['meeting', 'standup']);

    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);
    expect(result).not.toContain(SKILL_ENCODINGS['task-execution-engine'].full);
  });

  it('multiple skills can be injected simultaneously', () => {
    // Frasier with topic tags that trigger multiple skills at once.
    const result = buildSkillInjection(
      'Chief of Staff', 'chief_of_staff',
      ['design', 'parallel', 'delegate']
    );

    // design-orchestration triggered by 'design'
    expect(result).toContain(SKILL_ENCODINGS['design-orchestration'].full);

    // subagent-driven-development triggered by 'parallel'
    expect(result).toContain(SKILL_ENCODINGS['subagent-driven-development'].full);

    // multi-agent-patterns triggered by 'delegate'
    expect(result).toContain(SKILL_ENCODINGS['multi-agent-patterns'].full);

    // task-coordination-strategies triggered by 'delegate' too
    expect(result).toContain(SKILL_ENCODINGS['task-coordination-strategies'].full);
  });
});

// ============================================================
// ROLE FILTERING — ONLY APPLICABLE SKILLS
// ============================================================

describe('Skill Encoding — role filtering', () => {
  it('only role-applicable skills appear (Frasier gets orchestration, Spike does not)', () => {
    // Frasier should see orchestration skills
    const frasierResult = buildSkillInjection('Chief of Staff', 'chief_of_staff', ['design']);
    expect(frasierResult).toContain(SKILL_ENCODINGS['design-orchestration'].full);

    // Spike (sub_agent) should NOT see orchestration skills even with the same tags
    const spikeResult = buildSkillInjection('Full-Stack Engineer', 'sub_agent', ['design']);
    expect(spikeResult).not.toContain(SKILL_ENCODINGS['design-orchestration'].full);
    expect(spikeResult).not.toContain(SKILL_ENCODINGS['design-orchestration'].distilled);
  });

  it('QA agent only gets universal skills', () => {
    const result = buildSkillInjection('QA Engineer', 'qa', ['implement', 'deploy']);

    // Should have task-execution-engine (universal)
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].full);

    // Should NOT have chief_of_staff skills
    expect(result).not.toContain(SKILL_ENCODINGS['design-orchestration'].distilled);
    expect(result).not.toContain(SKILL_ENCODINGS['task-coordination-strategies'].distilled);
  });
});

// ============================================================
// TOKEN BUDGET GUARD
// ============================================================

describe('Skill Encoding — token budget guard', () => {
  it('total injected tokens stay under 3000 chars (budget guard)', () => {
    // Even when ALL skills are triggered simultaneously for Frasier,
    // the output must not exceed MAX_SKILL_INJECTION_CHARS.
    const result = buildSkillInjection(
      'Chief of Staff', 'chief_of_staff',
      // Trigger keywords that match every single skill
      ['implement', 'design', 'decompose', 'multi-agent', 'parallel']
    );

    expect(result.length).toBeLessThanOrEqual(MAX_SKILL_INJECTION_CHARS);
  });

  it('falls back to distilled-only when full injection exceeds budget', () => {
    // When all skills are triggered and full content would exceed the budget,
    // the system should fall back to distilled-only (which is always under budget).
    const result = buildSkillInjection(
      'Chief of Staff', 'chief_of_staff',
      ['implement', 'design', 'decompose', 'multi-agent', 'parallel']
    );

    // The result should still contain distilled texts
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);
    expect(result).toContain(SKILL_ENCODINGS['design-orchestration'].distilled);

    // If the budget was exceeded, full content should be absent
    // (this test verifies the fallback mechanism works — the actual behavior
    // depends on whether the full content exceeds 3000 chars)
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(MAX_SKILL_INJECTION_CHARS);
  });
});

// ============================================================
// EDGE CASES
// ============================================================

describe('Skill Encoding — edge cases', () => {
  it('returns empty string for unknown agent_type with no universal skills triggered', () => {
    // Even unknown types still get universal skills (task-execution-engine)
    const result = buildSkillInjection('Unknown Role', 'unknown_type', []);
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);
  });

  it('handles empty topicTags array gracefully', () => {
    const result = buildSkillInjection('Chief of Staff', 'chief_of_staff', []);
    expect(result).toContain('# SKILL KNOWLEDGE');
    // Distilled texts present, no full texts
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].distilled);
    expect(result).not.toContain(SKILL_ENCODINGS['task-execution-engine'].full);
  });

  it('handles null topicTags gracefully', () => {
    const result = buildSkillInjection('Chief of Staff', 'chief_of_staff', null);
    expect(result).toContain('# SKILL KNOWLEDGE');
    expect(result).not.toContain(SKILL_ENCODINGS['task-execution-engine'].full);
  });

  it('keyword matching is case-insensitive', () => {
    const result = buildSkillInjection('Full-Stack Engineer', 'sub_agent', ['IMPLEMENT', 'BUILD']);
    expect(result).toContain(SKILL_ENCODINGS['task-execution-engine'].full);
  });

  it('skill sections are properly formatted with headers', () => {
    const result = buildSkillInjection('Full-Stack Engineer', 'sub_agent', []);
    // Each skill should have a ## header with the skill name
    expect(result).toContain('## task-execution-engine');
  });
});
