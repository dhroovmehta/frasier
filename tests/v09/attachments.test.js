// tests/v09/attachments.test.js — Discord file attachment support (v0.9.6)
// TDD: Tests define the contract BEFORE implementation.
//
// Feature: When Dhroov drops a .md (or .txt, .json, etc.) file into Discord,
// the bot should download the file content and combine it with any typed message.
// The combined content flows through the existing classify → Frasier → decompose
// pipeline without any downstream changes.
//
// Two test suites:
//   A. fetchAttachments() — unit tests for the new web.js function
//   B. Message handler integration — verify attachments flow through the pipeline

const { makeAttachment, makeAttachmentCollection, resetIdCounter } = require('../helpers');

// ============================================================
// SUITE A: fetchAttachments() unit tests
// ============================================================
// WHY: fetchAttachments() is the core new function. It takes Discord's
// message.attachments Collection, filters for text-based files, downloads
// them from Discord CDN, and returns formatted content. All edge cases
// (binary files, oversized files, network errors) must be handled gracefully.

describe('fetchAttachments()', () => {
  let web;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    resetIdCounter();

    // Mock fetch globally for Discord CDN downloads
    global.fetch = jest.fn();

    // Silence console logs in tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    web = require('../../src/lib/web');
  });

  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
  });

  test('returns empty result when no attachments provided', async () => {
    const result = await web.fetchAttachments(null);
    expect(result).toEqual({ content: '', attachmentCount: 0 });
  });

  test('returns empty result for empty attachment collection', async () => {
    const attachments = makeAttachmentCollection([]);
    const result = await web.fetchAttachments(attachments);
    expect(result).toEqual({ content: '', attachmentCount: 0 });
  });

  test('downloads a single .md file and returns formatted content', async () => {
    const fileContent = '# Project Roadmap\n\n## Phase 1\n- Research competitors';

    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(fileContent)
    });

    const attachment = makeAttachment({ name: 'roadmap.md', size: 500 });
    const attachments = makeAttachmentCollection([attachment]);

    const result = await web.fetchAttachments(attachments);

    expect(result.attachmentCount).toBe(1);
    expect(result.content).toContain('## File: roadmap.md');
    expect(result.content).toContain('# Project Roadmap');
    expect(result.content).toContain('Research competitors');
  });

  test('downloads multiple text files up to the 3-attachment limit', async () => {
    const files = [
      makeAttachment({ name: 'phase1.md', size: 200 }),
      makeAttachment({ name: 'phase2.txt', size: 200 }),
      makeAttachment({ name: 'config.json', size: 200 }),
      makeAttachment({ name: 'phase3.csv', size: 200 })  // Should be skipped (over limit)
    ];

    // Mock fetch for each file that should be downloaded (first 3 only)
    global.fetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('Phase 1 content') });
    global.fetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('Phase 2 content') });
    global.fetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{"key": "value"}') });

    const attachments = makeAttachmentCollection(files);
    const result = await web.fetchAttachments(attachments);

    expect(result.attachmentCount).toBe(3);
    expect(result.content).toContain('## File: phase1.md');
    expect(result.content).toContain('## File: phase2.txt');
    expect(result.content).toContain('## File: config.json');
    expect(result.content).not.toContain('phase3.csv');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('skips binary files (images, PDFs)', async () => {
    const files = [
      makeAttachment({ name: 'photo.png', size: 5000, contentType: 'image/png' }),
      makeAttachment({ name: 'report.pdf', size: 8000, contentType: 'application/pdf' }),
      makeAttachment({ name: 'icon.jpg', size: 3000, contentType: 'image/jpeg' })
    ];

    const attachments = makeAttachmentCollection(files);
    const result = await web.fetchAttachments(attachments);

    expect(result).toEqual({ content: '', attachmentCount: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('skips files over 100KB (pre-download size check)', async () => {
    const attachment = makeAttachment({
      name: 'huge-doc.md',
      size: 200000,  // 200KB — over 100KB limit
      contentType: 'text/plain'
    });

    const attachments = makeAttachmentCollection([attachment]);
    const result = await web.fetchAttachments(attachments);

    expect(result).toEqual({ content: '', attachmentCount: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Skipping oversized attachment')
    );
  });

  test('truncates downloaded content at 50,000 chars', async () => {
    const longContent = 'x'.repeat(80000);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(longContent)
    });

    const attachment = makeAttachment({ name: 'long-doc.txt', size: 80000 });
    const attachments = makeAttachmentCollection([attachment]);

    const result = await web.fetchAttachments(attachments);

    expect(result.attachmentCount).toBe(1);
    // Content should be truncated — the file text portion should not exceed 50K chars
    // Plus the header and truncation marker
    expect(result.content).toContain('[...truncated at 50,000 characters]');
    // The raw file text within the content should be <= 50000 chars
    const fileTextStart = result.content.indexOf('## File: long-doc.txt\n') + '## File: long-doc.txt\n'.length;
    const fileText = result.content.substring(fileTextStart);
    // Should contain the truncation marker (confirming truncation happened)
    expect(fileText).toContain('[...truncated');
  });

  test('handles fetch failure gracefully (network error)', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network timeout'));

    const attachment = makeAttachment({ name: 'roadmap.md', size: 500 });
    const attachments = makeAttachmentCollection([attachment]);

    const result = await web.fetchAttachments(attachments);

    // Should return empty — no crash, no throw
    expect(result).toEqual({ content: '', attachmentCount: 0 });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Error downloading attachment roadmap.md')
    );
  });

  test('handles non-200 HTTP response gracefully', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404
    });

    const attachment = makeAttachment({ name: 'missing.md', size: 500 });
    const attachments = makeAttachmentCollection([attachment]);

    const result = await web.fetchAttachments(attachments);

    expect(result).toEqual({ content: '', attachmentCount: 0 });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Failed to download attachment missing.md')
    );
  });

  test('allows .md files with contentType application/octet-stream (extension-first filtering)', async () => {
    // WHY: Discord often sends application/octet-stream for text files.
    // Our filter should check the extension first, not just contentType.
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('# Real markdown content')
    });

    const attachment = makeAttachment({
      name: 'spec.md',
      size: 800,
      contentType: 'application/octet-stream'  // Discord's default for unknown types
    });

    const attachments = makeAttachmentCollection([attachment]);
    const result = await web.fetchAttachments(attachments);

    expect(result.attachmentCount).toBe(1);
    expect(result.content).toContain('# Real markdown content');
  });

  test('formats output with file name headers', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('File A content')
    });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('File B content')
    });

    const files = [
      makeAttachment({ name: 'requirements.md', size: 200 }),
      makeAttachment({ name: 'notes.txt', size: 150 })
    ];

    const attachments = makeAttachmentCollection(files);
    const result = await web.fetchAttachments(attachments);

    expect(result.attachmentCount).toBe(2);
    // Should have a top-level header
    expect(result.content).toContain('# ATTACHED FILES');
    // Each file should have its own header
    expect(result.content).toContain('## File: requirements.md');
    expect(result.content).toContain('## File: notes.txt');
    expect(result.content).toContain('File A content');
    expect(result.content).toContain('File B content');
  });
});

// ============================================================
// SUITE B: Message handler attachment integration
// ============================================================
// WHY: The message handler is the entry point. We need to verify that:
// 1. Attachment-only messages (no typed text) are NOT dropped
// 2. Text + attachment messages combine both into a single content string
// 3. Binary-only attachment messages with no text are still dropped
//
// These tests mock the discord_bot.js dependencies and exercise the
// messageCreate handler's attachment processing logic.

describe('Message handler attachment integration', () => {
  let discordBot, mockClassifyMessage, mockHandleFrasierMessage, mockWeb;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    resetIdCounter();

    // Silence console logs
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Mock Discord.js client (required at module load)
    jest.doMock('discord.js', () => ({
      Client: jest.fn().mockImplementation(() => ({
        once: jest.fn(),
        on: jest.fn(),
        login: jest.fn().mockResolvedValue(null),
        guilds: { cache: new Map() }
      })),
      GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
      Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' }
    }));

    // Mock all discord_bot.js dependencies
    jest.doMock('../../src/lib/supabase', () => global.__mockSupabase || {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null })
    });
    jest.doMock('../../src/lib/missions', () => ({
      createProposal: jest.fn().mockResolvedValue({ id: 1 }),
      createMission: jest.fn().mockResolvedValue({ id: 1 }),
      createStep: jest.fn().mockResolvedValue({ id: 1 })
    }));
    jest.doMock('../../src/lib/agents', () => ({
      findBestAgentAcrossTeams: jest.fn().mockResolvedValue({ id: 'agent-test-1' }),
      autoHireGapAgent: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/events', () => ({
      logEvent: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/models', () => require('../mocks/models'));
    jest.doMock('../../src/lib/memory', () => ({
      buildAgentPrompt: jest.fn().mockResolvedValue({
        systemPrompt: 'You are Frasier.',
        error: null
      }),
      saveMemory: jest.fn().mockResolvedValue(null),
      saveLesson: jest.fn().mockResolvedValue(null),
      saveConversation: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/policy', () => ({}));
    jest.doMock('../../src/lib/notion', () => ({}));
    jest.doMock('../../src/lib/google_drive', () => ({}));
    jest.doMock('../../src/lib/alerts', () => ({
      setDiscordChannels: jest.fn()
    }));
    jest.doMock('../../src/lib/projects', () => ({
      createProject: jest.fn().mockResolvedValue({ id: 1 }),
      linkMissionToProject: jest.fn().mockResolvedValue(null),
      checkPhaseCompletion: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/content', () => ({}));
    jest.doMock('../../src/lib/linear', () => ({
      syncMissionToLinear: jest.fn().mockResolvedValue(null),
      syncStepToLinear: jest.fn().mockResolvedValue(null),
      updateIssueStatus: jest.fn().mockResolvedValue(null),
      syncDecomposedProjectToLinear: jest.fn().mockResolvedValue(null),
      createDependencyRelations: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/decomposition', () => ({
      handleNewProjectDecomposition: jest.fn().mockResolvedValue({ success: true })
    }));

    // Mock web module — we control fetchAttachments here
    mockWeb = {
      prefetchUrls: jest.fn().mockResolvedValue({ enrichedText: '', fetchedUrls: 0 }),
      fetchAttachments: jest.fn().mockResolvedValue({ content: '', attachmentCount: 0 }),
      resolveWebTags: jest.fn().mockResolvedValue({ results: [], hasWebTags: false }),
      formatWebResults: jest.fn().mockReturnValue('')
    };
    jest.doMock('../../src/lib/web', () => mockWeb);

    // Set env for founder ID check
    process.env.DISCORD_ZERO_ID = 'founder-123';
  });

  afterEach(() => {
    delete process.env.DISCORD_ZERO_ID;
    jest.restoreAllMocks();
  });

  // Helper: create a mock Discord message
  function makeMockMessage(overrides = {}) {
    return {
      author: { bot: false, id: process.env.DISCORD_ZERO_ID },
      id: `msg-${Date.now()}`,
      content: overrides.content !== undefined ? overrides.content : 'Test message',
      attachments: overrides.attachments || makeAttachmentCollection([]),
      channel: {
        sendTyping: jest.fn().mockResolvedValue(null),
        send: jest.fn().mockResolvedValue(null)
      },
      reply: jest.fn().mockResolvedValue(null),
      ...overrides
    };
  }

  test('attachment-only message (no text) is processed and not dropped', async () => {
    const fileContent = '# Market Research Plan\n\nResearch competitors in TX insurance market.';

    // fetchAttachments returns the file content
    mockWeb.fetchAttachments.mockResolvedValueOnce({
      content: `# ATTACHED FILES\n\n## File: plan.md\n${fileContent}\n`,
      attachmentCount: 1
    });

    const attachment = makeAttachment({ name: 'plan.md', size: 500 });
    const mockMessage = makeMockMessage({
      content: '',  // No typed text
      attachments: makeAttachmentCollection([attachment])
    });

    // Load discord_bot and extract the messageCreate handler
    const discordJs = require('discord.js');
    require('../../src/discord_bot');
    const client = discordJs.Client.mock.results[0].value;

    // Find the messageCreate handler
    const onCall = client.on.mock.calls.find(c => c[0] === 'messageCreate');
    expect(onCall).toBeDefined();
    const messageHandler = onCall[1];

    // Execute the handler
    await messageHandler(mockMessage);

    // fetchAttachments should have been called with the message's attachments
    expect(mockWeb.fetchAttachments).toHaveBeenCalledWith(mockMessage.attachments);

    // The message should NOT have been dropped — Frasier should have received it.
    // We verify by checking that prefetchUrls was called (it runs inside handleFrasierMessage)
    // If the message was dropped at the empty check, prefetchUrls wouldn't be called.
    // Actually, we can verify classifyMessage was called by checking models.callLLM
    const models = require('../../src/lib/models');
    expect(models.callLLM).toHaveBeenCalled();
  });

  test('text + attachment combines both into single content string', async () => {
    const attachmentContent = '# ATTACHED FILES\n\n## File: roadmap.md\n## Phase 1\nDo research\n';

    mockWeb.fetchAttachments.mockResolvedValueOnce({
      content: attachmentContent,
      attachmentCount: 1
    });

    const mockMessage = makeMockMessage({
      content: 'Execute everything in this doc',
      attachments: makeAttachmentCollection([makeAttachment({ name: 'roadmap.md' })])
    });

    const discordJs = require('discord.js');
    require('../../src/discord_bot');
    const client = discordJs.Client.mock.results[0].value;
    const onCall = client.on.mock.calls.find(c => c[0] === 'messageCreate');
    const messageHandler = onCall[1];

    await messageHandler(mockMessage);

    // Verify fetchAttachments was called
    expect(mockWeb.fetchAttachments).toHaveBeenCalledWith(mockMessage.attachments);

    // The classifier (T1 LLM call) should have been called with the combined content.
    // classifyMessage runs BEFORE handleFrasierMessage, so it receives the combined
    // text+attachment content directly from the message handler.
    const models = require('../../src/lib/models');
    expect(models.callLLM).toHaveBeenCalled();

    // The classifier's userMessage should contain both the typed text AND the attachment content.
    const classifierCall = models.callLLM.mock.calls[0];
    const userMessage = classifierCall[0].userMessage;
    expect(userMessage).toContain('Execute everything in this doc');
    expect(userMessage).toContain('ATTACHED FILES');
  });

  test('binary-only attachment with no text is still dropped', async () => {
    // fetchAttachments returns empty (binary files are filtered out)
    mockWeb.fetchAttachments.mockResolvedValueOnce({
      content: '',
      attachmentCount: 0
    });

    const mockMessage = makeMockMessage({
      content: '',  // No typed text
      attachments: makeAttachmentCollection([
        makeAttachment({ name: 'photo.png', contentType: 'image/png' })
      ])
    });

    const discordJs = require('discord.js');
    require('../../src/discord_bot');
    const client = discordJs.Client.mock.results[0].value;
    const onCall = client.on.mock.calls.find(c => c[0] === 'messageCreate');
    const messageHandler = onCall[1];

    await messageHandler(mockMessage);

    // fetchAttachments was called, but returned empty
    expect(mockWeb.fetchAttachments).toHaveBeenCalled();

    // No LLM call should have been made — message was dropped at the empty check
    const models = require('../../src/lib/models');
    expect(models.callLLM).not.toHaveBeenCalled();
  });
});
