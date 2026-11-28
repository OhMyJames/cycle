/**
 * The major version of what the page may rely on the app (main and preload) for (docs/desktop.md "界面更新"): an
 * interface bundle is taken by every app of the same major, whichever of them it was built after. Within one major a
 * change may only add: a method, an event, an optional field the page sends, a field or a variant of a union the page is
 * sent... (test/ui-contract.test.ts checks the API's types against the last snapshot of them, in `bun run check`).
 *
 * Raise this by one, and take a new snapshot (`bun run --cwd apps/desktop ui-contract`), when:
 *  - the API's types change in a way an older app could not serve (the check says which methods);
 *  - the main process changes, in a way the page can tell, what it answers or does for a method or event whose types did
 *    not change (the meaning of a value, an order, a side effect the page counts on): no check can see that;
 *  - the preload changes how the page reaches the app.
 * Apps of the major before then take no bundle built after it: they get the new page with the next app update.
 */
export const CONTRACT_MAJOR = 2;
