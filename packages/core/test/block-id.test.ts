import { describe, expect, it } from "vitest";
import {
  headingSlug,
  parseBlockAnnotation,
  scanBlockIds,
  resolveBlockContent,
} from "../src/block-id";

describe("headingSlug", () => {
  it("generates lowercase hyphenated slugs", () => {
    expect(headingSlug("Design Goals")).toBe("design-goals");
  });

  it("removes special characters", () => {
    expect(headingSlug("Hello, World!")).toBe("hello-world");
  });

  it("handles leading/trailing spaces", () => {
    expect(headingSlug("  Spaces  ")).toBe("spaces");
  });

  it("handles unicode characters", () => {
    // \u00e9 (\u00e9) is a letter and is preserved; emoji (\ud83c\udf55) is removed
    expect(headingSlug("Caf\u00e9 \ud83c\udf55 nom-nom")).toBe("caf\u00e9-nom-nom");
  });

  it("collapses multiple hyphens", () => {
    expect(headingSlug("a--b--c")).toBe("a-b-c");
  });

  it("strips leading/trailing hyphens", () => {
    expect(headingSlug("---")).toBe("");
  });
});

describe("parseBlockAnnotation", () => {
  it("extracts explicit ^{id} from heading", () => {
    const result = parseBlockAnnotation("Design Goals ^{core-design}");
    expect(result.label).toBe("Design Goals");
    expect(result.explicitId).toBe("core-design");
  });

  it("returns null for lines without annotation", () => {
    const result = parseBlockAnnotation("Just Some Text");
    expect(result.label).toBe("Just Some Text");
    expect(result.explicitId).toBeNull();
  });

  it("does not match escaped \\^{ annotation", () => {
    const result = parseBlockAnnotation("Text with \\^{not-an-id} chars");
    expect(result.label).toBe("Text with \\^{not-an-id} chars");
    expect(result.explicitId).toBeNull();
  });

  it("extracts from paragraph lines", () => {
    const result = parseBlockAnnotation("Some paragraph ^{para-1}");
    expect(result.label).toBe("Some paragraph");
    expect(result.explicitId).toBe("para-1");
  });

  it("requires annotation at end of line", () => {
    const result = parseBlockAnnotation("^{id} at start");
    expect(result.label).toBe("^{id} at start");
    expect(result.explicitId).toBeNull();
  });
});

describe("scanBlockIds", () => {
  it("extracts heading slugs as block IDs", () => {
    const doc = [
      "# Design Goals",
      "",
      "Some content here.",
      "",
      "## Architecture",
      "",
      "More content.",
    ].join("\n");

    const registry = scanBlockIds(doc);
    expect(registry.has("design-goals")).toBe(true);
    expect(registry.has("architecture")).toBe(true);

    const goals = registry.get("design-goals")!;
    expect(goals.type).toBe("heading");
    expect(goals.level).toBe(1);
    expect(goals.label).toBe("Design Goals");
  });

  it("extracts explicit ^{id} annotations", () => {
    const doc = [
      "## Design Goals ^{core-design}",
      "",
      "Content for core design.",
      "",
      "A standalone paragraph ^{para-note}",
      "",
      "## Another Section",
    ].join("\n");

    const registry = scanBlockIds(doc);
    expect(registry.has("core-design")).toBe(true);
    expect(registry.has("para-note")).toBe(true);
    expect(registry.has("design-goals")).toBe(false); // explicit wins
  });

  it("handles empty document", () => {
    const registry = scanBlockIds("");
    expect(registry.size).toBe(0);
  });

  it("resolves block content for heading blocks", () => {
    const doc = [
      "## Design Goals ^{core-design}",
      "We aim to build a fast editor.",
      "",
      "## Next Section",
    ].join("\n");

    const registry = scanBlockIds(doc);
    const entry = registry.get("core-design")!;
    const content = resolveBlockContent(entry, doc);
    expect(content).toContain("We aim to build a fast editor.");
    expect(content).not.toContain("Next Section");
  });

  it("resolves block content for paragraph blocks", () => {
    const doc = [
      "Some text",
      "",
      "Important note here ^{my-note}",
      "",
      "Other text",
    ].join("\n");

    const registry = scanBlockIds(doc);
    const entry = registry.get("my-note")!;
    expect(entry.type).toBe("paragraph");
    const content = resolveBlockContent(entry, doc);
    expect(content).toBe("Important note here");
  });

  it("handles duplicate IDs (first wins)", () => {
    const doc = [
      "## First ^{dup}",
      "",
      "## Second ^{dup}",
    ].join("\n");

    const registry = scanBlockIds(doc);
    const entry = registry.get("dup")!;
    expect(entry.label).toBe("First");
  });
});
