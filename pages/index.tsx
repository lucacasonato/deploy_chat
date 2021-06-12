import {
  h,
  IS_BROWSER,
  useCallback,
  useEffect,
  useReducer,
  useState,
} from "../deps.ts";
import { Message } from "../types.ts";

export default function Home() {
  const [user, setUser] = useState(
    (IS_BROWSER && localStorage?.getItem("username")) || "",
  );

  useEffect(() => {
    localStorage.setItem("username", user);
  }, [user]);

  return (
    <div>
      <h2>Deploy Chat</h2>
      <p>
        Welcome to the Deno Deploy chat demo. This application sends your chat
        messages live across the world using a global `BroadcastChannel` in Deno
        Deploy.
      </p>
      <p>
        Before you can start chatting, please set a username:{" "}
        <input
          title="Username"
          autocomplete="off"
          type="text"
          value={user}
          onInput={(e) => setUser(e.currentTarget.value)}
        />
      </p>
      <ChatHistory />
      <SendField user={user} />
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
  }, []);

  return (
    <div>
      <p>Status: {status}</p>
      <ul>
        {messages.map((msg) => (
          <li>
            <b>{msg.user}</b>: {msg.body}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SendField(props: { user: string }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const disabled = sending || props.user === "";

  const onSubmit = useCallback((e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!disabled) {
      setSending(true);
      fetch("/api/send", {
        method: "POST",
        body: JSON.stringify({ user: props.user, body: message }),
      }).then(() => setMessage("")).finally(() => setSending(false));
    }
  }, [message, props.user, disabled]);

  return (
    <form onSubmit={onSubmit}>
      <input
        type="text"
        value={message}
        onInput={(e) => setMessage(e.currentTarget.value)}
        disabled={disabled}
      />
      <button type="submit" disabled={disabled}>Send</button>
    </form>
  );
}
