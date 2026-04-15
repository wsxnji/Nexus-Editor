import { createState, type AppState } from "./state";
import { createEditorShell, type EditorShell } from "./editor-shell";

const state: AppState = createState();
let shell: EditorShell;

function createToolbar(): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const openBtn = document.createElement("button");
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", handleOpen);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", handleSave);

  const saveAsBtn = document.createElement("button");
  saveAsBtn.textContent = "Save As";
  saveAsBtn.addEventListener("click", handleSaveAs);

  toolbar.append(openBtn, saveBtn, saveAsBtn);
  return toolbar;
}

function createStatusLine(): HTMLElement {
  const status = document.createElement("div");
  status.className = "status-line";
  status.id = "status-line";
  return status;
}

function renderStatus(): void {
  const el = document.getElementById("status-line");
  if (!el) return;

  const pathLabel = state.filePath ?? "Untitled";
  const dirtyMark = state.dirty ? " [modified]" : "";
  const errorText = state.error ? ` — Error: ${state.error}` : "";
  el.textContent = `${pathLabel}${dirtyMark}${errorText}`;
}

async function handleOpen(): Promise<void> {
  try {
    state.error = null;
    const result = await window.nexusDemo.openFile();
    if (!result) return;

    state.filePath = result.path;
    shell.loadDocument(result.content);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  renderStatus();
}

async function handleSave(): Promise<void> {
  try {
    state.error = null;
    if (state.filePath) {
      await window.nexusDemo.saveFile(state.filePath, state.content);
      state.dirty = false;
    } else {
      await handleSaveAs();
      return;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  renderStatus();
}

async function handleSaveAs(): Promise<void> {
  try {
    state.error = null;
    const result = await window.nexusDemo.saveFileAs(state.content);
    if (!result) return;

    state.filePath = result.path;
    state.dirty = false;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  renderStatus();
}

function boot(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app element");

  const toolbar = createToolbar();
  const statusLine = createStatusLine();
  const editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";

  root.append(toolbar, statusLine, editorContainer);

  shell = createEditorShell({
    container: editorContainer,
    state,
    onStateChange: renderStatus,
  });

  renderStatus();
}

boot();
