import {
  h,
  IS_BROWSER,
  tw,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "../deps.ts";
import { Message } from "../types.ts";
import { Logo } from "./logo.tsx";

export default function Home() {
  const [user, setUser] = useState(
    (IS_BROWSER && localStorage?.getItem("username")) || "",
  );

  // ログインしたか状態を保持する
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    localStorage.setItem("username", user);
  }, [user]);

  const onSubmit = useCallback((e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    setLoggedIn(true);
  }, []);

  return (
    <div
      class={tw`max-w-screen-md px-4 flex-1 flex flex-col overflow-y-hidden`}
    >
      <h2
        class={tw`text-center	text-3xl flex items-center text-green-800 my-4`}
      >
        <Logo />
        Deploy <span class={tw`font-bold mx-1`}>Chat</span>
      </h2>

      <div
        class={tw
          `bg-white rounded-lg flex-1 flex flex-col overflow-y-hidden mb-4`}
      >
        <div class={tw`bg-gray-100 m-4 p-4 rounded-lg text-gray-600`}>
          Welcome to the Deno Deploy chat demo. This application sends your chat
          messages live across the world using a global `BroadcastChannel` in
          Deno Deploy.
        </div>
        <ChatHistory />

        {loggedIn
          ? (
            <div>
              <div>
                <div
                  class={tw`py-1 px-2 font-bold inline-block`}
                >
                  {user}
                </div>

                <button
                  class={tw
                    `bg-gray-200 hover:bg-gray-400 text-gray-800 py-1 px-2 rounded`}
                  onClick={(e) => setLoggedIn(false)}
                >
                  change
                </button>
              </div>
              <SendField user={user} />
            </div>
          )
          : <form onSubmit={onSubmit} class={tw`flex`}>
            <input
              title="Username"
              autocomplete="off"
              type="text"
              value={user}
              class={tw
                `appearance-none border-2 border-gray-200 rounded flex-1 py-2 px-4 text-gray-700 leading-tight focus:outline-none focus:bg-white focus:border-purple-500`}
              onInput={(e) => setUser(e.currentTarget.value)}
            />
            <button
              type="submit"
              class={tw
                `bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded`}
            >
              Set Username
            </button>
          </form>}
      </div>
    </div>
  );
}

const DISCONNECTED = "🔴 Disconnected";
const CONNECTING = "🟡 Connecting...";
const CONNECTED = "🟢 Connected";

function ChatHistory() {
  const [status, setStatus] = useState(DISCONNECTED);
  const [messages, addMessage] = useReducer<Message[], Message>(
    (msgs, msg) => [...msgs, msg],
    [],
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const events = new EventSource("/api/listen");
    setStatus(CONNECTING);
    events.addEventListener("open", () => setStatus(CONNECTED));
    events.addEventListener("error", () => {
      switch (events.readyState) {
        case EventSource.OPEN:
          setStatus(CONNECTED);
          break;
        case EventSource.CONNECTING:
          setStatus(CONNECTING);
          break;
        case EventSource.CLOSED:
          setStatus(DISCONNECTED);
          break;
      }
    });
    events.addEventListener("message", (e) => {
      addMessage(JSON.parse(e.data));
    });
    console.log(messagesEndRef.current);
  }, []);

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div
      class={tw`flex-1 flex-col justify-end overflow-y-scroll`}
    >
      <p>Status: {status}</p>
      <ul>
        {messages.map((msg) => (
          <li>
            <b>{msg.user}</b>: {msg.body}
          </li>
        ))}
      </ul>
      <div ref={messagesEndRef}></div>
    </div>
  );
}

function SendField(props: { user: string }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const disabled = sending || props.user === "";

  const onSubmit = useCallback((e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!disabled) {
      setSending(true);
      fetch("/api/send", {
        method: "POST",
        body: JSON.stringify({ user: props.user, body: message }),
      }).then(() => {
        setMessage("");
      }).finally(() => setSending(false));
    }
  }, [message, props.user, disabled]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [sending]);

  return (
    <form onSubmit={onSubmit} class={tw`flex`}>
      <input
        type="text"
        value={message}
        ref={inputRef}
        onInput={(e) => setMessage(e.currentTarget.value)}
        disabled={disabled}
        class={tw
          `appearance-none border-2 border-gray-200 rounded w-full py-2 px-4 text-gray-700 leading-tight focus:outline-none focus:bg-white focus:border-purple-500`}
      />
      <button
        type="submit"
        class={tw
          `bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded`}
        disabled={disabled}
      >
        Send
      </button>
    </form>
  );
}
