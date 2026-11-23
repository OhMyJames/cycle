// The sections of the Connectors page, in the order they are listed. The words are also what the analytics name them by
// (`connectors_section_shown`): a test holds the two lists together. No React here, so that test can read it.
export const CONNECTORS_SECTIONS = ["plugins", "mcp"] as const;
export type ConnectorsSection = (typeof CONNECTORS_SECTIONS)[number];
