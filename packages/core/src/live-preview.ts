import { type Extension, type Range, type SelectionRange } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { Heading, Root } from "mdast";

import { collectLivePreviewRanges, selectionIntersects } from "./live-preview-ranges";
import { renderLivePreviewNode } from "./live-preview-renderers";
import type {
  LivePreviewConfig,
  LivePreviewNodeType,
  LivePreviewRenderer,
  ParserLike
} from "./types";

interface NormalizedLivePreviewConfig {
  enabled: boolean;
  renderers: Partial<Record<LivePreviewNodeType, LivePreviewRenderer>>;
}

function createEmptyAst(): Root {
  return {
    type: "root",
    children: []
  };
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
    return {
      enabled: false,
      renderers: {}
    };
  }

  if (config === true) {
    return {
      enabled: true,
      renderers: {}
    };
  }

  return {
    enabled: config.enabled ?? true,
    renderers: config.renderers ?? {}
  };
}

function createWidget(element: HTMLElement): WidgetType {
  return new (class extends WidgetType {
    toDOM() {
      return element;
    }

    ignoreEvent() {
      return false;
    }
  })();
}

const HEADING_FONT_SIZE: Record<number, string> = {
  1: "1.6em",
  2: "1.4em",
  3: "1.2em",
  4: "1.1em",
  5: "1.05em",
  6: "1em"
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
      // Cursor on heading: show # prefix dimmed, same size as heading text
      decos.push(
        Decoration.mark({
          attributes: { style: `font-weight: bold; font-size: ${fontSize}; color: #aaa` }
        }).range(range.from, textStart)
      );
    } else {
      // Cursor away: hide # prefix
      decos.push(Decoration.replace({}).range(range.from, textStart));
    }

    // Text is always bold + sized regardless of cursor position
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

function buildDecorations(
  view: EditorView,
  parser: ParserLike,
  config: NormalizedLivePreviewConfig
): DecorationSet {
  if (!config.enabled) {
    return Decoration.none;
  }

  const doc = view.state.doc.toString();
  const ast = parseDocument(parser, doc);
  const ranges = collectLivePreviewRanges(ast, doc, view.state.selection.ranges);
  const decos: Range<Decoration>[] = [];

  const headingSpans: [number, number][] = [];

  for (const range of ranges) {
    // When a heading uses widget-replace (custom renderer), skip child ranges inside it
    if (headingSpans.some(([from, to]) => range.from >= from && range.to <= to)) {
      continue;
    }

    if (range.node.type === "heading" && !config.renderers.heading) {
      buildHeadingDecorations(
        range as { from: number; to: number; node: Heading },
        view.state.selection.ranges,
        decos
      );
    } else {
      if (range.node.type === "heading") {
        headingSpans.push([range.from, range.to]);
      }
      decos.push(
        Decoration.replace({
          widget: createWidget(renderLivePreviewNode(range.node, range.source, config.renderers))
        }).range(range.from, range.to)
      );
    }
  }

  return Decoration.set(decos, true);
}

export function createLivePreviewExtension(
  parser: ParserLike,
  config: boolean | LivePreviewConfig | undefined
): Extension[] {
  const normalized = normalizeConfig(config);

  if (!normalized.enabled) {
    return [];
  }

  const plugin = ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, parser, normalized);
      }

      update(update: { docChanged: boolean; selectionSet: boolean; view: EditorView }) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, parser, normalized);
        }
      }
    },
    {
      decorations: (value) => value.decorations
    }
  );

  return [plugin];
}
