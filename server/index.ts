import { connectDiscord } from "../bot/discord";
import { describeError, loadConfig, type Config } from "./config";
import { handleRequest } from "./routes";
import { openSubmissions, type Submissions } from "./submissions";
import { openUploads, type Uploads } from "./uploads";
import { Library } from "./library";
import { acquireRuntime } from "./runtime";
import { Catalog } from "./catalog";
import { openOnline } from "./online";

let config: Config | undefined;
let connection: Awaited<ReturnType<typeof connectDiscord>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
let submissions: Submissions | undefined;
let uploads: Uploads | undefined;
let library: Library | undefined;
let releaseRuntime: (() => Promise<void>) | undefined;
let online: Awaited<ReturnType<typeof openOnline>> | undefined;

const stop = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  await server?.stop(true);
  await connection?.review.stop();
  await library?.stop();
  await connection?.client.destroy();
  submissions?.close();
  online?.close();
  await releaseRuntime?.();
};

try {
  config = loadConfig();
  releaseRuntime = await acquireRuntime(config.dataDir);
  submissions = await openSubmissions(config.dataDir);
  uploads = await openUploads(submissions.root, config);
  library = new Library(submissions, uploads);
  await library.recover();
  const catalog = new Catalog(submissions, uploads);
  online = await openOnline(submissions.root);
  connection = await connectDiscord(config, submissions, library);
  const discord = connection;

  server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    maxRequestBodySize: 65536,
    fetch: async (request, http) => {
      if (/\/(preview|cover)$/.test(new URL(request.url).pathname)) {
        http.timeout(request, 60);
      }
      const discordReady = discord.client.isReady();
      const storageReady = submissions!.isReady() && await uploads!.isReady();
      if (new URL(request.url).pathname.startsWith("/api/online")) {
        if (!storageReady) { return Response.json({ error: "service_unavailable" }, { status: 503 }); }
        const peer = http.requestIP(request)?.address ?? "unknown";
        const ip = peer === "127.0.0.1" || peer === "::1" ? request.headers.get("X-Real-IP") ?? peer : peer;
        return online!.online.handle(request, ip);
      }
      return handleRequest(request, discordReady, storageReady, catalog);
    },
  });

  console.log("beatnet backend ready");

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  await stop();
  console.error(`startup failed ${describeError(error, config)}`);
  process.exitCode = 1;
}
