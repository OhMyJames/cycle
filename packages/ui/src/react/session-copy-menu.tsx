import { MenuItem, MenuSub, MenuSubContent, MenuSubTrigger } from "@ui-sdk/react/menu";
import { toast } from "@ui-sdk/react/toast";
import type { SessionSummary } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { useAppStore } from "./store-context.tsx";

/** Values of the Copy submenu's items; the menus' own `onAction` leaves them alone, the items copy by themselves. */
export const COPY_VALUES: readonly string[] = ["copy-session-id", "copy-path"];

/** "Copy", a submenu of the session's id and its absolute path (its working folder). Put it in a session menu's content. */
export function SessionCopyMenu({ session }: { session: SessionSummary }) {
  const { t } = useI18n();
  const store = useAppStore();
  const copy = (text: string) =>
    void store.copyText(text).then((done) => {
      if (done) toast.success(t("tool.copied"), { duration: 1500 });
      else toast.error(t("tool.copyFailed"));
    });
  return (
    <MenuSub>
      <MenuSubTrigger>{t("session.copy")}</MenuSubTrigger>
      <MenuSubContent>
        <MenuItem value="copy-session-id" onSelect={() => copy(session.sessionId)}>
          {t("session.copySessionId")}
        </MenuItem>
        <MenuItem value="copy-path" onSelect={() => copy(session.cwd)}>
          {t("session.copyPath")}
        </MenuItem>
      </MenuSubContent>
    </MenuSub>
  );
}
