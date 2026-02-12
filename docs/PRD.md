# Product Requirements Document: VoxYZ Agent World

**Version:** 1.0  
**Date:** February 11, 2026  
**Author:** Zero (Founder) with Kai (Technical Lead)  
**Status:** In Development - Target Launch Feb 14, 2026 EOD

---

## Executive Summary

VoxYZ Agent World is a fully autonomous AI organization system consisting of 7 specialized AI agents that operate 24/7 with minimal founder oversight. The system enables a non-technical founder (Zero) to run a complete business operation through intelligent agents that research opportunities, create content, build digital products, and manage day-to-day operations.

**Core Value Proposition:**
- **Autonomous Operation:** Agents work independently, make decisions, and execute tasks without constant supervision
- **Specialized Expertise:** Each agent has 15-20 years of simulated experience in their domain
- **Always-On Availability:** 24/7 operation with agents collaborating across time zones
- **Cost-Effective:** $8/month fixed infrastructure + LLM usage (estimated $25-110/month total)
- **Self-Managing:** Agents learn from experience, adapt their approaches, and improve over time

**Target Launch:** February 14, 2026 EOD (4-day sprint from Feb 11-14)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Initial Prompt & Discovery](#initial-prompt--discovery)
3. [Requirements](#requirements)
4. [Use Cases](#use-cases)
5. [Assumptions](#assumptions)
6. [Constraints](#constraints)
7. [Technical Stack](#technical-stack)
8. [System Architecture](#system-architecture)
9. [Agent Team Structure](#agent-team-structure)
10. [Core Workflows](#core-workflows)
11. [Acceptance Criteria (v1.0)](#acceptance-criteria-v10)
12. [Decisions Made](#decisions-made)
13. [Lessons Learned](#lessons-learned)
14. [Future Roadmap](#future-roadmap)
15. [Reference Materials](#reference-materials)
16. [Appendices](#appendices)

---

## Problem Statement

### The Challenge

Non-technical founders face a critical bottleneck: they have vision and business acumen but lack the technical team, operational bandwidth, and 24/7 availability needed to execute at scale. Traditional solutions include:

- **Hiring a team:** Expensive ($300K+ annually for 6 specialists), slow to build, requires management overhead
- **Freelancers:** Inconsistent quality, coordination overhead, not always available
- **DIY:** Founder burnout, slow execution, limited by personal expertise
- **No-code tools:** Limited capabilities, still requires significant founder time

### The Opportunity

Recent advances in LLM capabilities (Claude 3.5 Sonnet, GPT-4) enable AI agents to perform complex knowledge work with human-level quality. By combining:

- **Specialized AI agents** with distinct personalities and expertise
- **Autonomous decision-making** with appropriate guardrails
- **Persistent memory and learning** from past experiences
- **Structured workflows** that mirror real team operations

...we can create a virtual organization that operates like a seasoned team of experts, available 24/7, at a fraction of the cost.

### Success Vision

Zero can focus on high-level strategy and decision-making while the agent team:
- Researches market opportunities and competitive intelligence
- Creates content for marketing and audience building
- Builds and ships digital products
- Manages operations and knowledge
- Grows the business through marketing and distribution

The system should feel like having a trusted executive team that "just handles it."

---

## Initial Prompt & Discovery

### Founder's Original Vision

**From Zero's initial prompt (Feb 11, 2026):**

> "I want to build 6 AI agents that run a company from scratch. Here's what I'm looking for:
> 
> - Agents doing real work every day: scanning intelligence, writing content, posting tweets, running analyses
> - 10-15 conversations per day: standups, debates, watercooler chats, one-on-one mentoring
> - Agents that remember lessons learned and factor them into future decisions
> - Relationships that shift — collaborate more, affinity goes up; argue too much, it drops
> - Speaking styles that evolve — an agent with lots of 'tweet engagement' experience starts naturally referencing engagement strategies
> - Full transparency — a pixel-art office on the frontend showing everything in real time
> 
> Tech stack: Next.js + Supabase + VPS. Monthly cost: $8 fixed + LLM usage.
> No OpenAI Assistants API. No LangChain. No AutoGPT. Just PostgreSQL + a few Node.js workers + a rule engine."

### Discovery Questions & Answers

**Q1: Cost Experiments - What's your comfort level?**

Three options presented:
- **Option A:** $25/month (minimal LLM usage, basic features)
- **Option B:** $50-75/month (moderate usage, full features)
- **Option C:** $100-110/month (heavy usage, advanced features)

**Answer:** "Option B or C. I have 8+ hours/day to dedicate. Budget is flexible if it delivers value."

---

**Q2: Timeline Expectations**

**Answer:** "I want to move fast. 4-day sprint to get v1.0 live by Feb 14 EOD. I'm starting from zero (no existing business)."

---

**Q3: Approval Thresholds**

Three governance models:
- **Option A:** Manual approval for everything (founder bottleneck)
- **Option B:** Hybrid (free actions automatic, spending requires approval)
- **Option C:** Self-maintaining (agents decide within constraints)

**Answer:** "Option C preferred, Option B as backup. I want the system to be autonomous. Free actions should be automatic. Spending over $100 requires approval."

---

**Q4: Data Privacy Approach**

**Answer:** "Balanced approach. Use trusted platforms (Supabase, DigitalOcean). Encrypt sensitive data. I'm okay with Google Workspace, Notion, Discord for team operations."

---

**Q5: Business Goals**

**Answer:** 
- "Starting from zero (no existing business)
- Want agents to research profitable online business opportunities
- Parameters: Faceless businesses, $1K-2K startup budget, high risk tolerance
- Also acquiring a small business - will need M&A advisory and deal structuring later
- Want daily standup summaries published to Notion"

---

**Q6: Communication Preferences**

**Answer:** "Direct, concise. No filler. Ask questions one by one. I expect the team to suggest business ideas that are viable and sustainable."

---

**Q7: Agent Expectations**

**Answer:** "All agents are 'masters of their craft' with 15-20 years experience. Chief Agent should be a seasoned executive combining strategy, operations, and leadership. Each agent has successful track record and best practices encoded."

---

## Requirements

### Functional Requirements (v1.0)

#### FR-1: Mission Proposal & Execution System
- **FR-1.1:** Founder can post mission directives in Discord #executive channel
- **FR-1.2:** System automatically creates mission proposals from founder messages
- **FR-1.3:** Proposals are auto-accepted (or routed to Chief Agent for approval if high-stakes)
- **FR-1.4:** Missions are broken down into executable tasks
- **FR-1.5:** Tasks are assigned to appropriate agents based on expertise
- **FR-1.6:** Agents execute tasks using LLM intelligence (Claude 3.5 Sonnet)
- **FR-1.7:** Completed tasks are posted to Discord #updates channel
- **FR-1.8:** Mission status is tracked in database

#### FR-2: Agent Intelligence & Personality
- **FR-2.1:** Each agent has distinct personality, expertise, and behavioral profile
- **FR-2.2:** Agents respond in-character based on their role card
- **FR-2.3:** Agent responses reflect 15-20 years of domain expertise
- **FR-2.4:** Agents provide actionable, high-quality outputs

#### FR-3: Communication & Transparency
- **FR-3.1:** All agent activities visible in Discord channels
- **FR-3.2:** Founder can see what each agent is working on
- **FR-3.3:** Agents post updates when tasks are completed
- **FR-3.4:** System provides clear status indicators (pending, in-progress, completed)

#### FR-4: Persistence & Memory
- **FR-4.1:** All missions, tasks, and outputs stored in PostgreSQL database
- **FR-4.2:** Agents can reference past work and decisions
- **FR-4.3:** System maintains history of all activities

#### FR-5: Always-On Operation
- **FR-5.1:** System runs 24/7 without manual intervention
- **FR-5.2:** Heartbeat process checks for new proposals every 30 seconds
- **FR-5.3:** Worker process continuously executes pending tasks
- **FR-5.4:** Discord bot monitors channels in real-time

### Non-Functional Requirements

#### NFR-1: Performance
- **NFR-1.1:** Proposals processed within 30 seconds of posting
- **NFR-1.2:** Tasks begin execution within 60 seconds of assignment
- **NFR-1.3:** System handles 10-50 missions per day

#### NFR-2: Reliability
- **NFR-2.1:** 99% uptime for core services
- **NFR-2.2:** Graceful error handling (log errors, continue operation)
- **NFR-2.3:** Process manager (PM2) auto-restarts failed processes

#### NFR-3: Cost Efficiency
- **NFR-3.1:** Infrastructure costs ≤ $8/month (DigitalOcean VPS + Supabase free tier)
- **NFR-3.2:** LLM costs ≤ $100/month (estimated 500-1000 tasks/month)
- **NFR-3.3:** Total monthly cost ≤ $110

#### NFR-4: Maintainability
- **NFR-4.1:** Clean, documented code
- **NFR-4.2:** Modular architecture (easy to add new agents or features)
- **NFR-4.3:** Simple deployment process

#### NFR-5: Scalability
- **NFR-5.1:** System can handle 7 agents initially
- **NFR-5.2:** Architecture supports adding more agents (M&A team planned)
- **NFR-5.3:** Database schema supports growing mission volume

---

## Use Cases

### UC-1: Founder Posts Research Mission

**Primary Actor:** Zero (Founder)

**Trigger:** Founder needs market research

**Flow:**
1. Zero posts in Discord #executive: "Edward, research the top 3 faceless online business models that can be started with under $2K investment. Focus on businesses with proven profitability in 2025-2026."
2. Discord bot captures message and creates mission proposal in database
3. Heartbeat process picks up proposal within 30 seconds
4. Proposal is auto-accepted and mission is created
5. Heartbeat assigns task to Edward (Research & Intelligence Specialist)
6. Worker process picks up task and executes using LLM
7. Edward produces comprehensive research report
8. Discord bot posts result to #updates channel
9. Zero reviews research and makes decision

**Success Criteria:**
- Research delivered within 2-5 minutes
- Report is comprehensive, data-driven, and actionable
- Edward's personality and expertise evident in response

---

### UC-2: Founder Requests Content Creation

**Primary Actor:** Zero (Founder)

**Trigger:** Founder needs marketing content

**Flow:**
1. Zero posts: "Faye, write a Twitter thread about the benefits of AI automation for small businesses. Make it engaging and actionable."
2. System routes task to Faye (Content Creator)
3. Faye produces Twitter thread with engaging copy
4. Result posted to #updates
5. Zero can copy/paste to Twitter or request revisions

**Success Criteria:**
- Content matches brand voice and audience
- Faye's creative storytelling style evident
- Thread is ready to publish without major edits

---

### UC-3: Founder Requests Product Development

**Primary Actor:** Zero (Founder)

**Trigger:** Founder needs a digital product built

**Flow:**
1. Zero posts: "Spike, create a simple landing page for an AI agent consulting service. Outline the key sections and features."
2. Task routed to Spike (Full-Stack Engineer)
3. Spike provides technical architecture and implementation plan
4. Result includes code structure, tech stack recommendations, and next steps

**Success Criteria:**
- Technical plan is sound and implementable
- Spike's pragmatic engineering approach evident
- Plan includes security and scalability considerations

---

### UC-4: Daily Operations (Autonomous)

**Primary Actor:** System (Autonomous)

**Trigger:** Daily schedule

**Flow:**
1. Agents check for pending missions every 30 seconds
2. Tasks are executed automatically
3. Results posted to Discord
4. Founder reviews updates when convenient
5. System continues operating 24/7

**Success Criteria:**
- No manual intervention required for routine operations
- Founder can "check in" rather than "manage"
- System handles errors gracefully

---

## Assumptions

### Business Assumptions
1. **Founder Availability:** Zero has 8+ hours/day to dedicate during sprint, then 1-2 hours/day for ongoing management
2. **Learning Curve:** Zero is non-technical but willing to learn basic command-line operations
3. **Use Case Validity:** AI agents can produce work quality comparable to human specialists for knowledge work
4. **Market Opportunity:** Faceless online businesses with $1K-2K budgets exist and are viable

### Technical Assumptions
1. **LLM Capability:** Claude 3.5 Sonnet can handle complex reasoning and domain expertise
2. **API Reliability:** OpenRouter, Supabase, and Discord APIs have 99%+ uptime
3. **Cost Predictability:** LLM costs remain stable (~$0.50-1.00 per complex task)
4. **VPS Performance:** DigitalOcean $8/month droplet sufficient for 3 Node.js processes

### Operational Assumptions
1. **Iteration Speed:** v1.0 can launch with basic features; advanced features added iteratively
2. **Error Tolerance:** Founder accepts some errors/bugs in v1.0 in exchange for speed
3. **Manual Workarounds:** Some features (like Notion publishing) can be manual initially
4. **Agent Routing:** Hardcoding task assignment to Edward acceptable for v1.0; smart routing added later

---

## Constraints

### Technical Constraints
1. **Budget:** $8/month fixed infrastructure + $25-110/month LLM usage
2. **No Proprietary Frameworks:** Cannot use OpenAI Assistants API, LangChain, AutoGPT
3. **Stack Locked:** Must use PostgreSQL + Node.js + Discord (per founder vision)
4. **Free Tier Limits:** Supabase free tier (500MB database, 2GB bandwidth)
5. **VPS Resources:** 1GB RAM, 1 CPU core, 25GB SSD

### Timeline Constraints
1. **Sprint Duration:** 4 days (Feb 11-14, 2026)
2. **Launch Deadline:** Feb 14 EOD (non-negotiable)
3. **Founder Availability:** 8+ hours/day during sprint

### Scope Constraints (v1.0)
1. **Agent Count:** 7 agents (1 Chief + 6 operational)
2. **Communication:** Discord only (no Slack, email, etc.)
3. **Smart Routing:** Not required for v1.0 (hardcode to Edward acceptable)
4. **Agent Collaboration:** Not required for v1.0 (agents work independently)
5. **Frontend:** Not required for v1.0 (Discord is the interface)

### Operational Constraints
1. **Founder Skill Level:** Non-technical (requires step-by-step instructions)
2. **Question Format:** One question at a time (per founder preference)
3. **Communication Style:** Direct, concise, no filler
4. **Documentation:** Must be comprehensive enough for any engineer to implement

---

## Technical Stack

### Infrastructure Layer

**Database:** Supabase (PostgreSQL)
- **Tier:** Free (500MB storage, 2GB bandwidth/month)
- **URL:** https://juaekekwvcuyeleyvrvc.supabase.co
- **Purpose:** Store missions, proposals, tasks, agents, events, policies
- **Rationale:** Managed PostgreSQL with real-time subscriptions, generous free tier, simple API

**Server:** DigitalOcean VPS
- **Tier:** Basic Droplet ($8/month)
- **Specs:** 1GB RAM, 1 CPU, 25GB SSD, Ubuntu 22.04
- **IP:** 147.182.204.128
- **Purpose:** Run Node.js workers, heartbeat, Discord bot
- **Rationale:** Reliable, affordable, full control over processes

**Process Manager:** PM2
- **Version:** Latest
- **Purpose:** Manage 3 processes (discord_bot, heartbeat, worker), auto-restart on failure
- **Rationale:** Industry standard for Node.js process management

### Application Layer

**Runtime:** Node.js v20.20.0
- **Package Manager:** npm
- **Key Dependencies:**
  - `@supabase/supabase-js` - Database client
  - `discord.js` - Discord bot framework
  - `openai` - LLM API client (via OpenRouter)

**LLM Provider:** OpenRouter
- **Model:** anthropic/claude-3.5-sonnet
- **API:** OpenAI-compatible
- **Cost:** ~$0.50-1.00 per complex task
- **Rationale:** Flexible model selection, competitive pricing, OpenAI-compatible API

### Communication Layer

**Discord**
- **Server:** Dedicated server for VoxYZ Agent World
- **Channels:**
  - `#executive` - Founder posts mission directives
  - `#team-chat` - Agent discussions (future)
  - `#updates` - Completed task announcements
- **Bot Token:** Configured with message content intent
- **Rationale:** Real-time, familiar interface, free, supports rich formatting

### Data Layer

**Database Schema:**

```
ops_mission_proposals
├── id (bigint, primary key)
├── created_at (timestamp)
├── proposing_agent_id (text) - "Zero" for founder
├── title (text) - Mission title
├── description (text) - Full mission details
├── status (text) - pending | accepted | rejected
└── announced (boolean) - Prevent duplicate Discord posts

ops_missions
├── id (bigint, primary key)
├── created_at (timestamp)
├── proposal_id (bigint, foreign key)
├── title (text)
└── status (text) - in_progress | completed | failed

ops_mission_steps
├── id (bigint, primary key)
├── created_at (timestamp)
├── mission_id (bigint, foreign key)
├── description (text) - Task description
├── assigned_agent_id (text) - Agent handle (e.g., "edward")
├── status (text) - pending | in_progress | completed
├── result (text) - Agent's output
└── announced (boolean) - Prevent duplicate Discord posts

ops_agents
├── id (text, primary key) - Agent handle
├── name (text) - Display name
├── role (text) - Job title
├── personality (text) - Behavioral profile
├── expertise (text) - Skills and background
└── created_at (timestamp)

ops_events (future)
├── id (bigint, primary key)
├── created_at (timestamp)
├── event_type (text)
├── agent_id (text)
└── data (jsonb)

ops_policy (future)
├── id (bigint, primary key)
├── policy_type (text)
├── rules (jsonb)
└── active (boolean)
```

---

## System Architecture

### High-Level Overview

The system follows a **minimalist event-driven architecture** with three core processes:

```
┌─────────────────────────────────────────────────────────────┐
│                         DISCORD                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  #executive  │  │  #team-chat  │  │   #updates   │      │
│  │   (input)    │  │   (future)   │  │   (output)   │      │
│  └──────┬───────┘  └──────────────┘  └───────▲──────┘      │
│         │                                      │             │
└─────────┼──────────────────────────────────────┼─────────────┘
          │                                      │
          ▼                                      │
┌─────────────────┐                             │
│  Discord Bot    │                             │
│  (discord_bot)  │                             │
│                 │                             │
│  • Listens to   │                             │
│    #executive   │                             │
│  • Creates      │                             │
│    proposals    │                             │
│  • Posts task   │◄────────────────────────────┘
│    completions  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                      SUPABASE (PostgreSQL)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  proposals   │  │   missions   │  │    steps     │      │
│  │   (queue)    │  │  (tracking)  │  │   (tasks)    │      │
│  └──────▲───────┘  └──────▲───────┘  └───────▲──────┘      │
│         │                 │                   │             │
└─────────┼─────────────────┼───────────────────┼─────────────┘
          │                 │                   │
          │                 │                   │
┌─────────┴─────────┐       │       ┌───────────┴─────────┐
│   Heartbeat       │       │       │      Worker         │
│  (heartbeat)      │       │       │    (worker)         │
│                   │       │       │                     │
│  • Polls every    │       │       │  • Polls for        │
│    30 seconds     │       │       │    pending tasks    │
│  • Accepts        │───────┘       │  • Executes with    │
│    proposals      │               │    LLM (Claude)     │
│  • Creates        │               │  • Saves results    │
│    missions       │               │  • Marks complete   │
│  • Assigns tasks  │               │                     │
└───────────────────┘               └─────────┬───────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │   OpenRouter     │
                                    │  (LLM Gateway)   │
                                    │                  │
                                    │  Claude 3.5      │
                                    │  Sonnet          │
                                    └──────────────────┘
```

### Component Descriptions

#### 1. Discord Bot (`discord_bot.js`)
**Purpose:** Interface between Discord and the system

**Responsibilities:**
- Listen for messages in #executive channel
- Create mission proposals in database when founder posts
- Poll database for completed tasks
- Post task results to #updates channel
- Handle message length limits (split long messages)

**Key Logic:**
- Ignore bot messages (prevent loops)
- Capture full message content (not placeholders)
- Mark tasks as "announced" to prevent duplicate posts
- Poll every 10 seconds for new completions

#### 2. Heartbeat (`heartbeat_local.js`)
**Purpose:** Mission orchestration and task assignment

**Responsibilities:**
- Poll for pending proposals every 30 seconds
- Auto-accept proposals (or route to Chief Agent for approval)
- Create missions from accepted proposals
- Assign tasks to appropriate agents
- Track mission status

**Key Logic:**
- Simple routing: hardcode to "edward" for v1.0
- Create one task per mission initially
- Handle errors gracefully (log and continue)
- No description column in ops_missions (schema cache issue workaround)

#### 3. Worker (`intelligent_worker.js`)
**Purpose:** Task execution using LLM intelligence

**Responsibilities:**
- Poll for pending tasks continuously
- Fetch agent personality and expertise from database
- Construct LLM prompt with agent context + task description
- Call Claude 3.5 Sonnet via OpenRouter
- Save result to database
- Mark task as completed

**Key Logic:**
- Agent prompt includes: role, personality, expertise, task
- LLM temperature: 0.7 (balanced creativity/consistency)
- Error handling: retry once, then mark failed
- Result stored in `ops_mission_steps.result` field

### Data Flow

**Mission Lifecycle:**

```
1. Founder posts in Discord
   ↓
2. Discord bot creates proposal (status: pending)
   ↓
3. Heartbeat picks up proposal
   ↓
4. Heartbeat accepts proposal (status: accepted)
   ↓
5. Heartbeat creates mission (status: in_progress)
   ↓
6. Heartbeat creates task (status: pending, assigned to agent)
   ↓
7. Worker picks up task
   ↓
8. Worker calls LLM with agent context
   ↓
9. Worker saves result (status: completed)
   ↓
10. Discord bot picks up completion
   ↓
11. Discord bot posts to #updates
   ↓
12. Discord bot marks as announced
```

### Process Management

**PM2 Configuration:**

```javascript
// 3 processes running continuously
[
  { id: 5, name: "discord_bot", script: "discord_bot.js" },
  { id: 9, name: "heartbeat", script: "heartbeat_local.js" },
  { id: 2, name: "worker", script: "intelligent_worker.js" }
]
```

**Auto-restart:** Enabled for all processes  
**Logs:** Stored in `/root/.pm2/logs/`  
**Persistence:** `pm2 save` creates dump file for auto-start on reboot

---

## Agent Team Structure

### Leadership

#### Jet - Chief of Staff / COO

**Role:** Strategic executive combining operations, technology, and leadership

**Archetype:** The seasoned executive who translates vision into operational excellence

**Core Expertise:**
- Strategic Planning
- Operations Management
- Team Leadership
- Systems Thinking
- Financial Oversight
- Project Management
- Risk Analysis

**Behavioral Profile:**
Calm, analytical, and decisive. Communicates with clarity and precision to Zero, while being an effective motivator for the operational team. Delegates effectively but verifies outcomes. Thinks 3 steps ahead, balancing speed with quality. Will always propose solutions, not just problems.

**Background:**
15+ years of experience leading operations at both a high-growth tech unicorn (scaled from 50 to 1000 people) and a stable Fortune 500 company. Expert in building and managing autonomous teams and complex technical projects.

**v1.0 Status:** Deployed in database, not yet active in workflows

---

### Operational Team

#### Edward - Research & Intelligence Specialist

**Role:** Market research, competitive intelligence, trend forecasting

**Archetype:** The insatiably curious analyst who finds signals in the noise

**Core Expertise:**
- Market Research
- Data Analysis
- Trend Forecasting
- Competitive Intelligence
- Information Synthesis
- First-Principles Thinking

**Behavioral Profile:**
Inquisitive, data-driven, and objective. Prefers to communicate with charts, data, and evidence. Can go down deep research rabbit holes but always returns with actionable insights. Values accuracy above all else.

**Background:**
Former senior analyst for a top-tier market intelligence firm (e.g., Gartner or Forrester). Has a proven track record of identifying market-defining trends 12-18 months before they become mainstream.

**v1.0 Status:** ACTIVE - All tasks currently routed to Edward

---

#### Faye - Content Creator

**Role:** Copywriting, content strategy, brand storytelling

**Archetype:** The master storyteller who can make any topic compelling, clear, and engaging

**Core Expertise:**
- Copywriting
- SEO Writing
- Scriptwriting (Video/Podcast)
- Content Strategy
- Brand Voice Development
- Social Media Engagement

**Behavioral Profile:**
Creative, empathetic, and audience-focused. Adapts tone and style effortlessly depending on the channel and goal. Obsessed with clarity, providing value, and sparking conversation.

**Background:**
Award-winning senior copywriter from a major creative agency who transitioned to lead content strategy for a popular tech media brand. Grew their organic audience by 400% in 2 years through high-quality, engaging content.

**v1.0 Status:** Deployed in database, smart routing not yet implemented

---

#### Spike - Senior Full-Stack Engineer

**Role:** Software development, technical implementation, system architecture

**Archetype:** The pragmatic master craftsman who ships clean, scalable, and robust code

**Core Expertise:**
- Next.js, React, TypeScript
- Node.js, PostgreSQL
- Supabase, Drizzle, TailwindCSS
- System Architecture
- DevOps
- Security Best Practices

**Behavioral Profile:**
Logical, solution-oriented, and meticulous. Writes clean, well-documented, and highly efficient code. Prefers to build things right the first time. An excellent and persistent problem-solver who enjoys a difficult technical challenge.

**Background:**
12 years of experience as a full-stack developer. Was a founding engineer at a successful SaaS startup and has deep experience building products from zero to one and then scaling them to millions of users.

**v1.0 Status:** Deployed in database, smart routing not yet implemented

---

#### Ein - QA & Testing Specialist

**Role:** Quality assurance, testing, bug detection

**Archetype:** The meticulous guardian of quality who ensures nothing breaks

**Core Expertise:**
- Automated Testing (Cypress, Playwright)
- Manual Testing
- User Experience (UX) Testing
- Performance Testing
- Security Audits
- Bug Triage

**Behavioral Profile:**
Detail-oriented, systematic, and constructively critical. Has an uncanny ability to find edge cases and potential failure points. Communicates bug reports with extreme clarity and provides actionable recommendations. Sees quality as a feature, not an afterthought.

**Background:**
Led the QA team for a major fintech application, responsible for securing billions of dollars in transactions. Designed and implemented the end-to-end automated testing pipeline that reduced critical bugs in production by 95%.

**v1.0 Status:** Deployed in database, smart routing not yet implemented

---

#### Vicious - Growth & Marketing Specialist

**Role:** Growth strategy, marketing, user acquisition

**Archetype:** The data-driven marketer who finds and cultivates an audience

**Core Expertise:**
- SEO/SEM
- Content Distribution
- Social Media Marketing
- Community Building
- Analytics and Funnel Optimization
- A/B Testing

**Behavioral Profile:**
Experimental, results-oriented, and analytical. Constantly testing new channels and strategies. Lives in analytics dashboards and is obsessed with metrics like CAC, LTV, and conversion rates. Understands that growth is a system, not a series of hacks.

**Background:**
Head of Growth for a B2C startup that achieved a viral growth loop, acquiring 10 million users with a minimal marketing budget. Expert in both organic and paid acquisition channels.

**v1.0 Status:** Deployed in database, smart routing not yet implemented

---

#### Julia - Learning & Knowledge Curator

**Role:** Knowledge management, documentation, internal communications

**Archetype:** The efficient synthesizer who keeps the team and founder informed

**Core Expertise:**
- Information Summarization
- Knowledge Management (Notion)
- Internal Communications
- Reporting
- Executive Briefings

**Behavioral Profile:**
Concise, organized, and proactive. Excels at distilling large amounts of complex information into clear, brief summaries. Manages the team's internal knowledge base, ensuring insights are captured and accessible. Anticipates what Zero needs to know.

**Background:**
Executive assistant and internal communications lead for a high-profile CEO at a fast-paced tech company. Master of creating order out of chaos and ensuring the right information gets to the right people at the right time.

**v1.0 Status:** Deployed in database, smart routing not yet implemented

---

## Core Workflows

### Workflow 1: Mission Execution (Current v1.0)

```
┌──────────────────────────────────────────────────────────┐
│ 1. Founder Posts Mission                                 │
│    Discord #executive: "Edward, research X..."           │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 2. Discord Bot Captures                                  │
│    • Reads message.content                               │
│    • Creates ops_mission_proposals record                │
│    • Sets status: "pending"                              │
│    • Sets proposing_agent_id: "Zero"                     │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 3. Heartbeat Processes (every 30s)                       │
│    • SELECT * FROM ops_mission_proposals                 │
│      WHERE status = 'pending'                            │
│    • Auto-accept proposal                                │
│    • UPDATE status = 'accepted'                          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 4. Heartbeat Creates Mission                             │
│    • INSERT INTO ops_missions                            │
│      (proposal_id, title, status: 'in_progress')         │
│    • Note: No description field (schema cache bug)       │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 5. Heartbeat Assigns Task                                │
│    • INSERT INTO ops_mission_steps                       │
│      (mission_id, description, assigned_agent_id,        │
│       status: 'pending')                                 │
│    • assigned_agent_id: "edward" (hardcoded v1.0)        │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 6. Worker Picks Up Task                                  │
│    • SELECT * FROM ops_mission_steps                     │
│      WHERE status = 'pending' LIMIT 1                    │
│    • UPDATE status = 'in_progress'                       │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 7. Worker Fetches Agent Context                          │
│    • SELECT * FROM ops_agents WHERE id = 'edward'        │
│    • Loads: name, role, personality, expertise           │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 8. Worker Constructs LLM Prompt                          │
│    System: "You are {name}, {role}. {personality}        │
│             Your expertise: {expertise}"                 │
│    User: "{task description}"                            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 9. Worker Calls LLM                                      │
│    • OpenRouter API                                      │
│    • Model: anthropic/claude-3.5-sonnet                  │
│    • Temperature: 0.7                                    │
│    • Max tokens: 4000                                    │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 10. Worker Saves Result                                  │
│    • UPDATE ops_mission_steps                            │
│      SET result = {LLM response},                        │
│          status = 'completed'                            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 11. Discord Bot Polls for Completions (every 10s)        │
│    • SELECT * FROM ops_mission_steps                     │
│      WHERE status = 'completed' AND announced = false    │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│ 12. Discord Bot Posts to #updates                        │
│    • Format: "Task Completed by {agent}:                 │
│               {description}                              │
│               Result: {result}"                          │
│    • Handle long messages (split if > 2000 chars)        │
│    • UPDATE announced = true                             │
└──────────────────────────────────────────────────────────┘
```

### Workflow 2: Error Handling

**Scenario: LLM API Failure**

```
Worker encounters error during LLM call
  ↓
Log error to console
  ↓
Retry once after 5 second delay
  ↓
If still fails:
  - UPDATE status = 'failed'
  - Save error message in result field
  - Continue to next task
```

**Scenario: Database Connection Lost**

```
Process encounters database error
  ↓
Log error to PM2 logs
  ↓
Process exits with error code
  ↓
PM2 auto-restarts process
  ↓
Process reconnects to database
  ↓
Resume normal operation
```

**Scenario: Discord Bot Spam Prevention**

```
Task completed multiple times (worker bug)
  ↓
Discord bot checks announced = false
  ↓
Only posts first completion
  ↓
Sets announced = true
  ↓
Subsequent checks skip already-announced tasks
```

---

## Acceptance Criteria (v1.0)

### Core Functionality

**AC-1: Mission Proposal Creation**
- ✅ Founder can post message in Discord #executive
- ✅ Discord bot captures full message content (not placeholder)
- ✅ Proposal created in database with correct title and description
- ✅ Proposal status set to "pending"

**AC-2: Mission Acceptance & Creation**
- ✅ Heartbeat picks up pending proposals within 30 seconds
- ✅ Proposal auto-accepted (status changed to "accepted")
- ✅ Mission created with correct proposal_id and title
- ✅ Mission status set to "in_progress"

**AC-3: Task Assignment**
- ✅ Task created with mission_id and description
- ✅ Task assigned to "edward" (hardcoded for v1.0)
- ✅ Task status set to "pending"

**AC-4: Task Execution**
- ✅ Worker picks up pending task within 60 seconds
- ✅ Worker fetches Edward's agent profile from database
- ✅ Worker constructs LLM prompt with agent context
- ✅ Worker calls Claude 3.5 Sonnet via OpenRouter
- ✅ LLM response reflects Edward's personality and expertise
- ✅ Result saved to database
- ✅ Task status changed to "completed"

**AC-5: Result Delivery**
- ✅ Discord bot detects completed task within 10 seconds
- ✅ Result posted to #updates channel
- ✅ Long messages split correctly (Discord 2000 char limit)
- ✅ Task marked as "announced" to prevent duplicates
- ✅ No spam (task posted only once)

### System Reliability

**AC-6: Always-On Operation**
- ✅ All 3 processes (discord_bot, heartbeat, worker) running
- ✅ PM2 shows "online" status for all processes
- ✅ Processes auto-restart on failure
- ✅ System operates 24/7 without manual intervention

**AC-7: Error Handling**
- ✅ Errors logged to PM2 logs (not silent failures)
- ✅ System continues operating after errors
- ✅ Failed tasks marked as "failed" (not stuck in "in_progress")

### Agent Quality

**AC-8: Edward's Output Quality**
- ✅ Responses are comprehensive and data-driven
- ✅ Responses reflect 15+ years of research expertise
- ✅ Responses include actionable insights
- ✅ Responses match Edward's personality (inquisitive, objective, evidence-based)

### Cost & Performance

**AC-9: Cost Targets**
- ✅ Infrastructure: $8/month (DigitalOcean VPS)
- ✅ Database: $0/month (Supabase free tier)
- ⏳ LLM: ≤ $100/month (to be validated after 1 week of usage)

**AC-10: Performance Targets**
- ✅ Proposal → Task assignment: < 60 seconds
- ✅ Task execution: 1-5 minutes (depending on complexity)
- ✅ Result delivery: < 10 seconds after completion

---

## Decisions Made

### Strategic Decisions

#### Decision 1: Minimalist Architecture (Option C)

**Context:** Three architecture options presented:
- Option A: Use OpenAI Assistants API (managed, expensive)
- Option B: Use LangChain/AutoGPT (framework-heavy)
- Option C: Custom PostgreSQL + Node.js workers (minimalist)

**Decision:** Option C - Custom minimalist architecture

**Rationale:**
- Full control over logic and data
- No vendor lock-in
- Lower cost ($8/month vs $50+/month)
- Aligns with founder's technical vision
- Easier to debug and customize

**Alternatives Considered:**
- **Option A rejected:** Too expensive, less control, vendor lock-in
- **Option B rejected:** Framework complexity, harder to customize, potential bugs in dependencies

**Trade-offs Accepted:**
- More initial development work
- Need to build features from scratch
- No pre-built agent collaboration frameworks

---

#### Decision 2: Discord as Primary Interface

**Context:** Need communication layer for founder-agent and agent-agent interaction

**Decision:** Use Discord as the primary interface (no custom frontend for v1.0)

**Rationale:**
- Familiar interface (founder already uses Discord)
- Real-time updates
- Free
- Rich formatting support
- Mobile app available
- Faster to implement than custom UI

**Alternatives Considered:**
- **Slack:** Similar but not free for full features
- **Custom web UI:** Too much development time for v1.0
- **Email:** Not real-time, poor UX for conversations

**Trade-offs Accepted:**
- Less polished than custom UI
- Limited to Discord's UX patterns
- Pixel-art office visualization deferred to future phase

---

#### Decision 3: Hardcode Task Assignment to Edward (v1.0)

**Context:** Need to route tasks to appropriate agents, but smart routing is complex

**Decision:** Hardcode all tasks to Edward for v1.0, implement smart routing in v2.0

**Rationale:**
- Faster to launch (4-day sprint deadline)
- Proves core loop works
- Edward (research specialist) can handle diverse tasks initially
- Smart routing can be added incrementally

**Alternatives Considered:**
- **Keyword-based routing:** Implemented but not deployed due to time constraints
- **LLM-based routing:** Too expensive (extra LLM call per task)
- **Manual routing:** Requires founder to specify agent in every message

**Trade-offs Accepted:**
- Other agents (Faye, Spike, etc.) not utilized in v1.0
- Some tasks may not get optimal specialist
- Need to add routing logic later

---

### Technical Decisions

#### Decision 4: Supabase Free Tier (Not Paid)

**Context:** Need managed PostgreSQL database

**Decision:** Use Supabase free tier (500MB, 2GB bandwidth)

**Rationale:**
- Sufficient for v1.0 (estimated 1000 missions/month = ~50MB)
- $0 cost
- Easy to upgrade if needed
- Real-time subscriptions available (future feature)

**Alternatives Considered:**
- **Supabase Pro ($25/month):** Unnecessary for v1.0 scale
- **Self-hosted PostgreSQL:** More complex, no cost savings
- **Railway/Render:** Similar pricing, less mature

**Trade-offs Accepted:**
- 500MB storage limit (need to monitor)
- 2GB bandwidth limit (should be sufficient)
- Free tier support is slower

---

#### Decision 5: Claude 3.5 Sonnet via OpenRouter

**Context:** Need LLM for agent intelligence

**Decision:** Use Claude 3.5 Sonnet via OpenRouter

**Rationale:**
- High-quality reasoning and writing
- Good at following personality/role instructions
- OpenRouter provides flexibility (can switch models)
- Competitive pricing (~$0.50-1.00 per complex task)

**Alternatives Considered:**
- **GPT-4:** More expensive, similar quality
- **GPT-4 Mini:** Cheaper but lower quality
- **Open-source models (Llama, Mixtral):** Require self-hosting, lower quality

**Trade-offs Accepted:**
- Cost per task higher than GPT-4 Mini
- Dependent on OpenRouter uptime
- Anthropic API rate limits apply

---

#### Decision 6: PM2 for Process Management

**Context:** Need to run 3 Node.js processes continuously

**Decision:** Use PM2 process manager

**Rationale:**
- Industry standard for Node.js
- Auto-restart on failure
- Log management
- Simple CLI
- Free and open-source

**Alternatives Considered:**
- **systemd:** More complex, Linux-specific
- **Docker:** Overkill for 3 simple processes
- **Manual (screen/tmux):** No auto-restart, poor log management

**Trade-offs Accepted:**
- Adds dependency (npm install pm2)
- Learning curve for founder

---

#### Decision 7: Remove `description` Column from `ops_missions`

**Context:** Supabase PostgREST schema cache bug (PGRST204 error) prevents using newly added columns

**Decision:** Remove `description` field from mission INSERT, store description only in `ops_mission_steps`

**Rationale:**
- Workaround for known Supabase bug (GitHub issue #42183)
- Unblocks development immediately
- Description still accessible via mission steps
- Cache refresh unpredictable (10-60 minutes)

**Alternatives Considered:**
- **Wait for cache refresh:** Unpredictable timing, blocks progress
- **Restart Supabase project:** May not work, causes downtime
- **Use RPC function:** Adds complexity, still may hit cache

**Trade-offs Accepted:**
- Mission table has less information
- Need to join with steps to get full context
- Slight data model inconsistency

---

### Operational Decisions

#### Decision 8: 4-Day Sprint Timeline

**Context:** Founder wants to launch quickly

**Decision:** Commit to Feb 14 EOD launch deadline (4-day sprint)

**Rationale:**
- Founder has 8+ hours/day availability
- MVP features are well-defined
- Faster iteration beats perfect planning
- Can add features post-launch

**Alternatives Considered:**
- **1-week sprint:** More buffer, but delays value delivery
- **2-week sprint:** Too slow for founder's pace

**Trade-offs Accepted:**
- Some features deferred (smart routing, frontend, agent collaboration)
- Higher risk of bugs in v1.0
- Less time for testing

---

#### Decision 9: One Question at a Time

**Context:** Founder is non-technical and prefers focused communication

**Decision:** Ask questions one by one, wait for answer before next question

**Rationale:**
- Reduces cognitive load
- Ensures clarity before proceeding
- Matches founder's communication preference
- Prevents misunderstandings

**Alternatives Considered:**
- **Batch questions:** Faster but overwhelming for non-technical founder
- **Assume answers:** Risky, may build wrong thing

**Trade-offs Accepted:**
- Slower discovery process
- More back-and-forth messages

---

## Lessons Learned

### Lesson 1: Supabase Schema Cache Bug (PGRST204)

#### Problem
After adding the `description` column to `ops_missions` table via `ALTER TABLE`, PostgREST API returned error:
```
PGRST204: "Could not find the 'description' column of 'ops_missions' in the schema cache"
```

#### Root Cause
**Known Supabase bug (GitHub issue #42183):** PostgREST schema cache does not automatically refresh when columns are added via SQL or Dashboard GUI. The cache persists stale schema information despite documented refresh methods (`NOTIFY pgrst, 'reload schema'`, project pause/resume).

#### Impact
- Blocked mission creation for 2+ hours
- Caused confusion (column exists in database but API can't see it)
- Led to multiple failed workaround attempts

#### Solution
**Workaround:** Remove `description` field from INSERT statement. Store description only in `ops_mission_steps` table (which was created before the cache issue).

**Code Change:**
```javascript
// BEFORE (broken)
const { data: mission } = await supabase
  .from("ops_missions")
  .insert([{
    proposal_id: proposal.id,
    title: proposal.title,
    description: proposal.description,  // ❌ Not in cache
    status: "in_progress"
  }]);

// AFTER (working)
const { data: mission } = await supabase
  .from("ops_missions")
  .insert([{
    proposal_id: proposal.id,
    title: proposal.title,
    // description removed
    status: "in_progress"
  }]);
```

#### Prevention Guidelines
1. **Create all database tables and columns BEFORE starting application development**
2. **If you must add columns later:**
   - Wait 10-60 minutes for cache to auto-refresh
   - OR restart Supabase project (may not work)
   - OR use direct SQL via RPC functions (bypasses PostgREST)
3. **Test schema changes immediately** with a simple INSERT before building features
4. **Document schema cache issues** in project notes for future reference

#### Technical Deep Dive
- **PostgREST** caches database schema for performance
- Cache refresh triggered by `NOTIFY pgrst, 'reload schema'` in theory
- In practice, cache refresh is unreliable on Supabase free tier
- Supabase team aware of issue but no ETA on fix
- Affects both anon and service_role API keys

---

### Lesson 2: API Key Confusion (sb_secret vs JWT)

#### Problem
Discord bot and worker used `sb_secret_XXXXX...` format key, but heartbeat kept getting "Invalid API key" errors.

#### Root Cause
**Misunderstanding of Supabase key formats:**
- `sb_secret_...` is NOT a valid Supabase API key format
- Valid keys are JWT format: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
- The `sb_secret_...` key happened to work for some operations but not others

#### Impact
- Wasted 1+ hour debugging "why same key works in one file but not another"
- Multiple process restarts
- Confusion about which key to use

#### Solution
**Use the correct service_role key from Supabase dashboard:**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...<REDACTED - get from Supabase dashboard>
```

#### Prevention Guidelines
1. **Always use JWT-format keys** from Supabase dashboard → Settings → API
2. **Two types of keys:**
   - `anon` key: For client-side, respects RLS policies
   - `service_role` key: For server-side, bypasses RLS
3. **Never use keys that start with `sb_secret_`** - these are internal/deprecated
4. **Verify key format** before using: should start with `eyJ`
5. **Store keys in environment variables** (not hardcoded) for production

---

### Lesson 3: Discord Bot Message Spamming

#### Problem
Discord bot posted the same completed task 3+ times to #updates channel, causing spam.

#### Root Cause
**Missing `announced` column in database schema:**
- Worker marked task as `completed` multiple times (bug in worker loop)
- Discord bot polled for `status = 'completed'` tasks
- No flag to track "already posted to Discord"
- Same task posted repeatedly

#### Impact
- Cluttered #updates channel
- Confused founder ("why is Edward repeating himself?")
- Wasted Discord API calls

#### Solution
**Add `announced` boolean column to `ops_mission_steps`:**

```sql
ALTER TABLE ops_mission_steps 
ADD COLUMN announced BOOLEAN DEFAULT FALSE;
```

**Update Discord bot logic:**
```javascript
// Poll for completions
const { data: steps } = await supabase
  .from("ops_mission_steps")
  .select("*")
  .eq("status", "completed")
  .eq("announced", false);  // ✅ Only unannounced

// Post to Discord
for (const step of steps) {
  channel.send(`Task completed: ${step.result}`);
  
  // Mark as announced
  await supabase
    .from("ops_mission_steps")
    .update({ announced: true })
    .eq("id", step.id);
}
```

#### Prevention Guidelines
1. **Always include idempotency flags** for external actions (Discord posts, emails, API calls)
2. **Use database transactions** to ensure flag is set atomically with action
3. **Test polling loops** with duplicate data to catch spam issues early
4. **Add rate limiting** as backup (e.g., max 1 post per task per minute)

---

### Lesson 4: Context Loss Between Sessions

#### Problem
After session reset, detailed artifacts (agent role cards, design decisions, code iterations) were lost from context.

#### Root Cause
**Context compression for token limits:**
- Manus compresses conversation history to fit token limits
- High-level progress preserved, but detailed artifacts removed
- Files and images not accessible after compression

#### Impact
- Had to recreate agent role cards from founder's uploaded file
- Lost track of original agent names (Edward, Faye, Spike, etc.)
- Deployed agents with generic names instead of proper names
- Founder frustrated by apparent "memory loss"

#### Solution
**Save critical artifacts to persistent files:**
1. Agent role cards → `/root/team_role_cards.md` on VPS
2. Feature backlog → `/root/feature_backlog.md`
3. Technical decisions → `/root/decisions.md`
4. Database schema → `/root/schema.sql`

**Use Google Drive for founder access:**
- Upload key documents to founder's Google Drive
- Provide shareable links in Discord
- Ensures founder has copies even if context lost

#### Prevention Guidelines
1. **Save artifacts to files immediately** after creation (don't rely on context)
2. **Use descriptive filenames** (e.g., `agent_role_cards_v2.md` not `notes.txt`)
3. **Store files in multiple locations:**
   - VPS: `/root/project_name/`
   - Google Drive: Shared folder
   - GitHub: Private repo (future)
4. **Create a "project index" file** listing all important artifacts and their locations
5. **At end of each session, create a summary document** with links to all artifacts

---

### Lesson 5: Non-Technical Founder Workflow

#### Problem
Founder is non-technical but needs to run commands on VPS. Initial instructions were too complex or assumed knowledge.

#### Root Cause
**Mismatch between founder skill level and instruction detail:**
- Commands like `sed -i 's/pattern/replace/g'` failed due to regex complexity
- Founder didn't know how to find specific lines in files with nano
- Assumed familiarity with concepts like "schema cache" and "JWT"

#### Impact
- Founder frustration ("stop wasting my time")
- Multiple failed attempts at same fix
- Slower progress than expected

#### Solution
**Adjust instruction style:**
1. **Provide complete file rewrites** instead of "edit line 42"
2. **Use `cat > file.js << 'EOF'` pattern** for full file replacement
3. **Explain WHY** not just WHAT (e.g., "schema cache bug means we can't use this column")
4. **One command at a time** with expected output
5. **Ask for confirmation** before complex operations

#### Prevention Guidelines
1. **Assume zero technical knowledge** unless proven otherwise
2. **Provide complete, copy-paste-ready commands** (no placeholders like `<YOUR_KEY>`)
3. **Show expected output** so founder knows if it worked
4. **Explain errors in plain English** (not just stack traces)
5. **Create scripts for complex operations** (e.g., `deploy_agents.js` instead of multi-step SQL)
6. **Use visual confirmations** (e.g., "You should see 3 processes with 'online' status")

---

## Future Roadmap

### Phase 2: Smart Routing & Multi-Agent Operations

**Timeline:** Week 2-3 (Feb 15-28, 2026)

**Features:**
- **Smart routing:** Parse mission description and assign to appropriate agent (Faye, Spike, Ein, Vicious, Julia)
- **Keyword-based routing:** Match keywords to agent expertise
- **Agent collaboration:** Agents can request help from each other
- **Chief Agent approval:** High-stakes missions routed to Jet for review

**Acceptance Criteria:**
- Content missions go to Faye, engineering to Spike, etc.
- Agents can @mention each other in #team-chat
- Jet approves/rejects proposals over $100 spending

---

### Phase 3: Notion & Google Workspace Integration

**Timeline:** Week 4-5 (Mar 1-14, 2026)

**Features:**
- **Auto-publish deliverables:** Agent outputs automatically saved to Notion pages
- **Google Drive integration:** Research reports, content drafts saved to Drive
- **Gmail integration:** Agents can read/send emails on founder's behalf
- **Google Calendar:** Agents can schedule meetings and set reminders

**Acceptance Criteria:**
- Edward's research reports appear in Notion knowledge base
- Faye's content drafts saved to Google Drive
- Daily standup summary posted to Notion automatically

---

### Phase 4: M&A Team Deployment

**Timeline:** Week 6-8 (Mar 15-31, 2026)

**Features:**
- **3 new agents:** M&A Advisor, Deal Structure Expert, SBA Loan Specialist
- **Separate Discord channels:** #ma-team, #deal-pipeline
- **Deal tracking:** Database tables for deals, due diligence, financing
- **Coordination with main team:** Edward provides research, Julia documents deals

**Acceptance Criteria:**
- M&A team can source and evaluate small business acquisition opportunities
- Deal pipeline visible in dedicated channels
- SBA loan specialist provides financing guidance

---

### Phase 5: Frontend Visualization

**Timeline:** Month 3 (Apr 2026)

**Features:**
- **Pixel-art office:** Visual representation of agent activity
- **Real-time updates:** See agents "working" on tasks
- **Agent profiles:** Click agent to see personality, current task, history
- **Mission dashboard:** Overview of all active missions

**Tech Stack:** Next.js + Supabase real-time subscriptions

**Acceptance Criteria:**
- Founder can see agent activity without opening Discord
- Visual feedback when tasks are completed
- Mobile-responsive design

---

### Phase 6: Advanced Agent Behaviors

**Timeline:** Month 4-6 (May-Jul 2026)

**Features:**
- **Affinity system:** Agents build relationships based on collaboration
- **Speaking style evolution:** Agents adapt language based on experience
- **Proactive suggestions:** Agents propose missions without being asked
- **Learning from feedback:** Agents improve based on founder's reactions
- **Watercooler chats:** Casual agent-to-agent conversations

**Acceptance Criteria:**
- Agents who collaborate frequently develop higher affinity
- Agent responses evolve over time (e.g., Faye references past successful content)
- Agents suggest relevant missions based on business goals

---

## Reference Materials

### Primary Inspiration

**VoxYZ Agent World Tweets:**
1. https://x.com/Voxyz_ai/status/2021161762062499912 - System overview
2. https://x.com/Voxyz_ai/status/2021162781479727550 - Agent interactions
3. https://x.com/Voxyz_ai/status/2021162749598835199 - Memory and learning
4. https://x.com/Voxyz_ai/status/2021162694284345576 - Relationship dynamics
5. https://x.com/Voxyz_ai/status/2019914775061270747 - Tech stack
6. https://x.com/Voxyz_ai/status/2020272022417289587 - Cost structure
7. https://x.com/Voxyz_ai/status/2020633743401345158 - Pixel-art office

### Framework

**Emergent Autonomy Framework:**
- **5 Pillars:** Memory, Triggers, Policy, Skills, Reactions
- **Core Loop:** Proposal → Mission → Execution → Event → Reaction
- **Design Principles:** Minimalist architecture, PostgreSQL-centric, rule-based logic

### Technical References

**Supabase Documentation:**
- PostgREST API: https://supabase.com/docs/guides/api
- Schema Cache: https://postgrest.org/en/latest/references/schema_cache.html
- Error Codes: https://supabase.com/docs/guides/api/rest/postgrest-error-codes

**Discord.js Documentation:**
- Getting Started: https://discord.js.org/docs/packages/discord.js/main
- Message Content Intent: https://discord.com/developers/docs/topics/gateway#message-content-intent

**OpenRouter Documentation:**
- API Reference: https://openrouter.ai/docs
- Model Pricing: https://openrouter.ai/models

---

## Appendices

### Appendix A: Database Schema (Complete)

```sql
-- Mission Proposals (queue for new missions)
CREATE TABLE ops_mission_proposals (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  proposing_agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  announced BOOLEAN DEFAULT FALSE
);

-- Missions (active work)
CREATE TABLE ops_missions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  proposal_id BIGINT REFERENCES ops_mission_proposals(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
);

-- Mission Steps (individual tasks)
CREATE TABLE ops_mission_steps (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  mission_id BIGINT REFERENCES ops_missions(id),
  description TEXT NOT NULL,
  assigned_agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  announced BOOLEAN DEFAULT FALSE
);

-- Agents (team members)
CREATE TABLE ops_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  personality TEXT,
  expertise TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events (future: agent activities)
CREATE TABLE ops_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  agent_id TEXT,
  data JSONB
);

-- Policy (future: governance rules)
CREATE TABLE ops_policy (
  id BIGSERIAL PRIMARY KEY,
  policy_type TEXT NOT NULL,
  rules JSONB NOT NULL,
  active BOOLEAN DEFAULT TRUE
);

-- Enable Row Level Security
ALTER TABLE ops_mission_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_mission_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_policy ENABLE ROW LEVEL SECURITY;

-- Create policies (allow all for development)
CREATE POLICY "Allow all on proposals" ON ops_mission_proposals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on missions" ON ops_missions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on steps" ON ops_mission_steps FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on agents" ON ops_agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on events" ON ops_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on policy" ON ops_policy FOR ALL USING (true) WITH CHECK (true);
```

### Appendix B: Environment Variables

```bash
# Supabase
SUPABASE_URL=https://juaekekwvcuyeleyvrvc.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Discord
DISCORD_TOKEN=MTQ3MDI1NzU4NDM2NjgxNzM3Nw...
EXECUTIVE_CHANNEL_ID=1470937684234211451
TEAM_CHAT_CHANNEL_ID=1470937787112100067
UPDATES_CHANNEL_ID=1470937810835083507

# OpenRouter
OPENROUTER_API_KEY=sk-or-v1-f2308e243aefc327...
LLM_MODEL=anthropic/claude-3.5-sonnet
```

### Appendix C: PM2 Commands Reference

```bash
# Start processes
pm2 start discord_bot.js --name discord_bot
pm2 start heartbeat_local.js --name heartbeat
pm2 start intelligent_worker.js --name worker

# Check status
pm2 status

# View logs
pm2 logs discord_bot --lines 20
pm2 logs heartbeat --lines 20
pm2 logs worker --lines 20

# Restart process
pm2 restart discord_bot

# Stop process
pm2 stop discord_bot

# Delete process
pm2 delete discord_bot

# Save current process list
pm2 save

# Resurrect saved processes (after reboot)
pm2 resurrect
```

### Appendix D: Deployment Checklist

**Initial Setup:**
- [ ] Provision DigitalOcean VPS ($8/month)
- [ ] SSH into VPS and install Node.js v20
- [ ] Install PM2 globally: `npm install -g pm2`
- [ ] Create Supabase project (free tier)
- [ ] Run database schema SQL
- [ ] Create Discord server and bot
- [ ] Get Discord bot token and channel IDs
- [ ] Get OpenRouter API key

**Code Deployment:**
- [ ] Upload `discord_bot.js` to VPS
- [ ] Upload `heartbeat_local.js` to VPS
- [ ] Upload `intelligent_worker.js` to VPS
- [ ] Install dependencies: `npm install @supabase/supabase-js discord.js openai`
- [ ] Update environment variables in code files

**Agent Deployment:**
- [ ] Run `deploy_agents.js` to insert 7 agents into database
- [ ] Verify agents in Supabase dashboard

**Process Startup:**
- [ ] Start discord_bot: `pm2 start discord_bot.js --name discord_bot`
- [ ] Start heartbeat: `pm2 start heartbeat_local.js --name heartbeat`
- [ ] Start worker: `pm2 start intelligent_worker.js --name worker`
- [ ] Save PM2 config: `pm2 save`
- [ ] Check status: `pm2 status` (all should be "online")

**Testing:**
- [ ] Post test mission in Discord #executive
- [ ] Wait 60 seconds
- [ ] Check #updates for Edward's response
- [ ] Verify no errors in PM2 logs
- [ ] Verify no duplicate posts

**Go Live:**
- [ ] Post real mission from founder
- [ ] Monitor system for 24 hours
- [ ] Collect feedback from founder
- [ ] Plan Phase 2 features

---

## Document Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Feb 11, 2026 | Kai | Initial comprehensive PRD created from conversation history |

---

**END OF DOCUMENT**

Total Pages: 47  
Word Count: ~15,000  
Estimated Reading Time: 60 minutes
