import { connectDiscord } from "../bot/discord";
import { describeError, loadConfig, type Config } from "./config";
import { handleRequest } from "./routes";

let config: Config | undefined;
let connection: Awaited<ReturnType<typeof connectDiscord>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;

const stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([server?.stop(true), connection?.client.destroy()]);
};

try {
  config = loadConfig();
  connection = await connectDiscord(config);
  const discord = connection;

  server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    fetch: (request) => handleRequest(request, discord.client.isReady()),
  });

  console.log(`beatnet-backend ready. Discord: ${discord.client.user?.tag}. HTTP: ${server.url}`);

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  await stop();
  console.error(`Startup failed: ${describeError(error, config)}`);
  process.exitCode = 1;
}
