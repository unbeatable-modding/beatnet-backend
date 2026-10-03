import { open } from "yauzl-promise";
import type { Metadata } from "./registry";
import type { Manifest, Uploads } from "./uploads";

function readFields(text: string) {
  const metadata: Record<string, string> = {};
  let section = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }

    if (section !== "metadata") {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (/^[a-z]+$/.test(key)) {
      metadata[key] = value.slice(0, 256);
    }
  }

  return metadata;
}

async function readChart(stream: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
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

  for (const stored of manifest.files) {
    names.push(stored.name);
    const path = uploads.path(manifest.submissionId, stored.file);
    try {
      const archive = await open(path);
      try {
        for await (const entry of archive) {
          if (!/\.(txt|osu)$/i.test(entry.filename)) {
            continue;
          }

          const metadata = await readChart(await entry.openReadStream());
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
    search: [...titles, ...artists, ...creators, ...names, submitter].join(" ").slice(0, 32_000),
  };
}
