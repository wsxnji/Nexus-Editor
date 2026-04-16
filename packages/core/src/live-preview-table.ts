import { EditorView, WidgetType } from "@codemirror/view";
import type { Table } from "mdast";

import type { LivePreviewLabels } from "./types";

let tableEditingCount = 0;

export function isTableEditing(): boolean {
  return tableEditingCount > 0;
}

const SEPARATOR_RE = /^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)*\|?\s*$/;

function extractCellText(cell: any): string {
  if (!cell || !("children" in cell) || !Array.isArray(cell.children)) return "";
  return cell.children
    .map((c: any) => {
      if ("value" in c && typeof c.value === "string") return c.value;
      if ("children" in c && Array.isArray(c.children))
        return c.children.map((n: any) => ("value" in n ? n.value : "")).join("");
      return "";
    })
    .join("");
}

const GRIP_BG = "#e8e8e8";
const GRIP_BG_HOVER = "#d0d0d0";
const SELECT_BG = "rgba(124, 108, 250, 0.12)";
const SELECT_BORDER = "#7c6cfa";
const DRAG_HIGHLIGHT_BG = "rgba(124, 108, 250, 0.08)";

export class EditableTableWidget extends WidgetType {
  private editing = false;

  constructor(
    private node: Table,
    private tableFrom: number,
    private source: string,
    private viewRef: { current: EditorView | null },
    private labels: Required<LivePreviewLabels>
  ) { super(); }

  eq(other: EditableTableWidget): boolean {
    if (this.editing) return true;
    return this.source === other.source;
  }

  ignoreEvent(): boolean { return true; }

  private dispatch(newSource: string): void {
    const v = this.viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: this.tableFrom, to: this.tableFrom + this.source.length, insert: newSource } });
  }

  private deleteColumn(colIdx: number): void {
    const lines = this.source.split("\n");
    const newLines = lines.map((line) => {
      const cells = line.split("|").filter((_, i, a) => i > 0 && i < a.length - 1);
      if (cells.length === 0) return line;
      cells.splice(colIdx, 1);
      return "|" + cells.join("|") + "|";
    });
    this.dispatch(newLines.join("\n"));
  }

  private deleteRow(rowIdx: number): void {
    const lines = this.source.split("\n");
    const dataLines: number[] = [];
    for (let i = 0; i < lines.length; i++) if (!SEPARATOR_RE.test(lines[i])) dataLines.push(i);
    const lineIdx = dataLines[rowIdx];
    if (lineIdx === undefined) return;
    lines.splice(lineIdx, 1);
    this.dispatch(lines.join("\n"));
  }

  private addColumn(): void {
    const lines = this.source.split("\n");
    const nl = lines.map((l) => SEPARATOR_RE.test(l) ? l.replace(/\|?\s*$/, " | --- |") : l.replace(/\|?\s*$/, " |  |"));
    this.dispatch(nl.join("\n"));
  }

  private addRow(): void {
    const cc = (this.node.children?.[0] as any)?.children?.length ?? 2;
    const nr = "\n| " + Array(cc).fill("  ").join(" | ") + " |";
    const v = this.viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: this.tableFrom + this.source.length, insert: nr } });
  }

  private moveColumn(from: number, to: number): void {
    const lines = this.source.split("\n");
    const nl = lines.map((line) => {
      const p = line.split("|"), cells = p.slice(1, -1);
      if (from >= cells.length || to >= cells.length) return line;
      const [m] = cells.splice(from, 1);
      cells.splice(to, 0, m);
      return "|" + cells.join("|") + "|";
    });
    this.dispatch(nl.join("\n"));
  }

  private moveRow(from: number, to: number): void {
    const lines = this.source.split("\n");
    const dl: number[] = [];
    for (let i = 0; i < lines.length; i++) if (!SEPARATOR_RE.test(lines[i])) dl.push(i);
    const s = dl[from], d = dl[to];
    if (s === undefined || d === undefined) return;
    const [m] = lines.splice(s, 1);
    lines.splice(d, 0, m);
    this.dispatch(lines.join("\n"));
  }

  toDOM(): HTMLElement {
    const self = this;
    const rows = this.node.children ?? [];
    const colCount = ("children" in rows[0] && Array.isArray(rows[0].children)) ? rows[0].children.length : 0;
    const sourceLines = this.source.split("\n");
    const dataLineIndices: number[] = [];
    for (let i = 0; i < sourceLines.length; i++) if (!SEPARATOR_RE.test(sourceLines[i])) dataLineIndices.push(i);

    // State
    let selectedCol = -1;
    let selectedRow = -1;

    // Cell range selection (Excel-style)
    let rangeStart: { row: number; col: number } | null = null;
    let rangeEnd: { row: number; col: number } | null = null;
    let isRangeSelecting = false;
    let cellMouseDown = false; // true between mousedown and mouseup on a cell

    // Custom drag state (no HTML5 drag API)
    let draggingCol = -1;   // which column is being dragged
    let draggingRow = -1;   // which row is being dragged
    let dropTargetCol = -1;
    let dropTargetRow = -1;

    // ── Root wrapper ──
    const wrapper = document.createElement("div");
    wrapper.className = "nexus-table-wrapper";
    wrapper.style.cssText = "display:inline-block;position:relative;margin:8px 0;user-select:none;";

    // ── Table ──
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;display:table;";
    if (rows.length === 0) { wrapper.appendChild(table); return wrapper; }

    // ── Selection overlay — highlights entire table when CM6 selection covers it ──
    const selectionOverlay = document.createElement("div");
    selectionOverlay.style.cssText =
      "position:absolute;inset:0;background:rgba(124,108,250,0.1);pointer-events:none;" +
      "display:none;z-index:1;border-radius:2px;";
    wrapper.appendChild(selectionOverlay);

    // Poll CM6 selection to show/hide overlay and clear range when focus leaves table
    const checkSelection = (): void => {
      if (!wrapper.isConnected) return;
      const v = self.viewRef.current;
      if (v && !self.editing) {
        const sel = v.state.selection.main;
        const tableEnd = self.tableFrom + self.source.length;
        const isSelected = sel.from !== sel.to && sel.from <= self.tableFrom && sel.to >= tableEnd;
        selectionOverlay.style.display = isSelected ? "block" : "none";
        // If cursor moved outside table, no active mouse interaction, and not mid-select, clear range
        if (rangeStart && !isRangeSelecting && !cellMouseDown && (sel.head < self.tableFrom || sel.head > tableEnd)) {
          clearRangeSelection();
        }
      } else {
        selectionOverlay.style.display = "none";
      }
      requestAnimationFrame(checkSelection);
    };
    requestAnimationFrame(checkSelection);

    // ── Drag indicator overlay (full-height vertical line) ──
    const colIndicator = document.createElement("div");
    colIndicator.style.cssText =
      "position:absolute;width:2px;background:" + SELECT_BORDER + ";pointer-events:none;" +
      "top:0;bottom:0;display:none;z-index:2;border-radius:1px;";
    wrapper.appendChild(colIndicator);

    const rowIndicator = document.createElement("div");
    rowIndicator.style.cssText =
      "position:absolute;height:2px;background:" + SELECT_BORDER + ";pointer-events:none;" +
      "left:0;right:0;display:none;z-index:2;border-radius:1px;";
    wrapper.appendChild(rowIndicator);

    // Floating pill that follows the mouse during column drag
    const floatingPill = document.createElement("div");
    floatingPill.style.cssText =
      "position:absolute;width:16px;height:6px;border-radius:3px;background:" + SELECT_BORDER + ";" +
      "pointer-events:none;display:none;z-index:3;top:4px;";
    wrapper.appendChild(floatingPill);

    // Floating pill for row drag
    const floatingRowPill = document.createElement("div");
    floatingRowPill.style.cssText =
      "position:absolute;width:6px;height:16px;border-radius:3px;background:" + SELECT_BORDER + ";" +
      "pointer-events:none;display:none;z-index:3;left:5px;";
    wrapper.appendChild(floatingRowPill);

    // ── Helpers ──

    function getColumnCells(colIdx: number): HTMLElement[] {
      const result: HTMLElement[] = [];
      table.querySelectorAll("tr").forEach((tr) => {
        const cells = tr.querySelectorAll(".nexus-cell");
        if (cells[colIdx]) result.push(cells[colIdx] as HTMLElement);
      });
      return result;
    }

    function getHeaderCells(): NodeListOf<Element> {
      return table.querySelectorAll("tr:nth-child(2) .nexus-cell");
    }

    function colAtClientX(clientX: number): number {
      const cells = getHeaderCells();
      for (let i = 0; i < cells.length; i++) {
        const rect = cells[i].getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right) return i;
      }
      return -1;
    }

    function rowAtClientY(clientY: number): number {
      // Skip header (index 0), only match data rows (index >= 1)
      const dataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      for (let i = 1; i < dataRows.length; i++) { // start at 1 to skip header row
        const rect = dataRows[i].getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) return i;
      }
      return -1;
    }

    function showColIndicator(targetCol: number): void {
      if (draggingCol < 0 || targetCol === draggingCol) { colIndicator.style.display = "none"; dropTargetCol = -1; return; }
      dropTargetCol = targetCol;
      const cells = getHeaderCells();
      const cell = cells[targetCol] as HTMLElement | undefined;
      if (!cell) return;
      const wrapperRect = wrapper.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const bounds = getContentBounds();
      const rawX = draggingCol < targetCol ? cellRect.right : cellRect.left;
      const clampedX = Math.max(bounds.left, Math.min(rawX, bounds.right));
      colIndicator.style.left = (clampedX - wrapperRect.left - 1) + "px";
      colIndicator.style.display = "block";
    }

    function showRowIndicator(targetRow: number): void {
      if (draggingRow < 0 || targetRow === draggingRow) { rowIndicator.style.display = "none"; dropTargetRow = -1; return; }
      dropTargetRow = targetRow;
      const dataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      const row = dataRows[targetRow] as HTMLElement | undefined;
      if (!row) return;
      const wrapperRect = wrapper.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const y = draggingRow < targetRow ? rowRect.bottom - wrapperRect.top : rowRect.top - wrapperRect.top;
      rowIndicator.style.top = (y - 1) + "px";
      rowIndicator.style.display = "block";
    }

    function hideIndicators(): void {
      colIndicator.style.display = "none";
      rowIndicator.style.display = "none";
      dropTargetCol = -1;
      dropTargetRow = -1;
    }

    function clearDragHighlights(): void {
      table.querySelectorAll(".nexus-cell").forEach((el) => {
        const h = el as HTMLElement;
        h.style.background = h.tagName === "TH" ? "#fafafa" : "";
      });
    }

    // ── Range selection border overlay ──
    const rangeBorder = document.createElement("div");
    rangeBorder.style.cssText =
      "position:absolute;border:2px solid " + SELECT_BORDER + ";pointer-events:none;" +
      "display:none;z-index:1;border-radius:2px;";
    wrapper.appendChild(rangeBorder);

    function getNormalizedRange(): { r1: number; c1: number; r2: number; c2: number } | null {
      if (!rangeStart || !rangeEnd) return null;
      return {
        r1: Math.min(rangeStart.row, rangeEnd.row),
        c1: Math.min(rangeStart.col, rangeEnd.col),
        r2: Math.max(rangeStart.row, rangeEnd.row),
        c2: Math.max(rangeStart.col, rangeEnd.col),
      };
    }

    function getCellElement(row: number, col: number): HTMLElement | null {
      const dataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      const tr = dataRows[row];
      if (!tr) return null;
      const cells = tr.querySelectorAll(".nexus-cell");
      return (cells[col] as HTMLElement) ?? null;
    }

    function renderRangeSelection(): void {
      const range = getNormalizedRange();
      if (!range) { rangeBorder.style.display = "none"; return; }

      // Highlight cells in range
      const dataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      dataRows.forEach((tr, rowIdx) => {
        tr.querySelectorAll(".nexus-cell").forEach((cell, colIdx) => {
          const h = cell as HTMLElement;
          if (rowIdx >= range.r1 && rowIdx <= range.r2 && colIdx >= range.c1 && colIdx <= range.c2) {
            h.style.background = SELECT_BG;
          } else {
            h.style.background = h.tagName === "TH" ? "#fafafa" : "";
          }
        });
      });

      // Position the border overlay around the selected range
      const topLeft = getCellElement(range.r1, range.c1);
      const bottomRight = getCellElement(range.r2, range.c2);
      if (!topLeft || !bottomRight) { rangeBorder.style.display = "none"; return; }

      const wrapperRect = wrapper.getBoundingClientRect();
      const tlRect = topLeft.getBoundingClientRect();
      const brRect = bottomRight.getBoundingClientRect();

      rangeBorder.style.left = (tlRect.left - wrapperRect.left - 1) + "px";
      rangeBorder.style.top = (tlRect.top - wrapperRect.top - 1) + "px";
      rangeBorder.style.width = (brRect.right - tlRect.left) + "px";
      rangeBorder.style.height = (brRect.bottom - tlRect.top) + "px";
      rangeBorder.style.display = "block";
    }

    function clearRangeSelection(): void {
      rangeStart = null;
      rangeEnd = null;
      isRangeSelecting = false;
      rangeBorder.style.display = "none";
      // Reset cell backgrounds
      table.querySelectorAll(".nexus-cell").forEach((el) => {
        const h = el as HTMLElement;
        h.style.background = h.tagName === "TH" ? "#fafafa" : "";
      });
    }

    function cellAtPoint(clientX: number, clientY: number): { row: number; col: number } | null {
      const dataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      for (let r = 0; r < dataRows.length; r++) {
        const cells = dataRows[r].querySelectorAll(".nexus-cell");
        for (let c = 0; c < cells.length; c++) {
          const rect = cells[c].getBoundingClientRect();
          if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
            return { row: r, col: c };
          }
        }
      }
      return null;
    }

    function clearSelection(): void {
      selectedCol = -1;
      selectedRow = -1;
      table.querySelectorAll(".nexus-cell").forEach((el) => {
        const h = el as HTMLElement;
        h.style.background = h.tagName === "TH" ? "#fafafa" : "";
      });
      table.querySelectorAll(".nexus-col-grip").forEach((el) => {
        (el as HTMLElement).style.background = "";
      });
      table.querySelectorAll(".nexus-row-grip").forEach((el) => {
        (el as HTMLElement).style.background = "";
      });
    }

    function highlightColumn(colIdx: number): void {
      clearSelection();
      selectedCol = colIdx;
      const gripCells = table.querySelectorAll(".nexus-col-grip");
      if (gripCells[colIdx]) (gripCells[colIdx] as HTMLElement).style.background = SELECT_BORDER;
      getColumnCells(colIdx).forEach((el) => { el.style.background = SELECT_BG; });
    }

    function highlightRow(rowIdx: number): void {
      clearSelection();
      selectedRow = rowIdx;
      const trs = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      if (trs[rowIdx]) {
        trs[rowIdx].querySelectorAll(".nexus-cell").forEach((el) => {
          (el as HTMLElement).style.background = SELECT_BG;
        });
        const grip = trs[rowIdx].querySelector(".nexus-row-grip");
        if (grip) (grip as HTMLElement).style.background = SELECT_BORDER;
      }
    }

    function createGripPill(): HTMLElement {
      const pill = document.createElement("div");
      pill.style.cssText =
        "width:16px;height:6px;border-radius:3px;background:" + GRIP_BG + ";" +
        "margin:0 auto;transition:background .15s;";
      return pill;
    }

    // ── Custom drag handlers (mousedown/mousemove/mouseup, no HTML5 drag) ──

    // Get the content area boundaries (excluding grip column)
    function getContentBounds(): { left: number; right: number; top: number; bottom: number } {
      const cells = getHeaderCells();
      if (cells.length === 0) return wrapper.getBoundingClientRect();
      const first = cells[0].getBoundingClientRect();
      const last = cells[cells.length - 1].getBoundingClientRect();
      return { left: first.left, right: last.right, top: first.top, bottom: last.bottom };
    }

    function onDragMove(e: MouseEvent): void {
      e.preventDefault();
      if (!wrapper.isConnected) { onDragEnd(); return; }
      const wrapperRect = wrapper.getBoundingClientRect();

      if (draggingCol >= 0) {
        const bounds = getContentBounds();
        const clampedX = Math.max(bounds.left, Math.min(e.clientX, bounds.right));
        floatingPill.style.left = (clampedX - wrapperRect.left - 8) + "px";

        const target = colAtClientX(clampedX);
        if (target >= 0 && target !== draggingCol) {
          showColIndicator(target);
        } else {
          colIndicator.style.display = "none";
          dropTargetCol = -1;
        }
      }
      if (draggingRow >= 0) {
        // Move floating pill vertically, constrained to non-header data rows
        const dataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
        // dataRows[0] is header, dataRows[1+] are body rows — clamp to body rows only
        const firstBodyRow = dataRows[1]?.getBoundingClientRect();
        const lastRow = dataRows[dataRows.length - 1]?.getBoundingClientRect();
        const minY = firstBodyRow ? firstBodyRow.top : wrapperRect.top;
        const maxY = lastRow ? lastRow.bottom : wrapperRect.bottom;
        const clampedY = Math.max(minY, Math.min(e.clientY, maxY));
        floatingRowPill.style.top = (clampedY - wrapperRect.top - 8) + "px";

        const target = rowAtClientY(clampedY);
        if (target >= 0 && target !== draggingRow) {
          showRowIndicator(target);
        } else {
          rowIndicator.style.display = "none";
          dropTargetRow = -1;
        }
      }
    }

    function onDragEnd(): void {
      const movedCol = draggingCol >= 0 && dropTargetCol >= 0 && dropTargetCol !== draggingCol;
      const movedRow = draggingRow >= 0 && dropTargetRow >= 0 && dropTargetRow !== draggingRow;
      const savedDragCol = draggingCol;
      const savedDropCol = dropTargetCol;
      const savedDragRow = draggingRow;
      const savedDropRow = dropTargetRow;

      // Clean up visual state FIRST
      clearDragHighlights();
      hideIndicators();
      floatingPill.style.display = "none";
      floatingRowPill.style.display = "none";
      gripRow.style.opacity = "0";
      draggingCol = -1;
      draggingRow = -1;
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      // Release editing lock BEFORE dispatch so the resulting update rebuilds widget
      self.editing = false;
      tableEditingCount--;

      // Now dispatch the move — this triggers a full decoration rebuild with new source
      if (movedCol) self.moveColumn(savedDragCol, savedDropCol);
      if (movedRow) self.moveRow(savedDragRow, savedDropRow);
    }

    function startColDrag(colIdx: number, startX: number): void {
      draggingCol = colIdx;
      draggingRow = -1;
      // Lock editing to prevent CM6 from recreating widget DOM mid-drag
      self.editing = true;
      tableEditingCount++;
      // Highlight source column
      getColumnCells(colIdx).forEach((el) => { el.style.background = DRAG_HIGHLIGHT_BG; });
      // Hide grip row, show floating pill instead
      gripRow.style.opacity = "0";
      const wrapperRect = wrapper.getBoundingClientRect();
      floatingPill.style.left = (startX - wrapperRect.left - 8) + "px";
      floatingPill.style.display = "block";
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }

    function startRowDrag(rowIdx: number, startY: number): void {
      draggingRow = rowIdx;
      draggingCol = -1;
      // Lock editing to prevent CM6 from recreating widget DOM mid-drag
      self.editing = true;
      tableEditingCount++;
      // Highlight source row
      const trs = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
      if (trs[rowIdx]) {
        trs[rowIdx].querySelectorAll(".nexus-cell").forEach((el) => {
          (el as HTMLElement).style.background = DRAG_HIGHLIGHT_BG;
        });
      }
      // Show floating row pill
      const wrapperRect = wrapper.getBoundingClientRect();
      floatingRowPill.style.top = (startY - wrapperRect.top - 8) + "px";
      floatingRowPill.style.display = "block";
      // Hide the source row grip
      const grip = trs[rowIdx]?.querySelector(".nexus-row-grip") as HTMLElement | null;
      if (grip) grip.style.opacity = "0";
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }

    // ── Column grip row ──
    const gripRow = document.createElement("tr");
    gripRow.style.cssText = "opacity:0;transition:opacity .15s;";

    const gripSpacer = document.createElement("td");
    gripSpacer.style.cssText = "width:16px;min-width:16px;padding:0;border:none;";
    gripRow.appendChild(gripSpacer);

    for (let c = 0; c < colCount; c++) {
      const gripCell = document.createElement("td");
      gripCell.className = "nexus-col-grip";
      gripCell.style.cssText =
        "padding:4px 0;text-align:center;cursor:grab;user-select:none;border:none;";
      const pill = createGripPill();
      gripCell.appendChild(pill);

      gripCell.addEventListener("mouseenter", () => { if (draggingCol < 0) pill.style.background = GRIP_BG_HOVER; });
      gripCell.addEventListener("mouseleave", () => { if (draggingCol < 0) pill.style.background = GRIP_BG; });

      const colIdx = c;

      gripCell.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startColDrag(colIdx, e.clientX);
      });

      gripCell.addEventListener("click", (e) => {
        e.stopPropagation();
        highlightColumn(colIdx);
        wrapper.focus({ preventScroll: true });
      });

      gripRow.appendChild(gripCell);
    }
    table.appendChild(gripRow);

    // ── Data rows ──
    let rowIdx = 0;
    for (const astRow of rows) {
      const isHeader = rowIdx === 0;
      const tr = document.createElement("tr");
      const astCells = "children" in astRow && Array.isArray(astRow.children) ? astRow.children : [];
      const sourceLineIdx = dataLineIndices[rowIdx];
      const curRowIdx = rowIdx;

      // Row grip
      const rowGrip = document.createElement(isHeader ? "th" : "td");
      rowGrip.className = "nexus-row-grip";
      rowGrip.style.cssText =
        "width:16px;min-width:16px;max-width:16px;padding:6px 2px;text-align:center;" +
        "cursor:" + (isHeader ? "default" : "grab") + ";user-select:none;border:none;" +
        "border-right:1px solid #eee;vertical-align:middle;" +
        "opacity:0;transition:opacity .15s;";

      if (!isHeader) {
        const rowPill = createGripPill();
        rowPill.style.width = "6px";
        rowPill.style.height = "16px";
        rowPill.style.borderRadius = "3px";
        rowGrip.appendChild(rowPill);

        rowGrip.addEventListener("mouseenter", () => { if (draggingRow < 0) rowPill.style.background = GRIP_BG_HOVER; });
        rowGrip.addEventListener("mouseleave", () => { if (draggingRow < 0) rowPill.style.background = GRIP_BG; });

        rowGrip.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          startRowDrag(curRowIdx, e.clientY);
        });

        rowGrip.addEventListener("click", (e) => {
          e.stopPropagation();
          highlightRow(curRowIdx);
          wrapper.focus({ preventScroll: true });
        });
      }

      tr.appendChild(rowGrip);

      // Content cells
      for (let colIdx = 0; colIdx < astCells.length; colIdx++) {
        const td = document.createElement(isHeader ? "th" : "td");
        td.className = "nexus-cell";
        td.textContent = extractCellText(astCells[colIdx]);
        td.style.cssText =
          "border-bottom:1px solid #eee;border-right:1px solid #eee;padding:8px 12px;" +
          "text-align:left;outline:none;min-width:60px;vertical-align:top;cursor:text;";
        if (isHeader) { td.style.fontWeight = "bold"; td.style.background = "#fafafa"; td.style.borderTop = "1px solid #eee"; }

        // Cell interaction: single click = edit, drag = range select
        const cellRow = curRowIdx;
        const cellCol = colIdx;
        let cellMouseMoved = false;

        td.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return; // only left button
          e.stopPropagation();
          cellMouseMoved = false;
          clearSelection();

          // Prepare range selection but don't render until mouse moves to a different cell
          clearRangeSelection();
          cellMouseDown = true;
          rangeStart = { row: cellRow, col: cellCol };
          rangeEnd = { row: cellRow, col: cellCol };

          const onCellMouseMove = (me: MouseEvent): void => {
            const target = cellAtPoint(me.clientX, me.clientY);
            if (target && (target.row !== rangeStart!.row || target.col !== rangeStart!.col)) {
              cellMouseMoved = true;
              isRangeSelecting = true;
              rangeEnd = target;
              renderRangeSelection();
            }
          };
          const onCellMouseUp = (): void => {
            document.removeEventListener("mousemove", onCellMouseMove);
            document.removeEventListener("mouseup", onCellMouseUp);
            cellMouseDown = false;
            isRangeSelecting = false;

            const range = getNormalizedRange();
            if (!cellMouseMoved || (range && range.r1 === range.r2 && range.c1 === range.c2)) {
              // Single cell click — activate editing
              clearRangeSelection();
              td.contentEditable = "true";
              requestAnimationFrame(() => td.focus({ preventScroll: true }));
            } else {
              // Multi-cell range selected — keep range visible, focus wrapper for key events
              wrapper.focus({ preventScroll: true });
            }
          };
          document.addEventListener("mousemove", onCellMouseMove);
          document.addEventListener("mouseup", onCellMouseUp);
        });

        td.addEventListener("focus", () => { self.editing = true; tableEditingCount++; clearRangeSelection(); });
        td.addEventListener("blur", () => {
          // Don't clear editing lock if a grip drag is active
          if (draggingCol < 0 && draggingRow < 0) {
            self.editing = false;
            tableEditingCount--;
          }
          td.contentEditable = "false";
        });

        td.addEventListener("input", () => {
          const v = self.viewRef.current;
          if (!v || sourceLineIdx === undefined) return;
          const vals: string[] = [];
          tr.querySelectorAll(".nexus-cell").forEach((el) => vals.push(el.textContent ?? ""));
          const newLine = "| " + vals.join(" | ") + " |";
          let off = self.tableFrom;
          for (let i = 0; i < sourceLineIdx; i++) off += sourceLines[i].length + 1;
          const end = off + sourceLines[sourceLineIdx].length;
          sourceLines[sourceLineIdx] = newLine;
          v.dispatch({ changes: { from: off, to: end, insert: newLine } });
        });

        td.addEventListener("keydown", (e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const all = table.querySelectorAll(".nexus-cell");
            const idx = Array.from(all).indexOf(td);
            const next = e.shiftKey ? idx - 1 : idx + 1;
            if (next >= 0 && next < all.length) (all[next] as HTMLElement).focus({ preventScroll: true });
          }
        });

        tr.appendChild(td);
      }

      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const clickedCell = (e.target as HTMLElement).closest("th,td") as HTMLElement | null;
        let clickedCol = 0;
        if (clickedCell) {
          const cells = Array.from(tr.querySelectorAll("th,td"));
          const cellIdx = cells.indexOf(clickedCell);
          clickedCol = Math.max(0, cellIdx - 1);
        }
        showContextMenu(e.clientX, e.clientY, self, curRowIdx, isHeader, clickedCol, colCount, rows.length, wrapper);
      });

      table.appendChild(tr);
      rowIdx++;
    }

    wrapper.appendChild(table);

    // ── "+" buttons ──
    const btnCss = "position:absolute;width:20px;height:20px;border:1px solid #ddd;" +
      "border-radius:50%;background:#fff;cursor:pointer;font-size:14px;line-height:1;" +
      "display:flex;align-items:center;justify-content:center;color:#999;padding:0;" +
      "opacity:0;transition:opacity .15s;z-index:1;";

    const addCol = document.createElement("button");
    addCol.textContent = "+";
    addCol.title = self.labels.addColumn;
    addCol.style.cssText = btnCss + "right:-24px;top:50%;transform:translateY(-50%);";
    addCol.addEventListener("click", () => self.addColumn());
    wrapper.appendChild(addCol);

    const addRow = document.createElement("button");
    addRow.textContent = "+";
    addRow.title = self.labels.addRow;
    addRow.style.cssText = btnCss + "bottom:-24px;left:50%;transform:translateX(-50%);";
    addRow.addEventListener("click", () => self.addRow());
    wrapper.appendChild(addRow);

    // ── Per-element hover (suppressed during drag) ──
    function isDragging(): boolean { return draggingCol >= 0 || draggingRow >= 0; }

    const headerTr = table.querySelectorAll("tr")[1] as HTMLElement | undefined;
    gripRow.addEventListener("mouseenter", () => { if (!isDragging()) gripRow.style.opacity = "1"; });
    gripRow.addEventListener("mouseleave", () => { if (!isDragging()) gripRow.style.opacity = "0"; });
    if (headerTr) {
      headerTr.addEventListener("mouseenter", () => { if (!isDragging()) gripRow.style.opacity = "1"; });
      headerTr.addEventListener("mouseleave", () => { if (!isDragging()) gripRow.style.opacity = "0"; });
    }

    table.querySelectorAll("tr").forEach((tr, trIdx) => {
      if (trIdx === 0) return;
      const grip = tr.querySelector(".nexus-row-grip") as HTMLElement | null;
      if (!grip) return;
      tr.addEventListener("mouseenter", () => { if (!isDragging()) grip.style.opacity = "1"; });
      tr.addEventListener("mouseleave", () => { if (!isDragging()) grip.style.opacity = "0"; });
    });

    addCol.addEventListener("mouseenter", () => { if (!isDragging()) addCol.style.opacity = "1"; });
    addCol.addEventListener("mouseleave", () => { if (!isDragging()) addCol.style.opacity = "0"; });
    table.querySelectorAll("tr").forEach((tr, trIdx) => {
      if (trIdx === 0) return;
      const cells = tr.querySelectorAll("th,td");
      const lastCell = cells[cells.length - 1] as HTMLElement | null;
      if (lastCell) {
        lastCell.addEventListener("mouseenter", () => { if (!isDragging()) addCol.style.opacity = "1"; });
        lastCell.addEventListener("mouseleave", () => { if (!isDragging()) addCol.style.opacity = "0"; });
      }
    });

    addRow.addEventListener("mouseenter", () => { addRow.style.opacity = "1"; });
    addRow.addEventListener("mouseleave", () => { addRow.style.opacity = "0"; });
    const allDataRows = Array.from(table.querySelectorAll("tr")).filter((_, i) => i > 0);
    const lastDataRow = allDataRows[allDataRows.length - 1] as HTMLElement | undefined;
    if (lastDataRow) {
      lastDataRow.addEventListener("mouseenter", () => { addRow.style.opacity = "1"; });
      lastDataRow.addEventListener("mouseleave", () => { addRow.style.opacity = "0"; });
    }

    wrapper.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".nexus-cell") &&
          !(e.target as HTMLElement).closest(".nexus-row-grip") &&
          !(e.target as HTMLElement).closest(".nexus-col-grip")) {
        clearSelection();
      }
    });

    wrapper.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        // Range selection: clear cell contents in selected range
        const range = getNormalizedRange();
        if (range) {
          e.preventDefault();
          const lines = self.source.split("\n");
          const dl: number[] = [];
          for (let i = 0; i < lines.length; i++) if (!SEPARATOR_RE.test(lines[i])) dl.push(i);
          for (let r = range.r1; r <= range.r2; r++) {
            const lineIdx = dl[r];
            if (lineIdx === undefined) continue;
            const cells = lines[lineIdx].split("|").filter((_, i, a) => i > 0 && i < a.length - 1);
            for (let c = range.c1; c <= range.c2; c++) {
              if (c < cells.length) cells[c] = "  ";
            }
            lines[lineIdx] = "|" + cells.join("|") + "|";
          }
          self.dispatch(lines.join("\n"));
          clearRangeSelection();
          return;
        }
        // Column/row grip selection: delete column/row
        if (selectedCol >= 0) {
          e.preventDefault();
          self.deleteColumn(selectedCol);
        } else if (selectedRow >= 0) {
          e.preventDefault();
          self.deleteRow(selectedRow);
        }
      }
    });
    wrapper.tabIndex = -1;
    wrapper.style.outline = "none";

    return wrapper;
  }
}

function showContextMenu(
  x: number, y: number,
  widget: EditableTableWidget,
  rowIdx: number, isHeader: boolean,
  colIdx: number, colCount: number, rowCount: number,
  container: HTMLElement
): void {
  container.querySelector(".nexus-table-ctx")?.remove();

  const menu = document.createElement("div");
  menu.className = "nexus-table-ctx";
  menu.style.cssText =
    "position:fixed;z-index:9999;background:#fff;border:1px solid #ddd;border-radius:6px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.12);padding:4px 0;min-width:140px;font-size:13px;";
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  function addItem(label: string, action: () => void, disabled = false): void {
    const item = document.createElement("div");
    item.textContent = label;
    item.style.cssText = "padding:6px 16px;cursor:pointer;white-space:nowrap;";
    if (disabled) {
      item.style.color = "#ccc";
      item.style.cursor = "default";
    } else {
      item.addEventListener("mouseenter", () => { item.style.background = "#f0f0f0"; });
      item.addEventListener("mouseleave", () => { item.style.background = ""; });
      item.addEventListener("click", () => { menu.remove(); action(); });
    }
    menu.appendChild(item);
  }

  if (!isHeader) {
    addItem("Delete row", () => (widget as any).deleteRow(rowIdx));
  }
  addItem("Delete column", () => (widget as any).deleteColumn(colIdx));
  addItem("Add row below", () => (widget as any).addRow());
  addItem("Add column right", () => (widget as any).addColumn());

  document.body.appendChild(menu);

  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}
