import { AccountNotice } from "./account.tsx";
import { AnalyticsNotice } from "./analytics.tsx";
import { useAppState } from "./store-context.tsx";
import { DaemonNotice, daemonNoticed, UpdateNotice } from "./update.tsx";

/**
 * What concerns the whole app, in one stack: the account first (online features stop on it), then each environment's
 * daemon this app cannot use or that wants updating, then this app's update, then what is counted. In the sidebar, over
 * its footer; as flat rows under the page's title bar, over its own notices, while the sidebar is put away.
 */
export function AppNotices({ at = "sidebar" }: { at?: "sidebar" | "top" }) {
  // The environments whose daemon has something to say, by id: a new array only when that set changes.
  const daemons = useAppState((s) =>
    s.environments
      .filter((e) => s.status[e.id]?.incompatible !== undefined || s.status[e.id]?.daemon?.upgrade)
      .map((e) => e.id)
      .join("\n"),
  );
  return (
    <div data-slot="app-notices" data-at={at}>
      <AccountNotice />
      {daemons === ""
        ? null
        : daemons.split("\n").map((id) => <DaemonNotice key={id} environmentId={id} />)}
      <UpdateNotice />
      <AnalyticsNotice />
    </div>
  );
}
