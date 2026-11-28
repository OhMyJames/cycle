// The tabs of a panel (CYCL-66): the right panel's (Overview, Files, Diff, Terminal, Browser) and, later, the settings
// page's sections. The SDK's tabs: arrows move and select, Home and End, and only the chosen tab's content is in the
// page, so a tab not looked at loads nothing. The strip is 42px, level with the conversation's header.
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { ReactNode } from "react";
import { CloseIcon } from "./icons.tsx";

export type PanelTab = {
  /** Stable: what is remembered, and what the analytics name (a fixed word, never a title). */
  id: string;
  label: string;
  /** What kind of tab it is, before its label: decoration, the label names it. */
  icon?: ReactNode;
  content: ReactNode;
  /**
   * A tab that can be closed: a cross on it for the pointer, and Delete or Backspace on the focused tab for
   * the keyboard (said to a screen reader as the tab's shortcut).
   */
  onClose?: (() => void) | undefined;
  /** Drawn quieter: a tab whose shell has exited. */
  quiet?: boolean | undefined;
};

export function PanelTabs({
  label,
  tabs,
  value,
  onValueChange,
  actions,
}: {
  /** What the strip is called, for a screen reader. */
  label: string;
  tabs: readonly PanelTab[];
  value: string | null;
  onValueChange: (id: string) => void;
  /** Buttons at the end of the strip, outside the tabs (Open a tab). */
  actions?: ReactNode;
}) {
  return (
    <Tabs
      data-kind="panel-tabs"
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next);
      }}
    >
      <div data-slot="panel-tabs-bar">
        <TabsList aria-label={label}>
          {tabs.map((tab) => (
            <TabsTab
              key={tab.id}
              value={tab.id}
              data-closable={tab.onClose !== undefined || undefined}
              data-quiet={tab.quiet || undefined}
              aria-keyshortcuts={tab.onClose !== undefined ? "Delete" : undefined}
              onKeyDown={(event) => {
                if (tab.onClose === undefined) return;
                if (event.key !== "Delete" && event.key !== "Backspace") return;
                event.preventDefault();
                tab.onClose();
              }}
            >
              {tab.icon}
              <span data-slot="panel-tab-label">{tab.label}</span>
              {tab.onClose !== undefined ? (
                // For the pointer only: the keyboard closes the focused tab with Delete, and a button inside a tab
                // would be a control inside a control.
                <span
                  data-slot="panel-tab-close"
                  aria-hidden="true"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    tab.onClose?.();
                  }}
                >
                  <CloseIcon size={12} />
                </span>
              ) : null}
            </TabsTab>
          ))}
        </TabsList>
        {actions}
      </div>
      {tabs.map((tab) => (
        <TabsPanel key={tab.id} value={tab.id}>
          {tab.content}
        </TabsPanel>
      ))}
    </Tabs>
  );
}
