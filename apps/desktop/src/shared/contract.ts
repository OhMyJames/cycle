/**
 * Raise this by one when the main process changes, in a way the page can tell, what it answers or does for an API
 * method or event whose types did not change (the meaning of a value, an order, a side effect the page counts on). Apps
 * built before the change then take no interface bundle built after it, and the other way round. Changes to the API's
 * types, and to the preload, change the shell without this (shared/ui-bundle.ts, `shellInput`).
 */
export const CONTRACT_REV = 1;
