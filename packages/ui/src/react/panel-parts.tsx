// What every tab of the right panel is built from, so that they read as one panel: a bar under the tab strip that says
// what is shown on its left and holds the tab's actions on its right, and a path drawn so that its file's name is what
// survives a narrow panel.
import { Button } from "@ui-sdk/react/button";
import type { ReactElement, ReactNode } from "react";
import { Tip } from "./tip.tsx";

/** The bar of a tab: `children` say what is shown, `actions` are icon buttons (`PanelAction`). It stays when its tab scrolls. */
export function PanelBar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <div data-slot="panel-bar">
      <div data-slot="panel-bar-lead">{children}</div>
      {actions !== undefined ? <div data-slot="panel-bar-actions">{actions}</div> : null}
    </div>
  );
}

/** An action of a tab's bar: an icon, named by its tip. `pressed`: a setting that is on or off. */
export function PanelAction({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactElement;
}) {
  return (
    <Tip label={label} side="bottom">
      <Button
        data-variant="ghost"
        data-kind="panel-action"
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tip>
  );
}

/**
 * A file's path on one line: its folder quiet, its name in ink. Too long for the row, the folder is cut (from its start,
 * so the nearest folder stays), and only a name longer than the whole row is cut itself.
 */
export function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span data-slot="path-label" title={path}>
      {/* Said whole: the two parts drawn are one path, and are not read as two words. */}
      <span data-slot="visually-hidden">{path}</span>
      {cut > 0 ? (
        <span data-slot="path-folder" aria-hidden="true">
          <bdi>{path.slice(0, cut)}</bdi>
        </span>
      ) : null}
      <span data-slot="path-name" aria-hidden="true">
        {path.slice(cut)}
      </span>
    </span>
  );
}
