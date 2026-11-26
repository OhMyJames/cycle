import type { UiKeys } from "./ui-crypto.ts";

/**
 * The public keys whose signature an interface bundle may carry, by id. Empty means the app takes no bundle from outside
 * and always runs the page it was built with. To rotate: add the new key in a release, sign with it from then on, and take
 * the old one out once no app that has only it is in use (docs/desktop.md, "Interface updates").
 */
export const UI_KEYS: UiKeys = {};
