// What needs a person, most urgent first, as the Loop server lists it. A Notice that names a session opens that
// session; the others take the person to the ticket.
import type { LoopNotice } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, ErrorCircleIcon, ShieldAlertIcon, WarningIcon } from "./icons.tsx";
import { PageGroup, PageRows } from "./page-layout.tsx";

/** What needs a person, most urgent first. One that names a session opens it; the others open the ticket's drawer. */
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
      <PageGroup title={t("loop.notices")}>
        <PageRows>
          <ul data-slot="loop-notice-list">
            {notices.map(({ projectKey, notice }) => (
              <li
                key={`${projectKey}:${notice.id}`}
                data-slot="loop-notice"
                data-notice={notice.kind}
              >
                <button
                  type="button"
                  data-slot="loop-notice-open"
                  onClick={() => onOpen(projectKey, notice)}
                >
                  <span data-slot="loop-notice-icon" aria-hidden="true">
                    {notice.kind === "permission" ? (
                      <ShieldAlertIcon size={16} />
                    ) : notice.kind === "blocked" ? (
                      <ErrorCircleIcon size={16} />
                    ) : (
                      <WarningIcon size={16} />
                    )}
                  </span>
                  <span data-slot="loop-notice-body">
                    <span data-slot="loop-notice-head">
                      <span data-slot="loop-ticket-id">{notice.identifier}</span>
                      <span data-slot="loop-notice-kind" data-notice={notice.kind}>
                        {t(`loop.notice.${notice.kind}`)}
                      </span>
                    </span>
                    {notice.text !== "" ? (
                      <span data-slot="loop-notice-detail">{notice.text}</span>
                    ) : null}
                  </span>
                  <ChevronRightIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        </PageRows>
      </PageGroup>
    </section>
  );
}
