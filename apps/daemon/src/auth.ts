import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compares in constant time, and by digest so lengths need not match. */
export function sameToken(given: string | null, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Whether a request may reach the daemon at all. Agents can run commands, so
 * only this machine's own pages may: the Host must be the loopback address the
 * daemon listens on, which a page elsewhere cannot name even by rebinding DNS,
 * and a browser's Origin must be the daemon's own.
 */
export function allowedRequest(
  headers: { host: string | null; origin: string | null },
  port: number,
  extraOrigins: readonly string[] = [],
): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!headers.host || !hosts.includes(headers.host)) return false;
  if (headers.origin === null) return true;
  return (
    hosts.some((host) => headers.origin === `http://${host}`) ||
    extraOrigins.includes(headers.origin)
  );
}
