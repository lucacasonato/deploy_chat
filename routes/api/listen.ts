import { Handlers } from "$fresh/server.ts";

export const handler: Handlers = {
  GET(_req: Request): Response {
    const channel = new BroadcastChannel("chat");
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(": Welcome to Deno Deploy Chat!\n\n");
        channel.onmessage = (e) => {
          const body = `data: ${JSON.stringify(e.data)}\n\n`;
          controller.enqueue(body);
        };
      },
      cancel() {
        channel.close();
      },
    });
    return new Response(stream.pipeThrough(new TextEncoderStream()), {
      headers: { "content-type": "text/event-stream" },
    });
  },
};
