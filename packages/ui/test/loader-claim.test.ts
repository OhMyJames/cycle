import { expect, test } from "bun:test";
import { LoaderClaims } from "../src/react/loader-claim.ts";

test("the lowest rank holds the loader; it passes on when the holder lets go", () => {
  const claims = new LoaderClaims();
  let told = 0;
  claims.subscribe(() => told++);
  const a = claims.claim("a", 20);
  claims.claim("b", 10);
  expect(claims.holder()).toBe("b");
  const line = claims.claim("line", Number.NEGATIVE_INFINITY);
  expect(claims.holder()).toBe("line");
  line();
  expect(claims.holder()).toBe("b");
  a();
  expect(claims.holder()).toBe("b");
  expect(told).toBe(4);
});

test("of two of the same rank, the first to claim keeps it, also when it claims again", () => {
  const claims = new LoaderClaims();
  const first = claims.claim("first", 5);
  claims.claim("second", 5);
  expect(claims.holder()).toBe("first");
  // Drawn again: lets go and claims at once, after the other.
  first();
  expect(claims.holder()).toBe("second");
  claims.claim("first", 5);
  expect(claims.holder()).toBe("first");
});

test("a release that is stale (the id claimed again since) leaves the new claim", () => {
  const claims = new LoaderClaims();
  const old = claims.claim("a", 1);
  claims.claim("a", 2);
  old();
  expect(claims.holder()).toBe("a");
});
