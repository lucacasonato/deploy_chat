import { Head } from "$fresh/runtime.ts";
import { Handlers, PageProps } from "$fresh/server.ts";
import { getCookies, setCookie } from "$std/http/cookie.ts";
import { Button } from "../components/Button.tsx";
import Chat from "../islands/Chat.tsx";

interface Data {
  name: string | undefined;
  region: string;
}

export const handler: Handlers<Data> = {
  GET(req, ctx) {
    const cookies = getCookies(req.headers);
    return ctx.render({
      name: cookies.user,
      region: Deno.env.get("DENO_REGION") || "local",
    });
  },
  async POST(req) {
    const form = await req.formData();
    const name = form.get("name");
    if (typeof name !== "string" || name.length === 0) {
      return new Response("Name is required", { status: 400 });
    }
    const headers = new Headers();
    setCookie(headers, {
      name: "user",
      value: name,
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "Lax",
    });
    headers.set("Location", "/");
    return new Response("Ok", { status: 303, headers });
  },
};

export default function Home({ data }: PageProps<Data>) {
  return (
    <>
      <Head>
        <title>Deploy Chat</title>
      </Head>
      <div class="py-8 px-4 mx-auto max-w-screen-md">
        <h1 class="text-3xl font-bold">Deploy Chat demo</h1>
        {data.name && (
          <>
            <p class="my-4">Welcome, {data.name}!</p>
            <Chat region={data.region} />
          </>
        )}
        {!data.name && <SignInForm />}
      </div>
    </>
  );
}

function SignInForm() {
  return (
    <form action="/" method="POST" class="mt-4">
      <input
        type="text"
        name="name"
        placeholder="Your name"
        class="border border-gray-300 rounded px-2 py-1"
      />
      <Button>
        Submit
      </Button>
    </form>
  );
}
