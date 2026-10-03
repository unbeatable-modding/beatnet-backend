import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
  PermissionFlagsBits,
  type Attachment as DiscordAttachment,
  type Message,
  type TextChannel,
} from "discord.js";
import { describeError, type Config } from "../server/config";
import type { Attachment, Submission, Submissions } from "../server/submissions";
import type { Library } from "../server/library";
import type { Registry } from "../server/registry";
import { Updates, type ReviewInteraction } from "./updates";
import { Replies } from "./replies";

function zipAttachments(attachments: Iterable<DiscordAttachment>): Attachment[] {
  return [...attachments]
    .filter((attachment) => /\.zip$/i.test(attachment.name))
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      url: attachment.url,
    }));
}

function hasReviewButton(message: Message, submissionId: string): boolean {
  const action = `beatnet:accept:${submissionId}`;

  return message.components.some((row) => {
    if (row.type !== ComponentType.ActionRow) {
      return false;
    }

    return row.components.some((button) => {
      if (button.type !== ComponentType.Button) {
        return false;
      }

      return button.customId === action || button.customId?.startsWith(`${action}:`);
    });
  });
}

function addPublicationFields(embed: EmbedBuilder, submission: Submission, complete: boolean, registry: Registry) {
  const revision = registry.revision(submission.id);
  const target = submission.target_project_id ? registry.get(submission.target_project_id) : null;

  if (target) {
    const base = submission.base_revision_id ? registry.byRevision(submission.base_revision_id) : null;
    const changed = !complete && target.current_revision_id !== submission.base_revision_id;
    const title = escapeMarkdown(revision?.title ?? target.title);
    const artist = escapeMarkdown((revision?.artist ?? target.artist) || "Unknown artist");
    const creator = escapeMarkdown((revision?.creator ?? target.creator) || target.submitter);
    const revisions = `Revision ${base?.number ?? target.number} → ${revision?.number ?? target.number + 1}`;
    const notice = changed ? "\nA newer revision is available, use Assign update again" : "";

    embed.addFields({
      name: "Update target",
      value: `${title}\n${artist} · ${creator}\n${revisions}${notice}`.slice(0, 1024),
    });

    const origin = registry.origin(target.id);
    if (origin?.source === "discord") {
      embed.addFields({
        name: "Existing beatmap",
        value: `[Original submission](https://discord.com/channels/${origin.guild_id}/${origin.channel_id}/${origin.message_id})`,
      });
    }
  } else if (revision) {
    embed.addFields({ name: "Beatmap", value: `${escapeMarkdown(revision.title)} · revision ${revision.number}`.slice(0, 1024) });
  } else if (!complete) {
    embed.addFields({ name: "Publication", value: "New beatmap · revision 1" });
  }

  return target;
}

function reviewOptions(submission: Submission, registry: Registry) {
  const complete = submission.status === "accepted" || submission.status === "rejected";
  const disabled = !["pending", "failed"].includes(submission.status);
  const attachments = JSON.parse(submission.attachments) as Attachment[];
  const source = `https://discord.com/channels/${submission.guild_id}/${submission.channel_id}/${submission.message_id}`;
  const embed = new EmbedBuilder()
    .setAuthor({ name: submission.author_name || "Unknown submitter", url: source })
    .setTitle(attachments[0]!.name.slice(0, 256))
    .setURL(attachments[0]!.url)
    .setDescription(`<@${submission.author_id}>: ${submission.content || "No message text"}`.slice(0, 3000))
    .setColor(0x0099ff);
  if (submission.author_avatar) {
    embed.setThumbnail(submission.author_avatar);
  }
  if (attachments.length > 1) {
    embed.addFields({ name: "Other ZIP files", value: `${attachments.length - 1} additional ZIP files in the linked submission` });
  }
  if (submission.error) {
    embed.addFields({ name: "Error", value: submission.error.slice(0, 500) });
  }
  const target = addPublicationFields(embed, submission, complete, registry);
  const embeds = [embed];
  const allowedMentions = { parse: [] as [], repliedUser: false };
  if (complete) {
    const decision = submission.status === "rejected" ? "REJECTED" : "ACCEPTED";
    const reviewer = submission.reviewer_id ? `<@${submission.reviewer_id}>` : "Unknown reviewer";
    embeds.push(new EmbedBuilder().setDescription(`${decision} by ${reviewer}`));
    return { embeds, components: [], allowedMentions };
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`beatnet:accept:${submission.id}:${submission.assignment_version}`)
      .setLabel("Accept")
      .setEmoji("\u2705")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`beatnet:reject:${submission.id}:${submission.assignment_version}`)
      .setLabel("Reject")
      .setEmoji("\u274c")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`beatnet:assign:${submission.id}:${submission.assignment_version}`)
      .setLabel("Assign update")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
  if (target) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`beatnet:new:${submission.id}:${submission.assignment_version}`)
        .setLabel("New beatmap")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }
  return { embeds, components: [buttons], allowedMentions };
}

export class Review {
  private readonly forwarding = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly edits = new Map<string, Promise<void>>();
  private readonly replies = new Replies();
  private stopped = false;
  private syncing = false;
  private readonly updates: Updates;
  private readonly stopWatching: () => void;
  private readonly syncTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: Config,
    private readonly submissions: Submissions,
    private readonly library: Library,
    private readonly submissionChannel: TextChannel,
    private readonly reviewChannel: TextChannel,
  ) {
    this.updates = new Updates(submissions, library, (submission) => this.notify(submission), this.replies);
    this.stopWatching = library.watch(() => this.run(() => this.sync()));
    this.syncTimer = setInterval(() => this.run(() => this.sync()), 30_000);
    this.syncTimer.unref();
  }

  private report(error: unknown) {
    console.error(`review failed ${describeError(error, this.config)}`);
  }

  run(work: () => Promise<unknown>) {
    if (this.stopped) {
      return;
    }
    const task = work()
      .catch((error) => this.report(error))
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async notify(submission: Submission) {
    if (!submission.review_id) {
      return;
    }
    await this.editMessage(submission.review_id, () => this.editReview(submission.id));
  }

  private async editReview(id: string) {
    const current = this.submissions.get(id);
    if (!current?.review_id) {
      return;
    }
    const message = await this.reviewChannel.messages.fetch({ message: current.review_id, force: true });
    await message.edit(reviewOptions(current, this.submissions.registry));
    this.submissions.notified(current.id, current.version);
  }

  private async editMessage(key: string, work: () => Promise<void>) {
    const previous = this.edits.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    this.edits.set(key, task);
    try {
      await task;
    } finally {
      if (this.edits.get(key) === task) {
        this.edits.delete(key);
      }
    }
  }

  private async findMessage(submission: Submission) {
    let before: string | undefined;
    while (true) {
      const batch = await this.reviewChannel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = batch.find((message) => {
        return message.author.id === this.reviewChannel.client.user?.id && hasReviewButton(message, submission.id);
      });
      if (found) {
        return found;
      }
      const last = batch.last();
      if (batch.size < 100 || !last || last.createdTimestamp < Date.parse(submission.created_at) - 60_000) {
        return null;
      }
      before = last.id;
    }
  }

  private async forward(submission: Submission, source?: Message) {
    if (submission.review_id || this.forwarding.has(submission.id)) {
      return;
    }
    this.forwarding.add(submission.id);
    try {
      let message = await this.findMessage(submission);
      if (!message) {
        const original = source ?? (await this.submissionChannel.messages.fetch(submission.message_id));
        await original.react("\u{1f440}");
        this.submissions.setAuthor(
          submission.id,
          original.author.username,
          original.author.displayAvatarURL({ size: 128 }),
          this.submissionChannel.name,
        );
        message = await this.reviewChannel.send({
          ...reviewOptions(this.submissions.get(submission.id)!, this.submissions.registry),
          nonce: submission.attachment_id || submission.message_id,
          enforceNonce: true,
        });
      }
      this.submissions.attachReview(submission.id, message.id);
      const current = this.submissions.get(submission.id)!;
      await this.notify(current);
    } finally {
      this.forwarding.delete(submission.id);
    }
  }

  async receive(message: Message) {
    if (
      message.guildId !== this.config.guildId ||
      message.channelId !== this.config.submissionChannelId ||
      message.author.bot ||
      message.webhookId
    ) {
      return;
    }
    const attachments = zipAttachments(message.attachments.values());
    if (!attachments.length) {
      return;
    }
    const entries = attachments.map((attachment) =>
      this.submissions.record({
        guildId: this.config.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        content: message.content,
        attachment,
      }),
    );
    for (const submission of entries) {
      await this.forward(submission, message);
    }
  }

  private async freshAttachments(submission: Submission) {
    try {
      const original = await this.submissionChannel.messages.fetch({ message: submission.message_id, force: true });
      const ids = new Set((JSON.parse(submission.attachments) as Attachment[]).map((attachment) => attachment.id));
      return zipAttachments(original.attachments.values()).filter((attachment) => ids.has(attachment.id));
    } catch {
      return JSON.parse(submission.attachments) as Attachment[];
    }
  }

  async interact(interaction: ReviewInteraction) {
    if (!/^beatnet:(accept|reject|assign|new|search|choose|page|scope|again):/.test(interaction.customId)) {
      return;
    }
    try {
      await this.prepareInteraction(interaction);

      const match = /^beatnet:(accept|reject):([0-9a-f-]{36})(?::(\d+))?$/.exec(interaction.customId);
      if (!match || !interaction.isButton()) {
        await this.updates.handle(interaction);
        return;
      }
      const id = match[2]!;
      const assignment = Number(match[3] ?? 0);
      const submission = this.submissions.get(id);
      if (!submission || submission.review_id !== interaction.message.id) {
        throw new Error("This review does not match a stored submission");
      }
      if (match[1] === "accept") {
        await this.library.accept(
          id,
          interaction.message.id,
          interaction.user.id,
          assignment,
          () => this.freshAttachments(this.submissions.get(id)!),
          () => this.notify(this.submissions.get(id)!),
        );
      } else {
        await this.library.reject(id, interaction.message.id, interaction.user.id, assignment);
      }
      const current = this.submissions.get(id)!;
      await this.notify(current).catch((error) => this.report(error));
      await this.replies.clear(interaction.user.id);
    } catch (error) {
      this.report(error);
      const match = /^beatnet:(accept|reject):([0-9a-f-]{36})/.exec(interaction.customId);
      const current = match ? this.submissions.get(match[2]!) : null;
      if (current) {
        await this.notify(current).catch((error) => this.report(error));
      }
      await this.errorReply(interaction, describeError(error, this.config)).catch((error) => this.report(error));
    }
  }

  private async prepareInteraction(interaction: ReviewInteraction) {
    if (interaction.guildId !== this.config.guildId || interaction.channelId !== this.config.reviewChannelId) {
      throw new Error("Review actions are only available in the verification channel");
    }
    const prompt = interaction.isButton() && /^beatnet:(assign|again):/.test(interaction.customId);
    if (prompt) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) {
        throw new Error("You no longer have access to the verification channel");
      }
    } else {
      if (!interaction.deferred && !interaction.replied) {
        if (interaction.isModalSubmit()) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await this.replies.clear(interaction.user.id);
        } else {
          await interaction.deferUpdate();
        }
      }
      const member = await this.reviewChannel.guild.members.fetch({ user: interaction.user.id, force: true });
      if (!this.reviewChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
        throw new Error("You no longer have access to the verification channel");
      }
    }
  }

  private async errorReply(interaction: ReviewInteraction, content: string) {
    let message;
    if (interaction.deferred || interaction.replied) {
      message = interaction.isModalSubmit()
        ? await interaction.editReply({ content, components: [], embeds: [] })
        : await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      message = await interaction.fetchReply();
    }
    await this.replies.keep(interaction, message.id, 30_000);
  }

  private async sync() {
    if (this.stopped || this.syncing) {
      return;
    }
    this.syncing = true;
    try {
      await this.updates.prune();
      for (const submission of this.submissions.outstanding()) {
        if (this.stopped) {
          break;
        }
        try {
          if (submission.review_id) {
            await this.notify(submission);
          } else {
            await this.forward(submission);
          }
        } catch (error) {
          this.report(error);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  recover() {
    this.run(() => this.sync());
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.syncTimer);
    this.stopWatching();
    this.updates.stop();
    await Promise.allSettled([...this.tasks]);
    await this.replies.stop();
  }
}
