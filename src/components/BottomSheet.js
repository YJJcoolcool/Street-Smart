export class BottomSheet {
  constructor(elements) {
    this.elements = elements;
    this.mode = "search";
    this.dragging = false;
    this.dragMoved = false;
    this.dragStartY = 0;
    this.dragStartOffset = 0;
    this.pointerId = null;

    elements.sheetHandle.addEventListener("click", () => {
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      this.setCollapsed(!elements.sheet.classList.contains("collapsed"));
    });
    elements.sheetHandle.addEventListener("pointerdown", (event) => this.startDrag(event));
    elements.sheetHandle.addEventListener("pointermove", (event) => this.drag(event));
    elements.sheetHandle.addEventListener("pointerup", (event) => this.endDrag(event));
    elements.sheetHandle.addEventListener("pointercancel", (event) => this.endDrag(event));
  }

  setMode(mode, { expand = true, title, subtitle } = {}) {
    this.mode = mode;
    this.elements.searchPanel.hidden = mode !== "search";
    this.elements.routePanel.hidden = mode !== "route";
    this.elements.editPanel.hidden = mode !== "edit";
    this.elements.sheetTitle.textContent = title || titleForMode(mode);
    this.elements.sheetSubtitle.textContent = subtitle || subtitleForMode(mode);
    this.elements.sheetTurnIcon.hidden = true;
    this.elements.sheetHandle.classList.remove("has-turn");
    this.setCollapsed(!expand);
  }

  update(title, subtitle, { icon = null } = {}) {
    if (title) this.elements.sheetTitle.textContent = title;
    if (subtitle) this.elements.sheetSubtitle.textContent = subtitle;
    this.elements.sheetTurnIcon.hidden = !icon;
    this.elements.sheetHandle.classList.toggle("has-turn", Boolean(icon));
    if (icon) this.elements.sheetTurnIcon.textContent = icon;
  }

  setCollapsed(collapsed) {
    this.elements.sheet.style.transform = "";
    this.elements.sheet.classList.toggle("collapsed", collapsed);
    this.elements.sheetHandle.setAttribute("aria-expanded", String(!collapsed));
  }

  startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    this.dragging = true;
    this.dragMoved = false;
    this.pointerId = event.pointerId;
    this.dragStartY = event.clientY;
    this.dragStartOffset = this.elements.sheet.classList.contains("collapsed")
      ? collapsedOffset(this.elements.sheet)
      : 0;
    this.elements.sheet.classList.add("dragging");
    this.elements.sheetHandle.setPointerCapture?.(event.pointerId);
  }

  drag(event) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const offset = clamp(this.dragStartOffset + event.clientY - this.dragStartY, 0, collapsedOffset(this.elements.sheet));
    if (Math.abs(event.clientY - this.dragStartY) > 4) this.dragMoved = true;
    this.elements.sheet.classList.remove("collapsed");
    this.elements.sheet.style.transform = `translateY(${offset}px)`;
    event.preventDefault();
  }

  endDrag(event) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.elements.sheet.classList.remove("dragging");
    this.elements.sheetHandle.releasePointerCapture?.(event.pointerId);
    if (!this.dragMoved) return;
    const offset = this.currentOffset();
    this.elements.sheet.style.transform = "";
    this.setCollapsed(offset > collapsedOffset(this.elements.sheet) * 0.45);
  }

  currentOffset() {
    const transform = this.elements.sheet.style.transform;
    const match = transform.match(/translateY\(([-\d.]+)px\)/);
    return match ? Number(match[1]) : 0;
  }
}

function collapsedOffset(sheet) {
  return Math.max(0, sheet.getBoundingClientRect().height - 74);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function titleForMode(mode) {
  return {
    search: "Street Smart",
    route: "Trip",
    edit: "Edit map"
  }[mode] || "Street Smart";
}

function subtitleForMode(mode) {
  return {
    search: "Search or start navigation",
    route: "Start and end location",
    edit: "Report map data"
  }[mode] || "";
}
