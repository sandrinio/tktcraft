# Connection & Board Setup Guide (For Humans & AI Agents)

This guide walks both **Human users** and **AI Coding Agents** through connecting
`tkt` to **Jira** (Cloud or Data Center) or **Azure DevOps Boards**, selecting the
target **Board**, and verifying Pre-Hooks and Post-Hooks. Experimental Copilot
integration is included in this unreleased candidate; live support is not yet
certified. Use [ONBOARDING.md](ONBOARDING.md) as the short entry point.

---

## Part A: For AI Agents (Automated Onboarding Sequence)

> **Instruction for the AI Agent**:
> Follow Steps 1–5 in order. Run shell commands where possible, and pause to ask the user only when credentials or **Board Selection** are needed.

### Step 1: Verify Runtime Environment
Ensure Node.js $\ge 20$ is installed, then install in the target workspace:
```bash
node --version && npm --version
npm install tktcraft
npx --no-install tkt onboarding
```

The commands below use the source-checkout launcher for developers. With an
installed package, use `npx --no-install tkt` instead of `node ./bin/tkt.js`.
Do not require a consumer workspace to contain the package's source tree.

### Step 2: Check or Create `.tktcraft/.env` Credentials
1. Have the user provision credentials directly into an ignored `.tktcraft/.env` file.
   Do not request tokens in chat or put them into command arguments. In a source
   checkout, the template can be copied:
   ```bash
   printf '\n.tktcraft/\n' >> .gitignore
   mkdir -p .tktcraft
   test -f .tktcraft/.env || (umask 077; cp .env.example .tktcraft/.env)
   chmod 600 .tktcraft/.env
   ```
   In Windows PowerShell, restrict the file to your account with an ACL instead:
   ```powershell
   Add-Content .gitignore "`n.tktcraft/"
   New-Item -ItemType Directory -Force .tktcraft | Out-Null
   if (-not (Test-Path .tktcraft\.env)) { Copy-Item .env.example .tktcraft\.env }
   $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
   icacls .tktcraft\.env /grant:r "*${me}:(F)"
   icacls .tktcraft\.env /inheritance:r
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
   > *"Which board(s) in `<PROJECT>` would you like to connect to? You can select a single board or multiple boards on this account (e.g. both the Discovery Board and Implementation Board)."*

### Step 4: Connect & Introspect the Selected Board(s)
Run `tkt setup` with the user's chosen board (or comma-separated boards on the same account):
```bash
# Connect a single board or multiple boards in the same Jira or ADO account at once:
node ./bin/tkt.js setup \
  --provider <jira|ado> \
  --project "<PROJECT_KEY_OR_NAME>" \
  --board "<BOARD_ID_1>,<BOARD_ID_2>" \
  --non-interactive
```
What this does automatically:
- Introspects **Tier 1 (Formal Schema)**: Each board's **Columns $\leftrightarrow$ Workflow Statuses / States**, WIP limits, Column Definitions of Done, JQL/WIQL filter placement rules (`requiredLabels`, `routedIssueTypes`, or Team `AreaPath`/`IterationPath`), and required/custom fields.
- Introspects **Tier 2 (Empirical Team Conventions)**: Samples recent tickets on each board to learn active issue type distribution, real label/tag vocabulary, `[Prefix]` title patterns, and description headings.
- Saves all connected boards to `.tktcraft/config.json`, generates per-board AI guides at `.tktcraft/boards/<board-alias>.md`, and builds the master multi-board routing map at `.tktcraft/boards/INDEX.md`.

### Step 5: Verify Connection & Board Schema
```bash
node ./bin/tkt.js me
node ./bin/tkt.js profiles
node ./bin/tkt.js board-schema
```
Confirm to the user that:
- ✅ Authentication is active (`tkt me`).
- ✅ Connected boards & auto-routing rules are synced (`.tktcraft/boards/INDEX.md` and `.tktcraft/boards/<board-alias>.md`).
- Full workflow/templates and the launcher live in `.tktcraft/skills/` and
  `.tktcraft/hooks/`. Small registration/discovery entries remain in
  `.agents/hooks.json`, `.agents/skills/tkt-ops/SKILL.md`, and
  `.github/hooks/tkt-governance.json`, plus a small instruction block. This does
  **not** verify that the current assistant
  has loaded or executed them. Start a new trusted session if needed, inspect
  the agent's hook diagnostics, and verify a harmless read-only command.

The launcher uses the installed package that ran setup, even in a different
workspace or a path containing spaces. Keep that installation available and
make sure `node` is on the agent's PATH. If it is moved or removed, reinstall
`tktcraft` and rerun setup. Setup preserves unrelated hooks and reports
customized governance or launcher conflicts for review rather than replacing
them. Rerun setup to add integrations to an existing workspace, even when the
skill already exists. Unmodified managed assets upgrade using a local hash
manifest; customized skills are retained and listed. See the
[compatibility evidence](COPILOT-COMPATIBILITY.md) for experimental Copilot
behavior, activation checks, and unverified environments.
In an unattended Copilot SDK probe, `ask` did not prevent an inert command from
executing. Setup does not override native permission policy. A hook response,
staged token, or successful preview is not human consent; never execute a ticket
mutation without explicit approval of that exact change. Unattended Copilot
ticket writes are not supported.

Existing `.tkt/` state migrates automatically. If both state directories exist,
reconcile them first; neither is silently overwritten. Existing root `.env`
contents are never moved or edited: they remain a compatibility fallback, with
`.tktcraft/.env` taking precedence. See [workspace layout](README.md#workspace-layout).

---

## Part B: For Humans (Interactive Terminal Quickstart)

### 1. Install
```bash
npm install tktcraft
```

### 2. Run the Interactive Setup Wizard
Simply run:
```bash
npx --no-install tkt setup
```
The interactive wizard will guide you step-by-step:
1. **Select Provider Account**: `[1] Jira` or `[2] Azure DevOps` (one provider account per workspace)
2. **Enter URL & Token**: Saved securely to `.tktcraft/.env` (never committed to git)
3. **Select Project**: Pick from a numbered list of your accessible projects
4. **Choose Your Board(s) (Required)**: Pick one or multiple comma-separated boards from the numbered list (e.g. `1` or `1,2`)
5. **Automatic 3-Tier Board Introspection**: `tkt` inspects each board's columns, statuses, JQL/WIQL filters, work item fields, and recent ticket conventions, saving the connected boards to `.tktcraft/config.json` and `.tktcraft/boards/INDEX.md`.

> **Tip — Single-Account Multi-Board (`Jira + Jira` or `ADO + ADO`)**:
> You can connect multiple boards from the same Jira account or the same Azure DevOps account!
> - Pass multiple boards at once: `tkt setup --project AIEAE --board "4893,4887"`
> - Or add another board from the same account later: `tkt setup --profile delivery --board "4887"`
> - `tkt create`, `tkt get`, and `tkt update` automatically route across your connected boards by `--board`, `--type` (e.g. `Initiative` $\rightarrow$ Discovery Board vs. `Story` $\rightarrow$ Delivery Board), `--labels`, or `--area-path`!

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
