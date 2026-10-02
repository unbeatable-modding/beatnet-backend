import { connectDiscord } from "../bot/discord";
import { describeError, loadConfig, type Config } from "./config";
import { handleRequest } from "./routes";
import { openSubmissions, type Submissions } from "./submissions";
import { openUploads, type Uploads } from "./uploads";

let config: Config | undefined;
let connection: Awaited<ReturnType<typeof connectDiscord>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
let submissions: Submissions | undefined;
let uploads: Uploads | undefined;

const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server?.stop(true);
  await connection?.review.stop();
  await connection?.client.destroy();
  submissions?.close();
};

try {
  config = loadConfig();
  submissions = await openSubmissions(config.dataDir);
  uploads = await openUploads(submissions.root, config);
  connection = await connectDiscord(config, submissions, uploads);
  const discord = connection;

  server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    fetch: async (request) => handleRequest(request, discord.client.isReady(), submissions!.isReady() && await uploads!.isReady()),
  });

  console.log("beatnet backend ready");

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  await stop();
  console.error(`startup failed ${describeError(error, config)}`);
  process.exitCode = 1;
}
