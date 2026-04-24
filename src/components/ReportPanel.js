import { labelForMode } from "../lib/format.js";
import { fetchStudioReports, publishReport } from "../lib/api.js";

const REPORT_CLUSTER_RADIUS = 30;
const REPORT_CLUSTER_MAX_ZOOM = 12;

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

    this.state.map.on("load", () => {
      this.installLayers();
      this.renderMapReports();
    });
    ["moveend", "zoomend"].forEach((eventName) => {
      this.state.map.on(eventName, () => this.renderMapReports());
    });
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

  installLayers() {
    const map = this.state.map;
    if (!map.getSource("user-reports")) {
      map.addSource("user-reports", {
        type: "geojson",
        data: reportFeatureCollection([]),
        cluster: true,
        clusterRadius: REPORT_CLUSTER_RADIUS,
        clusterMaxZoom: REPORT_CLUSTER_MAX_ZOOM
      });
    }

    if (!map.getLayer("user-report-clusters")) {
      map.addLayer({
        id: "user-report-clusters",
        type: "circle",
        source: "user-reports",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#c26a28",
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, 32],
          "circle-opacity": 0.92,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3
        }
      });
    }

    if (!map.getLayer("user-report-cluster-count")) {
      map.addLayer({
        id: "user-report-cluster-count",
        type: "symbol",
        source: "user-reports",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12
        },
        paint: {
          "text-color": "#ffffff"
        }
      });
    }

    if (!map.getLayer("user-report-point")) {
      map.addLayer({
        id: "user-report-point",
        type: "circle",
        source: "user-reports",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#c26a28",
          "circle-radius": 8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3
        }
      });
    }

    if (!this.layersInstalled) {
      map.on("click", "user-report-clusters", (event) => this.openReportCluster(event));
      map.on("click", "user-report-point", (event) => this.focusReportPoint(event));
    }
    this.layersInstalled = true;
  }

  renderMapReports() {
    if (!this.state.map?.isStyleLoaded()) return;
    this.installLayers();
    this.state.map.getSource("user-reports")?.setData(reportFeatureCollection(this.reportsInView()));
  }

  reportsInView() {
    const bounds = this.state.map.getBounds();
    return this.state.reports.filter((report) => {
      const point = reportPoint(report);
      return point && bounds.contains(point);
    });
  }

  async openReportCluster(event) {
    const feature = event.features?.[0];
    const source = this.state.map.getSource("user-reports");
    if (!feature || !source) return;

    try {
      const zoom = await getClusterExpansionZoom(source, feature.properties.cluster_id);
      this.state.map.easeTo({
        center: feature.geometry.coordinates,
        zoom: Math.min(Math.max(this.state.map.getZoom() + 1, zoom + 0.5), 17.5),
        duration: 550
      });
    } catch (error) {
      console.warn("Could not expand report cluster.", error);
    }
  }

  focusReportPoint(event) {
    const id = event.features?.[0]?.properties?.id;
    const report = this.state.reports.find((candidate) => candidate.id === id);
    if (!report) return;
    this.state.map.easeTo({
      center: [report.lng, report.lat],
      zoom: Math.max(this.state.map.getZoom(), 16),
      duration: 500
    });
    this.elements.status.textContent = `${report.type}: ${report.context || formatReportLocation(report)}`;
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

function getClusterExpansionZoom(source, clusterId) {
  return new Promise((resolve, reject) => {
    const result = source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) reject(error);
      else resolve(zoom);
    });
    if (result?.then) result.then(resolve).catch(reject);
  });
}
