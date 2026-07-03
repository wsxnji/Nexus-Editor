/**
 * Block ID extraction utilities for block references and transclusion.
 *
 * ## Automatic IDs (heading slugs)
 * Each heading (`## Design Goals`) auto-generates a slug via the same
 * algorithm Obsidian uses: lowercase, non-alphanumeric removed, spaces → `-`,
 * consecutive `-` collapsed, leading/trailing `-` stripped.
 *
 * ## Explicit IDs (`^{block-id}`)
 * Any block-level line can end with `^{id}` to assign a stable, manually
 * chosen identifier. Explicit IDs always win over slugs when both exist.
 *
 *   ## Design Goals ^{core-design}
 *   → block ID = "core-design", heading text = "Design Goals"
 */

export interface BlockEntry {
  /** Stable block identifier (heading slug or explicit `^{id}`). */
  id: string;
  /** Human-readable label (heading text sans markers and id suffix). */
  label: string;
  /** Offset where the labeled block starts in the document. */
  from: number;
  /** Offset where the labeled block content begins (first non-marker char). */
  contentFrom: number;
  /** Offset where this block ends (next sibling heading or EOF). */
  to: number;
  /** Type of block: "heading" or "paragraph". */
  type: "heading" | "paragraph";
  /** Heading level (1-6), only for heading blocks. */
  level?: number;
}

/** Block whose content has been resolved for transclusion rendering. */
export interface ResolvedBlock {
  /** The label shown in the breadcrumb. */
  label: string;
  /** The Markdown source of the resolved block. */
  markdown: string;
}

/** Registry: collected blocks in a document, keyed by block ID. */
export type BlockRegistry = ReadonlyMap<string, BlockEntry>;

/**
 * Compute the slug of a heading text using Obsidian's algorithm.
 *
 *   "Design Goals"       → "design-goals"
 *   "Hello, World!"      → "hello-world"
 *   "  Spaces  "         → "spaces"
 *   "Café 🍕 nom-nom"    → "cafe-nom-nom"
 *   "a--b--c"            → "a-b-c"
 *   "---"                → ""  (invalid block ID → filter upstream)
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse a heading/paragraph line to extract an optional explicit `^{id}`
 * suffix and the remaining label text.
 *
 *   "## Design Goals ^{core-design}" → { label: "Design Goals", explicitId: "core-design" }
 *   "Some paragraph ^{para-1}"       → { label: "Some paragraph", explicitId: "para-1" }
 *   "## No ID"                       → { label: "No ID", explicitId: null }
 *   "Text with ^{escaped} chars"      → { label: "Text with \^{escaped} chars", explicitId: null }
 */
export function parseBlockAnnotation(line: string): {
  label: string;
  explicitId: string | null;
} {
  // Only the LAST `^{...}` at end-of-line counts as an ID annotation.
  // Escaped `\^{...}` is literal text.
  const match = /^(.*?)(?<!\\)\s*\^\{([a-zA-Z0-9_-]+)\}\s*$/.exec(line);
  if (!match) return { label: line, explicitId: null };
  return { label: match[1], explicitId: match[2] };
}

/** True when `id` is a valid block identifier (non-empty, alphanumeric + `_-`). */
function isValidBlockId(id: string): boolean {
  return id.length > 0 && /^[a-zA-Z0-9_-]+$/.test(id);
}

const HEADING_LINE_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Scan a Markdown document and return a BlockRegistry mapping every block ID
 * to its entry. ID conflicts: first-definition wins (ordered by `from`).
 *
 * Blocks are:
 *   - Any heading line (auto-slug + optional explicit `^{id}`).
 *   - Any non-blank, non-heading line that ends with `^{id}` (paragraph anchor).
 *
 * Each block spans from its start to:
 *   - The next heading of equal-or-lower depth (for heading blocks), or
 *   - The next block-annotated paragraph, or
 *   - End of document.
 */
export function scanBlockIds(doc: string): BlockRegistry {
  const map = new Map<string, BlockEntry>();
  const lines = doc.split("\n");

  // Phase 1: collect potential block anchors
  const anchors: Array<{
    index: number;
    from: number;
    label: string;
    id: string;
    type: "heading" | "paragraph";
    level?: number;
  }> = [];

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = HEADING_LINE_RE.exec(line);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const { label, explicitId } = parseBlockAnnotation(headingMatch[2]);
      // headingTextOffset: character offset where the heading text begins
      const headingTextOffset = offset + line.indexOf(headingMatch[2]);
      const slug = headingSlug(label);
      const id = explicitId ?? slug;
      if (isValidBlockId(id)) {
        anchors.push({ index: i, from: offset, label, id, type: "heading", level: depth });
      }
    } else {
      const { label, explicitId } = parseBlockAnnotation(line);
      if (explicitId && isValidBlockId(explicitId) && label.trim().length > 0) {
        anchors.push({ index: i, from: offset, label: label.trim(), id: explicitId, type: "paragraph" });
      }
    }
    offset += line.length + 1;
  }

  // Phase 2: compute end positions and populate registry
  for (let ai = 0; ai < anchors.length; ai++) {
    const anchor = anchors[ai];
    const line = lines[anchor.index];
    const contentFrom =
      anchor.type === "heading"
        ? anchor.from + line.indexOf(anchor.label)
        : anchor.from + (line.length - line.trimStart().length);
    const markerLen = anchor.type === "heading" ? (anchor.level ?? 1) + 1 : 0;

    // Determine end: for paragraph blocks, just the annotated line.
    // For heading blocks, everything until the next heading of equal-or-lower level.
    let to = doc.length;
    if (anchor.type === "paragraph") {
      to = anchor.from + lines[anchor.index].length;
    } else {
      for (let aj = ai + 1; aj < anchors.length; aj++) {
        const next = anchors[aj];
        if (next.type === "heading" && (next.level ?? 7) <= (anchor.level ?? 1)) {
          to = next.from;
          break;
        }
      }
    }

    if (!map.has(anchor.id)) {
      map.set(anchor.id, {
        id: anchor.id,
        label: anchor.label,
        from: anchor.from,
        contentFrom,
        to,
        type: anchor.type,
        level: anchor.level,
      } satisfies BlockEntry);
    }
  }

  return map;
}

/**
 * Resolve a block's Markdown content given its registry entry and the full
 * document source. Strips the heading/annotation markers and returns just the
 * body content (suitable for rendering).
 */
export function resolveBlockContent(entry: BlockEntry, doc: string): string {
  const content = doc.slice(entry.contentFrom, entry.to);
  // For paragraph blocks, the content includes the annotation line; strip `^{id}`.
  if (entry.type === "paragraph") {
    return content.replace(/\s*\^\{[a-zA-Z0-9_-]+}\s*$/, "").trim();
  }
  return content;
}
