import { Fragment, h, jsx, serve, serveStatic } from "./deps.ts";

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
        <ul id="messages"></ul>
        <form id="form">
          <input type="text" id="message" />
          <button type="submit">Send</button>
        </form>
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
  const stream = new ReadableStream({
    start: (controller) => {
      channel.onmessage = (e) => {
        console.log(e.data);
        const chunk = new TextEncoder().encode(JSON.stringify(e.data) + "\n");
        controller.enqueue(chunk);
      };
    },
    cancel() {
      console.log("close!");
      channel.close();
    },
  });

  return new Response(stream, {});
}
