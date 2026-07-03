import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TransclusionWidget,
  clearTransclusionCache,
  invalidateFileCache,
  resolveContent,
} from "../src/transclusion-widget";

// Helper to create a mock EditorView
function mockView() {
  const el = document.createElement("div");
  return {
    current: null as any,
    dom: el,
  };
}

describe("resolveContent", () => {
  beforeEach(() => {
    clearTransclusionCache();
  });

  it("resolves content through the callback and caches the result", async () => {
    const resolve = vi.fn().mockReturnValue("# Resolved Content");

    const result1 = await resolveContent(resolve, "TestFile", "heading-1");
    expect(result1).toBe("# Resolved Content");
    expect(resolve).toHaveBeenCalledTimes(1);

    // Second call should use cached result, not call resolve again
    const result2 = await resolveContent(resolve, "TestFile", "heading-1");
    expect(result2).toBe("# Resolved Content");
    expect(resolve).toHaveBeenCalledTimes(1); // still 1
  });

  it("returns null when resolve returns null", async () => {
    const resolve = vi.fn().mockReturnValue(null);

    const result = await resolveContent(resolve, "Missing", undefined);
    expect(result).toBeNull();
  });

  it("returns null when resolve throws", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("Not found"));

    const result = await resolveContent(resolve, "Boom", undefined);
    expect(result).toBeNull();
  });

  it("uses different cache keys for different blockIds within same file", async () => {
    const resolve = vi.fn((file: string, blockId: string | undefined) => {
      if (blockId === "a") return "Content A";
      if (blockId === "b") return "Content B";
      return null;
    });

    const a = await resolveContent(resolve, "File", "a");
    const b = await resolveContent(resolve, "File", "b");
    expect(a).toBe("Content A");
    expect(b).toBe("Content B");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("clearTransclusionCache", () => {
  it("clears all cached resolutions", async () => {
    const resolve = vi.fn().mockReturnValue("content");

    await resolveContent(resolve, "File", "id");
    expect(resolve).toHaveBeenCalledTimes(1);

    clearTransclusionCache();

    // After clearing, should call resolve again
    await resolveContent(resolve, "File", "id");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateFileCache", () => {
  beforeEach(() => {
    clearTransclusionCache();
  });

  it("removes all block IDs for a given file", async () => {
    const resolve = vi.fn().mockReturnValue("content");

    await resolveContent(resolve, "FileA", "id1");
    await resolveContent(resolve, "FileB", "id1");
    expect(resolve).toHaveBeenCalledTimes(2);

    invalidateFileCache("FileA");

    // FileA should re-resolve, FileB should be cached
    await resolveContent(resolve, "FileA", "id1");
    expect(resolve).toHaveBeenCalledTimes(3);
    await resolveContent(resolve, "FileB", "id1");
    expect(resolve).toHaveBeenCalledTimes(3); // still cached
  });

  it("also removes the bare file key", async () => {
    const resolve = vi.fn().mockReturnValue("content");

    await resolveContent(resolve, "FileA", undefined);
    expect(resolve).toHaveBeenCalledTimes(1);

    invalidateFileCache("FileA");

    await resolveContent(resolve, "FileA", undefined);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("TransclusionWidget", () => {
  it("creates a DOM element with breadcrumb and body", () => {
    const viewRef = mockView();
    const widget = new TransclusionWidget(
      "TestFile",
      "test-block",
      "Test File > test-block",
      0,
      undefined,
      viewRef,
    );

    const dom = widget.toDOM();
    expect(dom.className).toBe("nexus-transclusion");
    expect(dom.querySelector(".nexus-transclusion-breadcrumb")).not.toBeNull();
    expect(dom.querySelector(".nexus-transclusion-body")).not.toBeNull();

    const breadcrumb = dom.querySelector(".nexus-transclusion-breadcrumb")!;
    expect(breadcrumb.textContent).toContain("TestFile");
    expect(breadcrumb.textContent).toContain("test-block");
  });

  it("shows initial body text when no resolver is configured", () => {
    const viewRef = mockView();
    const widget = new TransclusionWidget(
      "Missing",
      "block",
      "Missing > block",
      0,
      undefined,
      viewRef,
    );

    const dom = widget.toDOM();
    const body = dom.querySelector(".nexus-transclusion-body")!;
    // When no resolver is provided, widget renders unresolved immediately
    expect(body.textContent).toContain("Unresolved");
  });

  it("eq returns true for identical parameters", () => {
    const viewRef = mockView();
    const a = new TransclusionWidget("F", "b", "d", 0, undefined, viewRef);
    const b = new TransclusionWidget("F", "b", "d", 0, undefined, viewRef);
    expect(a.eq(b)).toBe(true);
  });

  it("eq returns false when file differs", () => {
    const viewRef = mockView();
    const a = new TransclusionWidget("A", "b", "d", 0, undefined, viewRef);
    const b = new TransclusionWidget("B", "b", "d", 0, undefined, viewRef);
    expect(a.eq(b)).toBe(false);
  });

  it("eq returns false when blockId differs", () => {
    const viewRef = mockView();
    const a = new TransclusionWidget("F", "a", "d", 0, undefined, viewRef);
    const b = new TransclusionWidget("F", "b", "d", 0, undefined, viewRef);
    expect(a.eq(b)).toBe(false);
  });

  it("eq returns false when sourceFrom differs", () => {
    const viewRef = mockView();
    const a = new TransclusionWidget("F", "b", "d", 5, undefined, viewRef);
    const b = new TransclusionWidget("F", "b", "d", 10, undefined, viewRef);
    expect(a.eq(b)).toBe(false);
  });

  it("ignoreEvent returns true", () => {
    const viewRef = mockView();
    const widget = new TransclusionWidget("F", "b", "d", 0, undefined, viewRef);
    expect(widget.ignoreEvent()).toBe(true);
  });

  it("returns estimatedHeight > 0", () => {
    const viewRef = mockView();
    const widget = new TransclusionWidget("F", "b", "d", 0, undefined, viewRef);
    expect(widget.estimatedHeight).toBeGreaterThan(0);
  });
});
