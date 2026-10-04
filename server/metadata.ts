import { open } from "yauzl-promise";
import type { Metadata } from "./registry";
import type { Manifest, Uploads } from "./uploads";
import { prepareCover, validCoverPath } from "./cover";

const slots = ["Beginner", "Easy", "Normal", "Hard", "UNBEATABLE", "Star"];

export function resolveDifficulty(path: string, version?: string) {
  const filename = path.split(/[\\/]/).pop()!.replace(/\.(txt|osu)$/i, "");
  const bracket = /\[([^\[\]]+)\]$/.exec(filename);
  const label = bracket?.[1]?.trim();
  if (label) {
    return label.toLowerCase() === "expert" ? "Hard"
      : slots.find((slot) => slot.toLowerCase() === label.toLowerCase()) ?? "Star";
  }
  const named = slots.find((slot) => filename.toLowerCase().includes(slot.toLowerCase()));
  if (named) {
    return named;
  }
  const value = version?.trim();
  return !value ? null : value.toLowerCase() === "expert" ? "Hard"
    : slots.find((slot) => slot.toLowerCase() === value.toLowerCase()) ?? "Star";
}

function readFields(text: string) {
  const metadata: Record<string, string> = {};
  let section = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }

    if (section !== "metadata" && section !== "general") {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (/^[a-z]+$/.test(key)) {
      metadata[key] = value.slice(0, key === "tags" ? 4096 : 256);
    }
  }

  return metadata;
}

async function readChart(stream: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 16_777_216) {
      throw new Error("Chart is too large");
    }
    chunks.push(Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
  return readFields(text);
}

export async function readMetadata(uploads: Uploads, manifest: Manifest, submitter = ""): Promise<Metadata> {
  const titles = new Set<string>();
  const artists = new Set<string>();
  const creators = new Set<string>();
  const names: string[] = [];
  const difficulties = new Set<string>();
  const chartInfo: NonNullable<Metadata["chartInfo"]> = { levels: {}, labels: {}, cover: null };

  for (const stored of manifest.files) {
    names.push(stored.name);
    const path = uploads.path(manifest.submissionId, stored.file);
    try {
      const archive = await open(path);
      const covers: string[] = [];
      const directories = new Set<string>();
      try {
        for await (const entry of archive) {
          const name = entry.filename.replace(/\\/g, "/");
          if (validCoverPath(name)) {
            covers.push(name);
          }
          if (!/\.(txt|osu)$/i.test(entry.filename)) {
            continue;
          }

          const metadata = await readChart(await entry.openReadStream());
          directories.add(name.split("/").slice(0, -1).join("/"));
          const difficulty = resolveDifficulty(entry.filename, metadata.version);
          if (difficulty) {
            difficulties.add(difficulty);
            if (!(difficulty in chartInfo.levels)) {
              let level = 0;
              try {
                const tags = JSON.parse(metadata.tags ?? "{}") as { Level?: number };
                level = Number.isSafeInteger(tags.Level) && tags.Level! >= 0 ? tags.Level! : 0;
              } catch {}
              chartInfo.levels[difficulty] = level;
              chartInfo.labels[difficulty] = metadata.version || difficulty;
            }
          }
          if (!chartInfo.preview && metadata.audiofilename) {
            const directory = entry.filename.replace(/\\/g, "/").split("/").slice(0, -1);
            const audio = metadata.audiofilename.replace(/\\/g, "/");
            if (!audio.startsWith("/") && !audio.split("/").includes("..") && /\.(mp3|ogg|wav|flac)$/i.test(audio)) {
              const time = Number(metadata.previewtime);
              chartInfo.preview = {
                fileId: stored.id,
                path: [...directory, audio].join("/"),
                start: Number.isFinite(time) && time > 0 ? time : 0,
              };
            }
          }
          const title = metadata.titleunicode || metadata.title;
          if (!title) {
            continue;
          }

          titles.add(title);

          const artist = metadata.artistunicode || metadata.artist;
          if (artist) {
            artists.add(artist);
          }
          if (metadata.creator) {
            creators.add(metadata.creator);
          }
          names.push(entry.filename);
        }
      } finally {
        await archive.close();
      }
      if (!chartInfo.cover) {
        for (const directory of directories) {
          const prefix = directory.length > 0 ? directory + "/" : "";
          const cover = ["cover.png", "cover.jpg", "cover.jpeg"]
            .map((filename) => covers.find((name) => name.toLowerCase() === (prefix + filename).toLowerCase()))
            .find((name) => name !== undefined);
          if (cover && await prepareCover(path, stored.sha256, cover)) {
            chartInfo.cover = { fileId: stored.id, path: cover };
            break;
          }
        }
      }
    } catch {
      console.warn(`cannot read metadata from ${stored.name}`);
      continue;
    }
  }

  const fallbackTitle = names[0]?.replace(/\.zip$/i, "") || "Untitled beatmap";

  return {
    title: ([...titles].join(" / ") || fallbackTitle).slice(0, 256),
    artist: [...artists].join(" / ").slice(0, 256),
    creator: [...creators].join(" / ").slice(0, 256) || submitter,
    difficulties: slots.filter((slot) => difficulties.has(slot)),
    chartInfo,
    search: [...titles, ...artists, ...creators, ...names, submitter].join(" ").slice(0, 32_000),
  };
}
