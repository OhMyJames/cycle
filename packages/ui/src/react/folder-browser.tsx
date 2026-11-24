// Choosing a folder on the machine of a location that is not this computer: its daemon lists the folders, one level
// at a time (docs/protocol.md §8). For this computer the system's own chooser is used.
import { Button } from "@ui-sdk/react/button";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderListing, ListFolders } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { StateBlock } from "./state-block.tsx";

export type FolderBrowserProps = {
  /** Where it starts: a folder, absolute; without it (or when it cannot be read) the location's home. */
  start?: string | undefined;
  list: ListFolders;
  onChoose: (path: string) => void;
  onBack: () => void;
};

type Shown =
  /** What was shown stays until the next listing is there: the page does not blank at every step. */
  | { kind: "loading"; previous?: FolderListing }
  | { kind: "error"; reason: string; path: string | undefined }
  | { kind: "listing"; listing: FolderListing };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The folder above a path that could not be listed (so that the way out of it is there too). */
const above = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return null;
  return trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
};

export function FolderBrowser({ start, list, onChoose, onBack }: FolderBrowserProps) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  // Where it started: it does not start again when what is typed behind it changes.
  const [initial] = useState(start);
  // The latest `list`, so that going to a folder does not depend on it (it is a new function at every render above).
  const lister = useRef(list);
  lister.current = list;
  // The answer to an older question is not shown: the person went on before it came.
  const asked = useRef(0);
  // The folder last asked for: what the toggle and "Try again" ask again, whatever came back.
  const target = useRef<string | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  // A step taken with the keyboard keeps the keyboard in the list.
  const focusList = useRef(false);
  const go = useCallback(
    async (path: string | undefined, withHidden: boolean, fromStart = false) => {
      asked.current += 1;
      const mine = asked.current;
      target.current = path;
      setShown((now) =>
        now.kind === "listing"
          ? { kind: "loading", previous: now.listing }
          : now.kind === "loading"
            ? now
            : { kind: "loading" },
      );
      try {
        const listing = await lister.current(path, withHidden);
        if (mine === asked.current) setShown({ kind: "listing", listing });
      } catch (error) {
        if (mine !== asked.current) return;
        // The folder it started in is gone or cannot be read: it starts from home instead of from an error.
        if (fromStart && path !== undefined) return void go(undefined, withHidden);
        setShown({ kind: "error", reason: messageOf(error), path });
      }
    },
    [],
  );
  useEffect(() => {
    void go(initial, false, true);
  }, [go, initial]);
  useEffect(() => {
    if (shown.kind !== "listing" || !focusList.current) return;
    focusList.current = false;
    box.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
  }, [shown]);
  const listing =
    shown.kind === "listing"
      ? shown.listing
      : shown.kind === "loading"
        ? shown.previous
        : undefined;
  const failedAt = shown.kind === "error" ? shown.path : undefined;
  const up = listing !== undefined ? listing.parent : above(failedAt);
  return (
    <div data-slot="folder-browser" ref={box} aria-busy={shown.kind === "loading"}>
      <div data-slot="stack">
        <p data-slot="row">
          <span data-slot="visually-hidden">{t("folders.path")}: </span>
          <code data-slot="path">{listing?.path ?? failedAt ?? ""}</code>
        </p>
        <div data-slot="row">
          <Button
            data-variant="outline"
            disabled={up === null}
            onClick={() => up !== null && void go(up, hidden)}
          >
            {t("folders.up")}
          </Button>
          <Button data-variant="outline" onClick={() => void go(undefined, hidden)}>
            {t("folders.home")}
          </Button>
          <Button
            data-variant="ghost"
            aria-pressed={hidden}
            onClick={() => {
              const next = !hidden;
              setHidden(next);
              void go(target.current, next);
            }}
          >
            {t("folders.hidden")}
          </Button>
        </div>
        {shown.kind === "loading" && listing === undefined ? (
          <StateBlock size="inline" tone="loading" title={t("folders.loading")} />
        ) : null}
        {shown.kind === "error" ? (
          <StateBlock
            size="inline"
            tone="error"
            title={t("folders.error")}
            reason={shown.reason}
            action={{ label: t("folders.retry"), onAction: () => void go(shown.path, hidden) }}
          />
        ) : null}
        {listing !== undefined && listing.folders.length === 0 ? (
          <StateBlock size="inline" tone="empty" title={t("folders.empty")} />
        ) : null}
        {listing !== undefined && listing.folders.length > 0 ? (
          <Listbox
            aria-label={t("folders.list")}
            value={null}
            onValueChange={(name) => {
              if (typeof name !== "string") return;
              focusList.current = true;
              void go(`${listing.path === "/" ? "" : listing.path}/${name}`, hidden);
            }}
          >
            {listing.folders.map((folder) => (
              <ListboxItem key={folder.name} value={folder.name}>
                {folder.name}
              </ListboxItem>
            ))}
          </Listbox>
        ) : null}
        {listing?.truncated === true ? (
          <p data-slot="hint">{t("folders.truncated", { count: listing.folders.length })}</p>
        ) : null}
      </div>
      <div data-slot="row">
        <Button data-variant="outline" onClick={onBack}>
          {t("folders.cancel")}
        </Button>
        <Button
          data-variant="solid"
          disabled={shown.kind !== "listing"}
          onClick={() => shown.kind === "listing" && onChoose(shown.listing.path)}
        >
          {t("folders.choose")}
        </Button>
      </div>
    </div>
  );
}
