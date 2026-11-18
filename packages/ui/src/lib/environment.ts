/**
 * What a session's Overview says of the environment it runs in: its name, found by id among the
 * owner's, "Removed environment" when the id names none of them, and nothing when none was chosen.
 * Nothing either until the owner's environments have come (`loaded`): an id not in a list that is
 * not there yet is not a removed environment.
 */
export function environmentLabel(
  environments: { id: string; name: string }[],
  id: string | null,
  loaded: boolean,
): string | null {
  if (id === null || !loaded) return null;
  return environments.find((one) => one.id === id)?.name ?? "Removed environment";
}
