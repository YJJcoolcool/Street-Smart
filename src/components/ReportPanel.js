import { labelForMode } from "../lib/format.js";
import { fetchStudioReports, publishReport } from "../lib/api.js";

export class ReportPanel {
  constructor({ state, elements, sheet }) {
    this.state = state;
    this.elements = elements;
    this.sheet = sheet;
    this.layersInstalled = false;
  }

  bind() {
    this.elements.editMapButton.addEventListener("click", () => {
      window.location.href = "/studio.html";
    });

    this.elements.reportButtons.forEach((button) => {
      button.addEventListener("click", () => this.addReport(button.dataset.signal));
    });
    window.addEventListener("street-smart-reports-changed", () => {
      this.loadLocalReports();
      this.render();
    });

    this.state.map.on("load", () => this.renderMapReports());
  }

  open() {
    this.sheet.setMode("edit", {
      expand: true,
      subtitle: `${this.state.reports.length} open reports`
    });
  }

  load() {
    this.loadLocalReports();
    this.render();
    this.syncReports();
  }

  loadLocalReports() {
    try {
      this.state.reports = JSON.parse(localStorage.getItem("street-smart-reports") || "[]")
        .map(normalizeReportLocation)
        .filter(Boolean);
    } catch {
      this.state.reports = [];
    }
  }

  addReport(type) {
    const center = this.state.map.getCenter();
    const activeRoute = this.state.route.routes[this.state.route.activeIndex];
    const context = activeRoute && this.state.startPlace && this.state.endPlace
      ? `${labelForMode(this.state.activeMode)} route: ${this.state.startPlace.name} to ${this.state.endPlace.name}`
      : this.state.selectedPlace?.name || `Map center ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;

    const report = {
      id: crypto.randomUUID(),
      type,
      context,
      mode: this.state.activeMode,
      lat: center.lat,
      lng: center.lng,
      createdAt: new Date().toISOString()
    };
    this.state.reports.unshift(report);
    this.store();
    this.render();
    this.open();
    publishReport(report).catch((error) => {
      console.warn("Report saved locally but could not be sent to Studio.", error);
    });
  }

  async syncReports() {
    try {
      const localReports = this.state.reports;
      await Promise.all(localReports.map((report) => publishReport(report).catch(() => null)));
      this.state.reports = await fetchStudioReports();
      this.state.reports = this.state.reports.map(normalizeReportLocation).filter(Boolean);
      this.store();
      this.render();
    } catch (error) {
      console.warn("Using local report cache.", error);
    }
  }

  store() {
    localStorage.setItem("street-smart-reports", JSON.stringify(this.state.reports.slice(0, 200)));
  }

  render() {
    this.elements.signalCount.textContent = `${this.state.reports.length} open`;
    this.elements.emptySignal.hidden = this.state.reports.length > 0;
    this.elements.signalList.innerHTML = "";

    this.state.reports.forEach((report) => {
      const item = document.createElement("li");
      item.className = "signal-item";
      const time = new Date(report.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      item.innerHTML = `
        <strong></strong>
        <span></span>
      `;
      item.querySelector("strong").textContent = report.type;
      item.querySelector("span").textContent = `${report.context} - ${time}`;
      this.elements.signalList.append(item);
    });
    this.renderMapReports();
  }

  renderMapReports() {
    this.state.map?.getSource("user-reports")?.setData(reportFeatureCollection([]));
  }
}

function reportFeatureCollection(reports) {
  return {
    type: "FeatureCollection",
    features: reports
      .map(normalizeReportLocation)
      .filter(Boolean)
      .map((report) => ({
        type: "Feature",
        properties: {
          id: report.id,
          type: report.type
        },
        geometry: {
          type: "Point",
          coordinates: [report.lng, report.lat]
        }
      }))
  };
}

function normalizeReportLocation(report) {
  const point = reportPoint(report);
  if (!point) return null;
  const [lng, lat] = point;
  return { ...report, lat, lng };
}

function reportPoint(report) {
  const lat = Number(report?.lat ?? report?.location?.lat);
  const lng = Number(report?.lng ?? report?.location?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return [lng, lat];
  if (isLngLat(report?.deviation?.point)) return report.deviation.point;
  const actualLine = Array.isArray(report?.deviation?.actualLine)
    ? report.deviation.actualLine.filter(isLngLat)
    : [];
  if (actualLine.length) return actualLine.at(-1);
  return null;
}

function formatReportLocation(report) {
  return `${Number(report.lat).toFixed(5)}, ${Number(report.lng).toFixed(5)}`;
}

function isLngLat(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]));
}
