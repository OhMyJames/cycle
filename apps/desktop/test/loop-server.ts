// A stand-in for the Loop server: a unix socket that answers one JSON line with one JSON line, and remembers what it
// was asked. The desktop talks to nothing else (CYC-483).
import { createServer, type Server } from "node:net";

export type Asked = { method: string; params: Record<string, unknown> | undefined };
export type Answer = { result: unknown } | { error: { code: number; data?: { reason?: string } } };

export const fakeLoop = async (
  socket: string,
  answer: (asked: Asked) => Answer,
): Promise<{ asked: Asked[]; close: () => Promise<void> }> => {
  const asked: Asked[] = [];
  const server: Server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end)) as Asked & { id: number };
      const one = { method: request.method, params: request.params };
      asked.push(one);
      connection.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...answer(one) })}\n`);
    });
    connection.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
};
