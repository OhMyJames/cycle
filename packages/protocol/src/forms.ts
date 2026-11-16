import type { FormField } from "./model.ts";

const FIELD_TYPES = new Set(["string", "number", "integer", "boolean"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * An MCP server's form, from the JSON Schema it sends, as fields: when each is one value of a
 * simple kind, as MCP asks of a form. Null for any other schema, which is shown as it is.
 */
export function formFields(schema: unknown): FormField[] | null {
  const properties = record(record(schema)["properties"]);
  const listed = record(schema)["required"];
  const required = Array.isArray(listed) ? listed.map(String) : [];
  const fields: FormField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = record(raw);
    const type = text(property["type"]);
    const options = property["enum"];
    if (!FIELD_TYPES.has(type) || (options !== undefined && !Array.isArray(options))) return null;
    fields.push({
      name,
      title: text(property["title"]) || name,
      description: text(property["description"]),
      type: type as FormField["type"],
      options: Array.isArray(options) ? options.map(String) : null,
      required: required.includes(name),
    });
  }
  return fields;
}
