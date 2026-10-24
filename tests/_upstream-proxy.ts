// A proxy a test puts between a replica broker and its upstream, so that "the
// network is down" is a state the test sets rather than a race it provokes:
// while `blocked` is true every request is answered 503 without reaching the
// upstream; `intercept` lets a test answer a path itself (an upstream of an
// older version answers 404 on a route it does not have).

export interface UpstreamProxy {
  url: string;
  port: number;
  /** While true, every request is answered 503 and never forwarded. */
  blocked: boolean;
  /**
   * Consulted before forwarding: a Response short-circuits the proxy, null
   * forwards as usual. Reset to null to forward everything again.
   */
  intercept: ((path: string, req: Request) => Response | null) | null;
  /** Requests seen by path, forwarded or not. */
  seen: string[];
  exchanges: Array<{ path: string; request: string; response: string }>;
  stop(): void;
}

export function startUpstreamProxy(upstreamUrl: string): UpstreamProxy {
  const proxy: UpstreamProxy = {
    url: "",
    port: 0,
    blocked: false,
    intercept: null,
    seen: [],
    exchanges: [],
    stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      proxy.seen.push(url.pathname);
      if (proxy.blocked) return new Response("upstream unreachable", { status: 503 });
      const intercepted = proxy.intercept ? proxy.intercept(url.pathname, req) : null;
      if (intercepted) return intercepted;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const auth = req.headers.get("authorization");
      if (auth) headers.authorization = auth;
      const requestText = req.method === "POST" ? await req.text() : "";
      const upstream = await fetch(`${upstreamUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "POST" ? requestText : undefined,
      });
      const responseText = await upstream.text();
      proxy.exchanges.push({ path: url.pathname, request: requestText, response: responseText });
      return new Response(responseText, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    },
  });
  proxy.port = server.port;
  proxy.url = `http://127.0.0.1:${server.port}`;
  return proxy;
}
