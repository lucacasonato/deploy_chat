import {
  readerFromStreamReader,
  readLines,
} from "https://deno.land/std@0.97.0/io/mod.ts";
import { delay } from "https://deno.land/std@0.97.0/async/delay.ts";
import { emojify } from "https://deno.land/x/emoji@0.1.2/mod.ts";
import { Message } from "./types.ts";

document.addEventListener("DOMContentLoaded", () => {
  const STATUS = document.getElementById("status") as HTMLSpanElement;
  const MESSAGES = document.getElementById("messages") as HTMLUListElement;
  const FORM = document.getElementById("form") as HTMLFormElement;
  const MESSAGE = document.getElementById("message") as HTMLInputElement;

  async function listen() {
    STATUS.innerText = "🟡 Connecting...";
    try {
      console.log("🟡 connecting", performance.now());
      const res = await fetch("/listen");
      console.log("🟢 connected", performance.now());
      STATUS.innerText = "🟢 Connected";
      const reader = readerFromStreamReader(res.body!.getReader());
      const lines = readLines(reader);
      for await (const line of lines) {
        const { kind, data } = JSON.parse(line);
        switch (kind) {
          case "msg": {
            handleMessage(data);
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
      console.log("🔴 error", performance.now());
      console.error(err);
    } finally {
      STATUS.innerText = "🔴 Disconnected";
    }
  }

  function handleMessage(message: Message) {
    const { user, body } = message;
    const li = document.createElement("li");
    const name = document.createElement("b");
    name.innerText = `[${user}] `;
    const contents = document.createElement("span");
    contents.innerText = emojify(body);
    li.appendChild(name);
    li.appendChild(contents);
    MESSAGES.appendChild(li);
  }

  let submitting = false;

  FORM.onsubmit = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const body = MESSAGE.value;

    if (submitting || body === "") return;

    const message = JSON.stringify({ body });

    FORM.disabled = true;
    submitting = true;

    fetch("/send", { body: message, method: "POST" })
      .then((r) => r.text())
      .then((txt) => {
        MESSAGE.disabled = false;
        submitting = false;
        FORM.reset();
        console.log(txt);
      });

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
