export function handleRequest(request: Request, discordReady: boolean): Response {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET" } });
  }

  const path = new URL(request.url).pathname;

  if (path === "/health") {
    return Response.json({ service: "beatnet-backend", status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (path === "/ready") {
    return Response.json(
      { service: "beatnet-backend", discord: discordReady ? "connected" : "disconnected" },
      { status: discordReady ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
