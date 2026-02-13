// discord_bot.js — Founder interface & notification system (PM2 process #1)
// WHY: Discord is the lifeline. Zero interacts with Frasier here.
// This bot:
//   1. Receives messages from Zero → creates mission proposals
//   2. Posts results, summaries, and alerts to Discord channels
//   3. Handles approval requests (Tier 3 escalation, spending approval)
//   4. Posts daily summary at 9:30am ET
//
// Channel structure:
//   - #frasier-dm (or DM): Zero ↔ Frasier personal assistant
//   - #team-research: Research team updates
//   - #team-execution: Execution team updates (when active)
//   - #team-advisory: Advisory team updates (when active)
//   - #daily-summary: Daily rollup
//   - #alerts: System alerts and errors

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const missions = require('./lib/missions');
const agents = require('./lib/agents');
const events = require('./lib/events');
const models = require('./lib/models');
const memory = require('./lib/memory');
const policy = require('./lib/policy');
const notion = require('./lib/notion');
const gdrive = require('./lib/google_drive');
const alerts = require('./lib/alerts');
const web = require('./lib/web');

// ============================================================
// DISCORD CLIENT SETUP
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// Channel name → ID mapping (populated on ready)
const channels = {};

// ============================================================
// BOT EVENTS
// ============================================================

client.once(Events.ClientReady, async (c) => {
  console.log(`[discord] Bot ready as ${c.user.tag}`);

  // Cache channel IDs
  for (const guild of c.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.isTextBased()) {
        channels[channel.name] = channel;
      }
    }
  }

  console.log(`[discord] Cached ${Object.keys(channels).length} channels`);

  // Share channel map with alerts module so heartbeat can post to Discord
  alerts.setDiscordChannels(channels);

  await events.logEvent({
    eventType: 'discord_bot_started',
    severity: 'info',
    description: `Discord bot ready as ${c.user.tag}`
  });

  // Start polling for announcements
  pollForAnnouncements();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only respond to Zero (founder)
  const zeroDiscordId = process.env.DISCORD_ZERO_ID;
  if (zeroDiscordId && message.author.id !== zeroDiscordId) return;

  const content = message.content.trim();
  if (!content) return;

  console.log(`[discord] Message from Zero: "${content.substring(0, 80)}..."`);

  try {
    // Handle special commands
    if (content.startsWith('!')) {
      await handleCommand(message, content);
      return;
    }

    // Everything else becomes a mission proposal via Frasier
    await handleFrasierMessage(message, content);
  } catch (err) {
    console.error('[discord] Error handling message:', err.message);
    await message.reply('Something went wrong. Error logged.');
    await events.logEvent({
      eventType: 'discord_error',
      severity: 'error',
      description: `Error handling message: ${err.message}`
    });
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Handle messages as Frasier conversations.
 * Zero talks to Frasier → Frasier processes → creates proposal or responds.
 */
async function handleFrasierMessage(message, content) {
  await message.channel.sendTyping();

  // Build Frasier's prompt with memory
  const frasierAgent = await findFrasier();
  if (!frasierAgent) {
    await message.reply('Frasier is not set up yet. Run the agent setup first.');
    return;
  }

  // Extract REAL topic tags from what Zero said — not generic labels.
  // WHY: If Zero says "what about that Super Bowl game?", we need to pull memories
  // tagged with 'super-bowl', 'football', 'nfl' — not just 'founder-interaction'.
  // This is what lets Frasier recall a casual Sunday conversation on Saturday.
  const contentTopics = extractConversationTopics(content);
  const retrievalTags = ['founder-interaction', ...contentTopics];

  const promptData = await memory.buildAgentPrompt(frasierAgent.id, retrievalTags);
  if (promptData.error) {
    await message.reply(`Error loading Frasier: ${promptData.error}`);
    return;
  }

  // PRE-FETCH: If Zero's message contains URLs (tweets, articles), fetch them now
  // so Frasier has the actual content. Twitter/X URLs auto-rewrite to fxtwitter.
  const { enrichedText: enrichedContent } = await web.prefetchUrls(content);

  // Add context about what Frasier should do
  const frasierInstructions = `Zero (the founder) just sent you this message via Discord:

"${enrichedContent}"

As Chief of Staff, determine the appropriate action:
1. If this is a task or request → acknowledge it, state which team/agent you'll route it to, and what the expected deliverable is
2. If this is a question → answer it directly from your knowledge and memory
3. If this is casual conversation → engage naturally, share your genuine thoughts, be a real person. Reference past conversations if relevant.
4. If this requires approval → explain what needs approval and why

CRITICAL — LIVE DATA: If Zero asks about current prices, news, scores, weather, recent events, or ANYTHING that requires up-to-date information, you MUST use your web access. Do NOT guess or use stale training data. Instead, include [WEB_SEARCH:your query] in your response and the system will fetch live results for you. Examples:
- "What is the price of ETH?" → include [WEB_SEARCH:current ethereum ETH price USD]
- "What happened in the news today?" → include [WEB_SEARCH:today's top news]
- "How did the market do?" → include [WEB_SEARCH:stock market today S&P 500]
If you are not 100% certain the information is current, USE WEB SEARCH. Never hallucinate prices, dates, scores, or stats.

SYSTEM SPEED: Your team is AI-powered. Tasks complete in MINUTES, not days. Never quote timelines like "3 business days" or "by end of week." When routing a task, say something like "The team will have this ready shortly" or "You'll have the deliverable within minutes." Do NOT use human-team timelines.

Always be concise, professional, and action-oriented. Reference relevant context from your memory. If Zero is referencing a past conversation, recall what you both said and build on it.

CRITICAL ACTION TAGS — You MUST end EVERY response with exactly ONE of these tags:

[ACTION:PROPOSAL] — USE THIS when Zero is asking for ANY work to be done. This includes: research, analysis, building, writing, creating, investigating, vetting, finding information, comparing options, making recommendations, or any request where a deliverable is expected. When in doubt, USE THIS. Your response should acknowledge the task and state who you'll route it to — the actual work happens in the pipeline AFTER the proposal is created.

[ACTION:RESPONSE] — ONLY use this for pure conversation with NO work request. Examples: greetings, casual chat, status questions, opinions, thank-yous, jokes. If Zero is asking you to DO anything or FIND OUT anything, this is the WRONG tag.

[ACTION:APPROVAL_NEEDED] — Use when something requires Zero's explicit approval before proceeding (e.g., spending over budget, major strategic decisions).

DEFAULT TO [ACTION:PROPOSAL]. It is far worse to miss a task (Zero waits forever for nothing) than to create an unnecessary proposal (which is harmless).`;

  // Call LLM as Frasier — always Tier 1, Frasier is just routing/responding
  const result = await models.callLLM({
    systemPrompt: promptData.systemPrompt,
    userMessage: frasierInstructions,
    agentId: frasierAgent.id,
    forceTier: 'tier1'
  });

  if (result.error) {
    await message.reply(`Frasier is having trouble: ${result.error}`);
    return;
  }

  let response = result.content;

  // WEB ACCESS: If Frasier embedded [WEB_SEARCH:] or [WEB_FETCH:] tags, resolve them
  // and re-call the LLM with the live data. Same pattern as worker.js.
  const webResolution = await web.resolveWebTags(response);
  if (webResolution.hasWebTags) {
    console.log(`[discord] Frasier requested ${webResolution.results.length} web resource(s). Fetching...`);
    const webContext = web.formatWebResults(webResolution.results);

    const followUp = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage: `${frasierInstructions}\n\nHere is live web data you requested:\n${webContext}\n\nUsing the live data above, respond to Zero's message. Do NOT include [WEB_SEARCH] or [WEB_FETCH] tags in this response.`,
      agentId: frasierAgent.id,
      forceTier: 'tier1'
    });

    if (followUp.content) {
      response = followUp.content;
      console.log('[discord] Frasier web-enriched response generated.');
    }
  }

  // Parse the action tag
  if (response.includes('[ACTION:PROPOSAL]')) {
    // Create a mission proposal
    const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();
    await missions.createProposal({
      proposingAgentId: 'zero',
      title: content.substring(0, 200),
      description: content,
      priority: content.toLowerCase().includes('urgent') ? 'urgent' : 'normal',
      rawMessage: content
    });

    await sendSplit(message.channel, cleanResponse + '\n\n*Mission proposal created. Team will pick this up shortly.*');
  } else {
    // Just a response
    const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();
    await sendSplit(message.channel, cleanResponse);
  }

  // Save FULL exchange to Frasier's memory with content-based topic tags.
  // Both Zero's message AND Frasier's response are saved so the complete
  // back-and-forth is available on future retrieval.
  const saveTags = ['founder-interaction', 'founder-request', ...contentTopics];

  // Save Zero's message as its own memory (so individual turns are retrievable)
  await memory.saveMemory({
    agentId: frasierAgent.id,
    memoryType: 'conversation',
    content: `Zero said: "${content}"`,
    summary: `Zero: ${content.substring(0, 150)}`,
    topicTags: saveTags,
    importance: 8,
    sourceType: 'conversation',
    relatedAgentIds: ['zero']
  });

  // Save Frasier's response as its own memory
  const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();
  await memory.saveMemory({
    agentId: frasierAgent.id,
    memoryType: 'conversation',
    content: `I said to Zero: "${cleanResponse}"`,
    summary: `My response to Zero: ${cleanResponse.substring(0, 150)}`,
    topicTags: saveTags,
    importance: 7,
    sourceType: 'conversation',
    relatedAgentIds: ['zero']
  });

  // LESSON EXTRACTION: If Zero gives a directive, preference, or strategic instruction,
  // save it as a permanent lesson so Frasier NEVER forgets it.
  const isDirective = detectFounderDirective(content);
  if (isDirective) {
    await memory.saveLesson({
      agentId: frasierAgent.id,
      lesson: `Zero's instruction: "${content.substring(0, 400)}"`,
      context: `Founder directive via Discord`,
      category: 'founder-directive',
      importance: 9
    });
    console.log(`[discord] Saved founder directive as permanent lesson: "${content.substring(0, 80)}..."`);
  }

  // Save conversation to history
  await memory.saveConversation({
    conversationId: `discord-${Date.now()}`,
    conversationType: 'founder_chat',
    senderAgentId: 'zero',
    recipientAgentId: frasierAgent.id,
    content,
    context: 'Discord DM'
  });
}

/**
 * Handle special commands (!status, !teams, !costs, etc.)
 */
async function handleCommand(message, content) {
  const [cmd, ...args] = content.substring(1).split(' ');

  switch (cmd.toLowerCase()) {
    case 'status': {
      const activeAgents = await agents.getAllActiveAgents();
      const activeMissions = await missions.getActiveMissions();
      const teams = await agents.getAllTeams();

      let reply = '**System Status**\n';
      reply += `Teams: ${teams.map(t => `${t.name} [${t.status}]`).join(', ')}\n`;
      reply += `Active Agents: ${activeAgents.length}\n`;
      reply += `Active Missions: ${activeMissions.length}\n`;
      await sendSplit(message.channel, reply);
      break;
    }

    case 'teams': {
      const teams = await agents.getAllTeams();
      let reply = '**Teams**\n';
      for (const team of teams) {
        const teamAgents = await agents.getTeamAgents(team.id);
        reply += `\n**${team.name}** [${team.status}]\n`;
        if (teamAgents.length > 0) {
          for (const a of teamAgents) {
            reply += `  - ${a.display_name} (${a.role}) [${a.status}]\n`;
          }
        } else {
          reply += '  No agents assigned\n';
        }
      }
      await sendSplit(message.channel, reply);
      break;
    }

    case 'costs': {
      const since = new Date();
      since.setHours(0, 0, 0, 0); // Today
      const costs = await models.getModelCosts(since.toISOString());
      if (!costs) {
        await message.reply('Unable to fetch cost data.');
        return;
      }
      let reply = '**Today\'s LLM Costs**\n';
      reply += `Tier 1 (MiniMax): ${costs.tier1.calls} calls, $${costs.tier1.cost.toFixed(4)}\n`;
      reply += `Tier 2 (Manus): ${costs.tier2.calls} calls\n`;
      reply += `Tier 3 (Claude): ${costs.tier3.calls} calls, $${costs.tier3.cost.toFixed(4)}\n`;
      reply += `**Total: ${costs.total.calls} calls, $${costs.total.cost.toFixed(4)}, ${costs.total.tokens.toLocaleString()} tokens**`;
      await message.reply(reply);
      break;
    }

    case 'approve': {
      const stepId = parseInt(args[0]);
      if (!stepId) {
        await message.reply('Usage: !approve <step_id>');
        return;
      }
      await missions.approveStep(stepId);
      await message.reply(`Step #${stepId} approved.`);
      break;
    }

    case 'activate': {
      const teamId = args[0];
      if (!teamId) {
        await message.reply('Usage: !activate <team-id>');
        return;
      }
      const success = await agents.setTeamStatus(teamId, 'active');
      await message.reply(success ? `Team ${teamId} activated.` : `Failed to activate ${teamId}.`);
      break;
    }

    case 'deactivate': {
      const teamId = args[0];
      if (!teamId) {
        await message.reply('Usage: !deactivate <team-id>');
        return;
      }
      const success = await agents.setTeamStatus(teamId, 'dormant');
      await message.reply(success ? `Team ${teamId} deactivated.` : `Failed to deactivate ${teamId}.`);
      break;
    }

    case 'hire': {
      const hireId = parseInt(args[0]);
      if (!hireId) {
        await message.reply('Usage: `!hire <proposal_id>`');
        return;
      }

      const hire = await agents.getHiringProposal(hireId);
      if (!hire) {
        await message.reply(`Hiring proposal #${hireId} not found.`);
        return;
      }
      if (hire.status !== 'pending') {
        await message.reply(`Hiring proposal #${hireId} is already ${hire.status}.`);
        return;
      }

      const approved = await agents.approveHiringProposal(hireId);
      if (approved) {
        await message.reply(`Hiring proposal #${hireId} approved. A new **${hire.role}** will be created on **${hire.team_id}** shortly.`);
      } else {
        await message.reply(`Failed to approve hiring proposal #${hireId}.`);
      }
      break;
    }

    case 'reject': {
      const rejectId = parseInt(args[0]);
      if (!rejectId) {
        await message.reply('Usage: `!reject <proposal_id>`');
        return;
      }

      const rejected = await agents.rejectHiringProposal(rejectId);
      if (rejected) {
        await message.reply(`Hiring proposal #${rejectId} rejected.`);
      } else {
        await message.reply(`Failed to reject hiring proposal #${rejectId}. It may not be pending.`);
      }
      break;
    }

    case 'fire': {
      const agentName = args.join(' ').trim();
      if (!agentName) {
        await message.reply('Usage: `!fire <agent_name>`');
        return;
      }

      // Find Frasier — can't fire the chief of staff
      const frasier = await findFrasier();

      // Find the agent by display_name (case-insensitive)
      const allAgents = await agents.getAllActiveAgents();
      const target = allAgents.find(a => a.display_name.toLowerCase() === agentName.toLowerCase());

      if (!target) {
        await message.reply(`No active agent named "${agentName}" found. Use \`!roster\` to see all agents.`);
        return;
      }

      if (frasier && target.id === frasier.id) {
        await message.reply(`Can't fire Frasier (Chief of Staff). The organization needs a leader.`);
        return;
      }

      await agents.setAgentStatus(target.id, 'retired');
      await message.reply(`**${target.display_name}** (${target.role}) has been retired from ${target.team_id}. Name released back to the pool.`);

      await events.logEvent({
        eventType: 'agent_fired',
        agentId: target.id,
        teamId: target.team_id,
        severity: 'info',
        description: `${target.display_name} (${target.role}) retired by Zero`
      });
      break;
    }

    case 'roster': {
      const teams = await agents.getAllTeams();
      let reply = '**Agent Roster**\n';

      for (const team of teams) {
        const teamAgents = await agents.getTeamAgents(team.id);
        reply += `\n**${team.name}** [${team.status}]\n`;

        if (teamAgents.length > 0) {
          for (const a of teamAgents) {
            const typeTag = a.agent_type === 'chief_of_staff' ? ' (CoS)' :
              a.agent_type === 'team_lead' ? ' (Lead)' :
              a.agent_type === 'qa' ? ' (QA)' : '';
            reply += `  - ${a.display_name} — ${a.role}${typeTag} [${a.status}]\n`;
          }
        } else {
          reply += '  No agents assigned\n';
        }
      }

      // Show pending hiring proposals
      const pendingHires = await agents.getAllHiringProposals();
      const pending = pendingHires.filter(h => h.status === 'pending');
      const approved = pendingHires.filter(h => h.status === 'approved');

      if (pending.length > 0 || approved.length > 0) {
        reply += '\n**Hiring Proposals**\n';
        for (const h of pending) {
          reply += `  - #${h.id}: ${h.role} for ${h.team_id} [pending — \`!hire ${h.id}\`]\n`;
        }
        for (const h of approved) {
          reply += `  - #${h.id}: ${h.role} for ${h.team_id} [approved — creating agent...]\n`;
        }
      }

      await sendSplit(message.channel, reply);
      break;
    }

    case 'newbiz': {
      const bizName = args.join(' ').trim();
      if (!bizName) {
        await message.reply('Usage: `!newbiz <business_name>`');
        return;
      }

      // Generate a slug-style ID from the name
      const bizId = bizName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const biz = await agents.createBusiness({
        id: bizId,
        name: bizName,
        description: `Business unit: ${bizName}`
      });

      if (biz) {
        await message.reply(`Business **${bizName}** (${bizId}) created.`);
      } else {
        await message.reply(`Failed to create business "${bizName}". It may already exist.`);
      }
      break;
    }

    case 'help': {
      await message.reply(
        '**Commands:**\n' +
        '`!status` — System overview\n' +
        '`!teams` — List all teams and agents\n' +
        '`!roster` — Full agent roster + pending hires\n' +
        '`!costs` — Today\'s LLM costs\n' +
        '`!approve <step_id>` — Approve a pending step\n' +
        '`!hire <id>` — Approve a hiring proposal\n' +
        '`!reject <id>` — Reject a hiring proposal\n' +
        '`!fire <name>` — Retire an agent\n' +
        '`!newbiz <name>` — Create a business unit\n' +
        '`!activate <team-id>` — Activate a team\n' +
        '`!deactivate <team-id>` — Deactivate a team\n' +
        '\nOr just type normally to talk to Frasier.'
      );
      break;
    }

    default:
      await message.reply(`Unknown command: !${cmd}. Type !help for available commands.`);
  }
}

// ============================================================
// ANNOUNCEMENT POLLING
// ============================================================

/**
 * Poll for unannounced events and post them to Discord.
 * Runs every 30 seconds alongside the main bot.
 */
async function pollForAnnouncements() {
  setInterval(async () => {
    try {
      await announceCompletedSteps();
      await announceHiringProposals();
      await announceAlerts();
    } catch (err) {
      console.error('[discord] Announcement polling error:', err.message);
    }
  }, 30 * 1000);
}

/**
 * Announce completed and approved mission steps.
 */
async function announceCompletedSteps() {
  const supabase = require('./lib/supabase');

  const { data: steps, error } = await supabase
    .from('mission_steps')
    .select('*, missions!inner(title, team_id)')
    .eq('status', 'completed')
    .eq('announced', false)
    .limit(5);

  if (error || !steps || steps.length === 0) return;

  for (const step of steps) {
    // Determine which channel to post in
    const channelName = getTeamChannel(step.missions.team_id);
    const channel = channels[channelName] || channels['general'];
    if (!channel) continue;

    // Build announcement
    const agent = await agents.getAgent(step.assigned_agent_id);
    const agentName = agent?.display_name || step.assigned_agent_id;

    // Publish full deliverable to Notion and Google Drive in parallel
    const [notionPage, driveDoc] = await Promise.all([
      notion.publishDeliverable({
        title: step.missions.title,
        content: step.result || '',
        teamId: step.missions.team_id,
        agentName,
        missionId: step.mission_id,
        stepId: step.id
      }),
      gdrive.publishDeliverable({
        title: step.missions.title,
        content: step.result || '',
        teamId: step.missions.team_id,
        agentName,
        missionId: step.mission_id,
        stepId: step.id
      })
    ]);

    // Brief alert in Discord — links to Notion and/or Google Drive
    const links = [];
    if (notionPage?.url) links.push(`[Notion](${notionPage.url})`);
    if (driveDoc?.url) links.push(`[Google Doc](${driveDoc.url})`);
    const linkText = links.length > 0 ? `\n${links.join(' | ')}` : '';
    const announcement = `**Deliverable Ready** — ${step.missions.title}\nAgent: ${agentName} | Approved by Team Lead${linkText}`;

    await sendSplit(channel, announcement);

    // Mark as announced
    await supabase
      .from('mission_steps')
      .update({ announced: true })
      .eq('id', step.id);
  }
}

/**
 * Announce pending hiring proposals to Discord.
 * Posts to #frasier-dm so Zero can approve with !hire <id>.
 */
async function announceHiringProposals() {
  const pendingHires = await agents.getPendingHiringProposals();
  if (pendingHires.length === 0) return;

  const channel = channels['frasier-dm'] || channels['general'];
  if (!channel) return;

  for (const hire of pendingHires) {
    const msg = `**Hiring Proposal #${hire.id}**\n` +
      `Role: ${hire.role}\n` +
      `Team: ${hire.team_id}\n` +
      `Reason: ${hire.justification || 'Team needs this role'}\n\n` +
      `Reply \`!hire ${hire.id}\` to approve or \`!reject ${hire.id}\` to reject.`;

    await sendSplit(channel, msg);
    await agents.markHiringProposalAnnounced(hire.id);
  }
}

/**
 * Announce critical alerts.
 */
async function announceAlerts() {
  const unprocessedErrors = await events.getUnprocessedEvents('worker_error');
  const tier3Requests = await events.getUnprocessedEvents('tier3_escalation_needed');

  const alertChannel = channels['alerts'] || channels['frasier-dm'] || channels['general'];
  if (!alertChannel) return;

  // Post error alerts
  for (const evt of unprocessedErrors.slice(0, 3)) {
    await sendSplit(alertChannel, `⚠ **Error:** ${evt.description}`);
    await events.markProcessed([evt.id]);
  }

  // Post Tier 3 escalation requests
  for (const evt of tier3Requests) {
    await sendSplit(alertChannel,
      `🔴 **Tier 3 Escalation Request**\n${evt.description}\n\nReply \`!approve ${evt.data?.stepId}\` to authorize Claude Opus 4.5.`
    );
    await events.markProcessed([evt.id]);
  }

  // Post agent upskill notifications
  const upskillEvents = await events.getUnprocessedEvents('agent_upskilled');
  const updatesChannel = channels['updates'] || channels['general'];
  for (const evt of upskillEvents) {
    const ch = updatesChannel || alertChannel;
    if (!ch) continue;
    await sendSplit(ch,
      `📈 **Agent Upskilled** — ${evt.description}\nSkill gap: ${evt.data?.skillGap || 'unknown'}\nThe agent's persona has been permanently upgraded. Retrying the task.`
    );
    await events.markProcessed([evt.id]);
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Find Frasier agent in the database.
 */
async function findFrasier() {
  const supabase = require('./lib/supabase');
  const { data } = await supabase
    .from('agents')
    .select('*')
    .eq('agent_type', 'chief_of_staff')
    .eq('status', 'active')
    .limit(1)
    .single();

  return data || null;
}

/**
 * Map team IDs to Discord channel names.
 */
function getTeamChannel(teamId) {
  const map = {
    'team-research': 'team-research',
    'team-execution': 'team-execution',
    'team-advisory': 'team-advisory'
  };
  return map[teamId] || 'general';
}

/**
 * Send a message to a channel, splitting if over 2000 chars.
 * WHY: Discord has a 2000-char limit. Never silently truncate.
 */
async function sendSplit(channel, text) {
  if (!channel || !text) return;

  const MAX_LEN = 1900; // Leave buffer
  if (text.length <= MAX_LEN) {
    await channel.send(text);
    return;
  }

  // Split on newlines or at max length
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitIdx === -1 || splitIdx < MAX_LEN / 2) {
      splitIdx = MAX_LEN; // Hard split
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

/**
 * Extract real conversation topics from message content.
 * WHY: Generic tags like 'founder-interaction' don't help retrieval when Zero says
 * "remember our Super Bowl conversation?" — we need 'super-bowl', 'football', 'nfl'
 * as tags so topic-based retrieval pulls the right memories 6 days later.
 *
 * Two strategies:
 * 1. Keyword matching against known topic categories
 * 2. N-gram extraction: pull 2-3 word phrases as topic slugs
 *
 * This lets casual conversation topics ("Super Bowl", "that restaurant", "crypto prices")
 * become durable retrieval keys.
 */
function extractConversationTopics(content) {
  const lower = content.toLowerCase();
  const topics = [];

  // Strategy 1: Known topic categories (expandable)
  const topicKeywords = {
    'football': ['football', 'nfl', 'super bowl', 'superbowl', 'touchdown', 'quarterback', 'halftime'],
    'basketball': ['basketball', 'nba', 'lakers', 'celtics', 'playoffs', 'march madness'],
    'sports': ['game', 'score', 'team', 'player', 'season', 'championship', 'finals'],
    'crypto': ['crypto', 'bitcoin', 'ethereum', 'eth', 'btc', 'token', 'blockchain', 'defi'],
    'markets': ['market', 'stocks', 'trading', 'portfolio', 'investment', 'sp500', 'nasdaq'],
    'ai': ['ai', 'artificial intelligence', 'llm', 'gpt', 'claude', 'machine learning'],
    'business': ['revenue', 'profit', 'startup', 'company', 'client', 'customer', 'sales'],
    'tech': ['software', 'app', 'code', 'api', 'deploy', 'server', 'database'],
    'food': ['restaurant', 'food', 'dinner', 'lunch', 'cooking', 'recipe'],
    'travel': ['travel', 'trip', 'flight', 'hotel', 'vacation', 'city'],
    'movies': ['movie', 'film', 'netflix', 'show', 'series', 'watch', 'actor'],
    'music': ['music', 'song', 'album', 'concert', 'artist', 'playlist'],
    'politics': ['election', 'president', 'congress', 'vote', 'policy', 'government'],
    'health': ['health', 'workout', 'gym', 'diet', 'sleep', 'running']
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      topics.push(topic);
    }
  }

  // Strategy 2: Extract notable noun phrases as slug tags.
  // Pull capitalized multi-word phrases (proper nouns) and common bigrams.
  // "Super Bowl" → 'super-bowl', "Patrick Mahomes" → 'patrick-mahomes'
  const properNouns = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];
  for (const phrase of properNouns.slice(0, 5)) {
    const slug = phrase.toLowerCase().replace(/\s+/g, '-');
    if (slug.length >= 3 && slug.length <= 30 && !topics.includes(slug)) {
      topics.push(slug);
    }
  }

  // Always include a general founder tag for baseline retrieval
  if (topics.length === 0) {
    topics.push('casual-chat');
  }

  return topics;
}

/**
 * Detect if a founder message contains a directive, preference, or strategic instruction
 * that should be saved as a permanent lesson.
 * Simple keyword heuristic — errs on the side of saving (better to remember too much
 * than to forget a critical instruction).
 */
function detectFounderDirective(content) {
  const lower = content.toLowerCase();

  // Direct instructions
  const directiveSignals = [
    'always ', 'never ', 'from now on', 'going forward', 'remember that',
    'make sure', 'don\'t forget', 'priority is', 'focus on', 'target is',
    'our goal', 'our target', 'we need to', 'i want', 'i need',
    'stop doing', 'start doing', 'change the', 'update the',
    'the budget is', 'the deadline is', 'the client', 'the customer',
    'important:', 'note:', 'fyi:', 'heads up'
  ];

  for (const signal of directiveSignals) {
    if (lower.includes(signal)) return true;
  }

  // Long messages (>100 chars) that aren't questions are likely strategic context
  if (content.length > 100 && !content.trim().endsWith('?')) return true;

  return false;
}

// ============================================================
// STARTUP
// ============================================================

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[discord] Missing DISCORD_BOT_TOKEN in .env');
  console.log('[discord] The bot will not start. Set the token and restart.');
  process.exit(1);
}

client.login(token).catch(err => {
  console.error('[discord] Failed to login:', err.message);
  process.exit(1);
});
