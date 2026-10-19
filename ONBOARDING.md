# `tktcraft` (`tkt`) — Zero-to-One AI & Human Onboarding Guide

This document defines the exact **Zero-to-One Onboarding Protocol** when a user asks an AI Coding Agent (or runs `tktcraft` themselves) to install and set up **`tktcraft`** in a new or existing workspace.

> **Tip for AI Agents in Any Directory**:
> You can print this guide at any time after installing `tktcraft` by running:
> ```bash
> npx tktcraft onboarding
> ```

---

## 1. AI Agent Rule: Always Check & Ask for Missing Connection Details First

When a user says *"Install and set up tktcraft"* (or gives partial credentials like only an API token or only a URL), **do not guess or fabricate missing credentials**.

Inspect what the user has provided and compare it against the **Required Connection Matrix** below:

| Provider | Required Connection Details | Where Stored |
| :--- | :--- | :--- |
| **Jira Cloud** (`https://<org>.atlassian.net`) | 1. **`JIRA_URL`** — Base URL (e.g., `https://your-org.atlassian.net`)<br>2. **`JIRA_USER`** — **Atlassian Account Email** *(mandatory for Jira Cloud Basic Auth `email:api_token`)*<br>3. **`JIRA_TOKEN`** — Atlassian API Token (`ATATT3x...`) | `.env` (gitignored) |
| **Jira Data Center / Server** | 1. **`JIRA_URL`** — Base URL<br>2. **`JIRA_TOKEN`** — Personal Access Token (Bearer PAT)<br>3. **`JIRA_AUTH_TYPE=datacenter`** | `.env` (gitignored) |
| **Azure DevOps Boards** (`https://dev.azure.com/<org>`) | 1. **`ADO_ORG_URL`** — Organization URL (e.g., `https://dev.azure.com/your-org`)<br>2. **`ADO_TOKEN`** — Personal Access Token (PAT with *Work Items: Read, write, & manage*) | `.env` (gitignored) |

### What the AI Agent Must Ask When Something Is Missing
- **Missing Provider**: Ask whether they are connecting to **Jira** or **Azure DevOps** (single account per workspace; multiple boards on that same account are supported).
- **Missing Jira Cloud Email (`JIRA_USER`)**: Even if the user provides `JIRA_URL` and `JIRA_TOKEN` (`ATATT3x...`), Jira Cloud REST API v3 requires `Basic base64(email:api_token)`. Politely ask:
  > *"To authenticate with Jira Cloud (`<JIRA_URL>`), what is your **Atlassian account email address** (`JIRA_USER`) associated with this API token?"*
- **Missing URL or Token**: Ask specifically for the missing `JIRA_URL` / `ADO_ORG_URL` or `JIRA_TOKEN` / `ADO_TOKEN`.

---

## 2. Step-by-Step Zero-to-One Setup Flow (From Scratch)

### Step 1: Install `tktcraft` from npm
In the target project directory:
```bash
npm install tktcraft
# Or run directly via npx:
npx tktcraft --help
```

### Step 2: Verify Connection & List Accessible Projects
Once the required credentials (`JIRA_URL`, `JIRA_USER`, `JIRA_TOKEN` or `ADO_ORG_URL`, `ADO_TOKEN`) are provided, save them to `.env` (or pass via flags) and list accessible projects:
```bash
npx tkt projects --provider <jira|ado>
```
- If there is only **1** project in the account (or the user already named the project), select it automatically.
- If there are **multiple** projects and the user hasn't specified one, list the discovered projects and ask which project to use.

### Step 3: Mandatory Board Discovery & Selection
> [!IMPORTANT]
> **Never skip board selection.** Different boards in the same project have different columns, JQL/WIQL filters, and issue types.

List all boards in the selected project:
```bash
npx tkt boards --provider <jira|ado> --project "<PROJECT_KEY>"
```
- Present the discovered boards to the user (Board ID, Name, and Type).
- Ask the user which board (or multiple boards on the same account, e.g., Discovery Board + Delivery Board) they want to connect to.

### Step 4: Run `tkt setup` to Introspect the Selected Board(s) & Scaffold Agent Harness
```bash
npx tkt setup \
  --provider <jira|ado> \
  --project "<PROJECT_KEY>" \
  --board "<BOARD_ID_1>,<BOARD_ID_2>" \
  --non-interactive
```
Running `tkt setup` automatically:
1. Saves credentials to `.env` (and ensures `.env` is in `.gitignore`).
2. Runs **Tier 1 Formal Schema Introspection** (Columns $\leftrightarrow$ Statuses, WIP limits, Column Definitions of Done, JQL/WIQL filter required labels & routed issue types, Team `AreaPath`/`IterationPath`, and required/custom fields).
3. Runs **Tier 2 Empirical Ticket Mining** (samples the last ~25 tickets on each connected board to learn active issue type %, real label vocabulary, `[Prefix]` title naming conventions, parent-linking rate, and recurring description headings).
4. Writes `.tkt/config.json`, per-board guides `.tkt/boards/<board-alias>.md`, and the master multi-board routing map `.tkt/boards/INDEX.md`.
5. Scaffolds `.agents/skills/tkt-ops/SKILL.md` (with ticket templates) and `.agents/hooks.json` (`PreToolUse` and `PostToolUse` safety hooks) into the workspace.

### Step 5: Verify Ready State
```bash
npx tkt me
npx tkt profiles
npx tkt board-schema
```
Report the connected account, active board(s), discovered columns, and `.tkt/boards/INDEX.md` path to the user.
