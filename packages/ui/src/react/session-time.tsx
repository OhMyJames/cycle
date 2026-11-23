import { memo } from "react";
import { fullTime, relativeTime } from "../relative-time.ts";
import { useI18n } from "./i18n.tsx";
import { useNow } from "./now.ts";

/**
 * When a session last changed (its `updatedAt`), short, at the end of its row: "5m". The whole date and time on
 * hover. Nothing when the daemon does not say (an older one) or says something that is not a time.
 */
export const SessionTime = memo(function SessionTime({ at }: { at: string | undefined }) {
  const { locale } = useI18n();
  const now = useNow();
  const time = at === undefined ? Number.NaN : Date.parse(at);
  if (Number.isNaN(time)) return null;
  return (
    <time
      data-slot="session-time"
      dateTime={new Date(time).toISOString()}
      title={fullTime(time, locale)}
    >
      {relativeTime(time, now, locale)}
    </time>
  );
});
