import { describe, expect, it } from "vitest";

import { createGfmPreset } from "../../preset-gfm/src/index";
import { createEditor } from "../src/index";

describe("live preview", () => {
  // ── Inline formatting ──

  it("hides markers and shows styled text for inline formatting", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text **bold** *italic* `code` [link](https://example.com)",
      livePreview: true
    });

    const text = container.textContent ?? "";
    expect(text).toContain("bold");
    expect(text).toContain("italic");
    expect(text).toContain("code");
    expect(text).toContain("link");
    // Markers hidden
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");
    editor.destroy();
  });

  it("restores raw markdown when cursor enters an inline range", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text **bold**",
      livePreview: true
    });

    expect(container.textContent).not.toContain("**");

    editor.setSelection(8);

    expect(container.textContent).toContain("**bold**");
    editor.destroy();
  });

  it("hides strikethrough markers when GFM is enabled", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text ~~deleted~~",
      livePreview: true,
      plugins: [createGfmPreset()]
    });

    const text = container.textContent ?? "";
    expect(text).toContain("deleted");
    expect(text).not.toContain("~~");
    editor.destroy();
  });

  it("re-renders inline formatting after document updates", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text **bold**",
      livePreview: true
    });

    editor.setDocument("Text **changed**");

    const text = container.textContent ?? "";
    expect(text).toContain("changed");
    expect(text).not.toContain("**");
    editor.destroy();
  });

  // ── Headings ──

  it("renders headings with bold text and heading level attribute", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Intro\n\n# Heading",
      livePreview: true
    });

    expect(container.querySelector("[data-heading-level='1']")?.textContent).toBe("Heading");
    editor.destroy();
  });

  // ── Block elements ──

  it("renders blockquotes and images as block previews", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Intro\n\n> Quote\n\n![Alt](https://example.com/image.png)",
      livePreview: true
    });

    expect(container.querySelector("blockquote")?.textContent).toBe("Quote");
    expect(container.querySelector("[data-live-preview-image]")?.getAttribute("data-live-preview-image")).toBe(
      "https://example.com/image.png"
    );
    editor.destroy();
  });

  it("renders thematic break as hr element", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text\n\n---\n\nMore",
      livePreview: true
    });

    expect(container.querySelector("hr")).not.toBeNull();
    editor.destroy();
  });

  // ── Code blocks ──

  it("renders code blocks with syntax highlighting and language label", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text\n\n```js\nconsole.log(1)\n```",
      livePreview: true
    });

    expect(container.textContent).toContain("console.log(1)");
    expect(container.textContent).toContain("Js");
    editor.destroy();
  });

  it("shows fence lines when cursor enters code block", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text\n\n```js\nconsole.log(1)\n```",
      livePreview: true
    });

    // View mode: fences hidden
    const textBefore = container.textContent ?? "";
    expect(textBefore).toContain("console.log(1)");

    // Move cursor into code block content
    editor.setSelection(12);

    // Edit mode: fences visible
    const textAfter = container.textContent ?? "";
    expect(textAfter).toContain("```js");
    expect(textAfter).toContain("console.log(1)");
    editor.destroy();
  });

  it("applies code block background to all content lines", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text\n\n```py\nx = 1\ny = 2\n```",
      livePreview: true
    });

    // All code content lines should have background styling via line decorations
    const codeLines = Array.from(container.querySelectorAll(".cm-line")).filter(
      (line) => (line as HTMLElement).style.background === "rgb(246, 248, 250)"
        || (line as HTMLElement).getAttribute("style")?.includes("background")
    );
    expect(codeLines.length).toBeGreaterThanOrEqual(2);
    editor.destroy();
  });

  // ── Tables ──

  it("renders tables as editable widget with grip cells", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
      livePreview: true,
      plugins: [createGfmPreset()]
    });

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const ths = table?.querySelectorAll("th");
    expect(ths!.length).toBeGreaterThanOrEqual(3);
    // First th is row grip, second is content cell "A"
    expect(ths![1]?.textContent).toBe("A");
    expect(ths![1]?.classList.contains("nexus-cell")).toBe(true);
    editor.destroy();
  });

  // ── Custom renderers ──

  it("allows host renderers to override default node rendering", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Intro\n\n# Heading",
      livePreview: {
        renderers: {
          heading({ text }) {
            const element = document.createElement("div");
            element.setAttribute("data-heading", "custom");
            element.textContent = text.toUpperCase();
            return element;
          }
        }
      }
    });

    expect(container.querySelector("[data-heading='custom']")?.textContent).toBe("HEADING");
    editor.destroy();
  });

  it("passes the raw markdown source into custom renderers", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text **bold**",
      livePreview: {
        renderers: {
          strong({ source }) {
            const element = document.createElement("span");
            element.setAttribute("data-source", source);
            return element;
          }
        }
      }
    });

    expect(container.querySelector("[data-source]")?.getAttribute("data-source")).toBe("**bold**");
    editor.destroy();
  });

  it("uses default mark decoration for node types without custom renderer", () => {
    const container = document.createElement("div");
    const editor = createEditor({
      container,
      initialValue: "Text **bold** *italic*",
      livePreview: {
        renderers: {
          strong({ text }) {
            const element = document.createElement("span");
            element.textContent = text.toUpperCase();
            return element;
          }
        }
      }
    });

    // Custom renderer for strong
    expect(container.querySelector("span")?.textContent).toBe("BOLD");
    // Default mark decoration for italic
    const text = container.textContent ?? "";
    expect(text).toContain("italic");
    expect(text).not.toContain("*italic*");
    editor.destroy();
  });
});
