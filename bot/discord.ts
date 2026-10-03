import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { describeError, type Config } from "../server/config";
import type { Submissions } from "../server/submissions";
import { Review } from "./review";
import type { Library } from "../server/library";

export async function connectDiscord(config: Config, submissions: Submissions, library: Library) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.Error, (error) => {
    console.error(`discord error ${describeError(error, config)}`);
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let review: Review | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, () => resolve());
    timeout = setTimeout(() => reject(new Error("Discord login timed out after 30 seconds")), 30_000);
  });

  try {
    await Promise.all([client.login(config.discordToken), ready]);
    if (timeout) {
      clearTimeout(timeout);
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
      const names = missing.map((permission) => {
        const entry = Object.entries(PermissionFlagsBits).find(([, value]) => value === permission);
        return entry?.[0];
      });
      throw new Error(`Missing review channel permissions: ${names.join(", ")}`);
    }

    review = new Review(config, submissions, library, submissionChannel, reviewChannel);
    review.recover();
    const handlers = review;
    client.on(Events.MessageCreate, (message) => handlers.run(() => handlers.receive(message)));
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        handlers.run(() => handlers.interact(interaction));
      }
    });

    return { client, review };
  } catch (error) {
    await review?.stop();
    await client.destroy();
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
