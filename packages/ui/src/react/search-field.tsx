// The one search box of the pages: a magnifier inside the field, a clear button once there is text, and Escape that
// clears it (not while an IME is composing). Callers own the text and what it filters.
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { useI18n } from "./i18n.tsx";
import { CloseIcon, SearchIcon } from "./icons.tsx";
import { Tip } from "./tip.tsx";

export function SearchField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder and accessible name. */
  label: string;
}) {
  const { t } = useI18n();
  return (
    <div data-slot="search-field">
      <SearchIcon size={14} />
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={label}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isComposing(event) && value !== "") {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value !== "" ? (
        <Tip label={t("loop.search.clear")}>
          <Button
            data-variant="ghost"
            data-kind="search-field-clear"
            aria-label={t("loop.search.clear")}
            onClick={() => onChange("")}
          >
            <CloseIcon size={12} />
          </Button>
        </Tip>
      ) : null}
    </div>
  );
}
