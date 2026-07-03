import { EditorSelection } from "@codemirror/state";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { lezerStringToMdast } from "../src/lezer-mdast-adapter";
import { collectLivePreviewRanges } from "../src/live-preview-ranges";

function parse(markdown: string): Root {
  return unified().use(remarkParse).parse(markdown) as Root;
}

describe("live preview ranges", () => {
  it("collects stable ranges for block and image previews", () => {
    const doc = "Intro\n\n# Heading\n\n> Quote\n\n![Alt](https://example.com/image.png)";
    const { ranges } = collectLivePreviewRanges(
      parse(doc),
      doc,
      [EditorSelection.cursor(0)]
    );

    expect(ranges.map((range) => range.node.type)).toEqual(["heading", "blockquote", "image"]);
    expect(ranges.at(-1)?.source).toBe("![Alt](https://example.com/image.png)");
  });

  it("always emits inline ranges regardless of cursor position", () => {
    const doc = "Text **bold** *italic*\n\nother line";
    // Inline ranges are always emitted; buildDecorations decides styling
    const { ranges: rangesSameLine } = collectLivePreviewRanges(
      parse(doc),
      doc,
      [EditorSelection.cursor(8)]
    );
    expect(rangesSameLine.map((r) => r.node.type)).toEqual(["strong", "emphasis"]);

    const { ranges: rangesDiffLine } = collectLivePreviewRanges(
      parse(doc),
      doc,
      [EditorSelection.cursor(doc.length)]
    );
    expect(rangesDiffLine.map((r) => r.node.type)).toEqual(["strong", "emphasis"]);
  });

  it("does not emit inline ranges inside table widgets", () => {
    const doc = [
      "| Source | Address |",
      "|---|---|",
      "| \u767e\u5ea6\u70ed\u641c | `https://top.baidu.com/board?tab=realtime` and [link](https://example.com) |",
      "",
      "## After",
    ].join("\n");

    const { ranges } = collectLivePreviewRanges(
      lezerStringToMdast(doc),
      doc,
      [EditorSelection.cursor(doc.length)]
    );

    expect(ranges.map((range) => range.node.type)).toEqual(["table", "heading"]);
  });

  it("collects transclusion matches", () => {
    const doc = [
      "Some text",
      "",
      "![[Data#schema]]",
      "",
      "More text",
      "",
      "![[Notes/Tech#design-goals|Design Goals]]",
    ].join("\n");

    const { transclusions } = collectLivePreviewRanges(
      lezerStringToMdast(doc),
      doc,
      [EditorSelection.cursor(0)]
    );

    expect(transclusions).toHaveLength(2);
    expect(transclusions[0].file).toBe("Data");
    expect(transclusions[0].blockId).toBe("schema");
    expect(transclusions[0].isTransclusion).toBe(true);

    expect(transclusions[1].file).toBe("Notes/Tech");
    expect(transclusions[1].blockId).toBe("design-goals");
    expect(transclusions[1].alias).toBe("Design Goals");
    expect(transclusions[1].display).toBe("Design Goals");
  });

  it("collects block reference links", () => {
    const doc = "See [[Data#schema]] for details and [[Other|alias]] for more.";

    const { blockRefs } = collectLivePreviewRanges(
      lezerStringToMdast(doc),
      doc,
      [EditorSelection.cursor(0)]
    );

    expect(blockRefs).toHaveLength(1);
    expect(blockRefs[0].file).toBe("Data");
    expect(blockRefs[0].blockId).toBe("schema");
    expect(blockRefs[0].isTransclusion).toBe(false);
  });
});
