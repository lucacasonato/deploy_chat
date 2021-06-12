import { generate as generateUUID } from "https://deno.land/std@0.98.0/uuid/v4.ts";
import { Message } from "../../types.ts";

export async function POST(req: Request): Promise<Response> {
  const msg = await req.json();

  const user = msg["user"];
  if (typeof user !== "string") {
    return new Response("invalid user", { status: 400 });
  }

  const body = msg["body"];
  if (typeof body !== "string") {
    return new Response("invalid body", { status: 400 });
  }

  const channel = new BroadcastChannel("chat");

  const message: Message = {
    id: generateUUID(),
    ts: new Date().toISOString(),
    user,
    body,
  };

  channel.postMessage(message);
  channel.close();

  return new Response("message sent");
}
