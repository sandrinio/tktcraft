---
name: tkt-ops
description: >-
  Manage Jira (Cloud & Data Center) and Azure DevOps Boards through the unified `tkt` CLI.
  Enforces board-selection setup, dynamic board-column and field routing, duplicate detection,
  mandatory Pre-Hook confirmation previews, hard no-delete governance, and Post-Hook direct + board view links.
---

# Unified Jira & Azure DevOps Board Skill (`tkt-ops`)

This skill defines the operating playbook, connection guide, pre-hook/post-hook guardrails, and board-aware workflows for interacting with **Jira** and **Azure DevOps Boards** using the `tkt` CLI.

---

## 1. Connection & Board Setup Requirement

Before creating or updating tickets, verify that a board profile is connected in [.tkt/config.json](../../.tkt/config.json):
```bash
npx tkt me
npx tkt board-schema
```

If no board profile is configured yet, follow [SETUP.md](../../SETUP.md):
1. List available boards in the project:
   ```bash
   npx tkt boards --provider <jira|ado> --project <PROJECT>
   ```
2. **Ask the user which board they want to connect to**, then run:
   ```bash
   npx tkt setup --provider <jira|ado> --project "<PROJECT>" --board "<BOARD_ID_OR_NAME>" --non-interactive
   ```
   This introspects the chosen board's **Columns $\leftrightarrow$ Statuses**, **Required Filter Labels / Team AreaPath**, and **Issue / Work-Item Type Fields**, saving the schema to `.tkt/config.json` and `.tkt/boards/<profile>.md`.

---

## 2. Mandatory Governance Guardrails (Pre-Hooks & Post-Hooks)

### A. NO DELETE / REMOVE (Hard Pre-Hook Block)
> [!CAUTION]
> **Ticket Deletion Is Strictly Prohibited**
> Under no circumstances may Jira issues or Azure DevOps work items be deleted, purged, or removed.
> - Both [.agents/hooks.json](../hooks.json) (`PreToolUse`) and the `tkt` CLI permanently block and exit with code `2` on any `delete`, `remove`, `destroy`, or `purge` argument.
> - If a ticket was created by mistake or is obsolete, transition it to **Closed / Removed / Cancelled** and add a comment explaining why.

### B. Mandatory Pre-Hook Confirmation for All Create & Update Actions
> [!IMPORTANT]
> **Never Execute Create or Update Autonomously Without Preview & Approval**
> Whenever the user requests creating a new ticket or updating an existing ticket (editing summary/description, adding a comment, transitioning board columns, or changing assignee/labels), the agent **MUST ALWAYS**:
> 1. Check the connected board's schema (`.tkt/boards/<profile>.md` or `npx tkt board-schema`).
> 2. Run a dry-run preview (`npx tkt create ... --dry-run`) or formulate the exact payload.
> 3. Present the structured **Pre-Execution Confirmation Preview** to the user in chat.
> 4. Halt and await explicit user approval before running `npx tkt create ... --yes` or `npx tkt update ... --yes`.

#### Pre-Hook Confirmation Format (Present in Chat):
```markdown
### 📋 Proposed Ticket Action: [Create Ticket | Update Ticket | Move Board Column | Add Comment]

| Field | Value |
| :--- | :--- |
| **Provider / Profile** | `Jira` / `Azure DevOps` (`<profile-name>`) |
| **Project & Connected Board** | `<PROJECT>` — **<Board Name>** (`#<Board ID>`) |
| **Action Type** | `create` / `update` |
| **Issue / Work Item Type** | `Story` / `User Story` / `Task` / `Bug` / `Epic` / `Initiative` |
| **Target Board Column** | `<Board Column Name>` *(Status: `<Underlying Status>`)* |
| **Summary / Title** | `[<Domain/Module>] <Verb> <Outcome>` |
| **Parent Ticket** | `<PARENT-KEY>` / `(None)` |
| **Auto-Applied Board Placement** | Labels: `<board-filter-labels>` / AreaPath: `<team-area-path>` |
| **Possible Duplicates** | `<None found or list of candidate keys>` |

**Proposed Description / Acceptance Criteria:**
> <Preview of the structured Markdown to be written>

---
**Do you approve executing this ticket change?** (Yes / Modify / Cancel)
```

### C. Mandatory Post-Hook Execution Rule (Direct Link + Connected Board Link)
> [!NOTE]
> **Always Surface Both Direct Ticket Link & Connected Board View Link**
> Whenever a ticket is created or updated, the CLI post-hook outputs two links and records an entry in `.tkt/audit.jsonl`. Your response to the user **MUST** immediately display both clickable links:
> 1. **Direct Ticket Link**:
>    - Jira: `https://<org>.atlassian.net/browse/<KEY>`
>    - Azure DevOps: `https://dev.azure.com/<org>/<project>/_workitems/edit/<ID>`
> 2. **Connected Board View Link** (highlights the ticket directly on the team's board):
>    - Jira: `https://<org>.atlassian.net/jira/software/c/projects/<PROJ>/boards/<BOARD_ID>?selectedIssue=<KEY>`
>    - Azure DevOps: `https://dev.azure.com/<org>/<project>/_boards/board/t/<Team>/<Board>?workitem=<ID>`

---

## 3. Board-Suited Structured Outputs & Multi-Platform Formatting

`tkt` automatically adapts inputs and outputs to the connected board:

1. **Jira Cloud & Data Center**:
   - Converts Markdown (headings, tables, bold/italic/code, links, bullet/numbered lists, `[ ]` / `[x]` checkboxes, fenced code blocks, blockquotes) into native **Atlassian Document Format (ADF v1)**.
   - Automatically injects any **required board filter labels** discovered from the board's JQL filter so new tickets never vanish from the board.
2. **Azure DevOps Boards (Agile, Scrum, Basic, CMMI)**:
   - Converts Markdown into clean HTML and **automatically splits sections across Azure DevOps's dedicated board fields**:
     - `## Acceptance Criteria` $\rightarrow$ `Microsoft.VSTS.Common.AcceptanceCriteria`
     - `## Repro Steps` $\rightarrow$ `Microsoft.VSTS.TCM.ReproSteps` (critical for ADO Bug cards, which often hide `System.Description`!)
     - `## System Info` $\rightarrow$ `Microsoft.VSTS.TCM.SystemInfo`
   - Automatically applies the connected Team's **Default Area Path** (`System.AreaPath`) and **Default Iteration Path** (`System.IterationPath`) via `application/json-patch+json`.
3. **Structured Output Modes (`--format`)**:
   - `--format human`: Rich terminal tables and previews.
   - `--format agent`: Token-efficient JSON with `boardColumn`, `status`, `directUrl`, and `boardViewUrl`.
   - `--format json`: Full `StructuredBoardOutput` envelope including board columns and hook execution metadata.
   - `--format md`: Ready-to-paste GitHub/Markdown tables and cards.

---

## 4. Command Reference

```bash
# 1. Test connection & see connected board
npx tkt me

# 2. Inspect connected board columns, statuses, placement rules & required fields
npx tkt board-schema
npx tkt discover

# 3. Search tickets on the connected board
npx tkt search --board-only --format agent
npx tkt search --column "In Progress" --assignee me
npx tkt search "project = AIEAE ORDER BY created DESC"   # Raw JQL (Jira) or WIQL/keyword (ADO)

# 4. Get full ticket details & comments
npx tkt get AIEAE-1871
npx tkt get 1042 --profile ado-main

# 5. View valid status transitions & mapped Board Columns
npx tkt transitions AIEAE-1871

# 6. Print standard templates (story | bug | epic | initiative)
npx tkt template --type story

# 7. Preview ticket creation (Pre-Hook Dry Run)
npx tkt create \
  --type Story \
  --summary "[Auth] Add OAuth2 token refresh retry" \
  --description-file ./draft-story.md \
  --parent AIEAE-100 \
  --priority High \
  --dry-run

# 8. Execute ticket creation after human approval
npx tkt create \
  --type Story \
  --summary "[Auth] Add OAuth2 token refresh retry" \
  --description-file ./draft-story.md \
  --parent AIEAE-100 \
  --priority High \
  --yes

# 9. Move a ticket to a specific Board Column or update fields/comments
npx tkt update AIEAE-1871 \
  --column "Tech Assessment" \
  --comment "Completed initial spike; ready for review." \
  --yes
```

---

## 5. Grounding, Duplicate Detection & Ambiguity Gate

1. **Grounding First**: Before asking the user questions, search the local repository and existing board tickets (`npx tkt search`) so every question you ask includes a concrete, pre-researched default hypothesis.
2. **Duplicate Check**: `tkt create` automatically searches for plausible duplicates on the target project/board and displays them in the Pre-Hook Preview.
3. **Provenance (`Filed by:`)**: Include a `**Filed by:**` line at the bottom of AI-drafted descriptions noting what the agent inferred (e.g., priority rubric or duplicate check) versus what the reporter stated.
