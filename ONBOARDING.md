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
| **Jira Cloud** (`https://<org>.atlassian.net`) | 1. **`JIRA_URL`** — Base URL (e.g., `https://your-org.atlassian.net`)<br>2. **`JIRA_USER`** — **Atlassian Account Email** *(mandatory for Jira Cloud Basic Auth `email:api_token`)*<br>3. **`JIRA_TOKEN`** — Atlassian API Token (`ATATT3x...`) | `.tktcraft/.env` (gitignored) |
| **Jira Data Center / Server** | 1. **`JIRA_URL`** — Base URL<br>2. **`JIRA_TOKEN`** — Personal Access Token (Bearer PAT)<br>3. **`JIRA_AUTH_TYPE=datacenter`** | `.tktcraft/.env` (gitignored) |
| **Azure DevOps Boards** (`https://dev.azure.com/<org>`) | 1. **`ADO_ORG_URL`** — Organization URL (e.g., `https://dev.azure.com/your-org`)<br>2. **`ADO_TOKEN`** — Personal Access Token (PAT with *Work Items: Read, write, & manage*) | `.tktcraft/.env` (gitignored) |

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
npx --no-install tkt onboarding
```

Use a persistent local or global installation for agent hooks, not a disposable
`npx` cache. The Copilot adapter in this unreleased candidate is experimental;
see [the verification status](COPILOT-COMPATIBILITY.md).

### Step 2: Verify Connection & List Accessible Projects
Have the user provision credentials directly in an ignored `.tktcraft/.env` file, not in
chat, command arguments, or hook files. Once the required connection values are
available, list accessible projects:
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
1. Saves credentials to `.tktcraft/.env` (mode `0600`) and ignores `.tktcraft/`.
2. Runs **Tier 1 Formal Schema Introspection** (Columns $\leftrightarrow$ Statuses, WIP limits, Column Definitions of Done, JQL/WIQL filter required labels & routed issue types, Team `AreaPath`/`IterationPath`, and required/custom fields).
3. Runs **Tier 2 Empirical Ticket Mining** (samples the last ~25 tickets on each connected board to learn active issue type %, real label vocabulary, `[Prefix]` title naming conventions, parent-linking rate, and recurring description headings).
4. Writes `.tktcraft/config.json`, per-board guides `.tktcraft/boards/<board-alias>.md`, and the master multi-board routing map `.tktcraft/boards/INDEX.md`.
5. Installs the full workflow and templates in `.tktcraft/skills/tkt-ops/` and
   the launcher in `.tktcraft/hooks/tkt-hook.cjs`. Small discovery entries remain
   in `.agents/skills/tkt-ops/SKILL.md`, `.agents/hooks.json`, and
   `.github/hooks/tkt-governance.json`. Missing
   hook files are installed even when the skill already exists. The launcher
   uses the package that ran setup; keep that installation available.
   Unrelated hooks and customized skills are preserved, and conflicts are
   reported instead of overwritten.
6. Adds a small managed instruction block to an existing `AGENTS.md`, otherwise
   existing `.github/copilot-instructions.md`, otherwise a new `AGENTS.md`.
   It points to the shared skill and board context rather than duplicating the
   workflow. A local `.tktcraft/agent-integration.json` hash manifest supports safe
   upgrades of unmodified managed assets.

Installed files are not proof that hooks are active in the current assistant.
Restart the session if required and check the assistant's hook diagnostics.
One versioned Copilot hook file is used for both VS Code harnesses and Copilot
CLI; the adapter translates their different payload/output contracts. Do not
add a second Local-only registration for the same hooks.

Legacy `.tkt/` state migrates into `.tktcraft/` on first CLI access. Competing
state directories or conflicting custom skill copies cause an explicit error,
not a silent overwrite. Root `.env` remains an untouched legacy fallback;
canonical values take precedence and new credential writes stay inside
`.tktcraft/`. See [the layout](README.md#workspace-layout).

### Step 5: Verify Ready State
```bash
npx tkt me
npx tkt profiles
npx tkt board-schema
```
Report the connected account, active board(s), discovered columns, and `.tktcraft/boards/INDEX.md` path to the user.

### Step 6: Verify Agent Discovery Separately

1. Start a new assistant session in the trusted workspace.
2. In Copilot, inspect `/hooks` for the selected Local or Copilot harness.
3. Check shared `tkt-ops` skill discovery and the installed instruction entry
   point. Discovery does not guarantee invocation.
4. Run a harmless read-only command and inspect the harness's hook diagnostics.
5. For a later ticket change, show the concrete preview, get explicit approval,
   and verify the permission prompt and both result links. A CLI-only test is
   not proof of real-agent compatibility.

An unattended Copilot SDK probe executed an inert command even after the hook
returned `ask`. Native permission policy is therefore not proof of human
approval. Never infer consent from an auto-approved tool, staged token, or
successful dry run; obtain explicit approval for the exact ticket change.
Unattended Copilot ticket writes remain unsupported.

If hooks do not run, check workspace trust, Local `chat.useHooks`, or the
Copilot harness's admission/disable policy, then check that `node` is available
in the agent environment. These controls are harness-specific. If setup reports
a conflict, review the named customized file rather than overwriting it.

## 3. Upgrade an Existing Workspace

Update the installed package, then rerun setup with the same selected project
and board, for example:

```bash
npx --no-install tkt setup --project "<PROJECT_KEY>" --board "<BOARD_ID>" --non-interactive
```

No agent selection is required. Missing integrations are installed even when
the skill exists; unchanged generated files upgrade from their recorded hashes.
Unrelated instruction text and hooks are retained. Edited governance files or
managed instruction blocks cause an explicit conflict; customized skill files
are retained and listed in setup's result. Start a new assistant session and
verify discovery again after upgrading.
