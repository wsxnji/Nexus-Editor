import { StateField, type Extension, type Range, type SelectionRange, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import hljs from "highlight.js";
import type { Code, Heading, List, Root, Table } from "mdast";

import { collectLivePreviewRanges, selectionIntersects } from "./live-preview-ranges";
import { renderLivePreviewNode } from "./live-preview-renderers";
import { EditableTableWidget, isTableEditing } from "./live-preview-table";
import type {
  LivePreviewConfig,
  LivePreviewLabels,
  LivePreviewNodeType,
  LivePreviewRenderer,
  ParserLike
} from "./types";

interface NormalizedLivePreviewConfig {
  enabled: boolean;
  renderers: Partial<Record<LivePreviewNodeType, LivePreviewRenderer>>;
  labels: Required<LivePreviewLabels>;
}

const DEFAULT_LABELS: Required<LivePreviewLabels> = {
  addColumn: "Add column",
  addRow: "Add row",
};

function createEmptyAst(): Root {
  return { type: "root", children: [] };
}

function parseDocument(parser: ParserLike, markdown: string): Root {
  try {
    return parser.parse(markdown);
  } catch {
    return createEmptyAst();
  }
}

function normalizeConfig(
  config: boolean | LivePreviewConfig | undefined
): NormalizedLivePreviewConfig {
  if (!config) {
    return { enabled: false, renderers: {}, labels: DEFAULT_LABELS };
  }
  if (config === true) {
    return { enabled: true, renderers: {}, labels: DEFAULT_LABELS };
  }
  return {
    enabled: config.enabled ?? true,
    renderers: config.renderers ?? {},
    labels: { ...DEFAULT_LABELS, ...config.labels }
  };
}

function createWidget(element: HTMLElement, swallowEvents = false): WidgetType {
  return new (class extends WidgetType {
    toDOM() { return element; }
    ignoreEvent() { return swallowEvents; }
  })();
}

const BLOCK_NODE_TYPES = new Set(["blockquote", "thematicBreak"]);

const HEADING_FONT_SIZE: Record<number, string> = {
  1: "1.6em", 2: "1.4em", 3: "1.2em", 4: "1.1em", 5: "1.05em", 6: "1em"
};

function buildHeadingDecorations(
  range: { from: number; to: number; node: Heading },
  selection: readonly SelectionRange[],
  decos: Range<Decoration>[]
): void {
  const firstChild = range.node.children[0];
  const textStart = firstChild?.position?.start?.offset;

  if (typeof textStart === "number" && textStart > range.from && textStart <= range.to) {
    const fontSize = HEADING_FONT_SIZE[range.node.depth] ?? "1em";
    const cursorOnHeading = selectionIntersects(range.from, range.to, selection);

    if (cursorOnHeading) {
      decos.push(
        Decoration.mark({
          attributes: { style: `font-weight: bold; font-size: ${fontSize}; color: #aaa` }
        }).range(range.from, textStart)
      );
    } else {
      decos.push(Decoration.replace({}).range(range.from, textStart));
    }

    decos.push(
      Decoration.mark({
        attributes: {
          style: `font-weight: bold; font-size: ${fontSize}`,
          "data-heading-level": String(range.node.depth)
        }
      }).range(textStart, range.to)
    );
  }
}

const LIST_MARKER_RE = /^(\s*)([-*+]|\d+[.)]) /;
const CHECKBOX_RE = /^\[([ xX])\] /;

function buildListDecorations(
  range: { from: number; to: number; node: List },
  doc: string,
  decos: Range<Decoration>[],
  viewRef: { current: EditorView | null }
): void {
  const source = doc.slice(range.from, range.to);
  const lines = source.split("\n");
  let offset = range.from;
  const isOrdered = range.node.ordered === true;
  let orderNum = range.node.start ?? 1;

  for (const line of lines) {
    const lineEnd = offset + line.length;
    const markerMatch = LIST_MARKER_RE.exec(line);

    if (markerMatch) {
      const indent = markerMatch[1];
      const markerStart = offset + indent.length;
      const markerEnd = offset + markerMatch[0].length;

      const bullet = document.createElement("span");
      if (isOrdered) {
        bullet.textContent = `${orderNum}. `;
        bullet.style.color = "#888";
        orderNum++;
      } else {
        bullet.textContent = "\u2022 ";
        bullet.style.color = "#888";
      }
      decos.push(
        Decoration.replace({ widget: createWidget(bullet) }).range(markerStart, markerEnd)
      );

      const afterMarker = line.slice(markerMatch[0].length);
      const checkMatch = CHECKBOX_RE.exec(afterMarker);
      if (checkMatch) {
        const checkStart = markerEnd;
        const checkEnd = markerEnd + checkMatch[0].length;
        const isChecked = checkMatch[1] !== " ";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = isChecked;
        checkbox.style.marginRight = "4px";
        checkbox.style.verticalAlign = "middle";
        checkbox.style.cursor = "pointer";

        const toggleFrom = checkStart + 1;
        checkbox.addEventListener("click", (e) => {
          e.preventDefault();
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: toggleFrom, to: toggleFrom + 1, insert: isChecked ? " " : "x" }
          });
        });

        decos.push(
          Decoration.replace({ widget: createWidget(checkbox) }).range(checkStart, checkEnd)
        );

        if (isChecked && checkEnd < lineEnd) {
          decos.push(
            Decoration.mark({
              attributes: { style: "text-decoration: line-through; color: #999" }
            }).range(checkEnd, lineEnd)
          );
        }
      }
    }

    offset = lineEnd + 1;
  }
}

// Token-to-color map (GitHub-light theme)
const HLJS_COLORS: Record<string, string> = {
  keyword: "#d73a49", "selector-tag": "#d73a49", "built_in": "#d73a49", name: "#d73a49", doctag: "#d73a49",
  string: "#032f62", attr: "#032f62", symbol: "#032f62", bullet: "#032f62", addition: "#032f62", regexp: "#032f62", link: "#032f62",
  title: "#6f42c1", section: "#6f42c1", "title.function_": "#6f42c1",
  comment: "#6a737d", quote: "#6a737d", meta: "#6a737d",
  number: "#005cc5", literal: "#005cc5",
  type: "#e36209", params: "#e36209",
  deletion: "#b31d28",
  variable: "#24292e", "template-variable": "#24292e",
};

function getTokenColor(scope: string): string | null {
  if (HLJS_COLORS[scope]) return HLJS_COLORS[scope];
  // Try prefix match (e.g., "title.function_" → "title")
  const dot = scope.indexOf(".");
  if (dot > 0) return HLJS_COLORS[scope.slice(0, dot)] ?? null;
  return null;
}

function buildCodeBlockDecorations(
  range: { from: number; to: number; node: Code; source: string },
  selection: readonly SelectionRange[],
  decos: Range<Decoration>[]
): void {
  const source = range.source;
  const lines = source.split("\n");
  const cursorOnCode = selectionIntersects(range.from, range.to, selection);
  const firstNewline = source.indexOf("\n");
  const lastNewline = source.lastIndexOf("\n");

  if (cursorOnCode) {
    // ── Editing mode: fences visible, syntax highlighted ──
    let lineOffset = range.from;
    for (let li = 0; li < lines.length; li++) {
      const lineStart = lineOffset;
      const isFirstLine = li === 0;
      const isLastLine = li === lines.length - 1;

      decos.push(Decoration.line({
        attributes: {
          style: "background:#f6f8fa;font-family:monospace;font-size:0.9em;"
            + (isFirstLine ? "border-radius:4px 4px 0 0;" : "")
            + (isLastLine ? "border-radius:0 0 4px 4px;" : "")
        }
      }).range(lineStart));

      lineOffset += lines[li].length + 1;
    }
  } else {
    // ── View mode: fences hidden via CSS (not cross-newline replace), content styled ──
    const HIDE_LINE = "height:0;padding:0;margin:0;overflow:hidden;font-size:0;line-height:0;min-height:0;";

    let lineOffset = range.from;
    for (let li = 0; li < lines.length; li++) {
      const lineStart = lineOffset;
      const lineEnd = lineOffset + lines[li].length;
      const isFirstLine = li === 0;
      const isLastLine = li === lines.length - 1;

      if (isFirstLine || isLastLine) {
        // Hide fence lines via line CSS + replace text content
        decos.push(Decoration.line({ attributes: { style: HIDE_LINE } }).range(lineStart));
        if (lineEnd > lineStart) {
          decos.push(Decoration.replace({}).range(lineStart, lineEnd));
        }
      } else {
        const isFirstContent = li === 1;
        const isLastContent = li === lines.length - 2;
        decos.push(Decoration.line({
          attributes: {
            style: "background:#f6f8fa;font-family:monospace;font-size:0.9em;position:relative;"
              + (isFirstContent ? "border-radius:4px 4px 0 0;padding-top:6px;" : "")
              + (isLastContent ? "border-radius:0 0 4px 4px;padding-bottom:6px;" : "")
          }
        }).range(lineStart));
      }

      lineOffset = lineEnd + 1;
    }

    // Language label (right-aligned on first content line)
    if (range.node.lang && firstNewline >= 0) {
      const firstContentLineStart = range.from + firstNewline + 1;
      const labelEl = document.createElement("span");
      labelEl.textContent = range.node.lang.charAt(0).toUpperCase() + range.node.lang.slice(1);
      labelEl.style.cssText =
        "position:absolute;right:8px;top:6px;font-size:11px;color:#999;font-family:sans-serif;user-select:none;";
      decos.push(Decoration.widget({
        widget: new (class extends WidgetType {
          toDOM() { return labelEl; }
          ignoreEvent() { return true; }
        })(),
        side: -1
      }).range(firstContentLineStart));
    }
  }

  // Syntax highlighting — always applied
  if (range.node.value && firstNewline >= 0) {
    const lang = range.node.lang;
    let result: hljs.HighlightResult | null = null;
    try {
      if (lang && hljs.getLanguage(lang)) {
        result = hljs.highlight(range.node.value, { language: lang });
      } else if (lang) {
        result = hljs.highlightAuto(range.node.value);
      }
    } catch { /* ignore hljs errors */ }

    if (result) {
      const contentStart = range.from + firstNewline + 1;
      applyHljsTokens(result._emitter as any, contentStart, decos);
    }
  }
}

function applyHljsTokens(emitter: any, offset: number, decos: Range<Decoration>[]): void {
  if (!emitter || !emitter.rootNode) return;

  function walk(node: any, pos: number): number {
    if (typeof node === "string") {
      return pos + node.length;
    }
    if (node.children) {
      const color = node.scope ? getTokenColor(node.scope) : null;
      const start = pos;
      let cur = pos;
      for (const child of node.children) {
        cur = walk(child, cur);
      }
      if (color && cur > start) {
        decos.push(Decoration.mark({ attributes: { style: "color:" + color } }).range(offset + start, offset + cur));
      }
      return cur;
    }
    return pos;
  }

  let pos = 0;
  for (const child of emitter.rootNode.children) {
    pos = walk(child, pos);
  }
}

interface InlineMarkerStyle {
  openLen: number;
  closeLen: number;
  style: string;
  attrs?: Record<string, string>;
}

function getInlineMarkerStyle(nodeType: string, source: string): InlineMarkerStyle | null {
  switch (nodeType) {
    case "strong":
      return { openLen: 2, closeLen: 2, style: "font-weight:bold" };
    case "emphasis":
      return { openLen: 1, closeLen: 1, style: "font-style:italic" };
    case "delete":
      return { openLen: 2, closeLen: 2, style: "text-decoration:line-through" };
    case "inlineCode": {
      // Detect ` vs `` markers
      let ticks = 0;
      for (let i = 0; i < source.length && source[i] === "`"; i++) ticks++;
      return {
        openLen: ticks, closeLen: ticks,
        style: "font-family:monospace;font-size:0.9em;background:#f0f0f0;padding:1px 4px;border-radius:3px"
      };
    }
    case "link": {
      // [text](url) — hide [ and ](url)
      const bracketClose = source.indexOf("](");
      if (bracketClose < 0) return null;
      return {
        openLen: 1,                          // hide [
        closeLen: source.length - bracketClose - 1, // hide ](url)
        style: "color:#0969da;text-decoration:underline;cursor:pointer"
      };
    }
    default:
      return null;
  }
}

function buildDecorations(
  doc: string,
  selection: readonly SelectionRange[],
  parser: ParserLike,
  config: NormalizedLivePreviewConfig,
  viewRef: { current: EditorView | null }
): DecorationSet {
  if (!config.enabled) return Decoration.none;

  const ast = parseDocument(parser, doc);
  const ranges = collectLivePreviewRanges(ast, doc, selection);
  const decos: Range<Decoration>[] = [];
  const parentSpans: [number, number][] = [];

  for (const range of ranges) {
    if (parentSpans.some(([from, to]) => range.from >= from && range.to <= to)) continue;

    if (range.node.type === "heading" && !config.renderers.heading) {
      buildHeadingDecorations(range as { from: number; to: number; node: Heading }, selection, decos);
    } else if (range.node.type === "table" && !config.renderers.table) {
      decos.push(
        Decoration.replace({
          widget: new EditableTableWidget(
            range.node as Table, range.from, range.source, viewRef, config.labels
          ),
          block: true
        }).range(range.from, range.to)
      );
    } else if (range.node.type === "list") {
      buildListDecorations(range as { from: number; to: number; node: List }, doc, decos, viewRef);
    } else if (range.node.type === "code" && !config.renderers.code) {
      buildCodeBlockDecorations(range as { from: number; to: number; node: Code; source: string }, selection, decos);
    } else if (range.node.type === "image") {
      const cursorOnImage = selectionIntersects(range.from, range.to, selection);
      if (cursorOnImage) {
        decos.push(Decoration.mark({ attributes: { style: "color: #aaa" } }).range(range.from, range.to));
        const preview = document.createElement("span");
        const img = document.createElement("img");
        img.src = range.node.url;
        img.alt = range.node.alt ?? "";
        img.referrerPolicy = "no-referrer";
        img.style.display = "block";
        img.style.maxWidth = "100%";
        preview.appendChild(img);
        decos.push(Decoration.widget({ widget: createWidget(preview), side: 1 }).range(range.to));
      } else {
        decos.push(
          Decoration.replace({
            widget: createWidget(renderLivePreviewNode(range.node, range.source, config.renderers))
          }).range(range.from, range.to)
        );
      }
    } else {
      if (range.node.type === "heading" || range.node.type === "table" || range.node.type === "list") {
        parentSpans.push([range.from, range.to]);
      }

      // Inline formatting: hide markers, apply style as mark (keeps text as real CM6 content)
      const inlineStyle = getInlineMarkerStyle(range.node.type, range.source);
      if (inlineStyle && !config.renderers[range.node.type]) {
        const { openLen, closeLen, style, attrs } = inlineStyle;
        // Hide opening marker
        if (openLen > 0) {
          decos.push(Decoration.replace({}).range(range.from, range.from + openLen));
        }
        // Hide closing marker
        if (closeLen > 0) {
          decos.push(Decoration.replace({}).range(range.to - closeLen, range.to));
        }
        // Apply style to visible text
        const textFrom = range.from + openLen;
        const textTo = range.to - closeLen;
        if (textTo > textFrom) {
          decos.push(Decoration.mark({ attributes: { style, ...attrs } }).range(textFrom, textTo));
        }
      } else {
        const isBlock = BLOCK_NODE_TYPES.has(range.node.type);
        decos.push(
          Decoration.replace({
            widget: createWidget(renderLivePreviewNode(range.node, range.source, config.renderers), isBlock),
            block: isBlock
          }).range(range.from, range.to)
        );
      }
    }
  }

  return Decoration.set(decos, true);
}

export function createLivePreviewExtension(
  parser: ParserLike,
  config: boolean | LivePreviewConfig | undefined
): Extension[] {
  const normalized = normalizeConfig(config);
  if (!normalized.enabled) return [];

  const viewRef: { current: EditorView | null } = { current: null };

  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state.doc.toString(), state.selection.ranges, parser, normalized, viewRef);
    },
    update(decos: DecorationSet, tr: Transaction) {
      if (tr.docChanged && isTableEditing()) {
        return decos.map(tr.changes);
      }
      if (tr.docChanged || tr.selection) {
        return buildDecorations(tr.state.doc.toString(), tr.state.selection.ranges, parser, normalized, viewRef);
      }
      return decos;
    },
    provide(field) {
      return EditorView.decorations.from(field);
    }
  });

  const viewCapture = EditorView.updateListener.of((update) => {
    viewRef.current = update.view;
  });

  return [field, viewCapture];
}
