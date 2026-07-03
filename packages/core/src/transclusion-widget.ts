/**
 * TransclusionWidget — renders embedded `![[file#block-id]]` content as a
 * CodeMirror 6 block WidgetType (integrated into the live-preview pipeline).
 *
 * ## Features
 * - Async content resolution via host-provided `resolve` callback.
 * - Breadcrumb header: "→ source-file.md" with the block label.
 * - Loading / error / unresolved / empty states.
 * - Click-to-edit: clicking the breadcrumb navigates the cursor into the
 *   source `![[ ]]` text so the user can edit the reference.
 * - Recursion guard: a static Set<string> of active resolutions prevents
 *   infinite loops (A → B → C → A). Cycles show a warning placeholder.
 */

import { WidgetType } from "@codemirror/view";
import type { TransclusionResolver } from "./types";

/** Cache resolved content keyed by "file::blockId". */
const resolutionCache = new Map<string, string | null>();

/** Active in-flight resolutions to prevent recursion. */
const activeResolutions = new Set<string>();

/** In-flight promises keyed by cache key. */
const pendingResolutions = new Map<string, Promise<string | null>>();

function cacheKey(file: string, blockId?: string): string {
  return blockId ? `${file}::${blockId}` : file;
}

/** Clear the entire transclusion cache (call when vault content changes). */
export function clearTransclusionCache(): void {
  resolutionCache.clear();
  pendingResolutions.clear();
}

/** Invalidate cached content for a specific file. */
export function invalidateFileCache(file: string): void {
  const prefix = `${file}::`;
  for (const key of resolutionCache.keys()) {
    if (key === file || key.startsWith(prefix)) resolutionCache.delete(key);
  }
  for (const key of pendingResolutions.keys()) {
    if (key === file || key.startsWith(prefix)) pendingResolutions.delete(key);
  }
}

/**
 * Resolve transclusion content through the host callback with caching and
 * recursion protection. Returns null when unresolved or in a cycle.
 */
export async function resolveContent(
  resolve: TransclusionResolver,
  file: string,
  blockId: string | undefined,
  sourcePath?: string,
): Promise<string | null> {
  const key = cacheKey(file, blockId);

  // Return cached result immediately.
  if (resolutionCache.has(key)) {
    return resolutionCache.get(key) ?? null;
  }

  // Return in-flight promise without starting a new one.
  if (pendingResolutions.has(key)) {
    return pendingResolutions.get(key)!;
  }

  // Recursion / self-reference guard.
  if (activeResolutions.has(key)) {
    return null; // cycle detected
  }

  activeResolutions.add(key);

  const promise = (async () => {
    try {
      const result = await Promise.resolve(resolve(file, blockId, sourcePath));
      resolutionCache.set(key, result ?? null);
      return result ?? null;
    } catch {
      resolutionCache.set(key, null);
      return null;
    } finally {
      activeResolutions.delete(key);
      pendingResolutions.delete(key);
    }
  })();

  pendingResolutions.set(key, promise);
  return promise;
}

// ── Widget ─────────────────────────────────────────────────────────────────

const TRANSCLUSION_BORDER = "var(--nexus-accent, #8250df)";
const TRANSCLUSION_BG = "var(--nexus-bg-subtle, rgba(130,80,223,0.05))";
const BREADCRUMB_COLOR = "var(--nexus-text-muted, #666)";

/**
 * Build a simple HTML rendering of markdown text as a DOM tree suitable for
 * a transclusion widget. This is deliberately minimal — no full Markdown
 * parser — because transclusion content is meant to be read inline, not be
 * an interactive Markdown surface itself. Hosts can override with their own
 * markdown-to-HTML pipeline if they need richer rendering.
 */
function markdownToTransclusionHtml(md: string): string {
  if (!md || md.trim().length === 0) return "";

  let html = md;

  // Headings
  html = html.replace(/^#{1,6}\s+(.+)$/gm, (_m, text) =>
    `<div style="font-weight:700;font-size:1.05em;margin:4px 0 2px;">${escapeHtml(text)}</div>`);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, "<em>$1</em>");
  // Inline code
  html = html.replace(/`([^`]+)`/g,
    '<code style="font-family:monospace;background:var(--nexus-bg-muted,#e8e8e8);padding:1px 3px;border-radius:2px;">$1</code>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" style="color:var(--nexus-accent)" rel="noopener noreferrer">$1</a>');

  // Paragraphs: wrap non-heading, non-empty lines in <div>
  const lines = html.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      result.push('<div style="height:4px;"></div>');
    } else if (line.startsWith("<div style=\"font-weight:700")) {
      result.push(line);
    } else {
      result.push(`<div>${line}</div>`);
    }
  }
  return result.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class TransclusionWidget extends WidgetType {
  constructor(
    private readonly file: string,
    private readonly blockId: string | undefined,
    private readonly display: string,
    private readonly sourceFrom: number,
    private readonly resolve: TransclusionResolver | undefined,
    private readonly viewRef: { current: import("@codemirror/view").EditorView | null },
    private readonly sourcePath?: string,
  ) {
    super();
  }

  eq(other: TransclusionWidget): boolean {
    return (
      other.file === this.file &&
      other.blockId === this.blockId &&
      other.display === this.display &&
      other.sourceFrom === this.sourceFrom
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  get estimatedHeight(): number {
    return 64;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "nexus-transclusion";
    container.style.cssText = [
      "display:block",
      "position:relative",
      "margin:4px 0",
      "padding:0",
      "border:1px solid",
      "border-color:" + TRANSCLUSION_BORDER,
      "background:" + TRANSCLUSION_BG,
      "border-radius:6px",
      "overflow:hidden",
      "font-size:0.92em",
    ].join(";") + ";";

    // Breadcrumb header
    const breadcrumb = document.createElement("div");
    breadcrumb.className = "nexus-transclusion-breadcrumb";
    const label = this.blockId
      ? `${this.file} > ${this.blockId}`
      : this.file;
    breadcrumb.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:4px",
      "padding:4px 10px",
      "font-size:0.8em",
      "color:" + BREADCRUMB_COLOR,
      "border-bottom:1px solid",
      "border-color:var(--nexus-border-subtle, rgba(0,0,0,0.06))",
      "cursor:pointer",
      "user-select:none",
    ].join(";") + ";";
    breadcrumb.textContent = `→ ${label}`;
    breadcrumb.title = "Click to edit reference";
    breadcrumb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = this.viewRef.current;
      if (!v) return;
      const safeFrom = Math.min(this.sourceFrom, v.state.doc.length);
      v.dispatch({ selection: { anchor: safeFrom } });
      v.focus();
    });
    container.appendChild(breadcrumb);

    // Content body
    const body = document.createElement("div");
    body.className = "nexus-transclusion-body";
    body.style.cssText = [
      "padding:6px 10px",
      "color:var(--nexus-text)",
      "line-height:1.5",
      "min-height:24px",
      "max-height:320px",
      "overflow-y:auto",
    ].join(";") + ";";
    body.textContent = "Loading…";
    body.style.color = BREADCRUMB_COLOR;
    container.appendChild(body);

    // Async resolve
    if (this.resolve) {
      const sourceKey = this.sourcePath ?? "";
      resolveContent(this.resolve, this.file, this.blockId, sourceKey).then((content) => {
        if (!container.isConnected) return;

        if (content === null) {
          this.renderUnresolved(body, breadcrumb);
          return;
        }

        if (content.trim().length === 0) {
          this.renderEmpty(body);
          return;
        }

        body.style.color = "";
        body.style.fontSize = "";
        body.style.padding = "";
        body.textContent = "";
        body.innerHTML = markdownToTransclusionHtml(content);
      }).catch(() => {
        if (!container.isConnected) return;
        this.renderError(body, "Resolution failed");
      });
    } else {
      this.renderUnresolved(body, breadcrumb);
    }

    return container;
  }

  private renderUnresolved(body: HTMLElement, breadcrumb: HTMLElement): void {
    breadcrumb.style.color = "var(--nexus-hl-deletion, #c0392b)";
    body.textContent = "⚠ Unresolved reference — no resolver configured or file not found.";
    body.style.color = "var(--nexus-text-muted)";
    body.style.fontSize = "0.85em";
    body.style.padding = "8px 10px";
  }

  private renderEmpty(body: HTMLElement): void {
    body.textContent = "(empty block)";
    body.style.color = "var(--nexus-text-faint)";
    body.style.fontSize = "0.85em";
    body.style.padding = "8px 10px";
  }

  private renderError(body: HTMLElement, message: string): void {
    body.textContent = `⚠ ${message}`;
    body.style.color = "var(--nexus-hl-deletion, #c0392b)";
    body.style.fontSize = "0.85em";
    body.style.padding = "8px 10px";
  }
}
