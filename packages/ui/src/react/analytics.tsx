import { Button } from "@ui-sdk/react/button";
import { AppNotice } from "./app-notice.tsx";
import { useI18n } from "./i18n.tsx";
import { ShieldIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * Said once, in the sidebar's notices, the first time the app runs with somewhere to report to: what is counted, and
 * that it can be turned off. Either button is an answer, and the notice does not come back.
 */
export function AnalyticsNotice() {
  const store = useAppStore();
  const { t } = useI18n();
  const analytics = useAppState((s) => s.analytics);
  if (analytics === undefined || !analytics.available || analytics.noticed) return null;
  return (
    <AppNotice
      tone="info"
      icon={<ShieldIcon />}
      text={t("analytics.notice")}
      actions={
        <>
          <Button data-variant="ghost" onClick={() => void store.setAnalytics(false)}>
            {t("analytics.turnOff")}
          </Button>
          <Button data-variant="outline" onClick={() => void store.setAnalytics(true)}>
            {t("analytics.keepOn")}
          </Button>
        </>
      }
    />
  );
}
