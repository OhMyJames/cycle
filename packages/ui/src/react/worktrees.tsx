// Worktrees (docs/desktop.md "Worktree"): the choice on the blank conversation, the one under a session's title, and the
// notice when its setup failed. Paths and branch names are the person's own words and are shown as text, nothing more.

import { isComposing } from "@ui-sdk/core";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { useId, useMemo, useRef, useState } from "react";
import type { GitBranches, WorktreeSummary } from "../api.ts";
import { type BlankConversation, type BlankWorktree, blankWorktreeOf } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, SearchIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** Branches that match what was typed (a part of the name, in any case), in the order they came. */
export const matchingBranches = (branches: readonly string[], query: string): string[] => {
  const needle = query.trim().toLowerCase();
  return needle === "" ? [...branches] : branches.filter((b) => b.toLowerCase().includes(needle));
};

/**
 * The two chips of a new session in a repository: the branch it starts from, and whether it is made in a worktree. The
 * branch is always shown (the one checked out until another is picked); picking another one turns the worktree on, since
 * Cycle never switches the person's own checkout. Only where a worktree can be made (this computer, a daemon that takes
 * it, a folder in a repository): nowhere else is anything shown.
 */
export function WorktreePicker({
  blank,
  agentId,
  disabled,
}: {
  blank: BlankConversation;
  agentId: string | undefined;
  disabled: boolean;
}) {
  const store = useAppStore();
  const { t } = useI18n();
  // A string, so the selector gives the same value until something shown changes (the offer is a new object each time).
  const offered = useAppState((s) => JSON.stringify(blankWorktreeOf(s, blank, agentId) ?? null));
  const offer = useMemo(() => JSON.parse(offered) as BlankWorktree | null, [offered]) ?? undefined;
  if (offer === undefined) return null;
  const current = offer.branches.current;
  const shown = offer.on ? (offer.base ?? current) : (current ?? offer.base);
  return (
    <>
      <BranchMenu
        branches={offer.branches}
        value={shown}
        worktreeOn={offer.on}
        disabled={disabled}
        onPick={(branch) => {
          // The branch already checked out, with no worktree: nothing to start from, so nothing changes.
          if (!offer.on && branch === current) return;
          store.chooseBlankWorktree({ on: true, base: branch });
        }}
      />
      <button
        type="button"
        role="switch"
        aria-checked={offer.on}
        data-slot="button"
        data-variant="ghost"
        data-kind="blank-worktree"
        data-unset={!offer.on || undefined}
        disabled={disabled}
        onClick={() => store.chooseBlankWorktree({ on: !offer.on })}
      >
        <span data-slot="blank-agent-name">{t("blank.worktree")}</span>
        {offer.on ? <CheckIcon size={13} aria-hidden="true" /> : null}
      </button>
    </>
  );
}

/** The branch chip and its menu: a search over the repository's local branches, the one checked out marked. */
function BranchMenu({
  branches,
  value,
  worktreeOn,
  disabled,
  onPick,
}: {
  branches: GitBranches;
  value: string | undefined;
  worktreeOn: boolean;
  disabled: boolean;
  onPick: (branch: string) => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // The remote's default may be only a remote name (`origin/main`): it can be started from, so it is listed first.
  const all = [
    ...(branches.defaultBranch !== undefined && !branches.branches.includes(branches.defaultBranch)
      ? [branches.defaultBranch]
      : []),
    ...branches.branches,
  ];
  const found = matchingBranches(all, query);
  return (
    <Menu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        // A menu of many branches is searched first. The menu puts the focus on itself as it opens, so this comes after.
        else setTimeout(() => search.current?.focus(), 30);
      }}
    >
      <Tip label={t("blank.branch.tip", { branch: value ?? "" })}>
        <MenuTrigger
          ref={trigger}
          data-variant="ghost"
          data-kind="blank-branch"
          aria-label={t("blank.branch.label", { branch: value ?? t("blank.branch.none") })}
          disabled={disabled}
        >
          <span data-slot="blank-branch-name">{value ?? t("blank.branch.none")}</span>
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
        <label data-slot="branch-search">
          <SearchIcon size={14} aria-hidden="true" />
          <input
            ref={search}
            value={query}
            placeholder={t("blank.branch.search")}
            aria-label={t("blank.branch.search")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") return;
              // The menu's type-ahead must not take the letters typed here.
              event.stopPropagation();
              const items = (selector: string) =>
                event.currentTarget
                  .closest('[role="menu"]')
                  ?.querySelectorAll<HTMLElement>(selector);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                items('[role="menuitemradio"]')?.[0]?.focus();
              } else if (event.key === "Enter" && !isComposing(event)) {
                event.preventDefault();
                items('[role="menuitemradio"]')?.[0]?.click();
              }
            }}
          />
        </label>
        <MenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => {
            if (typeof next === "string") onPick(next);
          }}
        >
          <MenuGroupLabel id={headingId}>{t("blank.branch.heading")}</MenuGroupLabel>
          {found.map((branch) => (
            <MenuRadioItem key={branch} value={branch} label={branch} closeOnSelect>
              <span data-slot="option-name">{branch}</span>
              {branch === branches.current ? (
                <span data-slot="branch-note">{t("blank.branch.current")}</span>
              ) : null}
              <MenuItemIndicator>
                <CheckIcon size={13} />
              </MenuItemIndicator>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {found.length === 0 ? <p data-slot="branch-empty">{t("blank.branch.empty")}</p> : null}
        {!worktreeOn && found.length > 0 ? (
          <p data-slot="branch-empty">{t("blank.branch.turnsOn")}</p>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/**
 * Above an open session's box: that it works in a worktree and on which branch, the worktree's folder as the tip. One
 * line of its own, as wide as the box; nothing for a session outside a worktree.
 */
export function WorktreeStrip({ worktree }: { worktree: WorktreeSummary | undefined }) {
  const { t } = useI18n();
  if (worktree === undefined) return null;
  return (
    <div data-slot="worktree-strip">
      <Tip label={worktree.path}>
        <span data-slot="worktree-strip-name">{t("session.worktree.name")}</span>
      </Tip>
      {worktree.branch !== undefined ? (
        <span data-slot="worktree-strip-branch" title={worktree.branch}>
          {worktree.branch}
        </span>
      ) : null}
    </div>
  );
}

/** What the setup script said when it failed: the session works, and the person is told, in text. */
export function WorktreeSetupNotice({ worktree }: { worktree: WorktreeSummary | undefined }) {
  const { t } = useI18n();
  if (worktree?.setupFailed === undefined) return null;
  return (
    <div data-slot="session-worktree-setup" role="status">
      <p>{t("session.worktree.setupFailed")}</p>
      <pre>{worktree.setupFailed}</pre>
    </div>
  );
}
