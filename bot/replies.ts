import type { ReviewInteraction } from "./updates";

type Reply = {
  interaction: ReviewInteraction;
  message: string;
  timer: ReturnType<typeof setTimeout>;
  close: (() => void) | undefined;
};

export class Replies {
  private readonly entries = new Map<string, Reply>();

  async keep(interaction: ReviewInteraction, message: string, duration: number, close?: () => void) {
    const user = interaction.user.id;
    const previous = this.entries.get(user);
    const reply: Reply = {
      interaction,
      message,
      timer: setTimeout(() => void this.clear(user, reply), Math.max(0, duration)),
      close,
    };
    reply.timer.unref();
    this.entries.set(user, reply);
    await this.remove(previous);
  }

  async clear(user: string, expected?: Reply) {
    const reply = this.entries.get(user);
    if (!reply || (expected && reply !== expected)) {
      return;
    }
    this.entries.delete(user);
    await this.remove(reply);
  }

  private async remove(reply?: Reply) {
    if (!reply) {
      return;
    }
    clearTimeout(reply.timer);
    reply.close?.();
    try {
      await reply.interaction.deleteReply(reply.message);
    } catch (error) {
      if (![10008, 10015, 50027].includes((error as { code?: number }).code ?? 0)) {
        console.error("cannot remove private reply");
      }
    }
  }

  async stop() {
    await Promise.all([...this.entries.keys()].map((user) => this.clear(user)));
  }
}
