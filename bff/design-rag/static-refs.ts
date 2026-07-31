// bff/design-rag/static-refs.ts — curated reference designs, no database.
//
// WHY THIS EXISTS ALONGSIDE THE RAG
// retrieveForBuild() uses pgvector to decide WHICH png files to open. That is the
// store's only job — everything after it reads images off disk and attaches them
// to the model call. So when the reference set is hand-curated, the decision is
// already made and the whole retrieval stack (extension, embeddings, captions,
// ANN index, domain classification) has nothing left to do.
//
// It is also the better choice for consistency, not merely the cheaper one.
// Retrieval rotates references, so consecutive builds see different exemplars and
// drift apart. A fixed set anchors every dashboard to the same visual target,
// which is the actual goal: ten dashboards that look like one product.
//
// Retrieval remains the right tool when the corpus is large and varied enough
// that picking the closest match beats always showing the best few. This module
// does not remove that path — it runs in front of it.
//
// THE CURATED FOLDER IS DELIBERATELY NOT corpus/. corpus/ is the RAG's working
// set (auto-enrolled, auto-retired, machine-scored). references/ is a small set
// of hand-picked gold images that a person chose and can delete. Keeping them
// apart means enrollment can never quietly change what every build sees.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImagePart } from "../aiflow";
import type { BuildReferences } from "./build-context";

/** Folder of curated reference PNGs. Files are used in sorted order, so prefix
 *  them `01-`, `02-` … to control which the model sees first. */
export const STATIC_REFS_DIR =
  process.env.DESIGN_REFS_DIR ?? "bff/design-rag/references";

/** How many to attach. More is not better: each image costs tokens and latency,
 *  and past ~4 the model averages them into mush rather than following any one. */
export const STATIC_REFS_K = Math.max(1, Number(process.env.DESIGN_REFS_K ?? 3));

/** Turn the curated path on. Independent of DESIGN_RAG_ENABLED so the two can be
 *  switched over without touching each other. */
export const STATIC_REFS_ENABLED = (process.env.DESIGN_REFS_ENABLED ?? "0") === "1";

const EMPTY: BuildReferences = { referenceBlock: "", images: [], refs: [] };

export interface StaticRefDeps {
  enabled?: boolean;
  dir?: string;
  k?: number;
  readDir?: (dir: string) => Promise<string[]>;
  readImage?: (p: string) => Promise<Buffer>;
}

/**
 * Load the curated references. Never throws — a missing folder, an unreadable
 * file or an empty directory all return EMPTY, and the caller falls back exactly
 * as it does when retrieval misses. Design references are a quality improvement,
 * never a build dependency.
 */
export async function staticReferences(deps: StaticRefDeps = {}): Promise<BuildReferences> {
  const enabled = deps.enabled ?? STATIC_REFS_ENABLED;
  if (!enabled) return EMPTY;

  const dir = deps.dir ?? STATIC_REFS_DIR;
  const k = deps.k ?? STATIC_REFS_K;
  const readDir = deps.readDir ?? ((d: string) => fs.readdir(d));
  const readImage = deps.readImage ?? ((p: string) => fs.readFile(p));

  let names: string[];
  try {
    names = (await readDir(dir)).filter((n) => /\.png$/i.test(n)).sort();
  } catch {
    console.warn(`[design-refs] ${dir} not readable — falling back to the text exemplar`);
    return EMPTY;
  }
  if (!names.length) {
    console.warn(`[design-refs] ${dir} holds no .png files — falling back to the text exemplar`);
    return EMPTY;
  }

  const images: ImagePart[] = [];
  const used: string[] = [];
  for (const name of names.slice(0, k)) {
    try {
      const buf = await readImage(path.join(dir, name));
      images.push({ mimeType: "image/png", dataB64: buf.toString("base64") });
      used.push(name);
    } catch {
      /* unreadable file -> skip it, keep the rest */
    }
  }
  if (!images.length) return EMPTY;

  // The DO NOT COPY line is load-bearing. Given a reference image the model will
  // otherwise lift its labels and categories wholesale, and the user gets a
  // dashboard about someone else's data.
  const referenceBlock = [
    "",
    "REFERENCE DESIGNS — each attached image is a COMPLETE, internally consistent",
    "design system: its own palette, typography, card treatment and spacing.",
    "",
    "CHOOSE ONE and follow it completely. Pick whichever best suits this data and",
    "this audience, then commit to it — its background, its accent colours, its",
    "heading face, its card radius and borders, all from that single reference.",
    "",
    "Do NOT blend them. A serif heading from one with the accent colour of another",
    "and the card treatment of a third looks unresolved, and is the most likely way",
    "to get a worse result than using no reference at all. Averaging several",
    "references is the failure mode; committing to one is the goal.",
    "",
    "These are design references ONLY. Do NOT copy their data, labels, category",
    "names, titles or any text content — every value must come from the user's",
    "real schema. Match how they look, never what they say.",
  ].join("\n");

  console.log(`[design-refs] attached ${images.length} curated reference(s): ${used.join(", ")}`);
  return { referenceBlock, images, refs: [] };
}