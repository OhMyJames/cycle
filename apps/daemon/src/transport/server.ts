// The half of the transport a daemon uses. It runs under Bun (Bun.listen, Bun.connect).
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk/experimental/v2";
import { SocketAdapter } from "./socket-adapter.ts";

/** One end of a connection: ACP messages in and out, and a way to hang up. */
export type ServerChannel = {
  stream: Stream;
  close: () => void;
};

export class AlreadyRunningError extends Error {
  constructor(path: string) {
    super(`Something is already listening on ${path}`);
    this.name = "AlreadyRunningError";
  }
}

/** The path is something that is not a socket: a file or folder of someone's, which is not Cycle's to remove. */
export class NotASocketError extends Error {
  constructor(path: string) {
    super(`${path} exists and is not a socket, so it is left as it is; choose another --socket`);
    this.name = "NotASocketError";
  }
}

/**
 * True if a process is accepting connections at `path`. A connection that is reset was taken by a listener: a daemon
 * that is stopping still holds its socket and hangs up on whoever connects (serve.ts), and Bun sometimes reports that
 * as a failed connect (ECONNRESET). That daemon is still running. Only no socket file (ENOENT) or no one behind it
 * (ECONNREFUSED) and the like mean nothing is there.
 */
export const isListening = async (path: string): Promise<boolean> => {
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ECONNRESET";
  }
};

/**
 * Listens on a unix socket. Only its owner can connect: the socket is 0600, and the directory 0700 when
 * this made it (decision 0004). A directory that was already there is someone's, and keeps its
 * permissions: the socket's own are what keep others out. Refuses to start if another process is
 * already listening; a socket file left by one that died is removed, and anything else at the path
 * is left alone and refused.
 */
export const listenUnix = async (options: {
  path: string;
  onConnection: (channel: ServerChannel) => void;
  /**
   * Done the moment the socket is bound, before anything else runs: only the one that holds the socket does it, and
   * what it writes is there by the time a connection is taken (serve.ts writes the pid file here). If it throws, the
   * socket is let go.
   */
  onListening?: () => void;
}): Promise<{ close: () => void }> => {
  const { path } = options;
  const folder = dirname(path);
  const existed = await lstat(folder).then(
    () => true,
    () => false,
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (!existed) await chmod(folder, 0o700).catch(() => undefined);
  const found = await lstat(path).catch(() => undefined);
  if (found !== undefined) {
    if (!found.isSocket()) throw new NotASocketError(path);
    if (await isListening(path)) throw new AlreadyRunningError(path);
    await rm(path, { force: true });
  }
  // Born private: with the folder not ours to make private, there is no moment between the bind and
  // the chmod in which the socket is open to others. Bun.listen binds at once, so the umask is
  // back before anything else runs.
  const before = process.umask(0o177);
  const server = (() => {
    try {
      return Bun.listen<{ adapter: SocketAdapter }>({
        unix: path,
        socket: {
          open(socket) {
            const adapter = new SocketAdapter();
            adapter.attach(socket);
            socket.data = { adapter };
            options.onConnection({
              stream: ndJsonStream(adapter.writable, adapter.readable),
              close: () => socket.end(),
            });
          },
          data(socket, chunk) {
            socket.data.adapter.data(chunk);
          },
          drain(socket) {
            socket.data.adapter.drain();
          },
          close(socket) {
            socket.data.adapter.close();
          },
          error(socket) {
            socket.data.adapter.close();
          },
        },
      });
    } catch (error) {
      // Another daemon bound it between the look above and here (two started at once): it is the one that runs.
      if ((error as { code?: unknown } | null)?.code === "EADDRINUSE")
        throw new AlreadyRunningError(path);
      throw error;
    } finally {
      process.umask(before);
    }
  })();
  try {
    options.onListening?.();
    await chmod(path, 0o600);
  } catch (error) {
    server.stop(true);
    await rm(path, { force: true });
    throw error;
  }
  return {
    close: () => {
      server.stop(true);
      void rm(path, { force: true });
    },
  };
};

/**
 * Copies bytes between this process's stdin and stdout and a daemon's socket, untouched. This is
 * what `ssh host cycle proxy` runs on the far side. Resolves when either side closes.
 */
export const bridgeStdio = async (
  path: string,
  io: { stdin: ReadableStream<Uint8Array>; stdout: WritableStream<Uint8Array> },
): Promise<void> => {
  const adapter = new SocketAdapter();
  const socket = await Bun.connect({
    unix: path,
    socket: {
      open(s) {
        adapter.attach(s);
      },
      data(_s, chunk) {
        adapter.data(chunk);
      },
      drain() {
        adapter.drain();
      },
      close() {
        adapter.close();
      },
      error() {
        adapter.close();
      },
    },
  });
  adapter.attach(socket);
  const toDaemon = io.stdin.pipeTo(adapter.writable).catch(() => undefined);
  const toClient = adapter.readable.pipeTo(io.stdout).catch(() => undefined);
  await Promise.race([toDaemon, toClient]);
  socket.end();
};
