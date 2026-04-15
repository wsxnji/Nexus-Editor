import { createEditor, type EditorAPI } from "@nexus/core";
import { createGfmPreset } from "@nexus/preset-gfm";
import { createHistoryPlugin } from "@nexus/plugin-history";
import type { AppState } from "./state";

export interface EditorShellOptions {
  container: HTMLElement;
  state: AppState;
  onStateChange: () => void;
}

export interface EditorShell {
  editor: EditorAPI;
  loadDocument(content: string): void;
  destroy(): void;
}

export function createEditorShell(options: EditorShellOptions): EditorShell {
  const { container, state, onStateChange } = options;

  const editor = createEditor({
    container,
    initialValue: state.content,
    plugins: [createGfmPreset(), createHistoryPlugin()],
    livePreview: true,
    onChange(doc) {
      state.content = doc;
      state.dirty = true;
      onStateChange();
    },
  });

  return {
    editor,
    loadDocument(content: string) {
      editor.setDocument(content);
      state.content = content;
      state.dirty = false;
      onStateChange();
    },
    destroy() {
      editor.destroy();
    },
  };
}
