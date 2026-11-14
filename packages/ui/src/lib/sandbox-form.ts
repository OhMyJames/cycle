import type { SandboxEnvironment, SandboxEnvironmentDraft } from "@cycle/protocol";

/** A variable in the form: its name, and a value only once one is typed. */
export interface VariableRow {
  name: string;
  value: string;
  /** Whether a value is stored under this name already. */
  stored: boolean;
}

/** An environment as its form holds it: every part as the text in its field. */
export interface SandboxForm {
  id: string | null;
  name: string;
  cpus: string;
  memoryGb: string;
  hosts: string;
  variables: VariableRow[];
  setup: string;
}

export function sandboxFormFor(environment: SandboxEnvironment | null): SandboxForm {
  return {
    id: environment?.id ?? null,
    name: environment?.name ?? "",
    cpus: environment?.cpus ? String(environment.cpus) : "",
    memoryGb: environment?.memoryGb ? String(environment.memoryGb) : "",
    hosts: environment?.hosts.join("\n") ?? "",
    variables: environment?.variables.map((name) => ({ name, value: "", stored: true })) ?? [],
    setup: environment?.setup ?? "",
  };
}

/** A whole number a field holds, null for an empty one, and NaN for what is neither. */
function amount(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** What to send for a form, or what is wrong with it. */
export function sandboxDraft(form: SandboxForm): SandboxEnvironmentDraft | string {
  if (!form.name.trim()) return "Give the environment a name.";
  const cpus = amount(form.cpus);
  const memoryGb = amount(form.memoryGb);
  if (Number.isNaN(cpus) || cpus === 0) return "CPUs is a whole number.";
  if (Number.isNaN(memoryGb) || memoryGb === 0) return "Memory is a whole number of GB.";
  const variables: Record<string, string | null> = {};
  for (const row of form.variables) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" is not a variable's name.`;
    if (name in variables) return `${name} is there twice.`;
    // A stored value left untouched stays the daemon's: the page never had it.
    if (!row.value && !row.stored) return `${name} needs a value.`;
    variables[name] = row.value || null;
  }
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    cpus,
    memoryGb,
    hosts: form.hosts
      .split(/[\s,]+/)
      .map((host) => host.trim())
      .filter(Boolean),
    variables,
    setup: form.setup,
  };
}

function count(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** One line on what an environment sets, for its row in the list. */
export function sandboxSummary(environment: SandboxEnvironment): string {
  const parts = [
    environment.cpus ? count(environment.cpus, "CPU") : null,
    environment.memoryGb ? `${environment.memoryGb} GB` : null,
    environment.hosts.length ? count(environment.hosts.length, "host") : null,
    environment.variables.length ? count(environment.variables.length, "variable") : null,
    environment.setup ? "setup script" : null,
  ].filter((part) => part !== null);
  return parts.length ? parts.join(" · ") : "Docker's own choices, and nothing added";
}
