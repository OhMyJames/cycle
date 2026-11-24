// Worktrees (docs/desktop.md "Worktree"): the choice on the blank conversation, the one under a session's title, and the
// notice when its setup failed. Paths and branch names are the person's own words and are shown as text, nothing more.
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { useId, useMemo, useRef } from "react";
import type { WorktreeSummary } from "../api.ts";
import { type BlankConversation, type BlankWorktree, blankWorktreeOf } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** The value that means no worktree; a branch is never called this (branch names cannot hold a space). */
const NONE = "no worktree";

/**
 * Whether to start in a worktree, and from which branch, as one menu: "No worktree", then each branch. Only where one can
 * be made (this computer, a daemon that takes it, a folder in a repository): nowhere else is it shown.
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
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  if (offer === undefined) return null;
  const name = offer.on ? (offer.base ?? t("blank.worktree.on")) : t("blank.worktree.none");
  const shown = offer.on ? t("blank.worktree.from", { branch: name }) : name;
  const branches = [
    ...(offer.branches.defaultBranch !== undefined &&
    !offer.branches.branches.includes(offer.branches.defaultBranch)
      ? [offer.branches.defaultBranch]
      : []),
    ...offer.branches.branches,
  ];
  return (
    <Menu modal={false}>
      <Tip label={t("composer.setting", { setting: t("blank.worktree"), value: shown })}>
        <MenuTrigger
          ref={trigger}
          data-variant="ghost"
          data-kind="blank-worktree"
          data-unset={!offer.on || undefined}
          disabled={disabled}
        >
          <span data-slot="blank-agent-name">{shown}</span>
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
          value={offer.on ? (offer.base ?? "") : NONE}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            if (next === NONE) store.chooseBlankWorktree({ on: false });
            else store.chooseBlankWorktree({ on: true, base: next });
          }}
        >
          <MenuGroupLabel id={headingId}>{t("blank.worktree.heading")}</MenuGroupLabel>
          <MenuRadioItem value={NONE} label={t("blank.worktree.none")} closeOnSelect>
            <span data-slot="option-name">{t("blank.worktree.none")}</span>
            <MenuItemIndicator>
              <CheckIcon size={13} />
            </MenuItemIndicator>
          </MenuRadioItem>
          {branches.map((branch) => (
            <MenuRadioItem key={branch} value={branch} label={branch} closeOnSelect>
              <span data-slot="option-name">{branch}</span>
              <MenuItemIndicator>
                <CheckIcon size={13} />
              </MenuItemIndicator>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Under a session's title: the branch it works on, with the worktree's path as its tip. Nothing outside a worktree. */
export function WorktreeBadge({ worktree }: { worktree: WorktreeSummary | undefined }) {
  const { t } = useI18n();
  if (worktree === undefined) return null;
  const label = worktree.branch ?? t("blank.worktree.on");
  return (
    <Tip label={worktree.path}>
      <span data-slot="session-worktree">{t("session.worktree", { branch: label })}</span>
    </Tip>
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
