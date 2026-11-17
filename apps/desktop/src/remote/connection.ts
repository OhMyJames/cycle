// The connection to one remote daemon through an ssh tunnel: which steps, in which order, and which
// state the page is shown. Everything it touches comes in as a port. The token is read from the
// server at each connect, lives in this module's memory and the page's address, and is never logged.
import type { RemoteServer, RemoteState } from "../shared/remote-state";
import {
  READY_EVERY_MS,
  READY_TRIES,
  backoffMs,
  notRunning,
  pageUrl,
  parseDaemonFile,
  parseHealth,
  readArgs,
  sshReason,
  tunnelArgs,
  versionWarning,
} from "./plan";

export type Tunnel = {
  exited(): boolean;
  /** What ssh has said so far, kept short. */
  stderr(): string;
  onExit(listener: () => void): void;
  kill(): void;
};

export type Ssh = {
  /** Runs ssh to the end. */
  run(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Starts ssh and leaves it running. */
  tunnel(args: readonly string[]): Tunnel;
};

export type ConnectionPorts = {
  ssh: Ssh;
  /** A small answer, whole. Rejects when nothing answers. */
  fetch(url: string): Promise<{ status: number; text: string }>;
  delay(ms: number): Promise<void>;
  /** Whether nothing on this machine holds the loopback port. */
  portFree(port: number): Promise<boolean>;
  /** This machine's own daemon's version, to say when the remote one differs. */
  localVersion(): Promise<string | undefined>;
  /** Shows the page at this address: when connected, and again when a reconnect brings a new token. */
  show(url: string, origin: string): void;
  onState(state: RemoteState): void;
};

/** A failure with a reason fit for the page. */
class Failure extends Error {}

const reasonOf = (error: unknown): string =>
  error instanceof Failure ? error.message : "The connection failed.";

type Established = { tunnel: Tunnel; token: string; url: string; origin: string; warning?: string };

export function createRemoteConnection(ports: ConnectionPorts) {
  let state: RemoteState = { status: "idle" };
  let tunnel: Tunnel | undefined;
  let shownToken: string | undefined;
  /** Bumped by every connect and disconnect, so what was started before knows it is over. */
  let generation = 0;

  const set = (next: RemoteState): void => {
    state = next;
    ports.onState(next);
  };

  async function establish(remote: RemoteServer): Promise<Established> {
    const read = await ports.ssh.run(readArgs(remote));
    if (read.code !== 0) {
      throw new Failure(
        /No such file|not found/i.test(read.stderr)
          ? notRunning(remote)
          : sshReason(read.stderr, remote),
      );
    }
    const facts = parseDaemonFile(read.stdout);
    if (!facts) throw new Failure(`The daemon file on ${remote.name} could not be read.`);
    // Before the tunnel: a program already on this port could answer in its place.
    if (!(await ports.portFree(facts.port))) {
      throw new Failure(`Port ${facts.port} is already used on this machine.`);
    }
    const started = ports.ssh.tunnel(tunnelArgs(remote, facts.port));
    try {
      for (let tries = 0; ; tries++) {
        if (started.exited()) throw new Failure(sshReason(started.stderr(), remote));
        const answer = await ports
          .fetch(`http://127.0.0.1:${facts.port}/health`)
          .catch(() => undefined);
        if (answer) {
          const health = answer.status === 200 ? parseHealth(answer.text) : undefined;
          if (!health) throw new Failure(notRunning(remote));
          const warning = versionWarning(remote, health.version, await ports.localVersion());
          return {
            tunnel: started,
            token: facts.token,
            url: pageUrl(facts.port, facts.token),
            origin: new URL(pageUrl(facts.port, facts.token)).origin,
            ...(warning ? { warning } : {}),
          };
        }
        if (tries + 1 >= READY_TRIES) throw new Failure(notRunning(remote));
        await ports.delay(READY_EVERY_MS);
      }
    } catch (error) {
      started.kill();
      throw error;
    }
  }

  function hold(remote: RemoteServer, mine: number, found: Established): void {
    tunnel = found.tunnel;
    set({
      status: "connected",
      id: remote.id,
      ...(found.warning ? { warning: found.warning } : {}),
    });
    if (found.token !== shownToken) {
      shownToken = found.token;
      ports.show(found.url, found.origin);
    }
    found.tunnel.onExit(() => {
      if (mine === generation) void reconnect(remote, mine);
    });
  }

  async function reconnect(remote: RemoteServer, mine: number): Promise<void> {
    tunnel = undefined;
    // The daemon may have started again with a new token, so the file is read again each time.
    for (let attempt = 1; ; attempt++) {
      if (mine !== generation) return;
      set({ status: "reconnecting", id: remote.id, attempt });
      await ports.delay(backoffMs(attempt));
      if (mine !== generation) return;
      try {
        const found = await establish(remote);
        if (mine !== generation) {
          found.tunnel.kill();
          return;
        }
        hold(remote, mine, found);
        return;
      } catch {
        // Tried again, with longer waits, until the owner chooses something else.
      }
    }
  }

  return {
    state: (): RemoteState => state,

    /** Stops the tunnel. The page shown stays until main shows another. */
    disconnect(): void {
      generation++;
      tunnel?.kill();
      tunnel = undefined;
      shownToken = undefined;
      if (state.status !== "idle") set({ status: "idle" });
    },

    async connect(remote: RemoteServer): Promise<void> {
      this.disconnect();
      const mine = generation;
      set({ status: "connecting", id: remote.id });
      try {
        const found = await establish(remote);
        if (mine !== generation) {
          found.tunnel.kill();
          return;
        }
        hold(remote, mine, found);
      } catch (error) {
        if (mine === generation) set({ status: "failed", id: remote.id, reason: reasonOf(error) });
      }
    },
  };
}
