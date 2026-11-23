// Reads and drives the app's window over the DevTools protocol, which Electron serves when started with
// --remote-debugging-port.

/** Asks the page, over the DevTools protocol, to evaluate an expression. */
export const evaluate = async (port: number, expression: string): Promise<unknown> => {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = pages.find((p) => p.type === "page");
  if (page === undefined) throw new Error("no page yet");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("devtools socket failed"));
  });
  try {
    return await new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: { result?: { value?: unknown } };
        };
        if (message.id === 1) resolve(message.result?.result?.value);
      };
      socket.onerror = () => reject(new Error("devtools socket failed"));
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
};
