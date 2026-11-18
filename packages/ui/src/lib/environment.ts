/**
 * What a session's Overview says of the environment it runs in: its name, found by id among the
 * owner's, "Removed environment" when the id names none of them, and nothing when none was chosen.
 */
export function environmentLabel(
  environments: { id: string; name: string }[],
  id: string | null,
): string | null {
  if (id === null) return null;
  return environments.find((one) => one.id === id)?.name ?? "Removed environment";
}
