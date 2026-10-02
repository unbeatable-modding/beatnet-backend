import { z } from "zod";

const discordId = z.string().regex(/^\d{17,20}$/);

const envSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_APPLICATION_ID: discordId,
  DISCORD_GUILD_ID: discordId,
  DISCORD_SUBMISSION_CHANNEL_ID: discordId,
  DISCORD_REVIEW_CHANNEL_ID: discordId,
  DISCORD_OWNER_ID: discordId,
  HTTP_HOST: z.enum(["127.0.0.1", "0.0.0.0", "::1", "::"]).default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid configuration: ${fields.join(", ")}`);
  }

  const values = result.data;

  if (values.DISCORD_SUBMISSION_CHANNEL_ID === values.DISCORD_REVIEW_CHANNEL_ID) {
    throw new Error("Submission and review channels must be different");
  }

  return {
    discordToken: values.DISCORD_TOKEN,
    applicationId: values.DISCORD_APPLICATION_ID,
    guildId: values.DISCORD_GUILD_ID,
    submissionChannelId: values.DISCORD_SUBMISSION_CHANNEL_ID,
    reviewChannelId: values.DISCORD_REVIEW_CHANNEL_ID,
    ownerId: values.DISCORD_OWNER_ID,
    httpHost: values.HTTP_HOST,
    httpPort: values.HTTP_PORT,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function describeError(error: unknown, config?: Config): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return config ? message.replaceAll(config.discordToken, "[redacted]") : message;
}
