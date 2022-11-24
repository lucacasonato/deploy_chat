import { Message } from "../../types.ts";
import { Handlers } from "$fresh/server.ts";
import { getCookies } from "$std/http/cookie.ts";

export const handler: Handlers = {
  async POST(req: Request): Promise<Response> {
    const cookies = getCookies(req.headers);

    const msg = await req.json();

    const user = cookies["user"];
    if (typeof user !== "string") {
      return new Response("not signed in", { status: 400 });
    }

    const body = msg["body"];
    if (typeof body !== "string") {
      return new Response("invalid body", { status: 400 });
    }

    const channel = new BroadcastChannel("chat");

    const message: Message = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      user,
      body,
    };

    channel.postMessage(message);
    channel.close();

    return new Response("message sent");
  },
};
