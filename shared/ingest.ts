// shared/ingest.ts — structured ingestion model. A ParsedDoc is the Document Parser's
// output: a title, ordered sections (heading + prose), and any tables found in the file.
// Tables are the valuable part — they bridge into queryable datasets so a deck built from a
// report can actually chart the report's numbers, not just quote its text. Asset is the
// Image/Asset Parser's output, tracked by the Asset Store.
export interface DocTable { name: string; columns: string[]; rows: string[][] }
export interface DocSection { heading: string; level: number; text: string }
export interface ParsedDoc {
  title?: string;
  sections: DocSection[];
  tables: DocTable[];
  source: string;      // filename
  kind: "docx" | "html" | "markdown" | "text";
}

export interface Asset {
  id: string;
  kind: "image";
  mime: string;
  width?: number;
  height?: number;
  dominant?: string;   // dominant color hex, for theming
  bytes: number;
  dataUrl: string;     // base64 data URL for embedding
  name: string;
}