import {
  readerFromStreamReader,
  readLines,
} from "https://deno.land/std@0.97.0/io/mod.ts";
import { delay } from "https://deno.land/std@0.97.0/async/delay.ts";

document.addEventListener("DOMContentLoaded", () => {
  const STATUS = document.getElementById("status") as HTMLSpanElement;
  const MESSAGES = document.getElementById("messages") as HTMLUListElement;
  const FORM = document.getElementById("form") as HTMLFormElement;
  const MESSAGE = document.getElementById("message") as HTMLInputElement;

  async function listen() {
    STATUS.innerText = "🟡 Connecting...";
    try {
      const res = await fetch("/listen");
      STATUS.innerText = "🟢 Connected";
      const reader = readerFromStreamReader(res.body!.getReader());
      const lines = readLines(reader);
      for await (const line of lines) {
        const { kind, data } = JSON.parse(line);
        switch (kind) {
          case "msg": {
            const { body } = data;
            const li = document.createElement("li");
            li.innerText = body;
            MESSAGES.appendChild(li);
            break;
          }
          case "keepalive":
            console.log("keepalive");
            break;
          default:
            break;
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      STATUS.innerText = "🔴 Disconnected";
    }
  }

  FORM.onsubmit = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const body = JSON.stringify({ body: MESSAGE.value });

    fetch("/send", { body, method: "POST" })
      .then((r) => r.text())
      .then(console.log);

    return false;
  };

  async function main() {
    while (true) {
      await listen();
      await delay(1000);
    }
  }

  main();
});
