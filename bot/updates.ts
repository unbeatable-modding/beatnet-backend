import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Library } from "../server/library";
import type { Project } from "../server/registry";
import type { Submission, Submissions } from "../server/submissions";
import type { Replies } from "./replies";

export type ReviewInteraction = ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;
type Search = {
  userId: string;
  submissionId: string;
  reviewId: string;
  assignmentVersion: number;
  query: string;
  ownOnly: boolean;
  expiresAt: number;
  page: number;
  choices: Map<string, string>;
};

const pageSize = 10;
const searchDuration = 10 * 60_000;

function cleanLabel(value: string, length = 100) {
  return value.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, length);
}

function formatText(value: string, length: number) {
  return escapeMarkdown(cleanLabel(value, length));
}

function formatProject(project: Project, number: number) {
  const title = formatText(project.title, 60);
  const artist = formatText(project.artist || "Unknown artist", 30);
  const creator = formatText(project.creator || project.submitter, 35);
  const submitter = formatText(project.submitter, 25);

  return [
    `**${number}. ${title}**`,
    `${artist} · ${creator} · r${project.number}`,
    `Submitted by ${submitter} · ${project.id.slice(0, 8)}`,
  ].join("\n");
}

export class Updates {
  private readonly searches = new Map<string, Search>();

  constructor(
    private readonly submissions: Submissions,
    private readonly library: Library,
    private readonly notify: (submission: Submission) => Promise<void>,
    private readonly replies: Replies,
  ) {}

  private get registry() {
    return this.submissions.registry;
  }

  private requirePending(id: string, assignmentVersion: number, reviewId: string) {
    const submission = this.submissions.get(id);
    if (
      !submission ||
      submission.review_id !== reviewId ||
      submission.assignment_version !== assignmentVersion ||
      !["pending", "failed"].includes(submission.status)
    ) {
      throw new Error("This review changed or was processed, open Assign update again");
    }
    return submission;
  }

  private searchModal(submission: Submission) {
    const input = new TextInputBuilder()
      .setCustomId("query")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(120);
    const label = new LabelBuilder()
      .setLabel("Title, artist, mapper or filename")
      .setTextInputComponent(input);

    return new ModalBuilder()
      .setCustomId(`beatnet:search:${submission.id}:${submission.assignment_version}:${submission.review_id}`)
      .setTitle("Find the beatmap to update")
      .addLabelComponents(label);
  }

  private results(key: string, search: Search) {
    const submission = this.requirePending(search.submissionId, search.assignmentVersion, search.reviewId);
    const submitterId = search.ownOnly ? submission.author_id : "";
    let found = this.registry.list(search.query, search.page * pageSize, pageSize, submitterId);
    if (search.page && !found.items.length) {
      search.page = Math.max(0, Math.ceil(found.total / pageSize) - 1);
      found = this.registry.list(search.query, search.page * pageSize, pageSize, submitterId);
    }
    search.choices = new Map(found.items.map((project) => [project.id, project.current_revision_id]));
    const description = found.items.length
      ? found.items.map((project, index) => formatProject(project, search.page * pageSize + index + 1)).join("\n\n")
      : "No matching beatmaps, try a different title, artist or mapper";
    const embed = new EmbedBuilder()
      .setTitle("Choose the beatmap to update")
      .setColor(0x0099ff)
      .setDescription(description);
    const components: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [];
    if (found.items.length) {
      const options = found.items.map((project, index) => ({
        label: cleanLabel(`${search.page * pageSize + index + 1}. ${project.title}`),
        value: project.id,
        description: cleanLabel(
          `${project.artist || "Unknown artist"} · ${project.creator || project.submitter} · revision ${project.number}`,
        ),
      }));
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`beatnet:choose:${key}`)
        .setPlaceholder("Select the existing beatmap")
        .addOptions(options);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`beatnet:page:${key}:${search.page - 1}`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(search.page === 0),
        new ButtonBuilder()
          .setCustomId(`beatnet:page:${key}:${search.page + 1}`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled((search.page + 1) * pageSize >= found.total),
        new ButtonBuilder()
          .setCustomId(`beatnet:scope:${key}`)
          .setLabel(search.ownOnly ? "All submitters" : "This submitter")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`beatnet:again:${key}`).setLabel("Search again").setStyle(ButtonStyle.Primary),
      ),
    );
    return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
  }

  private getSearch(key: string, userId: string) {
    const search = this.searches.get(key);
    if (!search || search.userId !== userId || search.expiresAt < Date.now()) {
      this.searches.delete(key);
      throw new Error("This search expired, open Assign update again");
    }
    this.requirePending(search.submissionId, search.assignmentVersion, search.reviewId);
    return search;
  }

  async handle(interaction: ReviewInteraction) {
    if (interaction.isButton()) {
      await this.handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.handleSearch(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await this.handleChoice(interaction);
    }
  }

  private async handleButton(interaction: ButtonInteraction) {
    const assign = /^beatnet:(assign|new):([0-9a-f-]{36}):(\d+)$/.exec(interaction.customId);
    if (assign) {
      const submission = this.requirePending(assign[2]!, Number(assign[3]), interaction.message.id);
      if (assign[1] === "assign") {
        await interaction.showModal(this.searchModal(submission));
        await this.replies.clear(interaction.user.id);
        return;
      }
      await this.library.exclusive(async () => this.registry.assign(submission.id, null, submission.assignment_version, null));
      await this.notify(this.submissions.get(submission.id)!);
      await this.replies.clear(interaction.user.id);
      return;
    }
    const page = /^beatnet:(page|scope|again):([0-9a-f-]{36})(?::(-?\d+))?$/.exec(interaction.customId);
    if (!page) {
      return;
    }
    const search = this.getSearch(page[2]!, interaction.user.id);
    if (page[1] === "again") {
      await interaction.showModal(this.searchModal(this.submissions.get(search.submissionId)!));
      await this.replies.clear(interaction.user.id);
      return;
    }
    if (page[1] === "scope") {
      search.ownOnly = !search.ownOnly;
      search.page = 0;
    } else {
      search.page = Math.max(0, Math.min(100_000, Number(page[3])));
    }
    await interaction.editReply(this.results(page[2]!, search));
  }

  private async handleSearch(interaction: ModalSubmitInteraction) {
    const match = /^beatnet:search:([0-9a-f-]{36}):(\d+):(\d{17,20})$/.exec(interaction.customId);
    if (!match) {
      return;
    }
    this.requirePending(match[1]!, Number(match[2]), match[3]!);
    for (const [key, search] of this.searches) {
      if (search.expiresAt < Date.now()) {
        this.searches.delete(key);
      }
    }
    if (this.searches.size >= 1000) {
      throw new Error("Too many active searches, try again shortly");
    }
    const key = crypto.randomUUID();
    const search: Search = {
      userId: interaction.user.id,
      submissionId: match[1]!,
      reviewId: match[3]!,
      assignmentVersion: Number(match[2]),
      query: interaction.fields.getTextInputValue("query").trim(),
      ownOnly: false,
      expiresAt: Date.now() + searchDuration,
      page: 0,
      choices: new Map(),
    };
    if (!search.query) {
      throw new Error("Enter a title, artist, mapper or filename");
    }
    this.searches.set(key, search);
    try {
      const message = await interaction.editReply(this.results(key, search));
      await this.replies.keep(interaction, message.id, search.expiresAt - Date.now(), () => this.searches.delete(key));
    } catch (error) {
      this.searches.delete(key);
      throw error;
    }
  }

  private async handleChoice(interaction: StringSelectMenuInteraction) {
    const match = /^beatnet:choose:([0-9a-f-]{36})$/.exec(interaction.customId);
    if (!match) {
      return;
    }
    const search = this.getSearch(match[1]!, interaction.user.id);
    const id = interaction.values[0]!;
    const revisionId = search.choices.get(id);
    if (!revisionId) {
      throw new Error("Select a beatmap from this search");
    }
    await this.library.exclusive(async () => this.registry.assign(search.submissionId, id, search.assignmentVersion, revisionId));
    this.searches.delete(match[1]!);
    await this.notify(this.submissions.get(search.submissionId)!);
    await this.replies.clear(interaction.user.id);
  }

  async prune() {
    for (const [key, search] of this.searches) {
      const submission = this.submissions.get(search.submissionId);
      if (
        search.expiresAt < Date.now() ||
        !submission ||
        !["pending", "failed"].includes(submission.status) ||
        submission.assignment_version !== search.assignmentVersion
      ) {
        this.searches.delete(key);
        await this.replies.clear(search.userId);
      }
    }
  }

  stop() {
    this.searches.clear();
  }
}
