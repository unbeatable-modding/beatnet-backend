import { connectDiscord } from "../bot/discord";
import { describeError, loadConfig, type Config } from "./config";
import { handleRequest } from "./routes";
import { openSubmissions, type Submissions } from "./submissions";
import { openUploads, type Uploads } from "./uploads";
import { Library } from "./library";
import { acquireRuntime } from "./runtime";

let config: Config | undefined;
let connection: Awaited<ReturnType<typeof connectDiscord>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
let submissions: Submissions | undefined;
let uploads: Uploads | undefined;
let library: Library | undefined;
let releaseRuntime: (() => Promise<void>) | undefined;

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
  await releaseRuntime?.();
};

try {
  config = loadConfig();
  releaseRuntime = await acquireRuntime(config.dataDir);
  submissions = await openSubmissions(config.dataDir);
  uploads = await openUploads(submissions.root, config);
  library = new Library(submissions, uploads);
  await library.recover();
  connection = await connectDiscord(config, submissions, library);
  const discord = connection;

  server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    fetch: async (request) => {
      const discordReady = discord.client.isReady();
      const storageReady = submissions!.isReady() && await uploads!.isReady();
      return handleRequest(request, discordReady, storageReady);
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
