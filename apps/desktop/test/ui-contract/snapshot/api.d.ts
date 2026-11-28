import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { Conversation } from "./model/index.ts";
export type LocationTransport = {
    type: "ssh";
    host: string;
    command?: string[];
};
export type LocationConfig = {
    id: string;
    name: string;
    kind: "local";
} | {
    id: string;
    name: string;
    kind: "remote";
    transport: LocationTransport;
};
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";
export type LocationStatus = {
    locationId: string;
    state: ConnectionState;
    error?: string;
    capabilities?: {
        queue: boolean;
        steer?: boolean;
        files: boolean;
        folders: boolean;
        filesInFolder?: boolean;
        stopSubagent?: boolean;
        trust?: boolean;
        connectors?: boolean;
        plugins?: string[];
        agentSetup?: boolean;
        storage?: boolean;
        agentPrewarm?: boolean;
        sessionMentions?: boolean;
        fs?: boolean;
        diff?: boolean;
        terminal?: boolean;
        environments?: boolean;
        worktrees?: boolean;
        vault?: boolean;
    };
    incompatible?: {
        with: "daemon" | "app" | "unknown";
        supported: string[];
        requested: string;
        command?: string;
    };
    daemon?: {
        version: string;
        upgrade?: {
            to: string;
            command: string;
            running?: boolean;
            error?: string;
            waiting?: boolean;
        };
    };
};
export type SessionSummary = {
    locationId: string;
    sessionId: string;
    cwd: string;
    title?: string;
    archived: boolean;
    agent: string;
    state: "running" | "idle" | "requires_action" | "stopped";
    lastSeq: number;
    unread?: boolean;
    background?: number;
    unknownBackground?: string[];
    updatedAt?: string;
    config?: Record<string, string>;
    environment?: SessionEnvironmentSummary;
    worktree?: WorktreeSummary;
    origin?: SessionOrigin;
};
export type SessionOriginRole = "dev" | "qa" | "review" | "research" | "research_qa" | "triage" | "shape" | "shape_qa" | "graph_planner";
export type SessionOrigin = {
    kind: "loop";
    project?: string;
    run?: string;
    role?: SessionOriginRole;
};
export type WorktreeSummary = {
    root: string;
    path: string;
    branch?: string;
    managed: boolean;
    setupFailed?: string;
};
export type GitBranches = {
    branches: string[];
    current?: string | undefined;
    defaultBranch?: string | undefined;
};
export type UnsavedWork = {
    files: string[];
    commits: string[];
};
export type EnvironmentScripts = {
    default?: string;
    macos?: string;
    linux?: string;
    windows?: string;
};
export type EnvironmentAction = {
    id: string;
    name: string;
    icon?: string;
    command: EnvironmentScripts;
};
export type EnvironmentSecret = {
    name: string;
    from?: string;
};
export type Environment = {
    id: string;
    name: string;
    setup?: EnvironmentScripts;
    cleanup?: EnvironmentScripts;
    variables: {
        name: string;
        value: string;
    }[];
    secrets: EnvironmentSecret[];
    actions: EnvironmentAction[];
};
export type EnvironmentsState = {
    environments: Environment[];
    defaults: Record<string, Record<string, string>>;
};
export type SessionEnvironmentSummary = {
    id: string;
    name: string;
    variableNames: string[];
    secretNames: string[];
    actions: {
        id: string;
        name: string;
        icon?: string;
    }[];
};
export type EnvironmentProblem = {
    problem: "name_missing";
} | {
    problem: "invalid_variable";
    name: string;
} | {
    problem: "duplicate_variable";
    name: string;
} | {
    problem: "reserved_variable";
    name: string;
} | {
    problem: "action_name_missing";
} | {
    problem: "action_id_invalid";
} | {
    problem: "action_command_missing";
    action: string;
} | {
    problem: "too_large";
    limit: number;
} | {
    problem: "invalid";
    message: string;
};
export type AgentInfo = {
    id: string;
    name: string;
    available: boolean;
    configSchema: Record<string, unknown>;
    promptCapabilities?: {
        image?: object | null | undefined;
        audio?: object | null | undefined;
        embeddedContext?: object | null | undefined;
    } | undefined;
    steer?: boolean | undefined;
};
export type AgentBinarySource = "builtin" | "configured" | "path" | "missing";
export type AgentBinaryProblem = "missing" | "version_too_old" | "probe_failed";
export type AgentBinaryStatus = {
    source: AgentBinarySource;
    path?: string | undefined;
    version?: string | undefined;
    minVersion?: string | undefined;
    problem?: AgentBinaryProblem | undefined;
};
export type AgentAuthState = "binary_unavailable" | "signed_out" | "signing_in" | "signed_in" | "signing_out" | "auth_unknown";
export type AgentAuthUnknownReason = "network_error" | "timeout" | "probe_failed";
export type AgentAuthMethod = "subscription" | "api_key" | "oauth_token" | "third_party" | "none" | "unknown";
export type AgentAuthMode = "browser" | "code" | "device_code";
export type AgentSignInMode = {
    mode: AgentAuthMode;
    requiresLocalLoopback: boolean;
};
export type AgentAccountInfo = {
    email?: string | undefined;
    organization?: string | undefined;
    plan?: string | undefined;
    expiresAt?: number | undefined;
    tierObservedAt?: number | undefined;
};
export type AgentAuthStatus = {
    state: AgentAuthState;
    unknownReason?: AgentAuthUnknownReason | undefined;
    method: AgentAuthMethod;
    viaEnv?: string | undefined;
    account?: AgentAccountInfo | undefined;
    signInModes: AgentSignInMode[];
    canSignOut: boolean;
    loginCommand: string;
};
export type AgentAuthProblemReason = "binary_unavailable" | "auth_in_progress" | "parse_failed" | "invalid_code" | "expired" | "cancelled" | "process_failed" | "timeout" | "unsupported_mode" | "untrusted_url" | "flow_not_found" | "flow_forbidden" | "flow_consumed" | "flow_not_active" | "disconnected" | "failed";
export type AgentAuthStartAnswer = {
    started: true;
    flowId: string;
    mode: AgentAuthMode;
    expiresAt: number;
    host?: string | undefined;
    hasUrl: boolean;
    userCode?: string | undefined;
} | {
    started: false;
    reason: AgentAuthProblemReason;
};
export type AgentAuthSubmitAnswer = {
    ok: true;
} | {
    ok: false;
    reason: AgentAuthProblemReason;
};
export type AgentAuthLogoutAnswer = {
    ok: true;
} | {
    ok: false;
    reason: AgentAuthProblemReason;
};
export type AgentRuntimeValue = boolean | number | string;
export type AgentRuntimePatchValue = AgentRuntimeValue | null;
export type AgentRuntimeSaveAnswer = {
    saved: true;
    values: Record<string, AgentRuntimeValue>;
    overrides: string[];
    revision: number;
} | {
    saved: false;
    problem: "revision_conflict" | "invalid_config" | "file_corrupt" | "failed";
    currentRevision?: number | undefined;
    field?: string | undefined;
    message?: string | undefined;
};
export type AgentRuntimeSnapshot = {
    schemaVersion: 1;
    schema: {
        type: "object";
        properties: Record<string, unknown>;
    };
    values: Record<string, AgentRuntimeValue>;
    overrides: string[];
    revision: number;
    fileError?: string | undefined;
};
export type AgentConfigFileStatus = {
    path: string;
    exists: boolean;
    stale: boolean;
    error?: string | undefined;
};
export type AgentRuntimeDiagnostics = {
    configFile: AgentConfigFileStatus;
    dataDir: string;
    customDataDir: boolean;
    allowEnv: string[];
    envNames: string[];
};
export type AgentSetupSnapshot = {
    agent: string;
    name: string;
    available: boolean;
    binary: AgentBinaryStatus;
    auth: AgentAuthStatus;
    planUsage?: PlanUsage | undefined;
    canRefreshUsage: boolean;
    runtime: AgentRuntimeSnapshot;
    environment: AgentRuntimeDiagnostics;
};
export type PromptBlock = {
    type: "text";
    text: string;
} | {
    type: "image";
    data: string;
    mimeType: string;
} | {
    type: "resource_link";
    name: string;
    uri: string;
    _meta?: Record<string, unknown>;
} | {
    type: "resource";
    resource: Record<string, unknown>;
    _meta?: Record<string, unknown>;
};
export type FileHit = {
    path: string;
    kind: "file" | "folder";
};
export type FileSearch = {
    root: string;
    entries: FileHit[];
    truncated: boolean;
};
export type FileEntry = {
    name: string;
    kind: "file" | "folder" | "other";
    link?: boolean | undefined;
    size?: number | undefined;
    ignored?: boolean | undefined;
};
export type FileListing = {
    root: string;
    path: string;
    entries: FileEntry[];
    truncated: boolean;
};
export type FileContent = {
    path: string;
    size: number;
    mtimeMs: number;
} & ({
    kind: "text";
    text: string;
    offset: number;
    next: number | null;
} | {
    kind: "image";
    mimeType: string;
    data?: string | undefined;
    tooLarge?: boolean | undefined;
} | {
    kind: "binary";
});
export type WorkspaceFile = {
    path: string;
    status: "added" | "modified" | "deleted" | "untracked";
    additions?: number | undefined;
    deletions?: number | undefined;
    binary?: boolean | undefined;
    folder?: boolean | undefined;
};
export type WorkspaceStatus = {
    state: "ok";
    head: string | null;
    files: WorkspaceFile[];
    truncated: boolean;
} | {
    state: "not_git";
} | {
    state: "untrusted";
    repository: string;
};
export type WorkspacePatch = {
    path: string;
    patch: string;
    truncated: boolean;
    binary: boolean;
};
export type TerminalInfo = {
    terminalId: string;
    sessionId: string;
    title: string;
    cols: number;
    rows: number;
    status: "running" | "exited";
    exitCode?: number | null | undefined;
};
export type TerminalAttached = {
    terminal: TerminalInfo;
    screen: string;
    seq: number;
};
export type TerminalProblem = "limit" | "archived" | "not_found" | "cwd_missing" | "spawn_failed" | "daemon_stopping" | "unknown_action" | "failed";
export type FolderListing = {
    path: string;
    parent: string | null;
    home: string;
    folders: {
        name: string;
    }[];
    truncated: boolean;
};
export type FolderTrust = {
    path: string;
    trusted: boolean | null;
    from: string | null;
};
export type ConnectorTransport = {
    type: "http";
    url: string;
} | {
    type: "stdio";
    command: string;
    args: string[];
    cwd?: string | undefined;
};
export type ConnectorAuth = {
    type: "none";
} | {
    type: "oauth";
    clientId?: string | undefined;
    scopes?: string[] | undefined;
};
export type ConnectorInfo = {
    id: string;
    name: string;
    enabled: boolean;
    transport: ConnectorTransport;
    auth: ConnectorAuth;
    secrets: {
        headers: string[];
        env: string[];
    };
    authorized: boolean;
    status: {
        state: "ready" | "needs_auth" | "disabled" | "error";
        reason?: "unreachable" | "auth_failed" | "spawn_failed" | "protocol" | undefined;
    };
    origin?: {
        type: "plugin";
        agentId: string;
        pluginId: string;
        pluginName?: string | undefined;
        server: string;
    } | undefined;
    requires?: string[] | undefined;
};
export type ConnectorSecrets = {
    headers?: Record<string, string | null>;
    env?: Record<string, string | null>;
};
export type ConnectorDraft = {
    name: string;
    enabled?: boolean;
    transport: ConnectorTransport;
    auth: ConnectorAuth;
    secrets?: ConnectorSecrets;
};
export type ConnectorChange = Partial<ConnectorDraft>;
export type ConnectorProblem = "invalid_name" | "reserved_header" | "invalid_cwd" | "name_taken" | "insecure_url" | "state_mismatch" | "no_registration" | "managed" | "auth_rejected" | "unreachable" | "not_found" | "invalid" | "unsupported" | "failed";
export type ConnectorAnswer = {
    connector: ConnectorInfo;
} | {
    problem: ConnectorProblem;
    message?: string;
};
export declare const PROVIDER_APIS: readonly ["openai-completions", "openai-responses", "anthropic-messages"];
export type ProviderApi = (typeof PROVIDER_APIS)[number];
export declare const CUSTOM_PROVIDER_KIND = "custom";
export type ProviderModel = {
    id: string;
    name: string;
    reasoning: boolean;
    images: boolean;
    contextWindow: number;
    maxTokens: number;
};
export type ProviderKind = {
    id: string;
    name: string;
};
export type ProviderInfo = {
    id: string;
    name: string;
    kind: string;
    api: ProviderApi | null;
    baseUrl: string | null;
    hasKey: boolean;
    models: ProviderModel[];
};
export type ProviderDraft = {
    id?: string | undefined;
    name: string;
    kind: string;
    api: ProviderApi | null;
    baseUrl: string | null;
    apiKey?: string | undefined;
    models: ProviderModel[];
};
export type ProviderProblem = "invalid" | "not_found" | "failed";
export type ProviderAnswer = {
    provider: ProviderInfo;
} | {
    problem: ProviderProblem;
    message?: string;
};
export type VaultProblem = "invalid" | "failed";
export type VaultAnswer = {
    done: true;
} | {
    problem: VaultProblem;
    message?: string;
};
export type StorageItem = {
    id: string;
    kind: "cache" | "history";
    bytes: number;
};
export type StorageAgent = {
    agent: string;
    name: string;
    managed: boolean;
    items: StorageItem[];
};
export type StorageCleanProblem = "busy" | "unmanaged" | "unknown_agent" | "failed";
export type StorageCleanAnswer = {
    cleaned: true;
    freedBytes: number;
} | {
    cleaned: false;
    problem: StorageCleanProblem;
    message: string;
};
export type ProvidersRead = {
    providers: ProviderInfo[];
    kinds: ProviderKind[];
};
export type PluginSourceInfo = {
    agentId: string;
    id: string;
    name: string;
    kind: "builtin" | "git" | "directory" | "url" | "other";
    location?: string | undefined;
    removable: boolean;
};
export type PluginInfo = {
    agentId: string;
    id: string;
    name: string;
    description?: string | undefined;
    version?: string | undefined;
    sourceId: string;
    installed: boolean;
    enabled?: boolean | undefined;
    scope?: "user" | "project" | undefined;
    contents?: {
        skills: number;
        commands: number;
        agents: number;
        hooks: number;
        mcpServers: number;
    } | undefined;
    servers?: {
        name: string;
        by: "cycle" | "agent";
        connectorId?: string | undefined;
    }[] | undefined;
    builtin?: boolean | undefined;
    icon?: string | undefined;
};
export type PluginProblem = "not_found" | "needs_command" | "unavailable" | "timeout" | "unsupported" | "failed";
export type PluginFailure = {
    problem: PluginProblem;
    message?: string;
};
export type ListFolders = (path?: string, hidden?: boolean) => Promise<FolderListing>;
export type PermissionOption = {
    optionId: string;
    name: string;
    kind: string;
};
export type PermissionRequest = {
    key: string;
    locationId: string;
    sessionId: string;
    title: string;
    subject?: unknown;
    options: PermissionOption[];
    subagentId?: string;
    form?: {
        message: string;
        schema: unknown;
    };
};
export type FormAnswer = {
    action: "accept";
    content: Record<string, string | number | boolean | string[]>;
} | {
    action: "decline";
} | {
    action: "cancel";
};
export type SessionSnapshot = {
    conversation: Conversation;
    permissions: PermissionRequest[];
    version: number;
};
export type UpdateState = {
    current: string;
} & ({
    kind: "disabled";
    reason: string;
} | {
    kind: "idle";
} | {
    kind: "checking";
} | {
    kind: "up-to-date";
    checkedAt: number;
} | {
    kind: "available";
    version: string;
} | {
    kind: "downloading";
    version: string;
    received: number;
    total: number;
    how?: "difference" | "whole";
} | {
    kind: "installing";
    version: string;
} | {
    kind: "error";
    message: string;
    version?: string;
});
export type InterfaceState = {
    bundled: number;
    running: number;
    ready?: number;
};
export type PlanWindow = {
    kind: string;
    utilization: number;
    resetsAt: number;
    status?: "allowed" | "allowed_warning" | "rejected" | undefined;
};
export type PlanUsage = {
    windows: PlanWindow[];
    at: number;
};
export type AccountStatus = {
    state: "signed-out" | "signed-in" | "offline" | "reauth";
    open: boolean;
    signingIn: boolean;
    user?: {
        name: string;
        email: string;
    };
    reason?: "expired" | "revoked";
    problem?: "failed" | "unreachable";
    switched?: boolean;
};
export type AppEvent = {
    type: "account";
    account: AccountStatus;
} | {
    type: "locations";
    locations: LocationConfig[];
} | ({
    type: "location-status";
} & LocationStatus) | {
    type: "sessions";
    locationId: string;
    sessions: SessionSummary[];
} | {
    type: "update";
    locationId: string;
    sessionId: string;
    update: SessionUpdate;
    at?: number;
    version: number;
} | {
    type: "permission";
    request: PermissionRequest;
    version: number;
} | {
    type: "permission-closed";
    locationId: string;
    sessionId: string;
    key: string;
    version: number;
} | {
    type: "agent-defaults";
    locationId: string;
    agent: string;
} | {
    type: "agent-setup-changed";
    locationId: string;
    agent: string;
    revision?: number;
} | {
    type: "agent-auth-completed";
    locationId: string;
    flowId: string;
    agent: string;
    ok: boolean;
    reason?: AgentAuthProblemReason | undefined;
} | {
    type: "plan-usage";
    locationId: string;
    agent: string;
    usage: PlanUsage;
} | {
    type: "connectors";
    locationId: string;
} | {
    type: "providers";
    locationId: string;
} | {
    type: "plugins";
    locationId: string;
    agentId: string;
} | {
    type: "session-gone";
    locationId: string;
    sessionId: string;
} | {
    type: "app-update";
    state: UpdateState;
} | {
    type: "interface-update";
    state: InterfaceState;
} | {
    type: "terminals";
    locationId: string;
    sessionId: string;
    terminals: TerminalInfo[];
} | {
    type: "terminal-output";
    locationId: string;
    terminalId: string;
    seq: number;
    data: string;
} | {
    type: "terminal-reset";
    locationId: string;
    terminalId: string;
    seq: number;
    screen: string;
    cols: number;
    rows: number;
} | {
    type: "focus-session";
    locationId: string;
    sessionId: string;
} | {
    type: "open-loop-ticket";
    projectKey: string;
    identifier: string;
} | {
    type: "loop-runs";
    runs: LoopRunsAnswer;
} | {
    type: "loop-activity";
    projectKeys: string[];
};
export type AnalyticsStatus = {
    available: boolean;
    enabled: boolean;
    noticed: boolean;
};
export declare const THEME_CHOICES: readonly ["system", "light", "dark"];
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export declare const LANGUAGE_CHOICES: readonly ["system", "en-US", "zh-CN"];
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];
export type Preferences = {
    theme: ThemeChoice;
    language: LanguageChoice;
    promptSuggestions: boolean;
    worktreeAgents: string[];
    loopActor: string;
};
export type PreferencesState = Preferences & {
    systemLanguage: string;
};
export type TrackProps = Record<string, string | number | boolean>;
export declare const ENVIRONMENT_REFUSALS: readonly ["reserved_variable", "invalid_variable", "missing_secret", "too_large", "invalid_environment", "missing", "needs_fix", "not_a_repository", "invalid_name", "invalid_base"];
export type EnvironmentRefusal = {
    reason: (typeof ENVIRONMENT_REFUSALS)[number];
    name?: string;
};
export type NewSession = {
    cwd: string;
    agent?: string;
    config?: Record<string, string>;
    environmentId?: string;
    worktree?: {
        base?: string;
    };
};
export type SendVia = "enter" | "shortcut" | "button";
export type AppApi = {
    locations(): Promise<{
        locations: LocationConfig[];
        status: LocationStatus[];
        sessions: Record<string, SessionSummary[]>;
    }>;
    saveLocation(location: LocationConfig): Promise<void>;
    removeLocation(locationId: string): Promise<void>;
    connect(locationId: string): Promise<void>;
    disconnect(locationId: string): Promise<void>;
    sessions(locationId: string): Promise<SessionSummary[]>;
    createSession(locationId: string, params: NewSession): Promise<string | {
        problem: EnvironmentRefusal;
    }>;
    openSession(locationId: string, sessionId: string): Promise<SessionSnapshot>;
    prompt(locationId: string, sessionId: string, content: string | PromptBlock[], options?: {
        steer?: boolean;
        via?: SendVia;
    }): Promise<void>;
    cancel(locationId: string, sessionId: string): Promise<void>;
    searchFiles(locationId: string, where: {
        sessionId: string;
    } | {
        cwd: string;
    }, query: string): Promise<FileSearch>;
    listFiles(locationId: string, sessionId: string, path: string): Promise<FileListing>;
    readFile(locationId: string, sessionId: string, path: string, offset?: number): Promise<FileContent>;
    workspaceStatus(locationId: string, sessionId: string): Promise<WorkspaceStatus>;
    workspaceFile(locationId: string, sessionId: string, path: string): Promise<WorkspacePatch>;
    listTerminals(locationId: string, sessionId: string): Promise<TerminalInfo[]>;
    createTerminal(locationId: string, sessionId: string, cols: number, rows: number, actionId?: string): Promise<TerminalAttached | {
        problem: TerminalProblem;
        message?: string;
    }>;
    attachTerminal(locationId: string, terminalId: string): Promise<TerminalAttached>;
    detachTerminal(locationId: string, terminalId: string): Promise<void>;
    terminalInput(locationId: string, terminalId: string, data: string): Promise<void>;
    resizeTerminal(locationId: string, terminalId: string, cols: number, rows: number): Promise<void>;
    closeTerminal(locationId: string, terminalId: string): Promise<void>;
    listFolders(locationId: string, path?: string, hidden?: boolean): Promise<FolderListing>;
    readTrust(locationId: string, path: string): Promise<FolderTrust>;
    planUsage(locationId: string): Promise<Record<string, PlanUsage>>;
    setTrust(locationId: string, path: string, trusted: boolean): Promise<FolderTrust>;
    ackReturn(locationId: string, sessionId: string, returnId: string): Promise<void>;
    dequeue(locationId: string, sessionId: string, queueId: string): Promise<PromptBlock[]>;
    setSessionConfig(locationId: string, sessionId: string, configId: string, value: string): Promise<void>;
    renameSession(locationId: string, sessionId: string, title: string, where?: "header" | "sidebar"): Promise<void>;
    dismissBackground(locationId: string, sessionId: string, taskIds: string[]): Promise<void>;
    stopSubagent(locationId: string, sessionId: string, childId: string, background: boolean): Promise<boolean>;
    archiveSession(locationId: string, sessionId: string, archived: boolean): Promise<void>;
    markRead(locationId: string, sessionId: string): Promise<void>;
    deleteSession(locationId: string, sessionId: string, discardWorktree?: boolean): Promise<{
        unsaved: UnsavedWork;
    } | undefined>;
    gitBranches(locationId: string, cwd: string): Promise<GitBranches | null>;
    answerPermission(key: string, optionId: string | "cancelled"): Promise<void>;
    answerForm(key: string, answer: FormAnswer): Promise<void>;
    agents(locationId: string): Promise<AgentInfo[]>;
    agentDefaults(locationId: string, agent: string): Promise<Record<string, string>>;
    setAgentDefaults(locationId: string, agent: string, config: Record<string, string>): Promise<void>;
    readAgentSetup(locationId: string, agent: string, options?: {
        refreshUsage?: boolean;
        forceRefresh?: boolean;
    }): Promise<AgentSetupSnapshot>;
    setAgentRuntimeSettings(locationId: string, agent: string, patch: Record<string, AgentRuntimePatchValue>, expectedRevision: number): Promise<AgentRuntimeSaveAnswer>;
    prewarmAgent(locationId: string, agent: string): Promise<void>;
    revealDaemonConfig(locationId: string): Promise<boolean>;
    startAgentAuth(locationId: string, agent: string): Promise<AgentAuthStartAnswer>;
    openAgentAuthUrl(locationId: string, flowId: string): Promise<boolean>;
    submitAgentAuth(locationId: string, flowId: string, code: string): Promise<AgentAuthSubmitAnswer>;
    cancelAgentAuth(locationId: string, flowId: string): Promise<void>;
    logoutAgent(locationId: string, agent: string): Promise<AgentAuthLogoutAnswer>;
    listConnectors(locationId: string): Promise<ConnectorInfo[]>;
    addConnector(locationId: string, draft: ConnectorDraft): Promise<ConnectorAnswer>;
    updateConnector(locationId: string, id: string, change: ConnectorChange): Promise<ConnectorAnswer>;
    removeConnector(locationId: string, id: string): Promise<{
        removed: true;
    } | {
        problem: ConnectorProblem;
        message?: string;
    }>;
    authorizeConnector(locationId: string, id: string): Promise<ConnectorAnswer | {
        cancelled: true;
    }>;
    cancelConnectorAuth(): Promise<void>;
    signOutConnector(locationId: string, id: string): Promise<ConnectorAnswer>;
    readStorage(locationId: string): Promise<StorageAgent[]>;
    cleanStorage(locationId: string, agent: string): Promise<StorageCleanAnswer>;
    listProviders(locationId: string): Promise<ProvidersRead>;
    providerCatalog(locationId: string, kind: string): Promise<ProviderModel[]>;
    saveProvider(locationId: string, draft: ProviderDraft): Promise<ProviderAnswer>;
    removeProvider(locationId: string, id: string): Promise<{
        removed: true;
    } | {
        problem: ProviderProblem;
        message?: string;
    }>;
    listVault(locationId: string): Promise<string[]>;
    setVaultItem(locationId: string, key: string, value: string): Promise<VaultAnswer>;
    removeVaultItem(locationId: string, key: string): Promise<VaultAnswer>;
    listPlugins(locationId: string, agentId: string): Promise<{
        sources: PluginSourceInfo[];
        plugins: PluginInfo[];
    }>;
    availablePlugins(locationId: string, query: {
        agentId: string;
        sourceId?: string;
        query?: string;
        cursor?: string;
        limit?: number;
    }): Promise<{
        plugins: PluginInfo[];
        nextCursor?: string | undefined;
        total: number;
    }>;
    installPlugin(locationId: string, agentId: string, id: string): Promise<{
        plugin: PluginInfo;
    } | PluginFailure>;
    uninstallPlugin(locationId: string, agentId: string, id: string): Promise<{
        removed: true;
    } | PluginFailure>;
    updatePlugin(locationId: string, agentId: string, id: string): Promise<{
        plugin: PluginInfo;
        updated: boolean;
    } | PluginFailure>;
    setPluginEnabled(locationId: string, agentId: string, id: string, enabled: boolean): Promise<{
        plugin: PluginInfo;
    } | PluginFailure>;
    addPluginSource(locationId: string, agentId: string, location: string): Promise<{
        source: PluginSourceInfo;
    } | PluginFailure>;
    removePluginSource(locationId: string, agentId: string, id: string): Promise<{
        removed: true;
    } | PluginFailure>;
    refreshPluginSources(locationId: string, agentId: string): Promise<{
        refreshed: true;
    } | PluginFailure>;
    chooseDirectory(): Promise<string | undefined>;
    copyText(text: string): Promise<boolean>;
    copyImage(type: string, data: string): Promise<boolean>;
    saveImage(name: string, type: string, data: string): Promise<ImageSaved>;
    updateState(): Promise<UpdateState>;
    checkForUpdate(): Promise<UpdateState>;
    installUpdate(): Promise<void>;
    interfaceState(): Promise<InterfaceState>;
    interfaceBooted(): Promise<void>;
    applyInterfaceUpdate(): Promise<void>;
    upgradeDaemon(locationId: string, when?: "now" | "later"): Promise<void>;
    environments(): Promise<EnvironmentsState>;
    saveEnvironment(environment: Environment): Promise<{
        state: EnvironmentsState;
    } | EnvironmentProblem>;
    removeEnvironment(environmentId: string): Promise<EnvironmentsState>;
    setEnvironmentDefault(locationId: string, cwd: string, environmentId: string | null): Promise<EnvironmentsState>;
    preferences(): Promise<PreferencesState>;
    setPreferences(change: Partial<Preferences>): Promise<PreferencesState>;
    account(): Promise<AccountStatus>;
    signIn(): Promise<AccountStatus>;
    cancelSignIn(): Promise<void>;
    signOut(): Promise<void>;
    track(event: string, props?: TrackProps): Promise<void>;
    analytics(): Promise<AnalyticsStatus>;
    setAnalytics(enabled: boolean): Promise<AnalyticsStatus>;
    loopProjects(): Promise<LoopProjectsAnswer>;
    workspaceRepo(cwd: string): Promise<string | null>;
    loopRuns(): Promise<LoopRunsAnswer>;
    loopBoard(projectKey: string): Promise<LoopBoardAnswer>;
    loopTimeline(projectKey: string, options?: {
        limit?: number;
        before?: string;
    }): Promise<LoopTimelineAnswer>;
    loopTicket(projectKey: string, identifier: string): Promise<LoopTicketAnswer>;
    loopRun(projectKey: string, identifier: string): Promise<LoopRunAnswer>;
    loopCancelRun(projectKey: string, identifier: string): Promise<LoopCancelRunResult>;
    loopRetryIntents(projectKey: string, identifier: string): Promise<LoopRetryIntentsResult>;
    loopNotices(projectKey: string): Promise<LoopNoticesAnswer>;
    loopChat(projectKey: string, identifier: string, agent?: string): Promise<LoopChatResult>;
    loopAct(projectKey: string, identifier: string, action: LoopAction, confirmed?: boolean, reason?: string): Promise<LoopActResult>;
    loopGraphAct(projectKey: string, identifier: string, nodeId: string, action: LoopGraphNodeAction, edits?: LoopGraphNodeEdits): Promise<LoopActResult>;
    loopActMany(projectKey: string, action: LoopManyAction, identifiers: string[], confirmed?: boolean, reason?: string): Promise<LoopManyResult>;
};
export type LoopProjectInfo = {
    name: string;
    projectKey: string;
    repo: {
        displayName: string;
        forge: "github" | "gitlab";
    };
};
export type LoopRunsAnswer = {
    kind: "ok";
    running: Record<string, string[]>;
} | {
    kind: "disconnected";
};
export type LoopProjectsAnswer = {
    kind: "ok";
    projects: LoopProjectInfo[];
} | {
    kind: "disconnected";
};
export type LoopTicket = {
    identifier: string;
    title: string;
    priority: string | null;
    type?: string | null;
    parent?: {
        identifier: string;
        title: string;
    } | null;
    column: string;
    pending?: {
        reason: string;
    };
    phase?: {
        name: string;
        since: string;
    };
    graph?: LoopGraphSummary;
};
export type LoopGraphSource = "single" | "plan_doc" | "auto_plan" | "auto_planner" | "edited";
export type LoopGraphNodeStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
export type LoopGraphNodeAction = "retry_node" | "skip_node" | "edit_node";
export type LoopGraphNodeEdits = {
    title?: string;
    goal?: string;
    verify?: string[];
};
export type LoopGraphSummary = {
    source: LoopGraphSource;
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    running: number;
    currentNodeId: string | null;
    currentNodeTitle: string | null;
};
export type LoopGraphNode = {
    id: string;
    position: number;
    origin: "planned" | "fix";
    title: string;
    goal: string;
    dependsOn: string[];
    filesHint: string[];
    verify: string[];
    status: LoopGraphNodeStatus;
    sessionId: string | null;
    commitSha: string | null;
    rounds: number;
    lastError: string | null;
    summary: string | null;
    startedAt: string | null;
    finishedAt: string | null;
};
export type LoopGraph = {
    runKey: string;
    source: LoopGraphSource;
    revision: number;
    currentNodeId: string | null;
    nodes: LoopGraphNode[];
    createdAt: string;
    updatedAt: string;
};
export type LoopChat = "new" | "watch" | "none";
export type LoopChatFailure = "needs_model" | "not_allowed" | "no_server" | "offline" | "refused" | "failed" | "no_folder" | "auth_required";
export type LoopChatResult = {
    kind: "started";
    locationId: string;
    sessionId: string;
} | {
    kind: "failed";
    reason: LoopChatFailure;
    sessionId?: string;
    locationId?: string;
};
export type LoopAction = "approve" | "return" | "to_backlog" | "to_todo";
export type LoopActFailure = "unconfirmed" | "no_server" | "forbidden" | "conflict" | "not_allowed" | "invalid_verify" | "offline" | "refused";
export type LoopActResult = {
    kind: "ok";
} | {
    kind: "failed";
    reason: LoopActFailure;
};
export type LoopManyAction = "approve_many" | "return_many";
export type LoopManyItem = {
    identifier: string;
    outcome: "ok";
} | {
    identifier: string;
    outcome: "skipped";
} | {
    identifier: string;
    outcome: "failed";
    reason: LoopActFailure;
};
export type LoopManyResult = {
    kind: "done";
    results: LoopManyItem[];
} | {
    kind: "failed";
    reason: LoopActFailure;
};
export type LoopNoticeKind = "permission" | "blocked" | "review" | "stuck" | "intent_stuck" | "supervisor" | "operator";
export type LoopNotice = {
    id: string;
    kind: LoopNoticeKind;
    identifier: string;
    text: string;
    session: {
        kind: string;
        id: string;
    } | null;
};
export type LoopNoticesAnswer = {
    kind: "ok";
    notices: LoopNotice[];
} | {
    kind: "no_server";
} | {
    kind: "unreachable";
};
export type LoopTicketDetail = Omit<LoopTicket, "graph"> & {
    actions: LoopAction[];
    chat: LoopChat;
    attention?: {
        kind: "blocked";
        text: string;
        session: {
            kind: string;
            id: string;
        } | null;
    } | {
        kind: "review";
        text: string;
        prUrl: string | null;
    };
    body: string;
    acceptance: string[];
    links: string[];
    graph?: LoopGraph;
};
export type LoopTicketAnswer = {
    kind: "ok";
    ticket: LoopTicketDetail;
} | {
    kind: "no_server";
} | {
    kind: "unreachable";
};
export type LoopRunDetail = {
    key: string;
    title: string;
    kind: "dev" | "research";
    phase: string;
    state: "active" | "blocked" | "done";
    round: number;
    startedAt: string;
    updatedAt: string;
    blockedReason: string | null;
    sessions: {
        kind: string;
        id: string;
    }[];
    prUrl: string | null;
    events: {
        ts: string;
        kind: string;
    }[];
    heartbeat: {
        at: string;
        detail: string | null;
    } | null;
    graph?: LoopGraph;
};
export type LoopRunAnswer = {
    kind: "ok";
    run: LoopRunDetail;
} | {
    kind: "none";
} | {
    kind: "no_server";
} | {
    kind: "unreachable";
};
export type LoopCancelRunResult = {
    kind: "ok";
    cancelled: boolean;
} | {
    kind: "failed";
    reason: LoopActFailure;
};
export type LoopRetryIntentsResult = {
    kind: "ok";
    retried: number;
} | {
    kind: "failed";
    reason: LoopActFailure;
};
export type LoopBoardColumn = {
    id: number;
    name: string;
    stateType: string;
    tickets: LoopTicket[];
    more: boolean;
};
export type LoopBoardAnswer = {
    kind: "ok";
    columns: LoopBoardColumn[];
    stale: boolean;
} | {
    kind: "no_server";
} | {
    kind: "unreachable";
};
export type LoopTimelineStepStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
export type LoopTimelineStep = {
    id: string;
    label: string;
    role: SessionOriginRole;
    status: LoopTimelineStepStatus;
    sessionId: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    summary: string | null;
    error: string | null;
    dependsOn?: string[];
};
export type LoopTimelineRunEntry = {
    entryKind: "run";
    id: string;
    key: string;
    title: string;
    kind: "dev" | "research";
    phase: string;
    state: "active" | "blocked" | "done";
    round: number;
    startedAt: string;
    updatedAt: string;
    prUrl: string | null;
    blockedReason: string | null;
    graph: LoopGraphSummary | null;
    steps: LoopTimelineStep[];
};
export type LoopTimelinePlanItem = {
    key: string;
    state: "waiting" | "shape" | "shape_qa" | "writing" | "done" | "stopped" | "asked" | "abandoned";
    round: number;
    resultKind: "rewrite" | "split" | null;
    splitCount: number;
    stoppedReason: string | null;
    shapeSessionId: string | null;
    qaSessionId: string | null;
};
export type LoopTimelinePlanEntry = {
    entryKind: "plan";
    id: string;
    planId: string;
    phase: "triage" | "shaping" | "finished" | "abandoned";
    state: "active" | "done";
    startedAt: string;
    updatedAt: string;
    endedAt: string | null;
    candidateCount: number;
    stoppedReason: string | null;
    triageSessionId: string | null;
    items: LoopTimelinePlanItem[];
};
export type LoopTimelineEntry = LoopTimelineRunEntry | LoopTimelinePlanEntry;
export type LoopTimelineAnswer = {
    kind: "ok";
    project: string;
    entries: LoopTimelineEntry[];
    hasMore: boolean;
    nextBefore: string | null;
    knownSessionIds: string[];
} | {
    kind: "no_server";
} | {
    kind: "unreachable";
};
export type ImageSaved = "saved" | "cancelled" | "failed";
export type AppEvents = (listener: (event: AppEvent) => void) => () => void;
export type CycleBridge = AppApi & {
    onEvent: AppEvents;
};
export type ApiMethod = keyof AppApi;
export declare const API_METHODS: readonly ApiMethod[];
export declare const channel: (method: string) => string;
export declare const EVENT_CHANNEL = "cycle:event";
