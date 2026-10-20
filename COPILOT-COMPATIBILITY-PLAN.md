# Copilot Compatibility Plan

Status: Execution started on 2026-10-20. CP-02 through CP-06 are implemented and
locally verified against documented contracts. CP-07 live provider create/read/
update/read checks passed for both providers after explicit approvals. CP-01
runtime captures and CP-07 real-agent verification remain open; Copilot support
is experimental.

## Execution Progress

- **CP-01 in progress:** captured official harness-specific contracts in
  [the compatibility evidence](COPILOT-COMPATIBILITY.md) and sanitized
  [reference fixtures](tests/fixtures/copilot-hook-contracts.json). These are
  documentation-derived baseline envelopes. A separately labeled observed
  Copilot SDK fixture now records real read-only `bash` argument/result shapes.
  Exact SDK builds, Local/CLI captures, and native permission behavior remain
  unverified.
- **CP-03 implemented:** package-bound launcher, explicit missing-runtime
  errors, external-workspace and compiled-package tests, and legacy hook
  registration migration. Unrelated/customized hooks are preserved or reported
  as conflicts. Automated tests cover paths containing spaces and shell
  metacharacters. The initial slice passed 19 tests (expanded in CP-06 below),
  type-check and build, and an offline npm archive install in a throwaway workspace.
  Required package assets and local cleanup were verified; no provider was
  contacted by that smoke test.
- **CP-02 implemented against documented contracts:** native Local/Copilot
  decisions and post-hook context, strict malformed-input/staging failures,
  shared governance, and one versioned registration. Runtime capture
  certification remains part of CP-01/CP-07.
- **CP-04 implemented:** integration assets install independently of skill
  presence; a local hash manifest upgrades only unmodified managed content.
  Unrelated hooks and instruction text are retained; custom conflicts are
  surfaced before integration writes.
- **CP-05 implemented:** one onboarding path, existing-user upgrade guidance,
  and minimal shared-skill/board instructions. Setup explicitly reports files
  installed, not verified active.
- **CP-06 locally verified:** 56 default tests plus a separate passing npm
  archive install test; type-check and build pass. The default flow test uses
  only a loopback mock provider. Package tests exercise both native pre/post
  envelopes, error exits, asset inclusion, repeated installation, and cleanup.
  CI runs the package gate.
- **Canonical workspace layout implemented:** state, credentials, full skills,
  templates and launchers live in `.tktcraft/`. Only small native discovery and
  registration entries stay outside. Legacy state/assets migrate with explicit
  conflict handling and customization preservation; root `.env` remains a
  read-only fallback. Layout/migration regression tests and the real archive
  install test pass. Original SDK discovery evidence predates this layout.
- **CP-07 partially verified:** both user-selected boards passed real packaged
  create/read/update/read tests, with separate concrete previews and explicit
  create/update approvals. Read-only follow-up checks verify complete normalized
  description/acceptance text, exact titles, labels, parent, placement, and
  board-scoped visibility. Remote tickets are retained; run-owned local folders
  and archives were removed. Sanitized evidence remains outside the checkout.
  [The opt-in runner](scripts/copilot-live.mjs) defaults to preview-only and never
  treats a preview digest as proof of human consent.
- **CP-07 read-only SDK runtime checks passed:** dedicated Azure/Jira consumer
  chats loaded the shared skill, instructions, routing index and board guides.
  Instrumented installed hooks observed native pre/post envelopes and delivered
  unpredictable post-context markers that both agents repeated. Fixture CLIs
  intercepted mutations; these chats made no remote changes.
- **CP-07 autonomous native controls recorded:** a credential-free fixture
  issued only inert `printf` commands. Production `deny` and adapter exit `2`
  blocked execution. A 20-second pre-hook delay failed open after 15.063 seconds
  under the shipped 15-second timeout. Native `ask` allowed its inert command
  under the unattended SDK policy; no human approval/decline is certified.
  All control workspaces were removed. No provider access or actual ticket
  command occurred in these controls.
- **CP-01/CP-07 remaining gates and CP-08 remain open.** VS Code 1.142.0 arm64
  was located despite `code` being absent from PATH, but the exact active SDK
  build was not captured. Actual human approval/decline and approved writes
  through harnesses, Local, and trust/disabled behavior remain unverified.
  SDK error/timeout controls do not certify other environments. Copilot CLI
  verification is unavailable in the user's VS Code-only environment.
  Provider CLI success and read-only SDK success do not certify these gates.

## Goal

A nontechnical user connects their board once, then manages tickets through
Claude Code, Antigravity, or GitHub Copilot without manually choosing or
configuring an agent.

## Scope

### Included

- GitHub Copilot in VS Code and Copilot CLI.
- Automatic installation of supported integration files.
- Shared skills, board configuration, and governance logic.
- Safe upgrades for existing users.
- Packaged-install and real-agent verification.

### Excluded initially

- Copilot cloud agent and unattended ticket creation.
- A new MCP server.
- Unrelated CLI redesign or broad approval-system changes.

## Current Architecture

- The shared operational skill is already available in
  [.agents/skills/tkt-ops/SKILL.md](.agents/skills/tkt-ops/SKILL.md), a location
  supported by Copilot.
- Existing hook registration is in
  [.agents/hooks.json](.agents/hooks.json). Copilot needs registration in a
  location it discovers and responses that match its runtime contract.
- Shared hook logic is in
  [src/hooks/agent-harness.ts](src/hooks/agent-harness.ts).
- Workspace integration scaffolding is in
  [src/setup/wizard.ts](src/setup/wizard.ts).
- Published assets are controlled by [package.json](package.json).
- Repository instructions exist in [AGENTS.md](AGENTS.md), but setup does not
  currently install equivalent always-on guidance into consumer workspaces.

Skill discovery alone does not establish hook compatibility or active enforcement.

## Work Item Summary

These are proposed work items in this document, not tickets created on either
remote system. Each item can be reviewed and delivered separately.

| ID | Work item | Depends on | Completion evidence |
| --- | --- | --- | --- |
| CP-01 | Verify Copilot contracts and capture fixtures | None | Versioned support matrix and verified payload fixtures |
| CP-02 | Implement Copilot hook adapter and registration assets | CP-01 | Focused adapter and executable-boundary tests |
| CP-03 | Fix installed-package launcher resolution | None | Launcher tests outside the source checkout |
| CP-04 | Install and upgrade integration assets safely | CP-02, CP-03 | Repeatable scaffolding and package-content tests |
| CP-05 | Simplify onboarding and instruction discovery | CP-04 | New-user and existing-user walkthroughs |
| CP-06 | Complete automated integration and regression coverage | CP-02, CP-04, CP-05 | Passing focused tests, type-check, build, and relevant regressions |
| CP-07 | Run live E2E tests in throwaway workspaces against Jira and Azure DevOps | CP-06 | Remote read-back evidence, real-agent checks, and local cleanup verification |
| CP-08 | Finalize documentation and support claims | CP-07 | Documentation matching verified behavior |

## CP-01: Establish the Integration Contract

**Depends on:** None.

Verify the behavior of each supported Copilot environment before implementation:

- Skill and instruction discovery.
- Terminal-tool names and command payloads.
- Pre-hook approval and blocking responses.
- Post-hook result and context injection.
- Hook execution directory and command resolution.
- Hook errors, timeouts, trust requirements, and disabled-hook behavior.

Use verified payloads as test fixtures. Distinguish VS Code's Local harness from
its Copilot harness rather than assuming identical runtime contracts.

### Deliverable

A documented support matrix with tested versions and limitations. Do not claim
support for every Copilot experience based on a single successful session.

## CP-02: Add the Copilot Hook Adapter

**Depends on:** CP-01.

Reuse the governance logic in
[src/hooks/agent-harness.ts](src/hooks/agent-harness.ts), with a thin adapter that:

- Reads Copilot's tool-call format.
- Translates existing allow, deny, and confirmation decisions into Copilot's
  expected responses.
- Handles post-tool results and preserves direct ticket and board-view links.
- Leaves existing integrations' contracts unchanged.
- Reports malformed relevant inputs and execution failures explicitly.

Add a dedicated hook configuration under Copilot's recognized `.github/hooks/`
location. Reuse the shared skill instead of maintaining a duplicate Copilot skill.

### Acceptance Criteria

- Read-only commands and previews work without unnecessary approval.
- Ticket deletion is denied.
- Writes request explicit confirmation.
- Successful writes supply both required links.
- Existing hook consumers retain their current input and output contracts.
- Focused tests cover input normalization, response serialization, and process
  exit behavior at the executable boundary.

## CP-03: Make Installed-Package Launcher Resolution Reliable

**Depends on:** None.

The existing hook configuration uses a relative launcher path that is not
guaranteed to work in a separate user project. Compatibility must work from an
installed package, not only from this source checkout.

Resolve the installed executable reliably without relying on the consumer
workspace having the package's source-tree layout. Cover the installation modes
that will be documented as supported.

### Acceptance Criteria

- The launcher works outside this source checkout.
- Paths containing spaces work.
- Missing executables or assets produce actionable errors.
- Existing integrations retain working command resolution.

## CP-04: Install and Upgrade Integration Assets Safely

**Depends on:** CP-02 and CP-03.

Update [workspace scaffolding](src/setup/wizard.ts) and
[package contents](package.json) to:

- Install Copilot assets alongside existing integrations.
- Install missing assets even when the shared skill already exists.
- Preserve unrelated user instructions and hooks.
- Make repeated setup safe and avoid duplicate hook execution.
- Surface conflicts instead of overwriting user customizations.

Keep new integration installation independent of the existing skill-presence
guard. Do not require a missing skill before adding missing Copilot assets.

### Acceptance Criteria

- A packaged installation works in a clean, unrelated workspace.
- Paths containing spaces work.
- Existing workspaces receive missing integration assets on repeated setup.
- Unrelated configuration remains unchanged.
- Repeated setup does not register hooks more than once.
- Package-content tests verify all required integration assets are included.

## CP-05: Provide Simple Onboarding and Upgrades

**Depends on:** CP-04.

### New Users

1. Follow one short installation and onboarding entry point.
2. Connect Jira or Azure DevOps.
3. Choose their board.
4. Let setup install supported agent integrations automatically.
5. Start a new assistant session if required, following clear setup instructions.

Users should choose their board, not learn hook formats or configuration folders.
Provide an initial onboarding entry point rather than assuming an unconfigured
assistant already knows how to discover or run the CLI.

### Existing Users

Rerun setup to add Copilot support without losing existing configuration.

### Instruction Handling

Provide minimal always-on guidance pointing to the shared skill and board
context. Reuse existing instruction entry points where possible and avoid
duplicating the entire workflow or introducing conflicting instructions.

### Setup Messaging

Distinguish these outcomes:

- **Integration files installed:** setup has written the required assets.
- **Integration verified active:** the current assistant has demonstrably loaded
  and executed the integration.

Do not claim active verification merely because files were copied. Explain any
remaining restart, trust, or activation step in plain language.

## CP-06: Complete Automated Integration and Regression Coverage

**Depends on:** CP-02, CP-04, and CP-05.

Consolidate cross-component coverage after the focused tests delivered with each
implementation item. Use mocks and fixtures for remote writes in the default
test suite; live provider testing belongs to CP-07.

| Check | Required outcome |
| --- | --- |
| Read-only command | No unnecessary approval |
| Dry run | Preview produced; no remote write |
| Write command | Explicit confirmation requested |
| User declines | No remote write |
| Delete attempt | Blocked |
| Successful write | Direct ticket and board links available |
| Existing workspace | Custom instructions and hooks preserved |
| Repeated setup | No duplicate registrations |
| Existing shared skill | Copilot integration still installed |
| Packaged install | Hooks run outside the source repository |
| Paths containing spaces | Launcher and hook execution succeed |
| Relevant malformed payload | Explicit error; no misleading success |
| Existing Claude/Antigravity integrations | Existing behavior preserved |

### Automated Validation

- Add focused adapter, executable-boundary, and scaffolding tests.
- Cover stdin parsing, JSON output, and process exit behavior.
- Verify packaged asset inclusion and external-workspace command resolution.
- Run focused tests first, then type-check, build, and the relevant regression
  suite using existing tooling.
- Extend [the existing tests](tests/tkt.test.ts) or add focused test files using
  the repository's existing test runner.

## CP-07: Live E2E Tests in Throwaway Workspaces

**Depends on:** CP-06.

### Objective

Prove the newly built CLI can be installed into an unrelated, disposable folder,
configured for each provider, and used to create and update real tickets through
the intended confirmation workflow. Delete the local test folders after testing.

### Target Environments

| Provider | Target | Required selection before testing |
| --- | --- | --- |
| Azure DevOps | https://dev.azure.com/ssuladze0549/K1-DEV | Team and board |
| Jira Cloud | https://sandrosuladze.atlassian.net/ | Project and board |

The supplied URLs identify environments, not authorization to use an arbitrary
board. List available boards and obtain the user's selection before setup.
Obtain any missing authentication details, including the Jira account email if
required by the supported authentication method.

### Credential Handling

- Rotate the credentials pasted into chat before running the tests.
- Have the user provision replacement credentials directly into an ignored
  `.env` file; do not ask them to paste replacement secrets into chat.
- Keep credentials out of this plan, source files, command arguments, package
  archives, test reports, and logs.
- Use credentials with only the permissions required for the selected test
  projects and boards.
- Never enable an approval bypass to make an unattended test pass.

### Test Procedure

1. Build the candidate package and produce an npm package archive from the
   current implementation. Inspect package contents for required assets and
   accidental secret inclusion.
2. Create uniquely named throwaway workspaces outside the source checkout,
   including a path containing spaces. Record the exact directories created.
   Initialize a minimal project and install the candidate archive locally,
   without modifying the user's global CLI installation.
3. Run the installed executable from the throwaway workspace, not the source
   checkout. Verify that skill, hook, and launcher assets are available.
4. Load provider credentials from the ignored `.env` file. List projects or
   teams as needed, list boards, obtain the user's board selection, and complete
   setup using the selected board. Read back the connected schema and identity.
5. Generate a unique test-run marker. Search the selected board for matching
   prior test items before creating anything. Do not blindly retry a create
   after an ambiguous response; search or read back first.
6. For each provider, draft one clearly labeled E2E test ticket using a type and
   fields supported by the selected board. Include the test-run marker and
   provenance in its description.
7. Run a create dry run and show the structured confirmation preview, including
   board placement and duplicate results. Obtain explicit approval before
   executing the create. Record and display both the direct ticket link and
   connected board-view link.
8. Read the created ticket back from the provider. Verify its title, supported
   description or dedicated fields, required labels or area/iteration placement,
   and visibility in a board-scoped search. Assert observed values rather than
   accepting a successful HTTP status alone.
9. Preview a deterministic update to that same test ticket, such as a title or
   description change supported by the CLI and board schema. Obtain explicit
   approval, execute the update, and display both links again. Read it back and
   assert the exact expected field changes.
10. Repeat setup and verify integration files are not duplicated and existing
    user customization fixtures remain intact.
11. Exercise the installed integration in actual Copilot CLI and the supported
    VS Code harnesses. Confirm skill discovery, hook activation, declined-write
    behavior, approved writes, and post-hook links against both providers.
    Reuse the marked test tickets for approved updates where possible instead
    of creating unnecessary additional tickets.
12. Save sanitized evidence outside the throwaway folders before local cleanup.
    Do not call CLI-only success proof of real-agent compatibility.

### Cleanup and Failure Handling

- Always attempt local cleanup after success, failure, or cancellation, using a
  finally-style cleanup path.
- Remove only exact, recorded test directories and package archives created by
  this run. Never remove the source repository, shared caches, global
  installations, unrelated directories, or user-owned credential files.
- Verify the temporary directories are gone. If cleanup fails, report the exact
  remaining paths without exposing credentials.
- Never delete, purge, or remove remote tickets. The throwaway folder is
  disposable; remote test tickets are not.
- If desired, preview and obtain approval to transition test tickets to a
  board-supported closed or cancelled state and add a test-completion comment.
  Treat this as another remote update, not automatic cleanup.
- Record remote ticket IDs as soon as available so partial failures remain
  traceable even after local cleanup.
- Test deletion rejection only with mocks or an intercepted request that cannot
  reach either provider.

### Acceptance Criteria and Evidence

- The candidate package installs and runs in an unrelated workspace.
- Both providers pass create, read-back, update, and second read-back checks.
- Remote writes occur only after the relevant preview and explicit approval.
- Each remote create or update surfaces direct and board-view links.
- Real Copilot sessions verify the integration, not just direct CLI execution.
- An opt-in live-test entry point is repeatable without putting remote writes
  into the default unit test suite.
- A sanitized report records package version, agent versions, selected boards,
  test-run marker, assertions, ticket links, and cleanup results.
- The report distinguishes passed, failed, and blocked checks. Missing credentials,
  unavailable agent sessions, or unapproved writes are blocked, not passed.
- All run-owned temporary directories are removed, or any cleanup failure is
  explicitly reported.

## CP-08: Finalize User Documentation and Support Claims

**Depends on:** CP-07.

Update [README.md](README.md), [SETUP.md](SETUP.md), and
[ONBOARDING.md](ONBOARDING.md) with:

- Supported Copilot environments and tested limitations.
- One onboarding path.
- Existing-user upgrade steps.
- How to verify the integration loaded.
- Plain-language troubleshooting.

Update the shared skill only where agent-specific assumptions need clarification;
keep the ticket-management workflow shared.

## Approval Boundary

The current [approval mechanism](src/hooks/engine.ts) does not bind its staged
approval token to an exact command or expiration time.

This work must preserve the explicit preview-and-confirm workflow, but must not
describe that token as proof of human approval. Stronger approval-token
guarantees should be a separate, explicitly reviewed change.

Hook enforcement also depends on the selected agent's runtime, trust settings,
and hook execution behavior. Document those boundaries instead of promising
unconditional enforcement.

## Recommended Implementation Order

1. Start CP-01 and CP-03 independently.
2. Complete CP-02 after contract verification.
3. Complete CP-04 when the adapter assets and launcher are ready.
4. Complete CP-05, then CP-06.
5. Run CP-07 only after board selection, replacement credential provisioning, and
   approval of the concrete write previews.
6. Complete CP-08 using the verified results.

Documentation drafts and focused tests should accompany their implementation
items; CP-08 finalizes the support claims rather than postponing all documentation.

## Review Decision

Recommended default: install supported integrations automatically, with no
agent-selection question and no overwriting of existing user configuration.

This is the proposed experience, not functionality already implemented.

## References

- [Copilot skill discovery](https://code.visualstudio.com/docs/agent-customization/agent-skills)
- [VS Code hook compatibility](https://code.visualstudio.com/docs/agent-customization/hooks)
- [Copilot hook reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
