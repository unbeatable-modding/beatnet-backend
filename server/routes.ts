import type { Catalog } from "./catalog";
import { streamAudio } from "./preview";
import { streamCover } from "./cover";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function readPage(url: URL) {
  const query = (url.searchParams.get("query") ?? "").trim();
  const offset = url.searchParams.get("offset") ?? "0";
  const limit = url.searchParams.get("limit") ?? "25";
  const sorting = url.searchParams.get("sorting") ?? "title";
  const difficulties = (url.searchParams.get("difficulties") ?? "").split(",").filter(Boolean);
  if (sorting !== "title" && sorting !== "rating" || difficulties.length > 16 || difficulties.some(value => !/^[a-zA-Z0-9_-]{1,64}$/.test(value))) { return null; }
  if (query.length > 256 || !/^\d+$/.test(offset) || !/^\d+$/.test(limit)) {
    return null;
  }
  const page = { query, offset: Number(offset), limit: Number(limit), sorting, difficulties };
  if (!Number.isSafeInteger(page.offset) || page.offset > 1_000_000 || page.limit < 1 || page.limit > 25) {
    return null;
  }
  return page;
}

async function download(request: Request, catalog: Catalog, projectId: string, revisionId: string, fileId: string) {
  const stored = catalog.download(projectId, revisionId, fileId);
  if (!stored) {
    return json({ error: "not_found" }, 404);
  }
  const file = Bun.file(stored.path);
  if (!await file.exists() || file.size !== stored.size) {
    return json({ error: "file_unavailable" }, 503);
  }
  const etag = `"${stored.sha256}"`;
  const headers = new Headers({
    "Cache-Control": "public, max-age=0, must-revalidate",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  const tags = request.headers.get("If-None-Match")?.split(",") ?? [];
  if (tags.some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  const filename = encodeURIComponent(stored.name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Length", String(stored.size));
  headers.set("Content-Disposition", `attachment; filename="beatmap.zip"; filename*=UTF-8''${filename}`);
  return new Response(file, { headers });
}

export async function handleRequest(request: Request, discordReady: boolean, storageReady: boolean, catalog: Catalog): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    return json({ service: "beatnet-backend", status: "ok" });
  }

  if (path === "/ready") {
    return json(
      {
        service: "beatnet-backend",
        discord: discordReady ? "connected" : "disconnected",
        storage: storageReady ? "ready" : "unavailable",
      },
      discordReady && storageReady ? 200 : 503,
    );
  }

  const match = /^\/api\/beatmaps\/([^/]+)(?:\/revisions\/([^/]+)\/(?:files\/([^/]+)|(preview|cover)))?$/.exec(path);
  if (path !== "/api/beatmaps" && path !== "/api/ratings" && !match) {
    return json({ error: "not_found" }, 404);
  }
  if (!storageReady) {
    return json({ error: "service_unavailable" }, 503);
  }

  try {
    if (path === "/api/ratings") {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return ids.length <= 100 && ids.every(id => uuid.test(id)) ? json(catalog.ratings(ids)) : json({ error: "invalid_query" }, 400);
    }
    if (path === "/api/beatmaps") {
      const page = readPage(url);
      return page ? json(catalog.list(page.query, page.offset, page.limit, page.sorting, page.difficulties)) : json({ error: "invalid_query" }, 400);
    }
    const projectId = match?.[1];
    const revisionId = match?.[2];
    const fileId = match?.[3];
    if (!projectId || !uuid.test(projectId) || (revisionId && !uuid.test(revisionId)) || (fileId && !uuid.test(fileId) && !/^\d{17,20}$/.test(fileId))) {
      return json({ error: "invalid_id" }, 400);
    }
    if (revisionId && fileId) {
      return await download(request, catalog, projectId, revisionId, fileId);
    }
    if (revisionId && match?.[4] === "cover") {
      const cover = await catalog.cover(projectId, revisionId);
      return cover ? await streamCover(request, cover) : json({ error: "cover_unavailable" }, 404);
    }
    if (revisionId && match?.[4] === "preview") {
      const audio = await catalog.audio(projectId, revisionId);
      return audio ? await streamAudio(request, audio) : json({ error: "preview_unavailable" }, 404);
    }
    const beatmap = catalog.get(projectId);
    return beatmap ? json(beatmap) : json({ error: "not_found" }, 404);
  } catch {
    console.error("catalog request failed");
    return json({ error: "internal_error" }, 500);
  }
}
