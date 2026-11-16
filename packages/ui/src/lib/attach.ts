import type { AttachmentKind, SlashCommand } from "@cycle/protocol";

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
