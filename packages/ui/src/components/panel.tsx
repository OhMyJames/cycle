import type { ReactNode } from "react";
import { useApp } from "../context.ts";
import { Icon } from "./icons.tsx";

/**
 * A panel's header: 30 high, so inside a card inset 6 its middle is level with the title row's. On
 * the left, what the panel is looking at, or its name; on the right, the panel's own actions and
 * then Close.
 */
export function PanelHeader({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const app = useApp();
  return (
    <header className="panel-header">
      <div className="panel-title">{children ?? <span className="fade-x">{title}</span>}</div>
      <div className="panel-actions">
        {actions}
        <button
          type="button"
          className="icon-button"
          title={`Close ${title}`}
          aria-label={`Close ${title}`}
          onClick={() => app.setView({ panel: null })}
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  );
}
