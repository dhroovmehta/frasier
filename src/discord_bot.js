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

  const promptData = await memory.buildAgentPrompt(frasierAgent.id, ['founder-request', 'delegation']);
  if (promptData.error) {
    await message.reply(`Error loading Frasier: ${promptData.error}`);
    return;
  }

  // Add context about what Frasier should do
  const frasierInstructions = `Zero (the founder) just sent you this message via Discord:

"${content}"

As Chief of Staff, determine the appropriate action:
1. If this is a task or request → acknowledge it, state which team/agent you'll route it to, and what the expected deliverable is
2. If this is a question → answer it directly from your knowledge and memory
3. If this requires approval → explain what needs approval and why

Always be concise, professional, and action-oriented. Reference relevant context from your memory.

IMPORTANT: End your response with one of these tags so the system knows what to do:
[ACTION:PROPOSAL] — if this should become a mission
[ACTION:RESPONSE] — if this is just a conversation reply
[ACTION:APPROVAL_NEEDED] — if you need Zero's approval for something`;

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

  const response = result.content;

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

  // Save to Frasier's memory
  await memory.saveMemory({
    agentId: frasierAgent.id,
    memoryType: 'conversation',
    content: `Zero said: "${content}"\n\nI responded: "${response.substring(0, 300)}"`,
    summary: `Conversation with Zero: ${content.substring(0, 100)}`,
    topicTags: ['founder-interaction', 'discord'],
    importance: 7,
    sourceType: 'conversation'
  });

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
