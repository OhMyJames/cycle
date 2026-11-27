// A page that takes the whole window in place of the sessions (CYCL-78): Settings (settings.tsx) and Connectors (connectors.tsx, CYCL-82).
// It keeps the sessions' frame (CYCL-219): on the left, in the sidebar's place and as wide, the way back and the page's
// sections; on the right the chosen section's name in the title bar, and the section under it.
// The sections are the SDK's tabs, set upright: the arrows move and select, Home and End, and only the chosen
// section is in the page. Escape goes back, unless something opened over the page (a dialog, a menu) is what it closes.
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { Fragment, type ReactNode, useEffect, useId, useRef } from "react";
import { ChevronLeftIcon } from "./icons.tsx";

/** The key that goes back, as it is printed on the keyboard: a name, not a word to translate. */
const ESCAPE_KEY = "Esc";

export type PageSection = {
  /** Stable: what is remembered, and what the analytics name (a fixed word, never a title). */
  id: string;
  label: string;
  /** Optional non-focusable group header rendered before the first section of a consecutive group. */
  group?: string;
  /** Optional icon rendered before the label inside the nav tab (e.g. `<AgentLogo />`). */
  icon?: ReactNode;
  /** Not there yet: the section is listed, with `note` beside it, and cannot be chosen. It has no content. */
  disabled?: boolean;
  /** A word kept at the end of the section's row (what a disabled section is waiting for). */
  note?: string;
  /** Optional custom heading content in the right pane; defaults to `label`. */
  heading?: ReactNode;
  /** `"full"` fills the content pane edge-to-edge without the centered reading column (used by the Loop board). */
  layout?: "column" | "full";
  content: ReactNode;
};

export function PageLayout({
  title,
  sectionsLabel,
  backLabel,
  onBack,
  banner,
  sections,
  value,
  onValueChange,
}: {
  title: string;
  /** What the list of sections is called, for a screen reader. */
  sectionsLabel: string;
  backLabel: string;
  onBack: () => void;
  /** Said above the section, whichever is shown: what went wrong. */
  banner?: ReactNode;
  sections: readonly PageSection[];
  value: string;
  onValueChange: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const back = useRef(onBack);
  back.current = onBack;

  // The page opens with the keyboard on its sections: the arrows walk them at once.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-slot="tabs-tab"][data-selected]')?.focus();
  }, []);

  // On the window, not the page: Escape also goes back when nothing in the page has the focus. What is opened over the
  // page is drawn outside it, so an Escape from there is that thing's own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An Escape that cancels an input method's text is that text's own, not the page's.
      if (event.key !== "Escape" || event.defaultPrevented || isComposing(event)) return;
      const target = event.target as Node | null;
      const root = rootRef.current;
      if (root === null) return;
      if (target !== null && target !== document.body && !root.contains(target)) return;
      event.preventDefault();
      back.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = sections.find((section) => section.id === value);
  const groupIdPrefix = useId();
  const groupIdOf = (group: string) => `${groupIdPrefix}-${group.replace(/\s+/g, "-")}`;

  return (
    <div data-slot="page" ref={rootRef}>
      <Tabs
        data-kind="page"
        orientation="vertical"
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onValueChange(next);
        }}
      >
        <nav data-slot="page-nav" aria-label={title}>
          <div data-slot="titlebar" aria-hidden="true" />
          <div data-slot="sidebar-actions">
            <Button data-variant="ghost" data-kind="sidebar-action" onClick={onBack}>
              <ChevronLeftIcon />
              {backLabel}
              <kbd>{ESCAPE_KEY}</kbd>
            </Button>
          </div>
          <h1 data-slot="page-title">{title}</h1>
          <TabsList aria-label={sectionsLabel}>
            {sections.map((section, index) => {
              const prevGroup = index > 0 ? sections[index - 1]?.group : undefined;
              const showGroup = section.group !== undefined && section.group !== prevGroup;
              return (
                <Fragment key={section.id}>
                  {/* A tablist holds only tabs: the group's name is drawn for the eye, and said with each of its tabs. */}
                  {showGroup && section.group !== undefined ? (
                    <div
                      data-slot="page-nav-group"
                      id={groupIdOf(section.group)}
                      aria-hidden="true"
                    >
                      {section.group}
                    </div>
                  ) : null}
                  <TabsTab
                    value={section.id}
                    disabled={section.disabled === true}
                    aria-describedby={
                      section.group !== undefined ? groupIdOf(section.group) : undefined
                    }
                  >
                    {section.icon}
                    <span data-slot="page-nav-label">{section.label}</span>
                    {section.note !== undefined ? (
                      <span data-slot="page-nav-note">{section.note}</span>
                    ) : null}
                  </TabsTab>
                </Fragment>
              );
            })}
          </TabsList>
        </nav>
        {/* The conversation's place: the title bar with the section's name, what is wrong under it, then the section,
            which alone scrolls. */}
        <div data-slot="page-main">
          <header data-slot="page-header">
            <h2 data-slot="page-heading">{shown?.heading ?? shown?.label}</h2>
          </header>
          {banner}
          <div data-slot="page-body" data-full={shown?.layout === "full" ? "" : undefined}>
            {sections
              .filter((section) => section.disabled !== true)
              .map((section) => (
                <TabsPanel
                  key={section.id}
                  value={section.id}
                  data-layout={section.layout === "full" ? "full" : undefined}
                >
                  {section.layout === "full" ? (
                    section.content
                  ) : (
                    <div data-slot="page-column">{section.content}</div>
                  )}
                </TabsPanel>
              ))}
          </div>
        </div>
      </Tabs>
    </div>
  );
}

/** A group of a section: a heading, a line of what it is when the heading does not say, and what belongs to it. */
export function PageGroup({
  title,
  lead,
  action,
  children,
}: {
  title?: string | undefined;
  lead?: string | undefined;
  /** One control that acts on the group as a whole (Add location), at the heading's end. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-slot="page-group">
      {title !== undefined || action !== undefined ? (
        <div data-slot="page-group-head">
          {title !== undefined ? (
            <h3 data-slot="page-group-title">{title}</h3>
          ) : (
            <p data-slot="page-group-lead">{lead}</p>
          )}
          {action}
        </div>
      ) : null}
      {lead !== undefined && (title !== undefined || action === undefined) ? (
        <p data-slot="page-group-lead">{lead}</p>
      ) : null}
      {children}
    </section>
  );
}

/** The rows of a group, as one bordered list. */
export function PageRows({ children }: { children: ReactNode }) {
  return <div data-slot="page-rows">{children}</div>;
}

/**
 * One setting: its name and a line under it on the left, its control on the right. `below` is what belongs to the row
 * and needs its whole width (the system's own words when something failed).
 */
export function PageRow({
  label,
  labelId,
  description,
  before,
  below,
  children,
}: {
  label: string;
  /** Names the row's control by its label (`aria-labelledby`) when the control has no text of its own. */
  labelId?: string;
  description?: ReactNode;
  /** A mark before the name: a state's dot. */
  before?: ReactNode;
  below?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-slot="page-row">
      <div data-slot="page-row-line">
        {before}
        <div data-slot="page-row-text">
          <span data-slot="page-row-label" id={labelId} title={label}>
            {label}
          </span>
          {description != null && description !== "" ? (
            <span data-slot="page-row-description">{description}</span>
          ) : null}
        </div>
        {children != null ? <div data-slot="page-row-control">{children}</div> : null}
      </div>
      {below}
    </div>
  );
}
