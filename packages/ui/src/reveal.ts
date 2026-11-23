// Asks the open conversation to bring one of its items into view (CYCL-88): the Overview's todo list or a background
// task goes back to where it began. A request, not state: each is answered once, by the conversation of that session.
// Plain TypeScript: the conversation and the card that holds the item listen.

export type RevealRequest = {
  /** `environmentId:sessionId`. */
  readonly sessionKey: string;
  /** The item: a tool call's id, or a plan's. */
  readonly itemId: string;
  /** Counts up, so that asking for the same item twice is asked twice. */
  readonly serial: number;
};

/** A channel of such requests: asked by one view, answered once by the one that holds the item. */
const channel = () => {
  let current: RevealRequest | undefined;
  let serial = 0;
  const listeners = new Set<() => void>();
  return {
    /** Brings an item of a session into view, and marks it for a moment. */
    request(sessionKey: string, itemId: string): number {
      serial += 1;
      current = { sessionKey, itemId, serial };
      for (const listener of [...listeners]) listener();
      return serial;
    },
    /** The request still being answered: the item not yet found. A view that mounts meanwhile reads it here. */
    get: (): RevealRequest | undefined => current,
    /** The item was found, or the view gave up: one that mounts later must not open for it. */
    done(serial: number): void {
      if (current?.serial === serial) current = undefined;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** The conversation's: one of its items brought into view. */
export const reveal = channel();

/** The Diff tab's (CYCL-133): the edit a call made, opened in its list. The item is the call's id. */
export const revealInDiff = channel();

/** Whether a laid block holds the item: the block's own item, or one of the calls of a stretch of work. */
export const blockHolds = (
  block: {
    kind: string;
    item?: { id: string };
    tools?: readonly { id: string }[];
    tool?: { id: string };
  },
  itemId: string,
): boolean =>
  block.item?.id === itemId ||
  block.tool?.id === itemId ||
  (block.tools?.some((tool) => tool.id === itemId) ?? false);
