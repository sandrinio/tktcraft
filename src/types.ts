/**
 * Core unified types for `tkt` — Multi-Provider (Jira & Azure DevOps)
 * Board-Aware CLI with Pre-Hooks and Post-Hooks.
 */

export type ProviderType = 'jira' | 'ado';

export type OutputFormat = 'human' | 'json' | 'agent' | 'md';

export type BoardArchetype =
  | 'scrum'
  | 'kanban'
  | 'discovery'
  | 'roadmap'
  | 'bug-triage'
  | 'custom';

export interface BoardColumnMapping {
  /** Column name shown on the visual board (e.g. "💡 Idea Captured", "In Progress", "Doing") */
  columnName: string;
  /** Underlying workflow status/state name(s) mapped to this column */
  statuses: string[];
  /** Optional status IDs (for Jira) */
  statusIds?: string[];
  /** Category: todo | in_progress | done */
  category?: 'todo' | 'in_progress' | 'done';
}

export interface BoardFieldDefinition {
  key: string;
  name: string;
  required: boolean;
  type: string;
  allowedValues?: Array<{ id?: string; name: string; value?: string }>;
}

export interface BoardIssueTypeSchema {
  id: string;
  name: string;
  subtask: boolean;
  description?: string;
  /** Valid statuses/states for this specific issue/work-item type on this board */
  statuses?: string[];
  /** Discovered required and notable custom fields for this issue type */
  fields: BoardFieldDefinition[];
  /** Dedicated acceptance criteria field key (e.g. Microsoft.VSTS.Common.AcceptanceCriteria in ADO) */
  acceptanceCriteriaField?: string;
  /** Dedicated repro steps field key (e.g. Microsoft.VSTS.TCM.ReproSteps in ADO) */
  reproStepsField?: string;
  /** Dedicated system info field key (e.g. Microsoft.VSTS.TCM.SystemInfo in ADO) */
  systemInfoField?: string;
}

export interface BoardPlacementRules {
  /**
   * Required labels/tags automatically injected on ticket creation so that
   * the ticket passes the board's JQL/WIQL filter and appears on the board.
   */
  requiredLabels?: string[];
  /** Jira JQL filter string discovered from the board */
  filterQuery?: string;
  /** Jira Filter ID */
  filterId?: string;
  /** Azure DevOps Team Name */
  teamName?: string;
  /** Azure DevOps Team ID */
  teamId?: string;
  /** Azure DevOps default Area Path for the selected board's team */
  defaultAreaPath?: string;
  /** Azure DevOps default Iteration Path for the selected board's team */
  defaultIterationPath?: string;
  /** Active sprint ID (Jira) or iteration path (ADO) */
  activeSprintId?: string | number;
  activeSprintName?: string;
}

export interface ConnectedBoardConfig {
  /** Board ID (numeric ID in Jira, GUID or name in Azure DevOps) */
  id: string;
  /** Display name of the selected board */
  name: string;
  /** Native board type from provider (e.g. "scrum", "kanban", "simple", "Stories", "Epics") */
  boardType: string;
  /** Inferred or user-selected board archetype */
  archetype: BoardArchetype;
  /** Direct web URL to view this board */
  boardUrl: string;
  /** URL template to open a specific ticket highlighted on this board (replaces {key}) */
  selectedTicketBoardUrlTemplate: string;
  /** Ordered list of columns on this board and their underlying statuses */
  columns: BoardColumnMapping[];
  /** Issue / Work Item types available on this board and their field schemas */
  issueTypes: BoardIssueTypeSchema[];
  /** Automatic placement rules so created tickets always show up on this board */
  placement: BoardPlacementRules;
  /** Custom field aliases configured for this board (e.g. { "theme": "customfield_13790" }) */
  customFieldAliases?: Record<string, string>;
  /** Custom value maps for custom fields (e.g. { "theme": { "input innovation": "25094" } }) */
  customFieldValueMaps?: Record<string, Record<string, string>>;
  /** Timestamp when board schema was last synced */
  syncedAt: string;
}

export interface HookScriptConfig {
  name: string;
  command: string;
  timeoutMs?: number;
  blocking?: boolean;
}

export interface ProfileGovernanceConfig {
  /** Always block delete/remove/purge actions (Default: true) */
  forbidDelete: boolean;
  /** Require confirmation or --yes before create/update (Default: true) */
  requireConfirmation: boolean;
  /** Validate issue type and required fields against the connected board schema (Default: true) */
  enforceBoardSchema: boolean;
  /** Automatically apply board placement rules (labels / area path) on create (Default: true) */
  autoApplyBoardPlacement: boolean;
  /** Automatically append audit log entries to .tkt/audit.jsonl (Default: true) */
  auditLog: boolean;
  /** Optional custom pre-hooks */
  preHooks?: HookScriptConfig[];
  /** Optional custom post-hooks */
  postHooks?: HookScriptConfig[];
}

export interface TktProfile {
  /** Profile identifier (e.g. "default", "jira-discovery", "ado-sprint") */
  name: string;
  provider: ProviderType;
  /** Base URL (e.g. https://org.atlassian.net or https://dev.azure.com/org) */
  baseUrl: string;
  /** Project Key (Jira, e.g. "AIEAE") or Project Name (Azure DevOps, e.g. "MyProject") */
  project: string;
  /** Auth mode: basic (Jira Cloud), bearer (Jira DC), pat (ADO) */
  authType?: 'cloud' | 'datacenter' | 'pat' | 'bearer';
  /** Env variable names holding credentials (keeps secrets out of .tkt/config.json) */
  envVars?: {
    url?: string;
    user?: string;
    token?: string;
  };
  /** The mandatory board connected during `tkt setup` */
  board: ConnectedBoardConfig;
  /** Pre-hook and post-hook governance settings */
  governance: ProfileGovernanceConfig;
}

export interface TktWorkspaceConfig {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, TktProfile>;
}

export interface TicketComment {
  id: string;
  author: string;
  created: string;
  body: string;
}

export interface UnifiedTicket {
  key: string;
  provider: ProviderType;
  project: string;
  issueType: string;
  summary: string;
  status: string;
  /** Resolved board column name on the connected board */
  boardColumn?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  parentKey?: string;
  labels: string[];
  description: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  areaPath?: string;
  iterationPath?: string;
  storyPoints?: number;
  customFields?: Record<string, unknown>;
  created?: string;
  updated?: string;
  /** Direct URL to the ticket/work-item */
  directUrl: string;
  /** Deep-link URL to the ticket highlighted on the connected board */
  boardViewUrl: string;
  /** Connected board metadata */
  boardName?: string;
  boardId?: string;
  comments?: TicketComment[];
}

export interface CreateTicketInput {
  project?: string;
  issueType: string;
  summary: string;
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  parentKey?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  /** Target board column or workflow status */
  columnOrStatus?: string;
  areaPath?: string;
  iterationPath?: string;
  storyPoints?: number;
  customFields?: Record<string, string>;
  dryRun?: boolean;
  yes?: boolean;
}

export interface UpdateTicketInput {
  key: string;
  summary?: string;
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  comment?: string;
  /** Target board column name OR workflow status/state name */
  columnOrStatus?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  parentKey?: string;
  areaPath?: string;
  iterationPath?: string;
  customFields?: Record<string, string>;
  dryRun?: boolean;
  yes?: boolean;
}

export interface SearchTicketsInput {
  /** Raw JQL / WIQL or natural keyword filter */
  query?: string;
  /** Restrict search to the connected board's filter/items */
  boardOnly?: boolean;
  statusOrColumn?: string;
  issueType?: string;
  assignee?: string;
  maxResults?: number;
}

export interface TransitionOption {
  id: string;
  name: string;
  toStatus: string;
  mappedBoardColumn?: string;
}

export interface StructuredBoardOutput<T> {
  ok: boolean;
  action: string;
  provider: ProviderType;
  profile: string;
  project: string;
  board: {
    id: string;
    name: string;
    type: string;
    archetype: BoardArchetype;
    boardUrl: string;
    columns: Array<{ column: string; statuses: string[] }>;
  };
  links?: {
    directUrl: string;
    boardViewUrl: string;
  };
  hooks?: {
    preHooksPassed: string[];
    postHooksExecuted: string[];
    warnings?: string[];
  };
  data: T;
}
