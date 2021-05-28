import { h, jsx, serve, serveStatic } from "./deps.ts";

serve({
  "/": () => jsx(<Page />),
  "/send": send,
  "/listen": listen,
  "/:filename+": serveStatic("public", {
    baseUrl: import.meta.url,
    cache: false,
  }),
});

function Page() {
  return (
    <html>
      <head>
        <title>Deno Chat</title>
        <script src="/ui.bundle.js" type="module"></script>
      </head>
      <body>
        <header>
          <h3>Deno Chat</h3>
          <p>
            Status: <span id="status">🔴 Disconnected</span>
          </p>
        </header>
        <form id="form">
          <input type="text" id="message" />
          <button type="submit">Send</button>
        </form>
        <ul id="messages"></ul>
      </body>
    </html>
  );
}

async function send(req: Request): Promise<Response> {
  if (req.method === "POST") {
    const msg = await req.json();
    const body = msg["body"];
    if (typeof body !== "string") {
      return new Response("invalid body", { status: 400 });
    }

    const channel = new BroadcastChannel("chat");
    channel.postMessage({ body });
    channel.close();

    return new Response("sent message");
  } else {
    return new Response("method not accepted", { status: 405 });
  }
}

function listen(_req: Request): Response {
  console.log("listen");
  const channel = new BroadcastChannel("chat");
  let intervalId: number | null = null;
  const stream = new ReadableStream({
    start: (controller) => {
      keepalive(controller);
      intervalId = setInterval(() => {
        keepalive(controller);
      });
      channel.onmessage = (e) => {
        send(controller, { kind: "msg", data: e.data });
      };
    },
    cancel() {
      console.log("close!");
      channel.close();
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
    },
  });

  function keepalive(controller: ReadableStreamController<Uint8Array>) {
    send(controller, { kind: "keepalive" });
  }

  function send(
    controller: ReadableStreamController<Uint8Array>,
    body: unknown,
  ) {
    const msg = JSON.stringify(body) + "\n";
    const chunk = new TextEncoder().encode(msg);
    controller.enqueue(chunk);
  }

  return new Response(stream, {});
}
