import {
  readerFromStreamReader,
  readLines,
} from "https://deno.land/std@0.97.0/io/mod.ts";

document.addEventListener("DOMContentLoaded", () => {
  const MESSAGES = document.getElementById("messages") as HTMLUListElement;
  const FORM = document.getElementById("form") as HTMLFormElement;
  const MESSAGE = document.getElementById("message") as HTMLInputElement;

  async function main() {
    const res = await fetch("/listen");
    const reader = readerFromStreamReader(res.body!.getReader());
    const lines = readLines(reader);
    for await (const line of lines) {
      const { body } = JSON.parse(line);
      const li = document.createElement("li");
      li.innerText = body;
      MESSAGES.appendChild(li);
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

  main();
});
