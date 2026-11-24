// The dictionary of what the app reports about how it is used. Nothing else is sent: `track` drops an event that is
// not here, and a property that is not in its schema.
//
// The rule that shapes every schema: a property is a number, a boolean, or one of a fixed list of words. Never a
// string the user or an agent wrote (a prompt, a path, a title, a command, a message, a repository). So there is no
// `z.string()` in this file, and a new one needs a decision (.agents/notes/2026-11-19-product-analytics-posthog.md).

import { z } from "zod";

const count = z.number().int().min(0);
/**
 * The agents Cycle is built with or is taking in (CYCL-152 Codex, CYCL-153 agy, CYCL-154 pi): fixed words of ours,
 * the ids their harnesses have in the daemon. The words are
 * here before the harnesses are (CYCL-155), so that the first session of each is counted under its name; an agent
 * that ships under another id is added here with its harness.
 */
export const KNOWN_AGENTS = ["claude", "codex", "agy", "pi"] as const;
const agent = z.enum([...KNOWN_AGENTS, "other"]);
/** An agent as the dictionary says it: one of ours by name, or "other". */
export type AgentWord = z.infer<typeof agent>;
const location = z.enum(["local", "remote"]);
const size = z.enum(["short", "medium", "long"]);
const panel = z.enum([
  "search",
  "new_session",
  "add_location",
  "edit_location",
  "remove_location",
  "settings",
  "session_settings",
  "delete",
  "trust",
  "connectors",
]);
/** The sections of the settings page (CYCL-78, CYCL-226): fixed words, as `SETTINGS_SECTIONS` of @cycle/ui lists them. */
const settingsSection = z.enum([
  "general",
  "appearance",
  "locations",
  "environments",
  "shortcuts",
  "harness",
]);
/** The sections of the Connectors page (CYCL-82): fixed words, as `CONNECTORS_SECTIONS` of @cycle/ui lists them. */
const connectorsSection = z.enum(["plugins", "mcp"]);
/** The kinds of tab in the right panel (CYCL-90): a fixed word, never a tab's title or what it shows. */
const panelTab = z.enum(["overview", "files", "diff", "terminal", "browser"]);
/** How many terminals a session has, in four words: 0, 1, 2 to 3, 4 or more. Never which, nor what runs in them. */
const terminalCount = z.enum(["none", "one", "few", "many"]);
const connectorTransport = z.enum(["http", "stdio"]);
const connectorAuth = z.enum(["none", "oauth"]);
/** How something asked of an agent's plugins ended: done, or the fixed word for why not. Never what the agent said. */
const pluginResult = z.enum([
  "ok",
  "not_found",
  "needs_command",
  "unavailable",
  "timeout",
  "unsupported",
  "failed",
]);
/** Where a source of plugins is: a fixed word, never its address. */
const pluginSourceKind = z.enum(["builtin", "git", "directory", "url", "other"]);

const o = z.strictObject;

/** What sent a message: Enter, the ⌘Enter shortcut, a button, or something that did not say. */
const via = z.enum(["enter", "shortcut", "button", "other"]);

/** Where a session's title was edited: the conversation's header, a row of the sidebar, or something that did not say. */
const renameWhere = z.enum(["header", "sidebar", "other"]);

/** Every event, and the properties it may carry. */
export const EVENTS = {
  // ---- the app ----
  /** The app started. */
  app_launched: o({ remote_locations: count, first_run: z.boolean() }),
  /** The person turned usage statistics on or off. Sent last when turning off, first when turning on. */
  analytics_toggled: o({ enabled: z.boolean() }),
  /** The person asked to check for an update. */
  update_checked: o({ result: z.enum(["available", "up_to_date", "error", "disabled"]) }),
  update_install_started: o({}),
  /** The person chose light, dark, or to follow the system. */
  theme_changed: o({ theme: z.enum(["system", "light", "dark"]) }),
  /** The person chose the interface's language: one of those the app has, or the system's. */
  language_changed: o({ language: z.enum(["system", "en-US", "zh-CN"]) }),
  /** The person turned the agent's suggestions of what to say next on or off in Settings (CYCL-225). */
  prompt_suggestions_toggled: o({ enabled: z.boolean() }),

  // ---- the account (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md): never who, only how it went ----
  /**
   * The sign-in page was shown: nobody had signed in here (`new`), after a sign-out, after 30 days without reaching
   * the provider (`expired`), or the provider refused the login at the start (`revoked`).
   */
  sign_in_shown: o({ reason: z.enum(["new", "signed_out", "expired", "revoked"]) }),
  /** A sign-in in the browser ended: signed in, failed, or given up (stopped, timed out, or the person said no). */
  signed_in: o({ result: z.enum(["ok", "failed", "cancelled"]) }),
  /** The provider refused the login while the app was open (revoked or expired), or a renewal named someone else. */
  sign_in_required: o({ reason: z.enum(["revoked", "changed_account"]) }),
  /** The provider could not be reached: the app goes on within the 30 days' grace. Once each time it starts to. */
  offline_grace: o({}),
  /** After the person confirmed it. `revoked`: the provider was told (false: it could not be reached; only logged). */
  signed_out: o({ revoked: z.boolean() }),
  /** Someone signed in where an account had been before: whether it was someone else. */
  account_switched: o({ switched: z.boolean() }),

  // ---- locations ----
  location_saved: o({ transport: z.enum(["ssh"]) }),
  location_removed: o({ kind: location }),
  /**
   * An environment (a reusable setup of scripts, variables and actions, docs/desktop.md "环境") was added or changed.
   * Not `environment_saved`: older versions still send that name for saving a location. How many variables and actions, and
   * whether it has setup and cleanup scripts: never a name, a value or a command.
   */
  environment_config_saved: o({
    has_setup: z.boolean(),
    has_cleanup: z.boolean(),
    variables: count,
    actions: count,
  }),
  /** An environment was removed. Not `environment_removed`: older versions still send that for removing a location. */
  environment_config_removed: o({}),
  /** The person chose a workspace's environment on the blank conversation. `none`: "No environment". */
  environment_chosen: o({ none: z.boolean() }),
  /** An action of a session's environment was run in a terminal from the session's header. Never which. */
  environment_action_run: o({}),
  /**
   * The person had the app update the daemon of a remote location (not the hand-run command), and it worked or not.
   * `when`: nothing was working there (`idle`), or sessions were and the person chose to interrupt them (`now`) or to
   * have the old daemon stop once they finish (`later`).
   */
  daemon_upgraded: o({ ok: z.boolean(), when: z.enum(["idle", "now", "later"]) }),
  /** A location's connection changed: it is up, it dropped and is trying again, or it is closed. */
  location_connection: o({
    kind: location,
    state: z.enum(["connected", "reconnecting", "closed"]),
  }),

  // ---- sessions ----
  session_list_loaded: o({ pages: z.number().int().positive() }),
  session_created: o({ agent, location: location, configured: z.boolean() }),
  /** Starting a session failed because the agent is not signed in (-32000). */
  agent_auth_required: o({ agent, location: location }),
  /** The person copied an install or sign-in command shown for an unavailable or signed-out agent. */
  agent_setup_command_copied: o({ agent, kind: z.enum(["install", "login"]) }),
  session_opened: o({ agent, location: location }),
  /** Never the title. `where`: in the conversation's header or on a row of the sidebar. */
  session_renamed: o({ where: renameWhere }),
  queue_return_restored: o({}),
  background_dismissed: o({ count: z.number().int().positive() }),
  /** One sub-agent was stopped alone from its card (CYCL-143). `background`: it ran in the background. */
  subagent_stopped: o({ background: z.boolean() }),
  session_archived: o({ archived: z.boolean() }),
  /** A session was pinned to the top of the sidebar's list, or unpinned: from a row of the sidebar, or the header. */
  session_pinned: o({ pinned: z.boolean(), where: z.enum(["sidebar", "header"]) }),
  /** After the person confirmed it (AGENTS.md: a delete is confirmed by the client first). */
  session_deleted: o({}),
  session_config_changed: o({ setting: z.enum(["mode", "model", "effort", "advisor", "other"]) }),
  agent_defaults_saved: o({ agent }),
  /**
   * Hot-reloadable runtime settings saved for an agent (CYCL-232). Never sends setting keys or values, but one:
   * `skip_permissions`, whether after the save the agent skips every permission prompt (agy's switch), to know how
   * many run an agent that asks nothing (.agents/notes/2026-11-24-agy-skip-permissions.md).
   */
  agent_runtime_settings_saved: o({
    agent,
    location: location,
    skip_permissions: z.boolean(),
  }),
  /** In-app subscription sign-in started for an agent (CYCL-233). Never sends URLs, accounts, or codes. */
  agent_auth_started: o({
    agent,
    location: location,
    mode: z.enum(["browser", "code", "device_code"]),
  }),
  /** In-app subscription sign-in finished for an agent (CYCL-233). Never sends URLs, accounts, or error text. */
  agent_auth_completed: o({
    agent,
    location: location,
    result: z.enum(["ok", "failed", "cancelled", "disconnected"]),
  }),
  /** In-app sign-out completed for an agent (CYCL-233). */
  agent_signed_out: o({ agent, location: location, ok: z.boolean() }),
  /** A session that was working changed to something the person is told of: it finished, it needs them, or it stopped. */
  session_attention: o({ kind: z.enum(["finished", "needs-you", "stopped"]) }),

  // ---- connectors (MCP servers every agent can use) ----
  /** Never the name, the URL, the command or a secret: how it is reached, how it signs in, how many secrets it has. */
  connector_added: o({ transport: connectorTransport, auth: connectorAuth, secrets: count }),
  /** Turned on or off from the list, or edited in its form. */
  connector_changed: o({ change: z.enum(["enabled", "disabled", "edited"]) }),
  /** After the person confirmed it: its credentials go with it. */
  connector_removed: o({ transport: connectorTransport }),
  /** A sign-in in the browser ended: signed in, refused or failed, or given up. */
  connector_authorized: o({ result: z.enum(["ok", "failed", "cancelled"]) }),
  connector_signed_out: o({}),

  // ---- plugins (each agent's own extension packages) ----
  /** After the person agreed to it. Never the plugin's name or where it comes from: whose it is, how it ended, and how many MCP servers it brought. */
  plugin_installed: o({ agent, result: pluginResult, servers: count }),
  /** After the person confirmed it. */
  plugin_removed: o({ agent, result: pluginResult }),
  /** Switched on or off. */
  plugin_toggled: o({ agent, enabled: z.boolean(), result: pluginResult }),
  /** Asked for its latest version. `updated`: there was a newer one. */
  plugin_updated: o({ agent, result: pluginResult, updated: z.boolean() }),
  /** A place plugins come from was added, after the person agreed to it. */
  plugin_source_added: o({ agent, result: pluginResult, kind: pluginSourceKind }),
  plugin_source_removed: o({ agent, result: pluginResult }),
  /** The lists of what can be installed were fetched again. */
  plugin_sources_refreshed: o({ agent, result: pluginResult }),

  // ---- the conversation ----
  prompt_sent: o({
    agent,
    location: location,
    size,
    images: count,
    /** Files embedded in it (text files, PDFs): how many, never which. */
    files: count,
    mentions: count,
    /** Sent into the running turn (Enter) instead of queued. */
    steered: z.boolean(),
    /**
     * What sent it: Enter, the ⌘Enter shortcut (which queues while the agent works), a button, or something else
     * (a new session's first message, a caller that does not say).
     */
    via,
  }),
  prompt_cancelled: o({ agent }),
  permission_answered: o({
    outcome: z.enum(["allowed", "rejected", "cancelled"]),
    remembered: z.boolean(),
    /** Other requests of the session waiting behind this one: they are shown one at a time. */
    queued: count,
  }),
  form_answered: o({ outcome: z.enum(["answered", "declined", "dismissed"]) }),

  // ---- the interface (the only ones the page may send) ----
  panel_opened: o({ panel, via: z.enum(["click", "shortcut"]) }),
  sidebar_toggled: o({ open: z.boolean(), via: z.enum(["click", "shortcut"]) }),
  /** Another section of the settings page was chosen (opening the page is `panel_opened` with `settings`). */
  settings_section_shown: o({ section: settingsSection }),
  /** One Harness settings sub-page was shown (CYCL-229). Never the location name, account, or paths. */
  harness_settings_shown: o({
    agent,
    location: location,
    from: z.enum(["settings", "blank", "other"]),
  }),
  /** Another section of the Connectors page was shown. Opening the page is `panel_opened` with `connectors`. */
  connectors_section_shown: o({ section: connectorsSection }),
  /**
   * The right panel opened or closed (CYCL-90). `via`: its button, ⌘\, its handle (folded by a key, a double-click
   * or a drag), or a tab's own button in the header (Overview). `tab`: the kind of tab it shows, or showed when it closed.
   */
  side_panel_toggled: o({
    open: z.boolean(),
    via: z.enum(["click", "shortcut", "handle", "tab_button"]),
    tab: panelTab,
  }),
  /** Another tab of the right panel was chosen. */
  side_panel_tab_shown: o({ tab: panelTab }),
  /** The Overview took the conversation to where something began: the todo list, or a background task. */
  overview_item_revealed: o({ section: z.enum(["todo", "background", "scheduled"]) }),
  /** The line at the end of the conversation that says what still runs in the background opened the Overview. */
  background_shown_from_conversation: o({}),
  /** The Files tab showed a file: what kind of preview it was, never which file. */
  file_previewed: o({ kind: z.enum(["text", "markdown", "image", "binary", "too_large"]) }),
  /** The Diff tab switched between this session's edits and the workspace against HEAD. */
  diff_view_changed: o({ view: z.enum(["session", "workspace"]) }),
  /** A file in the Diff tab was opened to its changes, in that view. */
  diff_file_opened: o({ view: z.enum(["session", "workspace"]) }),
  /** A call's change, from the head of its diff in the conversation, opened in the Diff tab (CYCL-133). */
  diff_shown_from_conversation: o({}),
  /** The Diff tab took the conversation to the call that made an edit. */
  diff_edit_revealed: o({}),
  /**
   * A terminal was opened beside a session (CYCL-98): from the header's Terminal button, or the panel's "New terminal".
   * `count`: how many the session has now. Never the shell, the folder, or anything typed or shown in it.
   */
  terminal_opened: o({ via: z.enum(["header", "tab_strip", "action"]), count: terminalCount }),
  /**
   * A terminal's tab was closed. `state`: its shell was still running (and was ended), had exited, or had already ended
   * with the daemon. `count`: how many the session has left.
   */
  terminal_closed: o({
    state: z.enum(["running", "exited", "ended"]),
    count: terminalCount,
  }),
  /** A terminal could not be opened: the daemon's reason as a fixed word, never its message. */
  terminal_open_failed: o({
    reason: z.enum(["limit", "archived", "cwd_missing", "other"]),
  }),
  /**
   * A file or folder named in the conversation was shown in the Files tab: what it was and where it was named. `line`: it
   * was named with a line (`app.tsx:12`), asked to be shown at that line (never which line).
   */
  file_shown_from_conversation: o({
    target: z.enum(["file", "folder"]),
    from: z.enum(["tool", "mention", "message", "review"]),
    line: z.boolean(),
  }),
  tool_copied: o({ part: z.enum(["command", "output"]) }),
  tool_output_expanded: o({}),
  /**
   * A sub-agent's card opened by the person. `work`: it had what the sub-agent did to show (its conversation, CYCL-134),
   * not only the task and the answer. `running`: the sub-agent was still at work.
   */
  subagent_opened: o({ work: z.boolean(), running: z.boolean() }),
  /** The whole of the task a sub-agent was given, past the three lines its open card shows (CYCL-217). */
  subagent_task_expanded: o({}),
  plan_opened: o({}),
  /**
   * The composer's context ring opened into its details. `state`: what it had to show, a number measured now, none
   * reported yet, or one from before the last compaction. `parts`: what the window holds was shown, part by part.
   * `plan`: the account's plan limits were shown under it (never how much of them is used).
   */
  context_details_opened: o({
    state: z.enum(["measured", "empty", "before_compaction"]),
    parts: z.boolean(),
    plan: z.boolean(),
  }),
  tool_link_opened: o({}),
  /** A link in an agent's message was opened, after the person said yes to where it goes. Never which. */
  message_link_opened: o({}),
  /** A message was copied from under it: the agent's reply in a turn, or what the person wrote. Never the words. */
  message_copied: o({ kind: z.enum(["agent", "user"]) }),
  /** "Back to bottom" took a reader who had scrolled up back to the end. `fresh`: something had arrived there meanwhile. */
  back_to_bottom_used: o({ fresh: z.boolean() }),
  /** The work a finished turn folds above its answer ("Worked for …") was opened by the person. */
  turn_work_opened: o({}),
  /** A long code block in a reply, shown in part, was shown whole. */
  code_block_expanded: o({}),
  /** A diagram drawn from a ```mermaid fence in a reply was opened large. */
  diagram_opened: o({}),
  /**
   * A picture in the conversation, opened large, was put on the clipboard (CYCL-212). `from`: the agent sent it or the
   * person did. Never the picture, its name or its size.
   */
  image_copied: o({ from: z.enum(["agent", "user"]) }),
  /** A picture opened large was saved to a file the person picked (CYCL-212). Never the picture, its name or where. */
  image_downloaded: o({ from: z.enum(["agent", "user"]) }),
  /** A drawn diagram's source was shown instead of the picture. */
  diagram_source_shown: o({}),
  /** A session's display mode was changed in Session settings: `detailed` shows the agent's thinking, `normal` does not. */
  display_mode_changed: o({ mode: z.enum(["normal", "detailed"]) }),
  code_theme_changed: o({}),
  slash_command_used: o({}),
  /**
   * The agent's suggestion of what to say next, shown in the empty input box, was taken as the message (CYCL-225), by
   * the right arrow or Tab. Never the suggestion.
   */
  prompt_suggestion_accepted: o({ key: z.enum(["arrow", "tab"]) }),
  /** Something was picked from the @ menu: what kind of thing, never which. */
  mention_picked: o({ kind: z.enum(["file", "folder", "session"]) }),
  /**
   * A file was attached in the input box. `kind`: what it is sent as (image, text file, PDF), never its name, path or
   * type; `via`: the attach button, a paste, or a drop.
   */
  attachment_added: o({
    kind: z.enum(["image", "text", "pdf"]),
    via: z.enum(["button", "paste", "drop"]),
  }),
  /** A file could not be attached: a kind the agent does not take, too large, or one too many. Never which. */
  attachment_refused: o({ reason: z.enum(["type", "too_large", "too_many"]) }),
  /**
   * "Edit message" (formerly "Send again") on a turn that failed: its message went back in the box. `failure` is the kind (from Cycle's error code,
   * never the message); `changed`: the turn had run a command or changed a file first, and the person was warned.
   */
  turn_resend_opened: o({
    failure: z.enum(["agent_exited", "daemon_stopped", "history", "resume", "agent_error"]),
    changed: z.boolean(),
  }),
  /** The message put back by "Edit message" was sent; `edited`: not as it was. */
  turn_resent: o({ edited: z.boolean() }),
  /**
   * "Try again" on a turn that failed: its message was sent again as it was, in one click. `failure` as in
   * `turn_resend_opened`; `changed`: the turn had run a command or changed a file, so the person was asked first and said yes.
   */
  turn_retried: o({
    failure: z.enum(["agent_exited", "daemon_stopped", "history", "resume", "agent_error"]),
    changed: z.boolean(),
  }),
  /**
   * A new session's folder was chosen on its blank page (CYCL-55): from the folders it has sessions in, the system's or
   * the daemon's folder browser, or by typing its path. Never which folder.
   */
  blank_folder_chosen: o({ via: z.enum(["recent", "browse", "typed"]) }),
  /** "Connect again" was pressed on a blank page whose location was not connected. */
  blank_connect_pressed: o({}),
  /** "Connect again" was pressed on the line under an open session's title, its location not connected. */
  session_connect_pressed: o({}),
  /** A blank page's first message went: how long the page was open before it, in four words. */
  blank_sent: o({ waited: z.enum(["under_10s", "under_1m", "under_5m", "longer"]) }),
} as const;

export type EventName = keyof typeof EVENTS;
export type EventProps<N extends EventName> = z.infer<(typeof EVENTS)[N]>;

/** What the page may report itself, through the bridge. The rest happen in main, where the page cannot forge them. */
export const UI_EVENTS = [
  "panel_opened",
  "sidebar_toggled",
  "settings_section_shown",
  "harness_settings_shown",
  "connectors_section_shown",
  "side_panel_toggled",
  "side_panel_tab_shown",
  "overview_item_revealed",
  "background_shown_from_conversation",
  "file_previewed",
  "diff_view_changed",
  "diff_file_opened",
  "diff_edit_revealed",
  "diff_shown_from_conversation",
  "terminal_opened",
  "terminal_closed",
  "terminal_open_failed",
  "file_shown_from_conversation",
  "code_theme_changed",
  "slash_command_used",
  "prompt_suggestion_accepted",
  "mention_picked",
  "attachment_added",
  "attachment_refused",
  "tool_copied",
  "tool_output_expanded",
  "subagent_opened",
  "subagent_task_expanded",
  "plan_opened",
  "context_details_opened",
  "tool_link_opened",
  "message_link_opened",
  "message_copied",
  "back_to_bottom_used",
  "turn_work_opened",
  "code_block_expanded",
  "diagram_opened",
  "diagram_source_shown",
  "image_copied",
  "image_downloaded",
  "display_mode_changed",
  "session_pinned",
  "turn_resend_opened",
  "turn_resent",
  "turn_retried",
  "blank_folder_chosen",
  "blank_connect_pressed",
  "session_connect_pressed",
  "blank_sent",
  "agent_setup_command_copied",
] as const satisfies readonly EventName[];
export type UiEventName = (typeof UI_EVENTS)[number];

export const isEventName = (name: string): name is EventName => Object.hasOwn(EVENTS, name);
export const isUiEvent = (name: string): name is UiEventName =>
  (UI_EVENTS as readonly string[]).includes(name);

// ---- words for what is not one of a list: the id of an agent, a setting, a length ----

/** Agents we know by name; any other is "other", so a custom agent's id is not sent. */
export const agentOf = (id: string): AgentWord =>
  (KNOWN_AGENTS as readonly string[]).includes(id) ? (id as AgentWord) : "other";

export const settingOf = (configId: string): "mode" | "model" | "effort" | "advisor" | "other" =>
  configId === "mode" || configId === "model" || configId === "effort" || configId === "advisor"
    ? configId
    : "other";

/** What the page says sent a message, as one of the words; anything else is "other". */
export const viaOf = (value: unknown): z.infer<typeof via> => {
  const word = via.safeParse(value);
  return word.success ? word.data : "other";
};

/** Where the page says a title was edited, as one of the words; anything else is "other". */
export const renameWhereOf = (value: unknown): z.infer<typeof renameWhere> => {
  const word = renameWhere.safeParse(value);
  return word.success ? word.data : "other";
};

/** How long a prompt is, in three words: the length is as much as is learned of it. */
export const sizeOf = (characters: number): z.infer<typeof size> =>
  characters < 200 ? "short" : characters < 2000 ? "medium" : "long";
