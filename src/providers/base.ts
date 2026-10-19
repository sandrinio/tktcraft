import type {
  ConnectedBoardConfig,
  CreateTicketInput,
  SearchTicketsInput,
  TransitionOption,
  UnifiedTicket,
  UpdateTicketInput,
} from '../types.ts';

export interface AuthenticatedUserInfo {
  id: string;
  displayName: string;
  email?: string;
  provider: 'jira' | 'ado';
  baseUrl: string;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  projectType?: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  type: string;
  projectKey?: string;
  teamName?: string;
  teamId?: string;
}

export interface DuplicateCandidate {
  key: string;
  summary: string;
  status: string;
  directUrl: string;
}

export interface TrackerProvider {
  readonly providerType: 'jira' | 'ado';

  /** Verify credentials and return current authenticated user */
  testConnection(): Promise<AuthenticatedUserInfo>;

  /** List accessible projects */
  listProjects(): Promise<ProjectSummary[]>;

  /** List boards available in a given project (used during `tkt setup`) */
  listBoards(projectKeyOrName: string): Promise<BoardSummary[]>;

  /**
   * Deeply introspect a chosen board during `tkt setup` or `tkt discover`:
   * - Columns <-> Statuses
   * - Board filter / required labels / default AreaPath & IterationPath
   * - Issue / Work-item types and their required/custom fields
   * - Active Sprint / Iteration
   */
  introspectBoard(
    projectKeyOrName: string,
    board: BoardSummary
  ): Promise<ConnectedBoardConfig>;

  /** Fetch a single ticket by key/ID and map it to the connected board's columns */
  getTicket(key: string): Promise<UnifiedTicket>;

  /** Search tickets using JQL/WIQL or structured board filters */
  searchTickets(input: SearchTicketsInput): Promise<UnifiedTicket[]>;

  /** Search for potential duplicate tickets before creating a new ticket (learned from Jira MCP skill) */
  findDuplicates(
    projectKeyOrName: string,
    issueType: string,
    summary: string
  ): Promise<DuplicateCandidate[]>;

  /** List valid status transitions or state changes for a ticket */
  getTransitions(key: string): Promise<TransitionOption[]>;

  /** Create a ticket on the connected board */
  createTicket(input: CreateTicketInput): Promise<UnifiedTicket>;

  /** Update a ticket, add a comment, or transition its board column / status */
  updateTicket(input: UpdateTicketInput): Promise<UnifiedTicket>;
}
