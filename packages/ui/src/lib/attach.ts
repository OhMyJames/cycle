import type { AttachmentKind, PromptDocument, QueuedMessage, SlashCommand } from "@cycle/protocol";

/** The largest file a prompt carries: its data goes to the daemon whole. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Files read as text though their type does not say so. */
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|log|ini|cfg|conf|sh|py|ts|tsx|js|jsx|go|rs|java|kt|swift|c|h|cc|cpp|hpp|rb|php|sql)$/i;

/** What a file is as an attachment, among the kinds the agent takes; null when it is none of them. */
export function attachmentKind(
  file: { type: string; name: string },
  accepted: readonly AttachmentKind[],
): AttachmentKind | null {
  const kind: AttachmentKind | null = file.type.startsWith("image/")
    ? "image"
    : file.type === "application/pdf" || /\.pdf$/i.test(file.name)
      ? "pdf"
      : file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name)
        ? "text"
        : null;
  return kind && accepted.includes(kind) ? kind : null;
}

/** The file chooser's `accept` for the kinds the agent takes. */
export function acceptOf(accepted: readonly AttachmentKind[]): string {
  const parts: string[] = [];
  if (accepted.includes("image")) parts.push("image/*");
  if (accepted.includes("pdf")) parts.push("application/pdf", ".pdf");
  if (accepted.includes("text")) parts.push("text/*", ".md", ".json", ".csv", ".yaml", ".yml");
  return parts.join(",");
}

/** What the attach button says it takes. */
export function attachLabel(accepted: readonly AttachmentKind[]): string {
  return accepted.some((kind) => kind !== "image") ? "Attach files" : "Attach images";
}

/**
 * The commands for a query: names that start with it first, then those that hold it, then an alias
 * that does. Each once, the agent's own before the rest when two share a name.
 */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const lower = query.toLowerCase();
  const seen = new Set<string>();
  const rank = (command: SlashCommand): number | null => {
    const name = command.name.toLowerCase();
    if (name.startsWith(lower)) return 0;
    if (name.includes(lower)) return 1;
    if (command.aliases.some((alias) => alias.toLowerCase().startsWith(lower))) return 2;
    return null;
  };
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter((row): row is { command: SlashCommand; rank: number } => row.rank !== null)
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.command.builtin) - Number(a.command.builtin) ||
        a.command.name.localeCompare(b.command.name),
    )
    .map((row) => row.command)
    .filter((command) => !seen.has(command.name) && seen.add(command.name));
}

/** What a prompt carries besides its text. */
export interface Attachments {
  images: string[];
  documents: PromptDocument[];
}

/** The attachments an agent takes, and the names of those it does not. */
export function keepAccepted(
  attached: Attachments,
  accepted: readonly AttachmentKind[],
): Attachments & { dropped: string[] } {
  const images = accepted.includes("image") ? attached.images : [];
  const documents = attached.documents.filter((document) => accepted.includes(document.kind));
  const dropped = [
    ...(images.length < attached.images.length
      ? [`${attached.images.length} image${attached.images.length === 1 ? "" : "s"}`]
      : []),
    ...attached.documents
      .filter((document) => !accepted.includes(document.kind))
      .map((document) => document.name),
  ];
  return { images, documents, dropped };
}

/**
 * A stopped turn's queue as the composer takes it back: its text, its images, and its documents,
 * whose data only the page that queued them holds (`held`, by queue id). `lost` names those it
 * does not hold.
 */
export function givenBack(
  queue: readonly QueuedMessage[],
  held: ReadonlyMap<string, PromptDocument[]>,
): { text: string; lost: string[] } & Attachments {
  const documents: PromptDocument[] = [];
  const lost: string[] = [];
  for (const queued of queue) {
    const kept = held.get(queued.id);
    if (kept) documents.push(...kept);
    else lost.push(...(queued.documents ?? []).map((document) => document.name));
  }
  return {
    text: queue.map((queued) => queued.text).join("\n\n"),
    images: queue.flatMap((queued) => queued.images),
    documents,
    lost,
  };
}
