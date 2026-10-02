import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { describeError, type Config } from "../server/config";

export async function connectDiscord(config: Config) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.Error, (error) => {
    console.error(`Discord error ${describeError(error, config)}`);
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;

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

    if (!submissionChannel.permissionsFor(member)?.has(readPermissions)) {
      throw new Error("The bot needs View Channel and Read Message History in the submission channel");
    }

    if (!reviewChannel.permissionsFor(member)?.has(reviewPermissions)) {
      throw new Error("The bot is missing required read or message permissions in the review channel");
    }

    return { client, guild, submissionChannel, reviewChannel };
  } catch (error) {
    await client.destroy();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
