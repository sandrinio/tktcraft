# Connection & Board Setup Guide (For Humans & AI Agents)

This guide walks both **Human users** and **AI Coding Agents** (Claude Code, Antigravity, Cursor, Codex) through connecting `tkt` to **Jira** (Cloud or Data Center) and/or **Azure DevOps Boards**, selecting the target **Board** during setup, and verifying Pre-Hooks and Post-Hooks.

---

## Part A: For AI Agents (Automated Onboarding Sequence)

> **Instruction for the AI Agent**:
> Follow Steps 1–5 in order. Run shell commands where possible, and pause to ask the user only when credentials or **Board Selection** are needed.

### Step 1: Verify Runtime Environment
Ensure Node.js $\ge 20$ is installed and build the CLI:
```bash
node --version && npm --version
npm install && npm run build
```

### Step 2: Check or Create `.env` Credentials
1. Check if `.env` exists; if not, copy `.env.example`:
   ```bash
   test -f .env || cp .env.example .env
   ```
2. Ask the user which platform(s) they want to connect (**Jira**, **Azure DevOps**, or **Both**):
   - **If Jira Cloud**:
     - Ask for:
       1. `JIRA_URL` (e.g. `https://your-org.atlassian.net`)
       2. `JIRA_USER` (their Atlassian email)
       3. `JIRA_TOKEN` (create at [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens))
   - **If Jira Data Center / Server**:
     - Ask for `JIRA_URL`, `JIRA_TOKEN` (Personal Access Token), and set `JIRA_AUTH_TYPE=datacenter`.
   - **If Azure DevOps (ADO)**:
     - Ask for:
       1. `ADO_ORG_URL` (e.g. `https://dev.azure.com/your-org`)
       2. `ADO_TOKEN` (create a PAT at `https://dev.azure.com/<your-org>/_usersSettings/tokens` with **Work Items: Read, write, & manage** scope)

### Step 3: List Projects & Discover Boards (Mandatory Board Selection)
> [!IMPORTANT]
> **During setup, the user MUST choose which Board to connect to.** Never guess a board silently if a project has multiple boards (e.g. Discovery Board vs. Sprint Board vs. Kanban Board).

1. List accessible projects:
   ```bash
   node ./bin/tkt.js projects --provider <jira|ado>
   ```
2. Once the project is known, list all boards in that project:
   ```bash
   node ./bin/tkt.js boards --provider <jira|ado> --project "<PROJECT_KEY_OR_NAME>"
   ```
3. Present the discovered boards to the user and ask:
   > *"Which board in `<PROJECT>` would you like to connect to? (You can also connect multiple boards using named profiles like `discovery` and `delivery`.)"*

### Step 4: Connect & Introspect the Selected Board
Run `tkt setup` with the user's chosen board:
```bash
node ./bin/tkt.js setup \
  --provider <jira|ado> \
  --profile <profile-name> \
  --project "<PROJECT_KEY_OR_NAME>" \
  --board "<CHOSEN_BOARD_ID_OR_NAME>" \
  --non-interactive
```
What this does automatically:
- Introspects the board's **Columns $\leftrightarrow$ Workflow Statuses / States**.
- Extracts **Board Placement Rules** (required Jira filter labels from the board's JQL, or default Team `AreaPath` and `IterationPath` in Azure DevOps) so every created ticket is guaranteed to appear on the chosen board.
- Introspects **Issue / Work-Item Types** and their required/custom fields (including dedicated Azure DevOps fields like `AcceptanceCriteria` and `ReproSteps`).
- Saves the profile to `.tkt/config.json` and generates the AI board reference doc at `.tkt/boards/<profile-name>.md`.

### Step 5: Verify Connection & Board Schema
```bash
node ./bin/tkt.js me --profile <profile-name>
node ./bin/tkt.js board-schema --profile <profile-name>
```
Confirm to the user that:
- ✅ Authentication is active (`tkt me`).
- ✅ Board schema & column mappings are synced (`.tkt/boards/<profile-name>.md`).
- ✅ AI Pre-Hooks and Post-Hooks are active (`.agents/hooks.json`).

---

## Part B: For Humans (Interactive Terminal Quickstart)

### 1. Install & Build
```bash
npm install
npm run build
# Optional: link `tkt` globally on your machine
npm link
```

### 2. Run the Interactive Setup Wizard
Simply run:
```bash
tkt setup
```
The interactive wizard will guide you step-by-step:
1. **Select Provider**: `[1] Jira` or `[2] Azure DevOps`
2. **Enter Profile Name**: e.g. `jira-delivery`, `jira-discovery`, or `ado-sprint`
3. **Enter URL & Token**: Saved securely to `.env` (never committed to git)
4. **Select Project**: Pick from a numbered list of your accessible projects
5. **Choose Your Board (Required)**: Pick from a numbered list of all boards in that project
6. **Automatic Board Introspection**: `tkt` inspects the board's columns, statuses, JQL/WIQL filters, and work item fields, saving the board profile to `.tkt/config.json`.

> **Tip — Connecting Multiple Boards at Once**:
> Run `tkt setup` as many times as you like with different `--profile` names! For example:
> - `tkt setup --profile discovery` (connected to your Product Discovery board)
> - `tkt setup --profile delivery` (connected to your Engineering Sprint board)
> - `tkt setup --profile ado-client` (connected to an Azure DevOps client board)

### 3. Everyday Commands for Humans

```bash
# Check who you are & which board is active
tkt me

# View your connected board's columns, statuses, and required fields
tkt board-schema

# Search tickets on your connected board
tkt search --board-only
tkt search --column "In Progress" --assignee me

# Inspect a ticket (auto-detects Jira KEY-123 vs Azure DevOps numeric ID!)
tkt get AIEAE-1871
tkt get 4092

# Preview creating a ticket (Pre-Hook Dry Run)
tkt create -t Story -s "[Checkout] Add Apple Pay button" -d "Support Apple Pay on web checkout." --dry-run

# Create a ticket interactively (shows Pre-Hook preview, asks [y/N], then runs Post-Hooks)
tkt create -t Story -s "[Checkout] Add Apple Pay button" -f ./story.md

# Move a ticket to a different Board Column and add a comment
tkt update AIEAE-1871 --column "Ready for Code Review" -c "PR #42 opened."
```
