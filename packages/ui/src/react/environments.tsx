// Environments (docs/desktop.md "环境"): the Settings section that lists and edits them, the choice of one on the blank
// conversation, and a session's actions in its title bar. A variable's value is shown only in the editor: never in a
// list, a menu, a notice or a report.
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { useId, useRef, useState } from "react";
import type {
  Environment,
  EnvironmentAction,
  EnvironmentProblem,
  EnvironmentScripts,
  SessionEnvironmentSummary,
} from "../api.ts";
import {
  ACTION_ICONS,
  type ActionIcon,
  actionIconOf,
  environmentProblem,
  formatVariables,
  newEnvironmentId,
  parseVariables,
  SCRIPT_SYSTEMS,
  type ScriptSystem,
  type VariableLineProblem,
} from "../environments.ts";
import type { Translator } from "../i18n.ts";
import { type BlankConversation, blankEnvironmentOf } from "../store/index.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DatabaseIcon,
  FlaskIcon,
  HammerIcon,
  type IconProps,
  MoreIcon,
  PlayIcon,
  RefreshIcon,
  ServerIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** How each of the action icons is drawn (the ids are `ACTION_ICONS`: one missing here is a type error). */
const ACTION_ICON_DRAWN: Record<ActionIcon, (props: IconProps) => React.JSX.Element> = {
  terminal: TerminalIcon,
  play: PlayIcon,
  test: FlaskIcon,
  build: HammerIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  refresh: RefreshIcon,
  clean: TrashIcon,
};

/** An action's icon: its own when this version knows it, else the terminal. */
export function ActionIconOf({ icon, size = 14 }: { icon: string | undefined; size?: number }) {
  const id = actionIconOf(icon);
  const Drawn = ACTION_ICON_DRAWN[id];
  return <Drawn size={size} data-icon={id} />;
}

/**
 * The choice of an action's icon. An id this version does not know shows as the terminal and is kept as it is, unless
 * another is chosen.
 */
function ActionIconField({
  icon,
  onChange,
}: {
  icon: string | undefined;
  onChange: (icon: ActionIcon) => void;
}) {
  const { t } = useI18n();
  const shown = actionIconOf(icon);
  const items = ACTION_ICONS.map((id) => ({ value: id, label: t(`environment.icon.${id}`) }));
  return (
    <Field data-kind="environment-action-icon">
      <FieldLabel>{t("environment.action.icon")}</FieldLabel>
      <Select
        items={items}
        value={shown}
        onValueChange={(next) => {
          const chosen = ACTION_ICONS.find((id) => id === next);
          if (chosen !== undefined && chosen !== shown) onChange(chosen);
        }}
      >
        <SelectTrigger>
          <ActionIconOf icon={shown} />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ACTION_ICONS.map((id) => (
            <SelectItem key={id} value={id} data-kind="environment-icon">
              <ActionIconOf icon={id} />
              <span data-slot="option-name">{t(`environment.icon.${id}`)}</span>
              <SelectItemIndicator>
                <CheckIcon size={13} />
              </SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** What the editor says is wrong with an environment, in the page's words. */
export const environmentProblemText = (problem: EnvironmentProblem, i18n: Translator): string => {
  const { t, number } = i18n;
  switch (problem.problem) {
    case "name_missing":
    case "action_name_missing":
    case "action_id_invalid":
      return t(`environment.problem.${problem.problem}`);
    case "invalid_variable":
    case "duplicate_variable":
    case "reserved_variable":
      return t(`environment.problem.${problem.problem}`, { name: problem.name });
    case "action_command_missing":
      return t("environment.problem.action_command_missing", { action: problem.action });
    case "too_large":
      return t("environment.problem.too_large", {
        limit: number(problem.limit / 1024, { style: "unit", unit: "kilobyte" }),
      });
    case "invalid":
      return t("environment.problem.invalid", { message: problem.message });
  }
};

const lineProblemText = (problem: VariableLineProblem, t: Translator["t"]): string => {
  switch (problem.problem) {
    case "no_equals":
      return t("environment.variables.noEquals", { line: problem.line });
    case "unclosed_quote":
      return t("environment.variables.unclosedQuote", { line: problem.line });
    case "invalid_name":
      return t("environment.variables.invalidName", { line: problem.line, name: problem.name });
    case "reserved":
      return t("environment.variables.reserved", { line: problem.line, name: problem.name });
    case "duplicate":
      return t("environment.variables.duplicate", {
        line: problem.line,
        name: problem.name,
        first: problem.first,
      });
  }
};

/** Settings → Environments: one row each, what can be done with it, and the way to add one. */
export function EnvironmentsSection() {
  const store = useAppStore();
  const i18n = useI18n();
  const { t } = i18n;
  const state = useAppState((s) => s.environments);
  const [editing, setEditing] = useState<{ environment: Environment; isNew: boolean }>();
  const [removing, setRemoving] = useState<Environment>();
  const environments = state?.environments ?? [];
  const add = () =>
    setEditing({
      environment: { id: newEnvironmentId("env"), name: "", variables: [], actions: [] },
      isNew: true,
    });
  return (
    <PageGroup
      lead={t("settings.environments.lead")}
      action={
        <Button data-variant="outline" onClick={add}>
          {t("environment.add")}
        </Button>
      }
    >
      {state === undefined ? null : environments.length === 0 ? (
        <StateBlock
          tone="empty"
          size="inline"
          align="start"
          title={t("settings.environments.empty")}
          body={t("settings.environments.emptyHint")}
          action={{ label: t("environment.add"), onAction: add }}
        />
      ) : (
        <PageRows>
          {environments.map((environment) => (
            <PageRow
              key={environment.id}
              label={environment.name}
              description={<EnvironmentFacts environment={environment} />}
            >
              <Menu
                onAction={(value) => {
                  if (value === "edit") setEditing({ environment, isNew: false });
                  else if (value === "duplicate")
                    setEditing({
                      environment: {
                        ...structuredClone(environment),
                        id: newEnvironmentId("env", new Set(environments.map((e) => e.id))),
                        name: t("environment.copyName", { name: environment.name }),
                      },
                      isNew: true,
                    });
                  else if (value === "remove") setRemoving(environment);
                }}
              >
                <Tip label={t("settings.environments.manage", { name: environment.name })}>
                  <MenuTrigger data-variant="ghost">
                    <MoreIcon />
                  </MenuTrigger>
                </Tip>
                <MenuContent align="end">
                  <MenuItem value="edit">{t("settings.environments.edit")}</MenuItem>
                  <MenuItem value="duplicate">{t("settings.environments.duplicate")}</MenuItem>
                  <MenuSeparator />
                  <MenuItem value="remove" data-destructive>
                    {t("settings.environments.remove")}
                  </MenuItem>
                </MenuContent>
              </Menu>
            </PageRow>
          ))}
        </PageRows>
      )}
      {editing !== undefined ? (
        <EnvironmentEditor
          key={editing.environment.id}
          environment={editing.environment}
          isNew={editing.isNew}
          onSave={(environment) => store.saveEnvironment(environment)}
          onDone={() => setEditing(undefined)}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t("environment.removeTitle", { name: removing?.name ?? "" })}
        description={t("environment.removeDescription")}
        confirmLabel={t("environment.removeConfirm")}
        destructive
        onConfirm={() =>
          removing !== undefined ? store.removeEnvironment(removing.id) : undefined
        }
      />
    </PageGroup>
  );
}

/**
 * A row's facts: how many variables and actions; or, for one the file holds that does not pass the daemon's rules (written
 * by hand or by another version), what to fix: it is not sent until it is.
 */
function EnvironmentFacts({ environment }: { environment: Environment }) {
  const i18n = useI18n();
  const { t } = i18n;
  const problem = environmentProblem(environment);
  if (problem !== undefined)
    return (
      <span data-slot="environment-needs-fix">
        {t("settings.environments.needsFix", { problem: environmentProblemText(problem, i18n) })}
      </span>
    );
  return (
    <>
      {[
        t("settings.environments.variables", { count: environment.variables.length }),
        t("settings.environments.actions", { count: environment.actions.length }),
      ].join(" · ")}
    </>
  );
}

/** A script for each system: the one shown is chosen above it; a system with a script of its own is marked. */
function ScriptsField({
  label,
  note,
  value,
  onChange,
  rows,
}: {
  label: string;
  note?: string;
  value: EnvironmentScripts;
  onChange: (value: EnvironmentScripts) => void;
  rows: number;
}) {
  const { t } = useI18n();
  const [system, setSystem] = useState<ScriptSystem>("default");
  const systemsLabel = `${label}: ${t("environment.systems")}`;
  return (
    <Field data-kind="environment-scripts">
      <div data-slot="environment-scripts-head">
        <FieldLabel>{label}</FieldLabel>
        <SegmentedControl
          aria-label={systemsLabel}
          value={system}
          onValueChange={(next) => {
            if ((SCRIPT_SYSTEMS as readonly unknown[]).includes(next))
              setSystem(next as ScriptSystem);
          }}
        >
          <SegmentedControlIndicator />
          {SCRIPT_SYSTEMS.map((s) => (
            <SegmentedControlItem
              key={s}
              value={s}
              data-filled={(value[s] ?? "").trim() !== "" || undefined}
            >
              {t(`environment.system.${s}`)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      <Textarea
        data-kind="environment-script"
        rows={rows}
        spellCheck={false}
        autoComplete="off"
        value={value[system] ?? ""}
        onChange={(event) => {
          const text = event.currentTarget.value;
          const next = { ...value };
          if (text === "") delete next[system];
          else next[system] = text;
          onChange(next);
        }}
      />
      <FieldDescription>
        {note !== undefined ? `${note} ` : ""}
        {t("environment.system.hint")}
      </FieldDescription>
    </Field>
  );
}

/** Adds or edits one environment. Saved only once it passes the daemon's rules; what is wrong is said in place. */
export function EnvironmentEditor({
  environment,
  isNew,
  onSave,
  onDone,
  initialProblem,
}: {
  environment: Environment;
  isNew: boolean;
  onSave: (environment: Environment) => Promise<EnvironmentProblem | undefined>;
  onDone: () => void;
  /** Shown from the start: for the gallery. */
  initialProblem?: EnvironmentProblem | undefined;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [name, setName] = useState(environment.name);
  const [setup, setSetup] = useState<EnvironmentScripts>(environment.setup ?? {});
  const [cleanup, setCleanup] = useState<EnvironmentScripts>(environment.cleanup ?? {});
  const [variablesText, setVariablesText] = useState(() => formatVariables(environment.variables));
  // An action without an id, or with another's, is given its own: saving fixes what the daemon would refuse.
  const [actions, setActions] = useState<EnvironmentAction[]>(() => {
    const taken = new Set<string>();
    return environment.actions.map((action) => {
      const id =
        action.id !== "" && !taken.has(action.id) ? action.id : newEnvironmentId("action", taken);
      taken.add(id);
      return id === action.id ? action : { ...action, id };
    });
  });
  // Line problems are said once a save was tried, and then follow what is typed.
  const [checked, setChecked] = useState(initialProblem !== undefined);
  const [problem, setProblem] = useState<EnvironmentProblem | undefined>(initialProblem);
  const [busy, setBusy] = useState(false);
  const variablesRef = useRef<HTMLTextAreaElement>(null);
  const variablesNote = useId();
  const parsed = parseVariables(variablesText);
  const lineProblems = checked ? parsed.problems : [];

  const save = async () => {
    if (busy) return;
    setChecked(true);
    setProblem(undefined);
    if (parsed.problems.length > 0) {
      variablesRef.current?.focus();
      return;
    }
    const next: Environment = {
      id: environment.id,
      name: name.trim(),
      variables: parsed.variables,
      actions: actions.map((a) => ({ ...a, name: a.name.trim() })),
      ...(Object.keys(setup).length > 0 ? { setup } : {}),
      ...(Object.keys(cleanup).length > 0 ? { cleanup } : {}),
    };
    const local = environmentProblem(next);
    if (local !== undefined) {
      setProblem(local);
      return;
    }
    setBusy(true);
    try {
      const refused = await onSave(next);
      if (refused !== undefined) {
        setProblem(refused);
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const changeAction = (id: string, change: Partial<EnvironmentAction>) =>
    setActions((list) => list.map((a) => (a.id === id ? { ...a, ...change } : a)));

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onDone()}>
      <DialogBackdrop />
      <DialogContent data-kind="environment-form">
        <DialogTitle>
          {isNew
            ? t("environment.addTitle")
            : t("environment.editTitle", { name: environment.name })}
        </DialogTitle>
        <form
          data-slot="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field name="name" invalid={problem?.problem === "name_missing"}>
            <FieldLabel>{t("environment.name")}</FieldLabel>
            <Input
              autoFocus
              value={name}
              placeholder={t("environment.namePlaceholder")}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Field name="variables" invalid={lineProblems.length > 0}>
            <FieldLabel>{t("environment.variables")}</FieldLabel>
            <Textarea
              ref={variablesRef}
              data-kind="environment-variables"
              rows={5}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              value={variablesText}
              placeholder={t("environment.variables.placeholder")}
              aria-describedby={variablesNote}
              onChange={(e) => setVariablesText(e.currentTarget.value)}
            />
            <FieldDescription id={variablesNote}>
              {t("environment.variables.note")}
            </FieldDescription>
            {lineProblems.length > 0 ? (
              <ul data-slot="environment-line-problems" role="alert">
                {lineProblems.map((p) => (
                  <li key={`${p.line}:${p.problem}`}>{lineProblemText(p, t)}</li>
                ))}
              </ul>
            ) : null}
          </Field>
          <fieldset data-slot="environment-actions">
            <legend>{t("environment.actions")}</legend>
            <p data-slot="hint">{t("environment.actions.note")}</p>
            {actions.map((action) => (
              <div key={action.id} data-slot="environment-action">
                <div data-slot="row">
                  <Field name={`action-${action.id}`}>
                    <FieldLabel>{t("environment.action.name")}</FieldLabel>
                    <Input
                      value={action.name}
                      placeholder={t("environment.action.namePlaceholder")}
                      onChange={(e) => changeAction(action.id, { name: e.currentTarget.value })}
                    />
                  </Field>
                  <ActionIconField
                    icon={action.icon}
                    onChange={(icon) => changeAction(action.id, { icon })}
                  />
                  <Tip
                    label={
                      action.name.trim() === ""
                        ? t("environment.action.removeUnnamed")
                        : t("environment.action.remove", { name: action.name })
                    }
                  >
                    <Button
                      type="button"
                      data-variant="ghost"
                      data-kind="environment-action-remove"
                      onClick={() => setActions((list) => list.filter((a) => a.id !== action.id))}
                    >
                      <CloseIcon />
                    </Button>
                  </Tip>
                </div>
                <ScriptsField
                  label={t("environment.action.command")}
                  value={action.command}
                  rows={2}
                  onChange={(command) => changeAction(action.id, { command })}
                />
              </div>
            ))}
            <div data-slot="row">
              <Button
                type="button"
                data-variant="outline"
                onClick={() =>
                  setActions((list) => [
                    ...list,
                    {
                      id: newEnvironmentId("action", new Set(list.map((a) => a.id))),
                      name: "",
                      command: {},
                    },
                  ])
                }
              >
                {t("environment.actions.add")}
              </Button>
            </div>
          </fieldset>
          <ScriptsField
            label={t("environment.setup")}
            note={t("environment.setup.note")}
            value={setup}
            rows={3}
            onChange={setSetup}
          />
          <ScriptsField
            label={t("environment.cleanup")}
            note={t("environment.cleanup.note")}
            value={cleanup}
            rows={3}
            onChange={setCleanup}
          />
          {problem !== undefined ? (
            <p data-slot="hint" role="alert">
              {environmentProblemText(problem, i18n)}
            </p>
          ) : null}
          <div data-slot="row" data-dialog-footer="">
            <DialogClose disabled={busy}>{t("dialog.cancel")}</DialogClose>
            <Button data-variant="solid" type="submit" disabled={busy}>
              {isNew ? t("environment.addSubmit") : t("environment.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The blank conversation's choice of environment, after its folder: the workspace's default, else what was chosen here
 * (none to start with). With a folder, choosing one makes it the workspace's default; without one, it waits for the
 * folder (`blankEnvironmentOf`). Only when there is an environment to choose; on a location whose daemon cannot take
 * one, it is there and cannot be used, and says why.
 */
export function EnvironmentPicker({
  blank,
  agentId,
  locationName,
  disabled,
}: {
  blank: BlankConversation;
  /** The agent the session starts: Antigravity's own commands do not have the variables. */
  agentId: string | undefined;
  locationName: string;
  disabled: boolean;
}) {
  const store = useAppStore();
  const { t } = useI18n();
  const { locationId } = blank;
  const environments = useAppState((s) => s.environments?.environments);
  const chosen = useAppState((s) => blankEnvironmentOf(s, blank));
  const supported = useAppState((s) => s.status[locationId]?.capabilities?.environments === true);
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  if (environments === undefined || environments.length === 0) return null;
  if (!supported) {
    // There, so that it is known environments exist, and not usable: a press does nothing, the tip says why.
    const why = t("blank.environment.oldDaemon", { location: locationName });
    return (
      <Tip label={why}>
        <Button
          data-variant="ghost"
          data-kind="blank-environment"
          data-unset=""
          aria-disabled="true"
        >
          <span data-slot="blank-agent-name">{t("blank.environment")}</span>
        </Button>
      </Tip>
    );
  }
  const name = chosen?.name ?? t("blank.environment.none");
  const chipLabel = t("composer.setting", { setting: t("blank.environment"), value: name });
  // agy is given no variable of the session (an explicit list only reaches agent processes): its terminals and actions
  // are (docs/protocol.md §6 "环境").
  const agyNote = agentId === "agy" && (chosen?.variables.length ?? 0) > 0;
  return (
    <>
      <Menu modal={false}>
        <Tip label={chipLabel}>
          <MenuTrigger
            ref={trigger}
            data-variant="ghost"
            data-kind="blank-environment"
            data-unset={chosen === undefined || undefined}
            disabled={disabled}
          >
            <span data-slot="blank-agent-name">{name}</span>
          </MenuTrigger>
        </Tip>
        <MenuContent
          align="start"
          sideOffset={6}
          collisionPadding={12}
          finalFocus={() => trigger.current}
          aria-labelledby={headingId}
          data-kind="setting"
        >
          <MenuRadioGroup
            value={chosen?.id ?? ""}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              store.chooseBlankEnvironment(next === "" ? null : next);
            }}
          >
            <MenuGroupLabel id={headingId}>{t("blank.environment")}</MenuGroupLabel>
            <MenuRadioItem value="" label={t("blank.environment.none")} closeOnSelect>
              <span data-slot="option-name">{t("blank.environment.none")}</span>
              <MenuItemIndicator>
                <CheckIcon size={13} />
              </MenuItemIndicator>
            </MenuRadioItem>
            {environments.map((e) => (
              <MenuRadioItem key={e.id} value={e.id} label={e.name} closeOnSelect>
                <span data-slot="option-name">{e.name}</span>
                <MenuItemIndicator>
                  <CheckIcon size={13} />
                </MenuItemIndicator>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      {agyNote ? (
        <span data-slot="blank-environment-note">{t("blank.environment.agyNote")}</span>
      ) : null}
    </>
  );
}

/** How many of a session's actions are buttons of their own; the rest are in a menu after them. */
const SHOWN_ACTIONS = 2;

/**
 * The actions of a session's environment, in its title bar: each runs in a new terminal of the session, which is shown.
 * Only when it has some, and its daemon can open terminals.
 */
export function EnvironmentActions({
  locationId,
  environment,
  onRun,
}: {
  locationId: string;
  environment: SessionEnvironmentSummary | undefined;
  onRun: (actionId: string) => void;
}) {
  const { t } = useI18n();
  const usable = useAppState(
    (s) =>
      s.status[locationId]?.state === "connected" &&
      s.status[locationId]?.capabilities?.terminal === true &&
      s.status[locationId]?.capabilities?.environments === true,
  );
  const [open, setOpen] = useState<"rest" | "all" | undefined>();
  const actions = environment?.actions ?? [];
  if (actions.length === 0) return null;
  const shown = actions.length > SHOWN_ACTIONS + 1 ? actions.slice(0, SHOWN_ACTIONS) : actions;
  const rest = actions.slice(shown.length);
  // A menu of some of the actions: after the buttons in a wide window, or of all of them in a narrow one, where
  // the buttons are not shown (main.css), so that the title keeps its room.
  const menu = (which: "rest" | "all", list: typeof actions, label: string) => (
    <Menu
      open={open === which && usable}
      onOpenChange={(next) => setOpen(next && usable ? which : undefined)}
      onAction={(value) => typeof value === "string" && onRun(value)}
    >
      <Tip label={label} side="bottom">
        <MenuTrigger
          data-variant="ghost"
          data-kind="environment-action"
          data-menu={which}
          aria-disabled={!usable || undefined}
        >
          <TerminalIcon size={14} />
          <ChevronDownIcon size={12} />
        </MenuTrigger>
      </Tip>
      <MenuContent align="end">
        {list.map((action) => (
          <MenuItem key={action.id} value={action.id} label={action.name}>
            <ActionIconOf icon={action.icon} />
            <span data-slot="option-name">{action.name}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
  return (
    <fieldset data-slot="environment-actions-bar" aria-label={t("session.environment.actions")}>
      {shown.map((action) => (
        <Tip
          key={action.id}
          label={t("session.environment.run", { name: action.name })}
          side="bottom"
        >
          <Button
            data-variant="ghost"
            data-kind="environment-action"
            aria-disabled={!usable || undefined}
            onClick={() => usable && onRun(action.id)}
          >
            <ActionIconOf icon={action.icon} />
            <span data-slot="environment-action-name">{action.name}</span>
          </Button>
        </Tip>
      ))}
      {rest.length > 0 ? menu("rest", rest, t("session.environment.more")) : null}
      {menu("all", actions, t("session.environment.actions"))}
    </fieldset>
  );
}
