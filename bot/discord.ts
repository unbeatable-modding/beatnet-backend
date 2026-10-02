import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { describeError, type Config } from "../server/config";
import type { Submissions } from "../server/submissions";
import type { Uploads } from "../server/uploads";
import { createReview } from "./review";

export async function connectDiscord(config: Config, submissions: Submissions, uploads: Uploads) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.Error, (error) => {
    console.error(`Discord error ${describeError(error, config)}`);
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let review: ReturnType<typeof createReview> | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, () => resolve());
    timeout = setTimeout(() => reject(new Error("Discord login timed out after 30 seconds")), 30_000);
  });

  try {
    await Promise.all([client.login(config.discordToken), ready]);
    if (timeout) clearTimeout(timeout);

    const application = await client.application?.fetch();
    if (application?.id !== config.applicationId) {
      throw new Error("The bot token and application ID do not belong to the same application");
    }

    const guild = await client.guilds.fetch(config.guildId);
    const member = await guild.members.fetchMe();
    const submissionChannel = await guild.channels.fetch(config.submissionChannelId);
    const reviewChannel = await guild.channels.fetch(config.reviewChannelId);

    if (submissionChannel?.type !== ChannelType.GuildText || reviewChannel?.type !== ChannelType.GuildText) {
      throw new Error("Submission and review channels must be text channels in the configured server");
    }

    const readPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    const reviewPermissions = [
      ...readPermissions,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ];

    if (!submissionChannel.permissionsFor(member)?.has([...readPermissions, PermissionFlagsBits.AddReactions])) {
      throw new Error("The bot needs View Channel, Read Message History and Add Reactions in the submission channel");
    }

    const missing = reviewPermissions.filter((permission) => !reviewChannel.permissionsFor(member)?.has(permission));
    if (missing.length) {
      const names = missing.map((permission) => Object.entries(PermissionFlagsBits).find(([, value]) => value === permission)?.[0]);
      throw new Error(`Missing review channel permissions: ${names.join(", ")}`);
    }

    review = createReview(config, submissions, uploads, submissionChannel, reviewChannel);
    await review.recover();
    const handlers = review;
    client.on(Events.MessageCreate, (message) => handlers.run(() => handlers.receive(message)));
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton()) handlers.run(() => handlers.click(interaction));
    });

    return { client, guild, submissionChannel, reviewChannel, review };
  } catch (error) {
    await review?.stop();
    await client.destroy();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
