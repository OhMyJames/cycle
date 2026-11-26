/**
 * What this build is: the release version, put in by `scripts/build.ts` (the same one the app has, so
 * a daemon and an app of one release agree). A run from source is `dev`.
 */
export const VERSION: string = process.env.CYCLE_BUILD_VERSION ?? "dev";

/** A release version: three numbers. What `initialize` reports and `cycle update` installs. */
export const VERSION_FORMAT = /^\d+\.\d+\.\d+$/;

/** True when release version `a` is lower than `b` (both match VERSION_FORMAT). */
export const olderThan = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++)
    if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0);
  return false;
};
