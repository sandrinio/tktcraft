# Copilot compatibility evidence

Contract baseline: 2026-10-20. Candidate package: `tktcraft` 0.2.3, unreleased
working-tree changes. This is an implementation baseline, not a support claim.

## Verification status

| Environment | Contract source | Tested agent version | Runtime status |
| --- | --- | --- | --- |
| VS Code, Local harness | VS Code Local hooks reference | VS Code 1.142.0 arm64 installed; harness not verified | Pending: no live payload captured |
| VS Code, Copilot SDK agent host | GitHub Copilot hook reference; observed consumer chats | VS Code 1.142.0 arm64 installed; exact SDK build not captured | Read-only discovery/context plus native deny/error/timeout controls observed; unattended `ask` allowed the inert command, so human approval is not certified |
| Copilot CLI, interactive | GitHub Copilot hook reference | Not available on PATH | Blocked: no live session captured |
| Copilot CLI, autopilot | GitHub Copilot hook reference | Not tested | Not supported for this interactive workflow |
| Copilot cloud agent | GitHub Copilot hook reference | Not tested | Excluded by the plan |

The `.agents/skills/tkt-ops` directory remains the documented skill discovery
location; its small entry points to the full workflow in `.tktcraft/skills/`.
Discovery does not prove invocation or hook enforcement. Existing
`.agents/hooks.json` registration is not Copilot registration. The experimental
adapter now uses one `.github/hooks/tkt-governance.json` registration, installed
automatically alongside the existing harness.

## Harness-specific contracts

| Surface | VS Code Local | Copilot CLI / VS Code Copilot harness |
| --- | --- | --- |
| Hook discovery | `.github/hooks/*.json`; workspace trust and `chat.useHooks` apply | `.github/hooks/*.json`; repository admission and runtime policy apply |
| Native configuration | `hooks.PreToolUse`, `hooks.PostToolUse`, `command`, `timeout` | `version: 1`, `hooks.preToolUse`, `hooks.postToolUse`, `bash`/`powershell`/`command`, `timeoutSec` |
| Input | `tool_name`, `tool_input`, `cwd`; ISO timestamp | `toolName`, `toolArgs`, `cwd`; numeric timestamp |
| Terminal names / arguments | Must be observed in the selected version's debug logs; do not assume another harness's tool name | Runtime names include `bash` and `powershell`; capture argument schemas from the target version |
| Pre-tool permission | `hookSpecificOutput.permissionDecision`: `allow`, `deny`, `ask` | Top-level `permissionDecision`: `allow`, `deny`, `ask`; `ask` is denied in autopilot |
| Post-tool result | `tool_response` (string or object) | `toolResult: { resultType: "success", textResultForLlm: string }` |
| Post-tool context | `hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext }` | Top-level `additionalContext`; do not replace the result merely to add a reminder |
| Directory | `cwd` resolves relative to the repository root | `cwd` resolves relative to the repository root or is absolute; sandbox grants still apply |
| Exit behavior | `0` processes stdout; `2` blocks with stderr; other codes warn and continue | Command pre-tool errors/nonzero exits deny; command timeouts fail open to normal permissions |
| Disabled hooks | No hook enforcement; settings are Local-specific | No hook enforcement; disable settings, enterprise policy, admission, and sandbox access apply |

Local can read a versioned Copilot configuration, but still emits its **Local**
payload. Registering separate Local and Copilot files could execute governance
twice. The adapter distinguishes runtime inputs and serializes the corresponding
outputs, rather than inferring a runtime from file discovery alone. The shipped
registration uses native camelCase events; do not replace them with Copilot
PascalCase aliases, which change input field naming.

The sanitized [contract fixtures](tests/fixtures/copilot-hook-contracts.json)
retain the documentation-derived baseline and separately label observed Copilot
SDK shapes. Local terminal names remain placeholders. The observed read-only
`bash` tool used `toolArgs.command`, `description`, and optionally `initial_wait`;
post results used `resultType` and `textResultForLlm`. Values in the committed
fixture are sanitized replacements, not raw traffic. Automated adapter tests
still use synthetic commands; they are not themselves live evidence.

## Experimental adapter (CP-02)

[The adapter](src/hooks/copilot.ts) accepts the documented Local and Copilot
envelopes and command-shaped terminal arguments (`command`, `CommandLine`, or
`cmd`). Unrelated tools and read-only commands return `{}` to preserve the
runtime's normal permission checks, not a blanket `allow`. Writes return native
`ask` decisions; deletion returns `deny`.

Previews are recognized only for direct supported invocations (`tkt`,
`tktcraft`, `npx [--no-install] tkt`, or Node running `bin/tkt.js`/`src/cli.ts`)
with a standalone, unquoted, case-sensitive `--dry-run` flag. Compound shell
commands, substitutions, and ambiguous wrappers conservatively request
confirmation for mutations. Quoted marker text is not a preview exemption.
This tightens the earlier substring check without changing the legacy decision
envelope or redesigning approval tokens.

Post-tool results support human/Markdown links, JSON/agent CLI outputs, and
documented result wrappers. Both links are injected as additional context.
A write result missing either link reports an error and advises read-back
before retrying. Malformed inputs, staging failures, and Copilot launcher
failures exit `2` with explicit stderr rather than success-shaped output.
Legacy consumers retain their existing JSON envelopes.

## Installed-package launcher (CP-03)

Setup installs `.tktcraft/hooks/tkt-hook.cjs`, pointing to the exact package that ran
setup. The package's `bin/tkt-hook.cjs` launches `bin/tkt.js` using the current
Node executable and argument arrays, never interpolating package paths into a
shell command. No global `tkt`, source checkout layout, or `npx` download is
required. The existing pre/post-hook JSON contracts remain unchanged.

Installation modes covered by this design:

- Persistent local npm installation (including workspace paths with spaces).
- Persistent global installation: the generated launcher binds to that package
  path rather than depending on `tkt` being on the agent's PATH.
- Source checkout: the checked-in launcher resolves the adjacent package.

The automated checks exercise external workspaces, a compiled package layout
under `node_modules`, shell metacharacters in package paths, legacy-registration
upgrades, and missing-runtime failures. Local validation uses macOS and Node
25.9.0; other OS/runtime versions and real-agent execution are not certified.

Node must be available to the hook command as `node`. Keep the installation that
ran setup: an ephemeral `npx` cache is not a persistent runtime guarantee.
After moving/removing an installation, reinstall and rerun setup. An unchanged
managed launcher can be rebound using its recorded hash. Setup reports edited
launchers or customized governance instead of silently overwriting them;
review/reconcile the named file before retrying.

Rerunning setup installs missing hook files even if a shared skill already
exists. Exact legacy registrations are upgraded; unrelated hooks and customized
skills are preserved.

On upgrades, an existing owned `.agents/tkt-hook.cjs` becomes a small forwarding
shim. New workspaces need no launcher outside `.tktcraft/`.

## Safe installation and onboarding (CP-04 / CP-05)

[The installer](src/setup/agent-integration.ts) preflights conflicts before
writing integration files. It records SHA-256 hashes in the local, ignored
`.tktcraft/agent-integration.json` manifest and upgrades only unchanged managed
content. It does not execute or evaluate manifest values.

- One Copilot file is installed; no duplicate Local registration is added.
- Unrelated hook files and legacy-registration sections remain intact.
- Existing root `AGENTS.md` is reused; otherwise existing
  `.github/copilot-instructions.md` is reused; otherwise `AGENTS.md` is created.
- Only a marked minimal instruction block is managed. Unrelated text is
  preserved byte-for-byte, including text around an upgraded block.
- Customized governance/launcher files or instruction blocks cause a conflict.
  Customized skills are preserved and listed in setup's output.
- Missing shared-skill resources are installed independently of skill presence.
- Setup returns `agentIntegration.status: "installed"` and
  `agentIntegration.verifiedActive: false`; it never certifies live activation.

[Onboarding](ONBOARDING.md) gives one installation/setup path and an existing-user
upgrade path. No agent-selection question is required.

## Local validation results

Executed on 2026-10-20 with Node 25.9.0 and npm 11.12.1 on macOS:

| Check | Result |
| --- | --- |
| Focused layout, launcher, adapter, and installer tests | 39 passed |
| Full existing and new default test suite | 56 passed |
| `npm run test:package` | 1 passed; builds and exercises a real npm archive installation |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `git diff --check` | Passed |
| Candidate `npm pack --ignore-scripts` asset inspection | Required launchers, Copilot registration, skill, compiled adapter/installer, and evidence document included; no credential files, `.tkt/`, `.tktcraft/`, or CI workflows |
| Offline npm archive install into unrelated workspace with spaces | Passed |
| Installed compiled wizard, repeated scaffolding, both native pre/post contracts, malformed-input exit, and installed onboarding | Passed; canonical launcher/workflow/templates and minimal external skill entry verified |
| Default mock-only CLI flow | Preview shape and duplicate lookup verified; zero mutations before simulated approval; mock create placement and both links verified |
| Run-owned npm archive and temporary workspace cleanup | Verified removed |
| Real provider create/read/update/read | Passed for Azure DevOps and Jira Cloud after separate explicit create/update approvals |
| Read-only provider follow-up | Complete normalized description/acceptance text, exact titles, labels, parent, placement, and board visibility passed for both providers |
| VS Code Copilot SDK read-only consumer chats | Both providers: skill/instruction discovery, native pre/post execution, and post-context canary delivery observed |
| Real native write-permission interaction | Pending; provider CLI writes and read-only agent success do not certify approval/decline |
| Autonomous native controls, no provider access | `deny` and exit `2` blocked; 15-second timeout failed open; unattended `ask` allowed the inert control |

The repeatable package test exercises the scaffolding function directly to
avoid remote setup or writes. Its type-only dependency is sourced from the
existing local installation, so the test needs no network or populated npm
cache. CI now runs this test before publishing is eligible.

The default flow test uses a loopback-only mock server and synthetic credentials.
Its denial is simulated, not a real-agent permission dialog. Neither test is
evidence of provider authentication, board visibility, or agent hook activation.

The canonical `.tktcraft/` layout was introduced after the original native SDK
probes. Package tests verify its discovery entry and registered launchers, but
those earlier runtime observations do not certify discovery of the new entry
or resolve the outstanding native human-confirmation gate.

Read-only provider verification was rerun with canonical credentials and
installed assets for Azure item `3201` and Jira `SCRUM-66`. Exact normalized
body text, title, placement and board visibility passed again. No remote
mutation was performed, and both run-owned workspaces/archives were removed.

## Opt-in live provider verification

[The live runner](scripts/copilot-live.mjs) is separate from the default tests.
It requires provider credentials provisioned in ignored `.tktcraft/.env`, a project and
an explicitly user-selected board. Never put tokens in arguments or reports.
Use an evidence path outside the checkout, retain it between phases, and run
providers sequentially when sharing a report.

```bash
npm run test:live -- --provider ado --project "<PROJECT>" \
  --board "<USER_SELECTED_BOARD>" --phase preview-create \
  --report "<ABSOLUTE_EVIDENCE_PATH>"
```

Use `--provider jira` for Jira. The default phase is `preview-create`; it does
not create a ticket. Subsequent invocations reuse all target/report options:

1. Show the exact saved create preview and obtain explicit human approval.
2. Run `--phase create --approve-preview "<PREVIEW_DIGEST>"` once.
3. Run `--phase preview-update`, show that title-only update preview, and obtain
   a **new** explicit approval.
4. Run `--phase update --approve-preview "<NEW_PREVIEW_DIGEST>"` once.
5. Use `--phase read` for additional read-only checks of the recorded ticket.

A digest checks preview consistency; it is not proof of approval or permission
to repeat a mutation. The runner regenerates the preview before writing, uses
the recorded ticket instead of guessing an ID, records write attempts, and
does not automatically retry writes. After an ambiguous failure, search for the
run marker or read back the saved ticket before considering another attempt.

Each phase packs and installs the candidate into a fresh unrelated directory
with spaces, checks the archive for secret/config inclusion, and removes its
run-owned local archive/workspace in `finally`. Temporary credential files use
mode `0600`; the source `.tktcraft/.env` remains untouched. Cleanup paths and outcomes
are recorded. Hard process termination is not certified for cleanup recovery.
Remote tickets are never deleted.

Both providers passed these live phases on 2026-10-20. The final read-only
checks compared full normalized text (not merely required substrings), including
Azure's separate acceptance field. This is not byte-for-byte markup equality,
and no original pre-update body snapshot was captured. Provider URLs, ticket
IDs, marker, package hashes, previews, read-back results, and local cleanup
evidence are retained in the sanitized local report rather than published here.
No credentials were committed, pushed, published, or included in evidence.

## Observed VS Code runtime probe

Two dedicated consumer chats used the installed package in unrelated workspaces,
one per selected provider board. Both loaded the shared `tkt-ops` skill, managed
instructions, routing index, and connected board guide without a manually
selected agent. Both read the existing test ticket and returned its title,
status, and both required links.

The fixture launcher forwarded native inputs to the installed hook, recorded
only key/type/decision metadata, and appended an unpredictable verification
marker to post-hook `additionalContext`. Both final chat responses repeated the
matching marker. This demonstrates post-context delivery beyond merely seeing
the same URLs in CLI stdout. It does not certify native write permissions.
Fixture CLIs intercepted all mutations before provider access; neither chat
performed a remote write.

An initial `npx` permission error was caused by the probe's own mutation wrapper
omitting executable metadata, not by the packaged CLI. Running through Node
succeeded; after correcting the fixture's shebang/mode, both chats also passed
the normal `npx --no-install tkt get` invocation. Hook payload `cwd` resolved
to the correct workspace by canonical realpath despite macOS path aliases.
The sanitized local probe report retains telemetry and cleanup results; no raw
command arguments, environment contents, or credentials were logged by it.

### Autonomous native permission/error/timeout controls

The user requested unattended testing, so no human dialog interaction is
claimed. A credential-free installed workspace issued only inert `printf`
commands containing synthetic tracker text and `example.invalid` links. No
actual ticket command, provider connection, or HTTP request occurred.

| Control | Observed native result |
| --- | --- |
| Production adapter `deny` on literal policy-test text | Tool blocked; hook exited `0` with native denial |
| Malformed input injected into installed adapter | Adapter exited `2`; tool blocked |
| Fixture delayed pre-hook output for 20 seconds | Tool executed after 15.063 seconds under the shipped 15-second timeout, before delayed output was available |
| Unmodified native `ask` response | Tool executed under the unattended SDK permission policy; human approval not established |

No timeout diagnostic reached the test agent. The measured delay and native
post-hook success establish fail-open behavior in this tested SDK host, not in
every Copilot environment. Full telemetry, tested archive hash, exact synthetic
controls, and cleanup results are retained in a separate sanitized local report.

**Do not treat `ask` as proof of an enforced human confirmation dialog.** This
run does not certify approval/decline, and the staged token is not human consent.
Instructions still require a concrete preview and explicit approval of each
real change. Unattended Copilot ticket writes remain unsupported. Do not
silently replace `ask` with `allow`, simulate a human click, or enable an approval
bypass to turn this limitation into a passing test.

## Remaining verification gates

1. Capture the exact active SDK build and corresponding evidence for Local and
   Copilot CLI; one observed SDK host is not all Copilot environments.
2. Verify the implemented CP-02 through CP-06 behavior in actual agent sessions,
   beyond the observed SDK read/control flows, especially actual human
   approval/decline under the target permission policy.
3. Preserve CP-07's ignored-credential, user-selected-board, concrete-preview,
   and separate-approval rules for any additional mutations. Existing approved
   provider creates and updates have already executed; do not repeat them.
   Never delete remote test tickets.
4. Approved provider writes through actual harnesses and trust/disabled behavior
   remain unverified. SDK denial, explicit error, and timeout controls above
   are scoped to the observed host; Local and CLI need their own evidence.
5. Finalize support claims only from that evidence (CP-08).

The existing staged approval token is not proof of human approval and does not
bind an exact command or expiry. This slice does not change that boundary.

## Official sources

Reviewed on 2026-10-20:

- [VS Code hooks and harness selection](https://code.visualstudio.com/docs/agent-customization/hooks)
- [VS Code Local hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference)
- [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Copilot CLI instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [VS Code skill locations and discovery](https://code.visualstudio.com/docs/agent-customization/agent-skills)

Copilot CLI documents `.github/copilot-instructions.md` and `AGENTS.md` among its
instruction locations. The installer reuses these entry points without
overwriting unrelated user text.
