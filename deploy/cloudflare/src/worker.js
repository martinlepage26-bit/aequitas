const PUBLIC_HOST = "aequitas.app.pharos-ai.ca";

const worker = {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.hostname !== PUBLIC_HOST && env.DEV_PREVIEW !== "true") {
      return new Response("Unknown host", { status: 421 });
    }

    const upstream = new URL(request.url);
    upstream.protocol = "http:";
    upstream.hostname = "localhost";
    upstream.port = "";

    const headers = new Headers(request.headers);
    headers.set("host", PUBLIC_HOST);
    headers.set("x-forwarded-host", PUBLIC_HOST);
    headers.set("x-forwarded-proto", "https");
    const privateRequest = new Request(upstream, { method: request.method, headers, body: request.body, redirect: "manual", duplex: "half" });
    return env.AEQUITAS_ORIGIN.fetch(privateRequest);
  },
};

export default worker;
