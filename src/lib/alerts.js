// alerts.js — Dual-channel alert dispatcher (Discord + Email)
// WHY: Zero needs to know when things break, costs spike, or the system needs attention.
// Every alert goes to BOTH Discord (#alerts) and email (drew@epyon.capital).
// Email fails silently — Discord is the primary channel, email is the safety net.
//
// CRITICAL: nodemailer is loaded with try/catch so a missing dependency never
// crashes the entire process. Learned the hard way — a missing nodemailer took
// down discord_bot + heartbeat simultaneously, killing all monitoring.

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (err) {
  console.warn('[alerts] nodemailer not installed — email alerts disabled. Run: npm install nodemailer');
}

// Discord channels map — injected by discord_bot.js on startup
let discordChannels = null;

// Gmail SMTP transporter — created lazily on first use
let transporter = null;

// ============================================================
// DISCORD CHANNEL INJECTION
// ============================================================

/**
 * Called once by discord_bot.js when the bot is ready.
 * Shares the channel map so alerts.js can post without importing discord.js.
 */
function setDiscordChannels(channels) {
  discordChannels = channels;
  console.log('[alerts] Discord channels connected');
}

// ============================================================
// CORE DISPATCHER
// ============================================================

/**
 * Send an alert to both Discord and email.
 * Discord posting happens inline. Email is fire-and-forget.
 *
 * @param {Object} params
 * @param {string} params.subject - Alert title (used as email subject + Discord header)
 * @param {string} params.body - Alert body (plain text)
 * @param {string} [params.severity] - info | warning | error | critical
 * @param {string} [params.channel] - Discord channel name (default: 'alerts')
 */
async function sendAlert({ subject, body, severity = 'info', channel = 'alerts' }) {
  const severityEmoji = {
    info: 'ℹ️',
    warning: '⚠️',
    error: '🔴',
    critical: '🚨'
  };

  const emoji = severityEmoji[severity] || 'ℹ️';
  const discordMessage = `${emoji} **${subject}**\n${body}`;

  // Post to Discord (sync — this is the primary channel)
  await postToDiscord(channel, discordMessage);

  // Send email (async, fire-and-forget)
  const alertEmail = process.env.ALERT_EMAIL;
  if (alertEmail) {
    sendEmail({
      to: alertEmail,
      subject: `[VoxYZ ${severity.toUpperCase()}] ${subject}`,
      body
    }).catch(err => {
      console.error(`[alerts] Email failed (non-blocking): ${err.message}`);
    });
  }
}

// ============================================================
// DISCORD POSTING
// ============================================================

/**
 * Post a message to a Discord channel by name.
 * Falls back through: requested channel → #alerts → #frasier-dm → #general.
 */
async function postToDiscord(channelName, message) {
  if (!discordChannels) {
    console.log(`[alerts] Discord not connected yet. Alert queued to console: ${message.substring(0, 100)}`);
    return;
  }

  const channel = discordChannels[channelName]
    || discordChannels['alerts']
    || discordChannels['frasier-dm']
    || discordChannels['general'];

  if (!channel) {
    console.error('[alerts] No Discord channel available for alerts');
    return;
  }

  try {
    await sendSplit(channel, message);
  } catch (err) {
    console.error(`[alerts] Discord post failed: ${err.message}`);
  }
}

// ============================================================
// EMAIL (Gmail SMTP via Nodemailer)
// ============================================================

/**
 * Send an email via Gmail SMTP.
 * Fails silently — never blocks the system.
 *
 * Requires GMAIL_USER and GMAIL_APP_PASSWORD in .env.
 * GMAIL_APP_PASSWORD is a 16-char app password from Google, NOT the account password.
 */
async function sendEmail({ to, subject, body }) {
  if (!nodemailer) {
    // nodemailer not installed — skip silently
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    // Email not configured — skip silently
    return;
  }

  // Lazy init transporter
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPass
      }
    });
  }

  await transporter.sendMail({
    from: `"VoxYZ Agent World" <${gmailUser}>`,
    to,
    subject,
    text: body
  });

  console.log(`[alerts] Email sent to ${to}: ${subject}`);
}

// ============================================================
// DAILY SUMMARY FORMATTER
// ============================================================

/**
 * Build a formatted daily summary for Discord and email.
 *
 * @param {Object} params
 * @param {Object} params.costs - From models.getModelCosts()
 * @param {Array} params.errors - Error events from yesterday
 * @param {Object} params.healthStatus - From health.runAllHealthChecks()
 * @param {number} params.agentCount - Active agents
 * @param {Object} params.eventSummary - From events.getEventSummary()
 * @returns {string} Formatted summary
 */
function formatDailySummary({ costs, errors, healthStatus, agentCount, eventSummary }) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const lines = [`VoxYZ Daily Summary — ${date}`, ''];

  // Costs
  lines.push('COSTS');
  if (costs) {
    lines.push(`  Tier 1 (MiniMax): ${costs.tier1.calls} calls, $${costs.tier1.cost.toFixed(4)}`);
    lines.push(`  Tier 2 (Manus):   ${costs.tier2.calls} calls`);
    lines.push(`  Tier 3 (Claude):  ${costs.tier3.calls} calls, $${costs.tier3.cost.toFixed(4)}`);
    lines.push(`  Total: ${costs.total.calls} calls, $${costs.total.cost.toFixed(4)}, ${costs.total.tokens.toLocaleString()} tokens`);
  } else {
    lines.push('  No cost data available');
  }
  lines.push('');

  // Health
  lines.push('HEALTH');
  if (healthStatus && healthStatus.checks) {
    for (const check of healthStatus.checks) {
      const status = check.status === 'pass' ? 'PASS' : check.status === 'warning' ? 'WARN' : 'FAIL';
      const time = check.responseTimeMs ? ` (${check.responseTimeMs}ms)` : '';
      lines.push(`  ${check.component.padEnd(14)} ${status}${time}`);
    }
  } else {
    lines.push('  No health data available');
  }
  lines.push('');

  // Activity
  lines.push('ACTIVITY');
  const missionsCompleted = eventSummary?.mission_completed?.total || 0;
  const tasksCompleted = eventSummary?.task_completed?.total || 0;
  const errorCount = errors ? errors.length : 0;
  lines.push(`  Missions completed: ${missionsCompleted}`);
  lines.push(`  Tasks completed:    ${tasksCompleted}`);
  lines.push(`  Errors:             ${errorCount}`);
  lines.push(`  Agents active:      ${agentCount}`);

  if (errorCount > 0) {
    lines.push('');
    lines.push('ERRORS');
    for (const err of errors.slice(0, 5)) {
      lines.push(`  - ${err.description || err.event_type}`);
    }
    if (errors.length > 5) {
      lines.push(`  ... and ${errors.length - 5} more`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('VoxYZ Agent World — Automated Report');

  return lines.join('\n');
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Split a message into chunks for Discord's 2000-char limit.
 * Duplicated from discord_bot.js to avoid circular dependency.
 */
async function sendSplit(channel, text) {
  if (!channel || !text) return;

  const MAX_LEN = 1900;
  if (text.length <= MAX_LEN) {
    await channel.send(text);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      await channel.send(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitIdx === -1 || splitIdx < MAX_LEN / 2) {
      splitIdx = MAX_LEN;
    }

    await channel.send(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }
}

module.exports = {
  setDiscordChannels,
  sendAlert,
  sendEmail,
  postToDiscord,
  formatDailySummary
};
