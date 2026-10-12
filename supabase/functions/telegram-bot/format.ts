// Turns Claude's answer into Telegram messages: text/figure segments, bold styling, and length limits.

import type { MessageEntity } from "./telegram.ts";

// Telegram rejects messages longer than 4096 characters and captions longer than 1024; leave headroom.
export const MAX_CHUNK = 4000;
export const MAX_CAPTION = 1000;

/** Placeholder Claude writes where a generated figure belongs, e.g. [[RASM:grafik.png]]. */
const FIGURE_MARKER = /\[\[RASM:\s*([^\]\s]+)\s*\]\]/g;

export type Segment = { kind: "text"; text: string } | { kind: "figure"; name: string };

export interface Formatted {
  text: string;
  entities: MessageEntity[];
}

/** Splits an answer into text and figure segments, in order. Empty text segments are dropped. */
export function parseSegments(answer: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of answer.matchAll(FIGURE_MARKER)) {
    const text = answer.slice(last, m.index).trim();
    if (text) segments.push({ kind: "text", text });
    segments.push({ kind: "figure", name: m[1] });
    last = m.index! + m[0].length;
  }
  const tail = answer.slice(last).trim();
  if (tail) segments.push({ kind: "text", text: tail });
  return segments;
}

/** The answer as plain text for conversation history, with figure markers made readable. */
export function answerForHistory(answer: string): string {
  return answer.replace(FIGURE_MARKER, "(rasm: $1)");
}

/**
 * Converts `**bold**` spans to bold entities (removing the asterisks) and bolds the final
 * "Javob:" line, so formatting never depends on escaping user-visible text.
 */
export function formatText(raw: string): Formatted {
  let text = "";
  const entities: MessageEntity[] = [];
  let last = 0;
  for (const m of raw.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    text += raw.slice(last, m.index);
    entities.push({ type: "bold", offset: text.length, length: m[1].length });
    text += m[1];
    last = m.index! + m[0].length;
  }
  text += raw.slice(last);

  for (const m of text.matchAll(/^Javob:.*$/gm)) {
    const overlaps = entities.some((e) =>
      e.offset < m.index! + m[0].length && m.index! < e.offset + e.length
    );
    if (!overlaps) entities.push({ type: "bold", offset: m.index!, length: m[0].length });
  }
  entities.sort((a, b) => a.offset - b.offset);
  return { text, entities };
}

/** Splits formatted text into chunks of at most `max` chars, preferring paragraph, line, then word breaks. */
export function splitFormatted(f: Formatted, max = MAX_CHUNK): Formatted[] {
  const chunks: Formatted[] = [];
  const { text } = f;
  let start = skipSpace(text, 0);

  while (start < text.length) {
    let end: number;
    if (text.length - start <= max) {
      end = text.length;
    } else {
      const window = text.slice(start, start + max);
      let cut = window.lastIndexOf("\n\n");
      if (cut < max / 2) cut = window.lastIndexOf("\n");
      if (cut < max / 2) cut = window.lastIndexOf(" ");
      if (cut <= 0) cut = max;
      end = start + cut;
    }
    const trimmedEnd = start + text.slice(start, end).trimEnd().length;
    chunks.push({
      text: text.slice(start, trimmedEnd),
      entities: clipEntities(f.entities, start, trimmedEnd),
    });
    start = skipSpace(text, end);
  }
  return chunks;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Entities restricted to [start, end) and re-based to start at 0. */
function clipEntities(entities: MessageEntity[], start: number, end: number): MessageEntity[] {
  return entities.flatMap((e) => {
    const s = Math.max(e.offset, start);
    const t = Math.min(e.offset + e.length, end);
    return t > s ? [{ ...e, offset: s - start, length: t - s }] : [];
  });
}

/**
 * Plain-text version of a solution sheet (the JSON Claude rendered), kept as the answer's text so
 * follow-up questions can refer to what the image showed. Formulas stay in LaTeX.
 */
export function sheetTranscript(sheet: unknown): string {
  if (!sheet || typeof sheet !== "object") return "";
  const s = sheet as Record<string, unknown>;
  const part = (p: unknown) =>
    p && typeof p === "object" && "math" in p ? `$$${(p as { math: unknown }).math}$$` : String(p);
  const parts = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(part).join("\n");

  const lines: string[] = [];
  if (s.topic) lines.push(`Mavzu: ${s.topic}`);
  if (s.question) lines.push(`Savol: ${parts(s.question)}`);
  if (s.options && typeof s.options === "object") {
    lines.push("Variantlar: " + Object.entries(s.options).map(([k, v]) => `${k}) ${v}`).join("  "));
  }
  const steps = Array.isArray(s.steps) ? s.steps : [];
  steps.forEach((step, i) => {
    const st = (step ?? {}) as Record<string, unknown>;
    lines.push(`${i + 1}. ${st.title ?? ""}\n${parts(st.body)}`);
  });
  const ans = (s.answer ?? {}) as Record<string, unknown>;
  if (ans.option) lines.push(`Javob: ${ans.option}`);
  else if (Array.isArray(ans.parts)) {
    lines.push("Javob: " + ans.parts.map((p) => `${p?.label ?? ""} ${p?.value ?? ""}`.trim()).join("; "));
  } else if (ans.value) lines.push(`Javob: ${ans.value}`);
  return lines.join("\n");
}
