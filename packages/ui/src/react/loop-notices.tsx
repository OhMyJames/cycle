// What needs a person, most urgent first, as the Loop server lists it. A Notice that names a session opens that
// session; the others take the person to the Project's board.
import type { LoopNotice } from "../api.ts";
import { useI18n } from "./i18n.tsx";

export function Notices({
  notices,
  onOpen,
}: {
  notices: { projectKey: string; notice: LoopNotice }[];
  onOpen: (projectKey: string, notice: LoopNotice) => void;
}) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <section data-slot="loop-notices" data-kind="loop-notices" aria-label={t("loop.notices")}>
      <h3 data-slot="loop-column-title">{t("loop.notices")}</h3>
      <ul data-slot="loop-tickets">
        {notices.map(({ projectKey, notice }) => (
          <li key={`${projectKey}:${notice.id}`} data-slot="loop-notice" data-notice={notice.kind}>
            <span data-slot="loop-ticket-id">{notice.identifier}</span>
            <button
              type="button"
              data-slot="loop-ticket-title"
              onClick={() => onOpen(projectKey, notice)}
            >
              {t(`loop.notice.${notice.kind}`)}
              {notice.text !== "" ? `: ${notice.text}` : ""}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
