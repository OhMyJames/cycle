import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { insideFolder } from "../files-view.ts";
import { type Finding, type Review, reviewTally, type ToolItem } from "../model/index.ts";
import { filesRootOf } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * A code review the agent reported (CYCL-138), on a card of its own: a line that says how many findings there are and
 * how sure the review is of them (or that it found nothing), then one row per finding, the surest first. A row says the
 * defect in a line and where it is; open, the whole sentence and when it goes wrong. Everything in it is the agent's,
 * drawn as plain text: nothing is parsed as Markdown or HTML, and nothing is loaded.
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

/** Where a finding is, as the row shows it: the path, and its line. */
const placeOf = (finding: Finding): string =>
  finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;

function FindingRow({ finding }: { finding: Finding }) {
  const { t } = useI18n();
  const store = useAppStore();
  const filesRoot = useAppState(filesRootOf);
  // A path inside the session's folder can be shown in Files; one outside it, or that climbs out, is only text.
  const inFiles =
    filesRoot === undefined
      ? undefined
      : finding.file.startsWith("/")
        ? insideFolder(finding.file, filesRoot)
        : insideFolder(`${filesRoot.replace(/\/+$/, "")}/${finding.file}`, filesRoot);
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
                store.showInFiles(inFiles);
                store.track("file_shown_from_conversation", { target: "file", from: "review" });
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
