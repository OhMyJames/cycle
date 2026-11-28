// The design flow (CYC-545): a Design work item is answered like a research one: a one-node graph (`design`, then
// `qa-n` and `fix-n` design nodes), read-only sessions, a report published as a document in the design folder, 「结论」
// filled question by question, follow-ups drafted in Backlog, and Done. It is the research flow with a design profile.

import type { FlowHost } from "../../engine/flow.ts";
import { ResearchFlow } from "../research/index.ts";

export const designFlow = (host: FlowHost): ResearchFlow => new ResearchFlow(host, "design");
