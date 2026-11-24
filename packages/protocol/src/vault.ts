import { z } from "zod";
import { VARIABLE_NAME } from "./environment.ts";
import { cycleMethod } from "./method.ts";
import { DoneSchema } from "./methods.ts";

/**
 * The vault (docs/protocol.md §6 "环境"): the keys of the daemon's `secrets.env`, which an environment's secrets name.
 * A value goes in and never comes out: a client reads which keys have a value, not the value.
 */

/** A key a `secrets.env` line can have: a name a shell can export. */
export const VaultKeySchema = z.string().max(128).regex(VARIABLE_NAME);

/** The most a value may hold; one line, so no line break (a `secrets.env` line is `KEY=value`). */
export const VAULT_VALUE_MAX = 8192;
export const VaultValueSchema = z
  .string()
  .max(VAULT_VALUE_MAX)
  .refine((v) => !/[\n\r\0]/.test(v), "A value is one line");

export const vaultList = cycleMethod(
  "_cycle/vault/list",
  z.object({}),
  z.object({ items: z.array(z.object({ key: z.string() })) }),
);

/** Adds the key, or replaces its value. */
export const vaultSet = cycleMethod(
  "_cycle/vault/set",
  z.object({ key: VaultKeySchema, value: VaultValueSchema }),
  DoneSchema,
);

/** Removes the key; one that is not there is already removed. */
export const vaultRemove = cycleMethod(
  "_cycle/vault/remove",
  z.object({ key: VaultKeySchema }),
  DoneSchema,
);
