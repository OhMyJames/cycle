// The other side, as a process: answers a few methods and records what it was sent, one JSON line each way.
import { closeSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const asked = new Map<number | string, string>();

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: { method?: string };
    result?: unknown;
    error?: unknown;
  };
  if (msg.method === "echo") send({ id: msg.id, result: { got: msg, jsonrpc: "jsonrpc" in msg } });
  else if (msg.method === "fail")
    send({ id: msg.id, error: { code: -32000, message: "no", data: 1 } });
  else if (msg.method === "bad error") send({ id: msg.id, error: "boom" });
  else if (msg.method === "null id") {
    // Not a request: nothing should be answered to it, and it is not a notification either.
    send({ id: null, method: "odd", params: {} });
    send({ id: msg.id, result: "after null id" });
  } else if (msg.method === "blank") {
    process.stdout.write("\n   \n");
    send({ id: msg.id, result: "after blank" });
  } else if (msg.method === "garbage") process.stdout.write("not json\n");
  else if (msg.method === "silent") {
    // Never answered.
  } else if (msg.method === "ask") {
    // Asks the parent `params.method`, and answers this call with what came back.
    asked.set(`q${msg.id}`, String(msg.id));
    send({ id: `q${msg.id}`, method: msg.params?.method, params: {} });
  } else if (msg.method === "exit") process.exit(3);
  else if (msg.method === "partial") {
    process.stdout.write('{"method":"cut","params":{"x":"');
    process.exit(0);
  } else if (msg.method === "partial, then linger") {
    // Half a line and the end of its output, then a while before it exits: what a busy machine looks like from the other
    // side, where the end of the output arrives well before the process's exit.
    writeSync(1, '{"method":"cut","params":{"x":"');
    closeSync(1);
    setTimeout(() => process.exit(0), 300);
  } else if (msg.id !== undefined && msg.method === undefined) {
    const original = asked.get(msg.id);
    if (original !== undefined) send({ id: Number(original), result: msg });
  } else if (msg.method === "note") send({ method: "noted", params: msg.params });
});
