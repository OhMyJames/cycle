// Terminals (docs/protocol.md §8 "终端"): this connection is where their output goes. A session's terminals come from
// the index: the session does not have to be loaded (its history read) to have them.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import {
  terminalAttach,
  terminalClose,
  terminalCreate,
  terminalDetach,
  terminalInput,
  terminalList,
  terminalResize,
} from "@cycle/protocol";
import { environmentOf, scriptFor, shellVariables } from "../environment.ts";
import { INVALID_PARAMS, RpcError } from "../errors.ts";
import type { TerminalSink } from "../terminals.ts";
import { type Core, cycleOn, type Me } from "./core.ts";

export const registerTerminals = (app: AgentApp, core: Core, me: Me): void => {
  const cycle = cycleOn(app, core.log);
  const sink = (): TerminalSink => {
    const conn = me();
    return { id: conn.id, send: (method, params) => conn.notify(method, params) };
  };
  cycle(terminalCreate, async (params) => {
    const cwd = core.cwdOf(params.sessionId);
    if (core.index.get(params.sessionId)?.archived === true)
      throw new RpcError(INVALID_PARAMS, "The session is archived", {
        sessionId: params.sessionId,
        reason: "archived",
      });
    const entry = core.index.get(params.sessionId);
    let command: { title: string; script: string } | undefined;
    if (params.actionId !== undefined) {
      // Only an action the session was made with: a client cannot have any command run this way.
      const action = (entry !== undefined ? environmentOf(entry) : undefined)?.actions.find(
        (a) => a.id === params.actionId,
      );
      const script = scriptFor(action?.command);
      if (action === undefined || script === undefined)
        throw new RpcError(INVALID_PARAMS, "The session's environment has no such action", {
          sessionId: params.sessionId,
          actionId: params.actionId,
          reason: "unknown_action",
        });
      command = { title: action.name, script };
    }
    return core.terminals.create(params.sessionId, cwd, params.cols, params.rows, sink(), {
      env: (await shellVariables(entry, core.dataDir)).variables,
      ...(command !== undefined ? { command } : {}),
    });
  });
  cycle(terminalList, (params) => {
    core.cwdOf(params.sessionId);
    return { terminals: core.terminals.list(params.sessionId) };
  });
  cycle(terminalAttach, (params) => core.terminals.attach(params.terminalId, sink()));
  cycle(terminalDetach, (params) => {
    core.terminals.detach(params.terminalId, me().id);
    return {};
  });
  cycle(terminalInput, (params) => {
    core.terminals.input(params.terminalId, params.data);
    return {};
  });
  cycle(terminalResize, (params) => {
    core.terminals.resize(params.terminalId, params.cols, params.rows);
    return {};
  });
  cycle(terminalClose, async (params) => {
    await core.terminals.close(params.terminalId);
    return {};
  });
};
