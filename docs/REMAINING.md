# Frasier — Remaining Features

> Last updated: Feb 17, 2026
> Priority: ranked by impact on "agents feel alive" goal
>
> **Note (Feb 17):** The System Overhaul fixed 4 critical failures that were NOT previously listed here:
> roster injection, context enrichment + persona-as-rubric, project lifecycle, smart routing + gap-fill hiring.
> See `COMPLETED.md` for full details. The items below remain outstanding.

---

## Priority 1: Agent Social Dynamics (Backend)

### 1. Conversation Scheduling (10-15/day)
- **Impact:** HIGH — agents only talk once/day at standup. The org feels dead without regular conversations.
- **What exists:** Daily standup at 9am ET. Structured conversation framework (handoff, review, delegation, brainstorm).
- **What's needed:**
  - Heartbeat schedules 10-15 conversations per day based on triggers + randomness
  - Types to schedule: debate (agents argue positions), brainstorm (team ideation), mentoring (senior → junior), watercooler (casual)
  - Time-based triggers: morning standup, midday brainstorm, afternoon check-in
  - Event-based triggers: new mission → debate approach, step completed → handoff, rejection → mentoring
  - Random trigger: 2-3 watercooler chats per day between random agent pairs
- **Files to modify:** `heartbeat.js` (scheduling), `src/lib/conversations.js` (new prompts)
- **Estimate:** Medium build

### 2. Affinity Matrix (Agent Relationships)
- **Impact:** HIGH — blocks watercooler conversations and agent dynamics. Agents can't form meaningful relationships.
- **What exists:** Nothing. Zero implementation.
- **What's needed:**
  - New `agent_affinity` table: agent_a_id, agent_b_id, score (float -1 to 1), interaction_count, last_interaction
  - Score increases on: successful collaboration, positive review, shared mission completion
  - Score decreases on: rejection of each other's work, conflicting decisions
  - Affinity checked before scheduling watercooler (high affinity → more likely)
  - Affinity displayed in `!roster` or `!relationships` command
- **Files to create:** `src/lib/affinity.js`
- **Files to modify:** `worker.js` (update affinity on review), `heartbeat.js` (use affinity for scheduling), `discord_bot.js` (display command)
- **DB migration:** New `agent_affinity` table
- **Estimate:** Medium build

### 3. Watercooler Conversations
- **Impact:** MEDIUM — makes agents feel like real people, not just task executors
- **Depends on:** Affinity matrix (#2), Conversation scheduling (#1)
- **What's needed:**
  - 2-3 random casual conversations per day
  - High-affinity pairs more likely to chat
  - Topics: recent work, shared interests, opinions on company direction
  - Watercooler prompt builder in conversations.js
  - Results saved to conversation_history + agent memories
- **Files to modify:** `heartbeat.js`, `src/lib/conversations.js`
- **Estimate:** Small build (once affinity + scheduling exist)

---

## Priority 2: Quick Wins (Backend)

### 4. Standup Publishing to Notion/Drive
- **Impact:** MEDIUM — standup transcripts already exist in DB, just need to be pushed
- **What exists:** Standups run daily. Notion + Drive integrations exist for deliverables.
- **What's needed:**
  - After all agents complete standup, aggregate responses into one transcript
  - Push to Notion page (new "Standup Notes" database or page)
  - Push to Google Drive as dated document
- **Files to modify:** `heartbeat.js` (after standup completion), `src/lib/notion.js` (new function), `src/lib/google_drive.js` (new function)
- **Estimate:** Small build

### 5. Missing Founder Commands
- **Impact:** LOW-MEDIUM — convenience for Zero
- **Commands needed:**
  - `!standup` — View today's standup transcript
  - `!memory <agent>` — Inspect an agent's recent memories + lessons
  - `!policy` — View current policy rules
  - `!reassign <agent> <team>` — Move agent between teams
- **Files to modify:** `discord_bot.js`
- **Estimate:** Small build

### 6. Policy Engine Integration
- **Impact:** LOW — framework exists, just not widely used
- **What exists:** Policy table, authorization functions, Tier 3 check works. Auto tier selection (Feb 17 overhaul) now ensures research/strategy/final steps use tier2 automatically.
- **What's still needed:**
  - Agents check policy before executing actions that have cost implications
  - Spending limits enforced at task assignment time (not just Tier 3)
  - Policy violations logged as events
- **Files to modify:** `worker.js` (add policy check before LLM call), `heartbeat.js` (check policy at mission creation)
- **Estimate:** Small build

---

## Priority 3: Agent Personality (Backend)

### 7. Speaking Style Drift
- **Impact:** MEDIUM — makes agents feel distinct over time, not just at creation
- **What exists:** Nothing.
- **What's needed:**
  - Track "style tokens" per agent: formal/casual, technical/simple, verbose/concise, emoji usage, etc.
  - Tokens accumulate based on task types: writing tweets → more casual tokens, writing reports → more formal
  - Style profile injected into system prompt: "Your communication tends to be [casual/formal], [concise/detailed]..."
  - Drift is gradual — 50+ tasks to meaningfully shift style
- **Files to create:** `src/lib/style.js`
- **Files to modify:** `src/lib/memory.js` (inject style into prompt), `worker.js` (update style after task)
- **Estimate:** Medium build

### 8. Debate Conversations
- **Impact:** LOW-MEDIUM — agents arguing positions makes the org feel intellectually alive
- **What's needed:**
  - Debate prompt builder: two agents take opposing positions on a topic
  - Topics from: mission planning, strategy decisions, tool choices
  - Multi-turn (3-5 turns each), saved to conversation_history
  - Outcome can influence mission direction
- **Files to modify:** `src/lib/conversations.js`, `heartbeat.js`
- **Estimate:** Small build

### 9. Mentoring Conversations
- **Impact:** LOW-MEDIUM — senior agents teaching junior ones
- **What's needed:**
  - Triggered when an agent struggles (2+ rejections on a step)
  - Team Lead or experienced agent mentors the struggling agent
  - Mentoring content saved as lessons for the mentee
- **Files to modify:** `src/lib/conversations.js`, `heartbeat.js` or `worker.js`
- **Estimate:** Small build

---

## Priority 4: Frontend (Large Build)

### 10. Pixel-Art Frontend (Next.js)
- **Impact:** HIGH visually, but backend must be solid first
- **What exists:** Nothing. No frontend app at all.
- **What's needed:**
  - Next.js 14+ app with TypeScript + TailwindCSS
  - Pixel-art office environment (HTML5 Canvas or CSS pixel grid)
  - Agent sprites at desk positions
  - Activity indicators: typing animation when working, speech bubbles for conversations
  - Dashboard panels: active missions, recent outputs, agent status, conversation feed
  - Supabase real-time subscriptions for live updates
- **Files to create:** Entire `frontend/` directory
- **Dependencies:** next, react, tailwindcss, @supabase/supabase-js
- **Estimate:** Large build (multi-session)

### 11. Supabase Real-Time Subscriptions
- **Depends on:** Pixel-art frontend (#10)
- **What's needed:**
  - Subscribe to: mission_steps (status changes), conversation_history (new messages), events (alerts)
  - Live feed of agent activity
  - Real-time agent status (idle, working, in_review, chatting)
- **Estimate:** Part of frontend build

### 12. Agent Sprites & Office Layout
- **Depends on:** Pixel-art frontend (#10)
- **What's needed:**
  - Desk positions for each agent (x, y coordinates)
  - Pixel-art sprites per agent (could be generated or hand-drawn)
  - Status-based animations: idle, typing, speaking, reviewing
  - Office background with desks, computers, meeting room
- **Estimate:** Part of frontend build

### 13. Dashboard Panels
- **Depends on:** Pixel-art frontend (#10)
- **What's needed:**
  - Active missions panel (real-time)
  - Recent outputs panel (latest deliverables)
  - Agent status cards (what each agent is doing right now)
  - Conversation feed (live chat bubbles)
  - Cost tracker (today's spend)
- **Estimate:** Part of frontend build

---

## Priority 5: Polish & Scaling

### 14. Multi-Business Support (Runtime)
- **Impact:** LOW for now — only one business (NERV)
- **What exists:** `businesses` table, `!newbiz` command, `createBusiness()` function
- **What's needed:**
  - Proposals routed to correct business based on context
  - Teams scoped to businesses
  - Costs tracked per business
  - Dashboard filtered by business
- **Estimate:** Medium build (when needed)

### 15. Agent-to-Agent Ad-Hoc Messaging
- **Impact:** LOW — structured conversations cover most cases
- **What's needed:**
  - Agents can send messages to each other outside of scheduled conversations
  - Message triggers: need help, FYI, question about shared work
  - Stored in conversation_history with type 'direct_message'
- **Estimate:** Small build

---

## Build Order Recommendation

> System Overhaul (Feb 17) is complete. The following phases are for remaining work.

**Next — Make agents social:**
1. Conversation scheduling (10-15/day)
2. Affinity matrix
3. Watercooler conversations

**Then — Quick wins:**
4. Standup publishing
5. Missing founder commands

**Then — Agent personality:**
6. Speaking style drift
7. Debate + mentoring conversations

**Then — Frontend (multi-session):**
8. Next.js pixel-art office
9. Real-time subscriptions
10. Dashboard panels

**Finally — Polish:**
11. Policy integration
12. Multi-business runtime
13. Ad-hoc messaging
