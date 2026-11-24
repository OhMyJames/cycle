import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog";
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { useEffect, useState } from "react";
import type { LocationConfig } from "../api.ts";
import { useI18n } from "./i18n.tsx";

type OpenProps = { open: boolean; onOpenChange: (open: boolean) => void };

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']*': (Error: )?/,
    "",
  );

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  detail,
  confirmLabel,
  destructive = false,
  onConfirm,
  alternative,
}: OpenProps & {
  title: string;
  description: string;
  /** A path or name the decision is about, shown whole under the description. */
  detail?: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Returning a non-empty error string keeps the dialog open and shows it inline. */
  onConfirm: () => unknown;
  /** A second way to go ahead, beside the first (as the first, it may keep the dialog open with an error). */
  alternative?: { label: string; destructive?: boolean; onConfirm: () => unknown } | undefined;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    if (!open) {
      setBusy(false);
      setProblem(undefined);
    }
  }, [open]);
  const confirm = async (action: () => unknown = onConfirm) => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const error = await action();
      if (typeof error === "string" && error !== "") {
        setProblem(error);
        return;
      }
      onOpenChange(false);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogBackdrop />
      <AlertDialogContent>
        <div data-slot="stack">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {detail !== undefined ? <code data-slot="decision-path">{detail}</code> : null}
          {problem !== undefined ? (
            <p data-slot="hint" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div data-slot="row" data-dialog-footer="">
          <AlertDialogClose disabled={busy}>{t("dialog.cancel")}</AlertDialogClose>
          {alternative !== undefined ? (
            <Button
              type="button"
              data-variant={alternative.destructive === true ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => void confirm(alternative.onConfirm)}
            >
              {alternative.label}
            </Button>
          ) : null}
          <Button
            type="button"
            data-variant={destructive ? "destructive" : "solid"}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type RemoteLocation = LocationConfig & { kind: "remote" };

export type LocationDialogProps = OpenProps & {
  editing?: RemoteLocation | undefined;
  existingIds?: ReadonlySet<string> | undefined;
  /** Returning a non-empty error string keeps the dialog open and shows it inline. */
  onSave: (location: LocationConfig) => unknown;
};

const uniqueLocationId = (rawHost: string, existing?: ReadonlySet<string>): string => {
  const slug =
    rawHost
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "remote";
  const base = `ssh-${slug}`;
  if (existing === undefined || !existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

/** A remote location: a daemon on another machine, reached over ssh with the keys and config the user already has. */
export function LocationDialog({
  open,
  onOpenChange,
  editing,
  existingIds,
  onSave,
}: LocationDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [command, setCommand] = useState("cycle proxy");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // Reset when closed or switching between add and edit so stale inputs do not carry across.
  useEffect(() => {
    if (!open) {
      setName("");
      setHost("");
      setCommand("cycle proxy");
      setBusy(false);
      setProblem(undefined);
      return;
    }
    if (editing !== undefined) {
      setName(editing.name);
      setHost(editing.transport.host);
      setCommand(
        (editing.transport.command && editing.transport.command.length > 0
          ? editing.transport.command
          : ["cycle", "proxy"]
        ).join(" "),
      );
    } else {
      setName("");
      setHost("");
      setCommand("cycle proxy");
    }
    setProblem(undefined);
  }, [open, editing]);
  const save = async () => {
    if (host.trim() === "" || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const id = editing?.id ?? uniqueLocationId(host, existingIds);
      const error = await onSave({
        id,
        name: name.trim() || host.trim(),
        kind: "remote",
        transport: {
          type: "ssh",
          host: host.trim(),
          command: command.trim().split(/\s+/).filter(Boolean),
        },
      });
      if (typeof error === "string" && error !== "") {
        setProblem(error);
        return;
      }
      onOpenChange(false);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>
          {editing !== undefined
            ? t("location.editTitle", { name: editing.name })
            : t("location.addTitle")}
        </DialogTitle>
        <DialogDescription>{t("location.sshNote")}</DialogDescription>
        <form
          data-slot="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field name="host">
            <FieldLabel>{t("location.address")}</FieldLabel>
            <Input
              autoFocus
              value={host}
              placeholder={t("location.addressHint")}
              onChange={(e) => setHost(e.currentTarget.value)}
            />
          </Field>
          <Field name="name">
            <FieldLabel>{t("location.name")}</FieldLabel>
            <Input
              value={name}
              placeholder={host || t("location.nameHint")}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Field name="command">
            <FieldLabel>{t("location.command")}</FieldLabel>
            <Input value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
          </Field>
          {problem !== undefined ? (
            <p data-slot="hint" role="alert">
              {problem}
            </p>
          ) : null}
          <div data-slot="row" data-dialog-footer="">
            <DialogClose disabled={busy}>{t("dialog.cancel")}</DialogClose>
            <Button type="submit" data-variant="solid" disabled={host.trim() === "" || busy}>
              {editing !== undefined ? t("location.save") : t("location.addSubmit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
