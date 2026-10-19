# Agent Workspace Directives (`tkt`)

This repository contains **`tkt`** (`tkt-board-cli`), an open-source CLI and AI Agent harness for **Jira** (Cloud & Data Center) and **Azure DevOps Boards** featuring mandatory board-selection setup, board-suited structured outputs, and dual-layer **Pre-Hooks & Post-Hooks**.

---

## 1. Core Operational Rules for AI Agents

1. **Onboarding & Connection Setup**:
   - When a user asks to set up or connect Jira or Azure DevOps, follow [SETUP.md](SETUP.md) step-by-step.
   - **Mandatory Board Selection Rule**: During setup, always list the project's boards (`tkt boards`) and let the user choose which board to connect to before running `tkt setup --board "<BOARD_ID>"`.
2. **Board-Aware Operations**:
   - Consult `.tkt/boards/<profile>.md` or run `tkt board-schema` to see the connected board's exact **Columns $\leftrightarrow$ Statuses**, **Auto-Placement Rules** (required Jira labels or Azure DevOps `AreaPath`/`IterationPath`), and **Issue / Work-Item Type schemas**.
   - Use `.agents/skills/tkt-ops/SKILL.md` for ticket triage, templates, and formatting rules.
3. **Pre-Hook Governance (Strict Enforcement)**:
   - **NO DELETE**: Never attempt to delete, remove, or purge tickets in Jira or Azure DevOps. Both `.agents/hooks.json` (`PreToolUse`) and the `tkt` CLI hard-block deletion.
   - **Pre-Execution Confirmation**: Never run `tkt create` or `tkt update` with `--yes` without first showing the user the structured **Pre-Hook Confirmation Preview** (or running `--dry-run`) and receiving their explicit confirmation.
4. **Post-Hook Output Rule**:
   - After every `tkt create` or `tkt update`, always display **both** the **Direct Ticket Link** and the **Connected Board View Link** returned by the CLI post-hook.
5. **Secret Isolation**:
   - Keep credentials strictly in `.env` (never in `.tkt/config.json` or git commits).
