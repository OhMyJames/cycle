import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useContext, useMemo } from "react";
import { agentPathInFolder } from "../files-view.ts";
import { type Finding, type Review, reviewTally, type ToolItem } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { type FileLinks, FileLinksContext, Markdown } from "./markdown.tsx";
import { useScopedFilesRoot } from "./session-scope.tsx";
import { useAppStore } from "./store-context.tsx";

/**
 * A code review the agent reported (CYCL-138), on a card of its own: a line that says how many findings there are and
 * how sure the review is of them (or that it found nothing), then one row per finding, in the agent's order (the most
 * severe first). A row says the
 * defect in a line and where it is; open, the whole sentence and when it goes wrong. Everything in it is the agent's:
 * the findings are drawn as plain text, nothing in them parsed as Markdown or HTML. What the agent said around them (a
 * skill's result, CYCL-216) goes under the head, through the same Markdown as a reply (no HTML, no images loaded).
 */
export function ReviewCard({ tool, review }: { tool: ToolItem; review: Review }) {
  const { t } = useI18n();
  const tally = reviewTally(review);
  const parts =
    tally.total === 0
      ? [t("review.none")]
      : [
          t("review.count", { count: tally.total }),
          ...(tally.confirmed > 0 ? [t("review.confirmed", { count: tally.confirmed })] : []),
          ...(tally.plausible > 0 ? [t("review.plausible", { count: tally.plausible })] : []),
          ...(tally.fixed > 0 ? [t("review.fixed", { count: tally.fixed })] : []),
        ];
  return (
    <section data-kind="review" data-item-id={tool.id} aria-label={t("review.title")}>
      <header data-slot="review-head">
        <h3 data-slot="review-title">{t("review.title")}</h3>
        <span data-slot="review-tally">{parts.join(" · ")}</span>
      </header>
      {review.prose !== undefined ? <ReviewProse text={review.prose} /> : null}
      {review.findings.length > 0 ? (
        <ol data-slot="review-findings" aria-label={t("review.findings")}>
          {review.findings
            // A reported review never changes: a finding's place is who it is.
            .map((finding, at) => ({ finding, key: `${at}:${finding.file}` }))
            .map(({ finding, key }) => (
              <FindingRow key={key} finding={finding} />
            ))}
        </ol>
      ) : null}
    </section>
  );
}

/** What the agent said around its findings. A file named in it opens as from a reply's, and is counted as the review's. */
function ReviewProse({ text }: { text: string }) {
  const store = useAppStore();
  const links = useContext(FileLinksContext);
  const reviewLinks = useMemo<FileLinks | undefined>(
    () =>
      links === undefined
        ? undefined
        : {
            root: links.root,
            open: (file) => {
              const folder = file.folder === true;
              store.showInFiles(file.path, { folder, line: file.line, end: file.end });
              store.track("file_shown_from_conversation", {
                target: folder ? "folder" : "file",
                from: "review",
                line: file.line !== undefined,
              });
            },
          },
    [links, store],
  );
  return (
    <div data-slot="review-prose">
      <div data-slot="message" data-role="agent">
        <FileLinksContext.Provider value={reviewLinks}>
          <Markdown text={text} />
        </FileLinksContext.Provider>
      </div>
    </div>
  );
}

/** Where a finding is, as the row shows it: the path, and its line. */
const placeOf = (finding: Finding): string =>
  finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;

function FindingRow({ finding }: { finding: Finding }) {
  const { t } = useI18n();
  const store = useAppStore();
  const filesRoot = useScopedFilesRoot();
  // A path inside the session's folder can be shown in Files; one outside it, or that climbs out, is only text.
  const inFiles = filesRoot === undefined ? undefined : agentPathInFolder(finding.file, filesRoot);
  const place = placeOf(finding);
  return (
    <li data-slot="review-finding" data-verdict={finding.verdict} data-outcome={finding.outcome}>
      <Collapsible data-kind="review-finding">
        <CollapsibleTrigger>
          {finding.verdict !== undefined ? (
            <span data-slot="review-tag" data-verdict={finding.verdict}>
              {t(`review.verdict.${finding.verdict}`)}
            </span>
          ) : null}
          {finding.outcome !== undefined ? (
            <span data-slot="review-tag" data-outcome={finding.outcome}>
              {t(`review.outcome.${finding.outcome}`)}
            </span>
          ) : null}
          <span data-slot="review-summary" title={finding.short ?? finding.summary}>
            {finding.short ?? finding.summary}
          </span>
        </CollapsibleTrigger>
        <div data-slot="review-place">
          {inFiles !== undefined ? (
            <button
              type="button"
              data-slot="review-file"
              aria-label={t("review.open", { file: place })}
              title={place}
              onClick={() => {
                // At the finding's line, when it names one (CYCL-136).
                store.showInFiles(inFiles, { line: finding.line });
                store.track("file_shown_from_conversation", {
                  target: "file",
                  from: "review",
                  line: finding.line !== undefined,
                });
              }}
            >
              {place}
            </button>
          ) : (
            <span data-slot="review-file" title={place}>
              {place}
            </span>
          )}
          {finding.category !== undefined ? (
            <span data-slot="review-category">{finding.category}</span>
          ) : null}
        </div>
        <CollapsiblePanel>
          {finding.short !== undefined ? (
            <section data-slot="review-part" aria-label={t("review.issue")}>
              <h4 data-slot="tool-block-label">{t("review.issue")}</h4>
              <p>{finding.summary}</p>
            </section>
          ) : null}
          <section data-slot="review-part" aria-label={t("review.scenario")}>
            <h4 data-slot="tool-block-label">{t("review.scenario")}</h4>
            <p>{finding.scenario}</p>
          </section>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
