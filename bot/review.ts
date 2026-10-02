import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags, escapeMarkdown,
  type Attachment as DiscordAttachment, type ButtonInteraction, type Message, type TextChannel,
} from "discord.js";
import { describeError, type Config } from "../server/config";
import type { Attachment, Submission, Submissions } from "../server/submissions";
import type { Uploads } from "../server/uploads";

const statuses = {
  pending: "Waiting for review",
  uploading: "Uploading to the server",
  accepted: "Accepted and saved on the server",
  rejected: "Rejected",
  failed: "Upload failed, press Accept to retry or Reject to close",
};

export function zipAttachments(attachments: Iterable<DiscordAttachment>): Attachment[] {
  return [...attachments].filter((attachment) => /\.zip$/i.test(attachment.name)).map((attachment) => ({
    id: attachment.id, name: attachment.name, size: attachment.size, url: attachment.url,
  }));
}

export function reviewOptions(submission: Submission) {
  const complete = submission.status === "accepted" || submission.status === "rejected";
  const disabled = !["pending", "failed"].includes(submission.status);
  const attachments = JSON.parse(submission.attachments) as Attachment[];
  const source = `https://discord.com/channels/${submission.guild_id}/${submission.channel_id}/${submission.message_id}`;
  const embed = new EmbedBuilder()
    .setAuthor({ name: submission.author_name || "Unknown submitter", url: source })
    .setTitle(attachments[0]!.name.slice(0, 256))
    .setURL(attachments[0]!.url)
    .setDescription(`<@${submission.author_id}>: ${submission.content || "No message text"}`)
    .addFields({ name: "Submission", value: `[#${escapeMarkdown(submission.channel_name || "submissions")}](${source})` })
    .setColor(0x0099ff);
  if (!complete) embed.setFooter({ text: statuses[submission.status] });
  if (submission.author_avatar) embed.setThumbnail(submission.author_avatar);
  if (attachments.length > 1) embed.addFields({ name: "Other ZIP files", value: `${attachments.length - 1} additional ZIP files in the linked submission` });
  if (submission.error) embed.addFields({ name: "Error", value: submission.error.slice(0, 500) });
  const embeds = [embed];
  if (complete) {
    const decision = submission.status === "rejected" ? "REJECTED" : "ACCEPTED";
    const reviewer = submission.reviewer_id ? `<@${submission.reviewer_id}>` : "Unknown reviewer";
    embeds.push(new EmbedBuilder().setDescription(`${decision} by ${reviewer}`));
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`beatnet:accept:${submission.id}`).setLabel("Accept").setEmoji("\u2705").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`beatnet:reject:${submission.id}`).setLabel("Reject").setEmoji("\u274c").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
  return { embeds, components: complete ? [] : [buttons], allowedMentions: { parse: [] as [], repliedUser: false } };
}

export function createReview(
  config: Config, submissions: Submissions, uploads: Uploads,
  submissionChannel: TextChannel, reviewChannel: TextChannel,
) {
  const forwarding = new Set<string>();
  const tasks = new Set<Promise<unknown>>();
  const updates = new Map<string, Promise<void>>();
  let stopped = false;
  let syncing = false;

  const report = (error: unknown) => console.error(`review failed ${describeError(error, config)}`);

  function run(work: () => Promise<unknown>) {
    if (stopped) return;
    const task = work().catch(report).finally(() => tasks.delete(task));
    tasks.add(task);
  }

  async function notify(submission: Submission) {
    const previous = updates.get(submission.id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = submissions.get(submission.id);
      if (!current?.review_id) return;
      const message = await reviewChannel.messages.fetch({ message: current.review_id, force: true });
      await message.edit(reviewOptions(current));
      submissions.notified(current.id, current.version);
    });
    updates.set(submission.id, task);
    try {
      await task;
    } finally {
      if (updates.get(submission.id) === task) updates.delete(submission.id);
    }
  }

  async function findMessage(submission: Submission, matches: (message: Message) => boolean) {
    let before: string | undefined;
    while (true) {
      const batch = await reviewChannel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = batch.find((message) => message.author.id === reviewChannel.client.user?.id
        && matches(message));
      if (found) return found;
      const last = batch.last();
      if (batch.size < 100 || !last || last.createdTimestamp < Date.parse(submission.created_at) - 60_000) return null;
      before = last.id;
    }
  }

  async function forward(submission: Submission, source?: Message) {
    if (submission.review_id || forwarding.has(submission.id)) return;
    forwarding.add(submission.id);
    try {
      let message = await findMessage(submission, (entry) => entry.components.some((row) => row.type === ComponentType.ActionRow
        && row.components.some((button) => button.type === ComponentType.Button && "customId" in button
          && button.customId === `beatnet:accept:${submission.id}`)));
      if (!message) {
        const original = source ?? await submissionChannel.messages.fetch(submission.message_id);
        await original.react("\u{1f440}");
        submissions.setAuthor(submission.id, original.author.username, original.author.displayAvatarURL({ size: 128 }), submissionChannel.name);
        message = await reviewChannel.send({
          ...reviewOptions(submissions.get(submission.id)!), nonce: submission.message_id, enforceNonce: true,
        });
      }
      submissions.attachReview(submission.id, message.id);
      const current = submissions.get(submission.id)!;
      await notify(current);
    } finally {
      forwarding.delete(submission.id);
    }
  }

  async function receive(message: Message) {
    if (message.guildId !== config.guildId || message.channelId !== config.submissionChannelId || message.author.bot || message.webhookId) return;
    const attachments = zipAttachments(message.attachments.values());
    if (!attachments.length) return;
    const submission = submissions.record({
      guildId: config.guildId, channelId: message.channelId, messageId: message.id,
      authorId: message.author.id, content: message.content, attachments,
    });
    await forward(submission, message);
  }

  async function freshAttachments(submission: Submission) {
    try {
      const original = await submissionChannel.messages.fetch({ message: submission.message_id, force: true });
      return zipAttachments(original.attachments.values());
    } catch {
      return JSON.parse(submission.attachments) as Attachment[];
    }
  }

  async function click(interaction: ButtonInteraction) {
    const match = /^beatnet:(accept|reject):([0-9a-f-]{36})$/.exec(interaction.customId);
    if (!match) return;
    if (interaction.user.id !== config.ownerId || interaction.guildId !== config.guildId
      || interaction.channelId !== config.reviewChannelId) {
      await interaction.reply({ content: "Only the configured owner can review submissions", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = match[2]!;
    const action = match[1] as "accept" | "reject";
    const submission = submissions.get(id);
    if (!submission || submission.review_id !== interaction.message.id) {
      await interaction.reply({ content: "This review does not match a stored submission", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!submissions.decide(id, interaction.message.id, interaction.user.id, action)) {
      await interaction.editReply(`This submission is already ${submission.status}`);
      return;
    }
    try {
      await notify(submissions.get(id)!);
    } catch (error) {
      report(error);
    }
    if (action === "accept") {
      try {
        const current = submissions.get(id)!;
        const existing = await uploads.stored(current);
        const manifest = existing ?? await uploads.save(current, await freshAttachments(current));
        submissions.complete(id, manifest.files);
      } catch (error) {
        submissions.fail(id, describeError(error, config));
        report(error);
      }
    }
    const current = submissions.get(id)!;
    try {
      await notify(current);
    } catch (error) {
      report(error);
    }
    await interaction.editReply(current.status === "failed" ? `${statuses.failed}\n${current.error}` : statuses[current.status]);
  }

  async function sync() {
    if (stopped || syncing) return;
    syncing = true;
    try {
      for (const submission of submissions.outstanding()) {
        if (stopped) break;
        try {
          if (submission.review_id) await notify(submission);
          else await forward(submission);
        } catch (error) {
          report(error);
        }
      }
    } finally {
      syncing = false;
    }
  }

  async function recover() {
    for (const submission of submissions.interrupted()) {
      try {
        const manifest = await uploads.stored(submission);
        if (manifest) submissions.complete(submission.id, manifest.files);
        else submissions.fail(submission.id, "Upload interrupted by a restart, press Accept to retry");
      } catch (error) {
        submissions.fail(submission.id, describeError(error, config));
      }
    }
    run(sync);
  }

  const interval = setInterval(() => run(sync), 30_000);
  interval.unref();
  return {
    receive, click, recover, run,
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await Promise.allSettled([...tasks]);
    },
  };
}
