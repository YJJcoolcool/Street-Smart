import { fetchRoute, publishReport } from "../lib/api.js";
import { bearingBetween, emptyFeatureCollection, fitRoute, movePoint, nearestRouteProgress, parseLatLng, routeFeatureCollection, trafficFeatureCollection } from "../lib/geo.js";
import { formatDistance, formatDuration, formatLatLng, labelForMode } from "../lib/format.js";

export class RoutePanel {
  constructor({ state, elements, sheet, searchPanel, locationLayer, setStatus }) {
    this.state = state;
    this.elements = elements;
    this.sheet = sheet;
    this.searchPanel = searchPanel;
    this.locationLayer = locationLayer;
    this.setStatus = setStatus;
    this.simulationTimer = null;
    this.deviationTimer = null;
    this.manualFrame = null;
    this.manualKeys = new Set();
    this.lastManualFrame = 0;
    this.lastDeviationCheck = 0;
    this.lastDeviationReroute = -Infinity;
    this.deviationRerouteInFlight = false;
    this.rerouteInstructionLoading = false;
    this.rerouteInstructionLoadingStartedAt = 0;
    this.routeEditMode = null;
    this.deviationMap = null;
  }

  bind() {
    this.elements.navigateButton.addEventListener("click", () => {
      this.open({
        endText: this.state.selectedPlace?.name || this.elements.input.value.trim(),
        endPlace: this.state.selectedPlace
      });
    });

    this.elements.routeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.locationLayer.watchHeading({ requestPermission: true });
      if (this.routeEditMode) {
        this.calculate({ startNavigation: this.state.navigation.active });
      } else if (this.state.route.routes.length && !this.state.navigation.active) {
        this.startNavigation();
        this.sheet.setCollapsed(true);
      } else {
        this.calculate({ startNavigation: true });
      }
    });

    this.elements.clearRoute.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const routeStatus = this.elements.routeStatus.textContent.trim().toLowerCase();
      if (this.state.navigation.active && routeStatus !== "stopped" && routeStatus !== "arrived") {
        this.stopNavigation();
        return;
      }
      this.returnToStartState({ status: "Search for a place or start navigation." });
    });
    this.elements.editRouteLocations.addEventListener("click", () => this.editLocations());
    this.elements.addStop.addEventListener("click", () => this.startAddStop());
    this.elements.routeCancelButton.addEventListener("click", () => this.cancelRouteEdit());
    [this.elements.startInput, this.elements.endInput].forEach((input) => {
      input.addEventListener("change", () => {
        input.dataset.place = "";
      });
    });
    this.elements.routeForm.querySelectorAll(".route-point-input .route-row-up").forEach((button) => {
      button.addEventListener("click", () => this.moveRouteInput(this.rowIndexFor(button), -1));
    });
    this.elements.routeForm.querySelectorAll(".route-point-input .route-row-down").forEach((button) => {
      button.addEventListener("click", () => this.moveRouteInput(this.rowIndexFor(button), 1));
    });
    this.elements.simulateRoute.addEventListener("click", () => this.startSimulation());
    this.elements.pauseSimulation.addEventListener("click", () => this.togglePause());
    this.elements.manualControl.addEventListener("click", () => this.toggleManualControl());
    this.elements.deviationClose.addEventListener("click", () => this.dismissDeviationPrompt());
    this.elements.tellUsWhy.addEventListener("click", () => {
      const willShowCategories = this.elements.deviationCategoryPanel.hidden;
      this.elements.deviationCategoryPanel.hidden = !willShowCategories;
      this.elements.deviationReportPanel.hidden = true;
      if (willShowCategories) {
        window.requestAnimationFrame(() => this.renderDeviationPreview());
      }
    });
    this.elements.deviationCategoryButtons.forEach((button) => {
      button.addEventListener("click", () => this.showDeviationCategory(button.dataset.category));
    });
    this.elements.deviationReportBack.addEventListener("click", () => this.showDeviationCategories());
    this.elements.deviationButtons.forEach((button) => {
      button.addEventListener("click", () => this.recordDeviation(button.dataset.reason));
    });
    window.addEventListener("keydown", (event) => this.handleKeydown(event));
    window.addEventListener("keyup", (event) => this.handleKeyup(event));

    this.state.map.on("load", () => {
      this.installLayers();
    });
  }

  async open({ endText = "", endPlace = null, calculate = false } = {}) {
    if (this.state.navigation.active && this.state.addingStop && endPlace) {
      this.addStop(endPlace);
      return;
    }

    this.sheet.setMode("route", { expand: true, subtitle: "Start and end location" });
    this.searchPanel.setMapResultsVisible(false);
    this.prepareCurrentLocation();
    this.state.addingStop = false;
    this.state.routeStops = [];

    this.state.startPlace = this.state.currentPlace;
    this.state.endPlace = endPlace;
    this.elements.startInput.value = "Current location";
    this.elements.endInput.value = endText;
    this.elements.startInput.dataset.place = JSON.stringify(this.state.currentPlace);
    this.elements.endInput.dataset.place = endPlace ? JSON.stringify(endPlace) : "";
    this.renderStopInputs();
    if (calculate && endPlace) {
      await this.calculate({ startNavigation: false });
    } else {
      this.elements.endInput.focus();
    }
  }

  async calculate({ startNavigation = false } = {}) {
    this.sheet.setMode("route", { expand: true, subtitle: "Calculating route..." });
    this.setRouteLoading(true);
    this.showRouteError("");
    this.state.route = {
      routes: [],
      activeIndex: 0,
      loading: true,
      error: null
    };
    this.clearLines();
    this.setRouteDetails("Routing");

    try {
      const routeDrafts = this.getRouteDrafts();
      const resolvedPlaces = await Promise.all(routeDrafts.map((draft, index) => {
        const fallback = draft.place
          || (index === 0 ? this.state.startPlace || this.state.currentPlace : null)
          || (index === routeDrafts.length - 1 ? this.state.endPlace : null);
        return this.resolvePlace(draft.value, fallback);
      }));
      const origin = resolvedPlaces[0];
      const destination = resolvedPlaces.at(-1);
      const stops = resolvedPlaces.slice(1, -1);

      if (!origin || !destination) throw new Error("Choose both a start and end location.");
      if (stops.some((stop) => !stop)) throw new Error("Choose a place for every stop, or remove the empty stop.");

      this.state.startPlace = origin;
      this.state.endPlace = destination;
      this.state.routeStops = stops;
      this.elements.startInput.value = origin.name || formatLatLng(origin);
      this.elements.startInput.dataset.place = JSON.stringify(origin);
      this.elements.endInput.value = destination.name || formatLatLng(destination);
      this.elements.endInput.dataset.place = JSON.stringify(destination);
      this.renderStopInputs();

      const routes = await fetchRoute({
        origin,
        destination,
        stops: this.state.routeStops,
        profile: this.state.activeMode,
        provider: this.state.preferences.routingProvider
      });
      if (!routes.length) throw new Error("Grab routing did not return route geometry.");

      this.state.route = {
        routes,
        activeIndex: 0,
        loading: false,
        error: null
      };
      this.renderRoute();
      this.renderAnchorMarkers(origin, destination);
      fitRoute(this.state.map, routes[0], origin, destination, routePaddingForSheet());
      this.setRouteDetails("Ready");
      this.renderAlternatives();
      this.updateRouteChip();
      if (startNavigation) {
        this.routeEditMode = null;
        this.startNavigation();
        this.sheet.setCollapsed(true);
      } else {
        this.routeEditMode = null;
        this.elements.routeForm.hidden = false;
        this.elements.routeCancelButton.hidden = true;
        this.elements.navigationCard.hidden = true;
        this.sheet.setMode("route", { expand: true, subtitle: "Route preview" });
      }
      this.setStatus(routeStatusMessage(routes));
    } catch (error) {
      console.error(error);
      this.state.route.loading = false;
      this.state.route.error = error.message;
      this.elements.routeChip.hidden = true;
      this.setRouteDetails("Unavailable");
      this.showRouteError(error.message || "Route calculation failed.");
      this.setStatus(error.message || "Route calculation failed.");
    } finally {
      this.setRouteLoading(false);
    }
  }

  selectRoute(index) {
    this.state.route.activeIndex = index;
    this.renderRoute();
    this.setRouteDetails("Ready");
    this.renderAlternatives();
    this.updateRouteChip();
  }

  get activeRoute() {
    return this.state.route.routes[this.state.route.activeIndex] || null;
  }

  installLayers() {
    const map = this.state.map;
    if (!map.getSource("route-alternatives")) {
      map.addSource("route-alternatives", {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }
    if (!map.getSource("route-active")) {
      map.addSource("route-active", {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getLayer("route-alt-path")) {
      map.addLayer({
        id: "route-alt-path",
        type: "line",
        source: "route-alternatives",
        paint: {
          "line-color": "#64748b",
          "line-width": 4,
          "line-opacity": 0.72
        }
      });
    }

    if (!map.getLayer("route-active-casing")) {
      map.addLayer({
        id: "route-active-casing",
        type: "line",
        source: "route-active",
        paint: {
          "line-color": "#ffffff",
          "line-width": 9,
          "line-opacity": 0.9
        }
      });
    }

    if (!map.getLayer("route-active-path")) {
      map.addLayer({
        id: "route-active-path",
        type: "line",
        source: "route-active",
        paint: {
          "line-color": [
            "match",
            ["get", "trafficLevel"],
            "clear", "#0f8f68",
            "moderate", "#f5b301",
            "heavy", "#ea580c",
            "severe", "#dc2626",
            "#2563eb"
          ],
          "line-width": 5,
          "line-opacity": 0.96
        }
      });
    }
  }

  renderRoute() {
    if (!this.state.map.isStyleLoaded()) {
      this.state.map.once("styledata", () => this.renderRoute());
      return;
    }
    this.installLayers();
    const activeRoute = this.activeRoute;
    const alternatives = this.state.route.routes.filter((_, index) => index !== this.state.route.activeIndex);
    this.state.map.getSource("route-active").setData(activeRoute ? trafficFeatureCollection(activeRoute) : emptyFeatureCollection());
    this.state.map.getSource("route-alternatives").setData(routeFeatureCollection(alternatives));
  }

  clearLines() {
    const map = this.state.map;
    if (!map) return;
    if (!map.isStyleLoaded()) {
      map.once("styledata", () => this.clearLines());
      return;
    }
    if (!map.getSource("route-active") || !map.getSource("route-alternatives")) this.installLayers();
    map.getSource("route-active")?.setData(emptyFeatureCollection());
    map.getSource("route-alternatives")?.setData(emptyFeatureCollection());
  }

  clear() {
    this.returnToStartState({ status: "Route cleared." });
  }

  stopNavigation({ arrived = false, keepDeviationPrompt = false } = {}) {
    if (!this.state.navigation.active) {
      this.returnToStartState({ status: "Search for a place or start navigation." });
      return;
    }

    const shouldKeepDeviationPrompt = keepDeviationPrompt && !this.elements.deviationPrompt.hidden;
    window.clearInterval(this.simulationTimer);
    this.stopDeviationMonitor();
    this.stopManualLoop();
    this.state.navigation = {
      active: false,
      simulating: false,
      paused: false,
      manualControl: false,
      progressIndex: 0,
      routeProgressMeters: 0,
      heading: null,
      trace: [],
      lastTracePoint: null,
      startedAt: null,
      endedAt: null,
      actualDistanceMeters: 0,
      deviations: this.state.navigation.deviations || []
    };
    this.rerouteInstructionLoading = false;
    this.rerouteInstructionLoadingStartedAt = 0;
    if (arrived && this.state.lastTripStats) {
      this.elements.routeDistance.textContent = formatDistance(this.state.lastTripStats.distance);
      this.elements.routeDuration.textContent = formatActualDuration(this.state.lastTripStats.duration);
      this.elements.routeStatus.textContent = "Actual trip";
    }
    this.elements.sheetHandle.classList.remove("is-loading", "is-error");
    this.elements.nextStepPrimary.closest(".next-step")?.classList.remove("is-loading", "is-error");
    this.elements.navigationCard.hidden = true;
    if (!shouldKeepDeviationPrompt) {
      this.elements.deviationPrompt.hidden = true;
      this.elements.deviationCategoryPanel.hidden = true;
      this.elements.deviationReportPanel.hidden = true;
    }
    this.elements.editMapButton.hidden = false;
    this.elements.topControls.hidden = false;
    this.elements.pauseSimulation.disabled = true;
    this.elements.manualControl.disabled = true;
    this.elements.pauseSimulation.querySelector("span:last-child").textContent = "Pause";
    this.syncSimulationButtons();
    this.locationLayer.setNavigationMode(false);
    this.searchPanel.setMapResultsVisible(true);
    this.renderRoute();
    this.elements.routeChip.hidden = false;
    const activeRoute = this.activeRoute;
    if (activeRoute && this.state.startPlace && this.state.endPlace) {
      fitRoute(this.state.map, activeRoute, this.state.startPlace, this.state.endPlace, routePaddingForSheet());
    }
    this.state.map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 700
    });
    this.setRouteDetails(arrived ? "Arrived" : "Stopped");
    if (shouldKeepDeviationPrompt) {
      this.elements.deviationPrompt.hidden = false;
      this.sheet.setMode("route", { expand: true, title: "Arrived", subtitle: "Deviation report pending" });
    }
    this.setStatus(arrived ? "Arrived at your destination." : "Navigation stopped. The route remains on the map.");
  }

  returnToStartState({ status = "Search for a place or start navigation." } = {}) {
    window.clearInterval(this.simulationTimer);
    this.stopDeviationMonitor();
    this.stopManualLoop();
    this.clearLines();

    Object.values(this.state.anchorMarkers || {}).forEach((marker) => marker?.remove());
    this.state.anchorMarkers = { origin: null, destination: null };
    this.state.startPlace = null;
    this.state.endPlace = null;
    this.state.routeStops = [];
    this.state.addingStop = false;
    this.routeEditMode = null;
    this.rerouteInstructionLoading = false;
    this.rerouteInstructionLoadingStartedAt = 0;
    this.state.route = { routes: [], activeIndex: 0, loading: false, error: null };
    this.state.navigation = { active: false, simulating: false, paused: false, manualControl: false, progressIndex: 0, routeProgressMeters: 0, heading: null, trace: [], lastTracePoint: null, startedAt: null, endedAt: null, actualDistanceMeters: 0, deviations: [] };
    this.state.lastTripStats = null;
    this.state.places = [];
    this.state.selectedPlace = null;
    this.state.lastSearchQuery = "";

    this.elements.input.value = "";
    this.elements.results.innerHTML = "";
    this.elements.count.textContent = "0";
    this.elements.searchAreaButton.hidden = true;
    this.elements.routeChip.hidden = true;
    this.elements.routeDetails.hidden = true;
    this.elements.routeForm.hidden = false;
    this.elements.routeCancelButton.hidden = true;
    this.elements.navigationCard.hidden = true;
    this.elements.nextStepPrimary.closest(".next-step").hidden = false;
    this.elements.deviationPrompt.hidden = true;
    this.elements.deviationCategoryPanel.hidden = true;
    this.elements.deviationReportPanel.hidden = true;
    this.elements.routeAlternatives.innerHTML = "";
    this.elements.directionsList.innerHTML = "";
    this.elements.sheetHandle.classList.remove("is-loading", "is-error");
    this.elements.nextStepPrimary.closest(".next-step")?.classList.remove("is-loading", "is-error");
    this.elements.editMapButton.hidden = false;
    this.elements.topControls.hidden = false;
    this.elements.settingsPanel.hidden = true;
    this.elements.pauseSimulation.disabled = true;
    this.elements.manualControl.disabled = true;
    this.elements.pauseSimulation.querySelector("span:last-child").textContent = "Pause";

    if (this.deviationMap) {
      this.deviationMap.remove();
      this.deviationMap = null;
    }
    this.elements.deviationPreview.textContent = "";
    this.elements.deviationPreview.classList.remove("is-empty");

    this.showRouteError("");
    this.setRouteLoading(false);
    this.syncRouteSubmitLabel();
    this.syncSimulationButtons();
    this.renderStopInputs();
    this.locationLayer.setNavigationMode(false);
    this.searchPanel.clearMapResults();
    this.searchPanel.updatePoweredBy("grabmaps");
    this.clearLines();
    this.sheet.setMode("search", {
      expand: false,
      title: "Street Smart",
      subtitle: "Search or start navigation"
    });
    this.state.map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 700
    });
    this.setStatus(status);
  }

  renderAnchorMarkers(origin, destination) {
    Object.values(this.state.anchorMarkers || {}).forEach((marker) => marker?.remove());
    const markers = { origin: makeAnchorMarker("A", origin).addTo(this.state.map) };
    this.state.routeStops.forEach((stop, index) => {
      markers[`stop-${index}`] = makeAnchorMarker(String(index + 1), stop).addTo(this.state.map);
    });
    markers.destination = makeAnchorMarker("B", destination).addTo(this.state.map);
    this.state.anchorMarkers = markers;
  }

  setRouteDetails(status) {
    const activeRoute = this.activeRoute;
    this.elements.routeDetails.hidden = false;
    this.elements.routeStatus.textContent = status;
    this.elements.routeTitle.textContent = `${labelForMode(this.state.activeMode)} route`;
    this.elements.routeDistance.textContent = activeRoute ? formatDistance(activeRoute.distance) : "--";
    this.elements.routeDuration.textContent = activeRoute ? formatDuration(activeRoute.duration) : "--";
    this.updateRouteProvider(activeRoute);
    if (activeRoute && status === "Ready") {
      this.elements.routeStatus.textContent = activeRoute.trafficSummary?.label || "Traffic-aware";
    }
    this.renderRouteLocations();

    const subtitle = activeRoute && this.state.startPlace && this.state.endPlace
      ? `${this.state.startPlace.name} to ${this.state.endPlace.name}`
      : "Start and end location";
    if (!(this.rerouteInstructionLoading && this.state.navigation.active)) {
      this.sheet.update("Trip", subtitle);
    }
  }

  renderRouteLocations() {
    const places = [
      { label: "Start", place: this.state.startPlace },
      ...this.state.routeStops.map((place, index) => ({ label: `Stop ${index + 1}`, place })),
      { label: "End", place: this.state.endPlace }
    ].filter((item) => item.place);

    this.elements.routeLocationList.innerHTML = "";
    places.forEach(({ label, place }) => {
      const item = document.createElement("div");
      item.className = "route-location";
      item.innerHTML = `
        <span></span>
        <div>
          <strong></strong>
          <small></small>
        </div>
      `;
      item.querySelector("span").textContent = label[0];
      item.querySelector("strong").textContent = label;
      item.querySelector("small").textContent = place.name || formatLatLng(place);
      this.elements.routeLocationList.append(item);
    });
  }

  startNavigation() {
    const activeRoute = this.activeRoute;
    if (!activeRoute) return;

    this.state.navigation.active = true;
    this.state.navigation.manualControl = false;
    this.state.navigation.progressIndex = 0;
    this.state.navigation.routeProgressMeters = 0;
    this.state.navigation.trace = [];
    this.state.navigation.lastTracePoint = null;
    this.state.navigation.startedAt = Date.now();
    this.state.navigation.endedAt = null;
    this.state.navigation.actualDistanceMeters = 0;
    this.state.lastTripStats = null;
    this.elements.routeForm.hidden = true;
    this.elements.editMapButton.hidden = true;
    this.elements.topControls.hidden = true;
    this.elements.searchAreaButton.hidden = true;
    this.elements.settingsPanel.hidden = true;
    this.elements.navigationCard.hidden = false;
    this.elements.nextStepPrimary.closest(".next-step").hidden = true;
    this.elements.pauseSimulation.disabled = false;
    this.elements.manualControl.disabled = false;
    this.state.addingStop = false;
    this.routeEditMode = null;
    this.searchPanel.clearMapResults();
    this.renderDirections();
    this.updateCurrentInstruction();
    this.locationLayer.setNavigationMode(true);
    this.startDeviationMonitor();
    this.focusNavigationCamera();
  }

  startDeviationMonitor() {
    this.stopDeviationMonitor();
    this.lastDeviationCheck = performance.now();
    this.deviationTimer = window.setInterval(() => {
      this.checkLatestDeviationPoint();
    }, DEVIATION_MONITOR_INTERVAL_MS);
  }

  stopDeviationMonitor() {
    if (this.deviationTimer) window.clearInterval(this.deviationTimer);
    this.deviationTimer = null;
  }

  checkLatestDeviationPoint({ force = false } = {}) {
    if (!this.state.navigation.active) return;
    if (this.state.navigation.simulating && !this.state.navigation.manualControl) return;
    const point = this.latestNavigationPoint();
    if (!point) return;

    const now = performance.now();
    if (!force && now - this.lastDeviationCheck < DEVIATION_CHECK_INTERVAL_MS) return;
    this.lastDeviationCheck = now;
    this.recordNavigationTrace(point);
    this.checkDeviation(point).finally(() => this.updateCurrentInstruction());
  }

  latestNavigationPoint() {
    const place = this.state.currentPlace;
    if (!place || !Number.isFinite(place.lng) || !Number.isFinite(place.lat)) return null;
    return [place.lng, place.lat];
  }

  editLocations() {
    this.prepareCurrentLocation();
    this.state.startPlace = this.state.currentPlace;
    this.elements.startInput.value = "Current location";
    this.elements.startInput.dataset.place = JSON.stringify(this.state.currentPlace);
    this.elements.endInput.value = this.state.endPlace?.name || "";
    this.elements.endInput.dataset.place = this.state.endPlace ? JSON.stringify(this.state.endPlace) : "";
    this.state.addingStop = false;
    this.routeEditMode = "edit";
    this.renderStopInputs();
    this.syncRouteSubmitLabel();
    this.elements.routeForm.hidden = false;
    this.elements.routeCancelButton.hidden = false;
    this.elements.navigationCard.hidden = true;
    this.elements.nextStepPrimary.closest(".next-step").hidden = false;
    this.sheet.setMode("route", { expand: true, subtitle: "Edit route locations" });
    this.renderRouteLocations();
    this.searchPanel.setMapResultsVisible(false);
  }

  startAddStop() {
    this.prepareCurrentLocation();
    this.state.addingStop = true;
    this.routeEditMode = "add-stop";
    this.elements.startInput.value = "Current location";
    this.elements.startInput.dataset.place = JSON.stringify(this.state.currentPlace);
    this.elements.endInput.value = this.state.endPlace?.name || "";
    this.elements.endInput.dataset.place = this.state.endPlace ? JSON.stringify(this.state.endPlace) : "";
    this.renderStopInputs({ addBlank: true });
    this.syncRouteSubmitLabel();
    this.elements.routeForm.hidden = false;
    this.elements.routeCancelButton.hidden = false;
    this.elements.navigationCard.hidden = true;
    this.elements.nextStepPrimary.closest(".next-step").hidden = false;
    this.sheet.setMode("route", { expand: true, subtitle: "Add a stop" });
    this.searchPanel.setMapResultsVisible(false);
    this.setStatus("Add a stop between the start and end locations.");
    this.elements.stopInputList.querySelector(".route-stop-input:last-child input")?.focus();
  }

  async addStop(place) {
    if (!place || !this.state.endPlace) return;
    this.state.routeStops.push(place);
    this.state.addingStop = false;
    this.searchPanel.clearMapResults();
    this.sheet.setMode("route", { expand: true, subtitle: "Adding stop..." });
    await this.calculate({ startNavigation: true });
  }

  cancelRouteEdit() {
    this.state.addingStop = false;
    this.routeEditMode = null;
    this.syncRouteSubmitLabel();
    this.renderStopInputs();
    this.elements.startInput.value = this.state.startPlace?.name || "Current location";
    this.elements.startInput.dataset.place = this.state.startPlace ? JSON.stringify(this.state.startPlace) : "";
    this.elements.endInput.value = this.state.endPlace?.name || "";
    this.elements.endInput.dataset.place = this.state.endPlace ? JSON.stringify(this.state.endPlace) : "";
    this.elements.routeCancelButton.hidden = true;
    this.elements.routeForm.hidden = this.state.navigation.active;
    this.elements.navigationCard.hidden = !this.state.navigation.active;
    this.elements.nextStepPrimary.closest(".next-step").hidden = this.state.navigation.active;
    this.sheet.setMode("route", {
      expand: true,
      subtitle: this.state.navigation.active ? "Navigation details" : "Route preview"
    });
    if (this.activeRoute) {
      this.setRouteDetails(this.state.navigation.active ? "Ready" : "Ready");
      this.renderRouteLocations();
    }
    this.searchPanel.setMapResultsVisible(!this.state.navigation.active);
    this.setStatus("Route edit cancelled.");
  }

  renderStopInputs({ addBlank = false } = {}) {
    const list = this.elements.stopInputList;
    if (!list) return;
    const stops = this.state.routeStops.filter(Boolean).map((place) => ({ place, value: place.name || formatLatLng(place) }));
    if (addBlank || (this.routeEditMode === "add-stop" && !stops.some((stop) => !stop.value))) {
      stops.push({ place: null, value: "" });
    }

    list.innerHTML = "";
    stops.forEach((stop, index) => {
      const row = document.createElement("div");
      row.className = "route-stop-input";
      row.dataset.index = String(index);
      row.innerHTML = `
        <label>
          <span></span>
          <input type="search" autocomplete="off" placeholder="Search for a stop" />
        </label>
        <div class="route-stop-actions">
          <button class="icon-button route-row-up route-stop-up" type="button" aria-label="Move stop up" title="Move stop up">
            <span class="material-symbols-rounded" aria-hidden="true">arrow_upward</span>
          </button>
          <button class="icon-button route-row-down route-stop-down" type="button" aria-label="Move stop down" title="Move stop down">
            <span class="material-symbols-rounded" aria-hidden="true">arrow_downward</span>
          </button>
          <button class="icon-button route-stop-remove" type="button" aria-label="Remove stop" title="Remove stop">
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      `;
      row.querySelector("label span").textContent = `Stop ${index + 1}`;
      const input = row.querySelector("input");
      input.value = stop.value;
      input.dataset.place = stop.place ? JSON.stringify(stop.place) : "";
      input.addEventListener("change", () => {
        input.dataset.place = "";
      });
      row.querySelector(".route-stop-up").addEventListener("click", (event) => this.moveRouteInput(this.rowIndexFor(event.currentTarget), -1));
      row.querySelector(".route-stop-down").addEventListener("click", (event) => this.moveRouteInput(this.rowIndexFor(event.currentTarget), 1));
      row.querySelector(".route-stop-remove").addEventListener("click", () => this.removeStopInput(index));
      list.append(row);
    });
    this.syncStopInputControls();
  }

  getStopDrafts() {
    return [...this.elements.stopInputList.querySelectorAll(".route-stop-input input")]
      .map((input) => ({
        value: input.value.trim(),
        place: readInputPlace(input)
      }))
      .filter((stop) => stop.value || stop.place);
  }

  getRouteDrafts({ includeEmptyStops = false } = {}) {
    const stopDrafts = [...this.elements.stopInputList.querySelectorAll(".route-stop-input input")]
      .map((input) => ({
        value: input.value.trim(),
        place: readInputPlace(input)
      }))
      .filter((stop) => includeEmptyStops || stop.value || stop.place);

    return [
      {
        value: this.elements.startInput.value.trim(),
        place: readInputPlace(this.elements.startInput)
      },
      ...stopDrafts,
      {
        value: this.elements.endInput.value.trim(),
        place: readInputPlace(this.elements.endInput)
      }
    ];
  }

  rowIndexFor(button) {
    const row = button.closest(".route-point-input, .route-stop-input");
    return this.getRouteInputRows().indexOf(row);
  }

  getRouteInputRows() {
    return [
      this.elements.startInput.closest(".route-point-input"),
      ...this.elements.stopInputList.querySelectorAll(".route-stop-input"),
      this.elements.endInput.closest(".route-point-input")
    ].filter(Boolean);
  }

  moveRouteInput(index, direction) {
    const drafts = this.getRouteDrafts({ includeEmptyStops: true });
    const target = index + direction;
    if (target < 0 || target >= drafts.length) return;
    [drafts[index], drafts[target]] = [drafts[target], drafts[index]];
    this.applyRouteDrafts(drafts);
  }

  removeStopInput(index) {
    const drafts = this.getStopDrafts();
    drafts.splice(index, 1);
    this.applyRouteDrafts([
      {
        value: this.elements.startInput.value.trim(),
        place: readInputPlace(this.elements.startInput)
      },
      ...drafts,
      {
        value: this.elements.endInput.value.trim(),
        place: readInputPlace(this.elements.endInput)
      }
    ]);
  }

  applyRouteDrafts(drafts) {
    const normalized = drafts.length >= 2 ? drafts : [
      { value: "Current location", place: this.state.currentPlace },
      { value: "", place: null }
    ];
    const first = normalized[0];
    const last = normalized.at(-1);
    this.elements.startInput.value = first.value || first.place?.name || "";
    this.elements.startInput.dataset.place = first.place ? JSON.stringify(first.place) : "";
    this.elements.endInput.value = last.value || last.place?.name || "";
    this.elements.endInput.dataset.place = last.place ? JSON.stringify(last.place) : "";
    this.renderDraftStops(normalized.slice(1, -1));
  }

  renderDraftStops(drafts) {
    this.elements.stopInputList.innerHTML = "";
    drafts.forEach((draft, index) => {
      const place = draft.place || { name: draft.value, lat: NaN, lng: NaN };
      const row = document.createElement("div");
      row.className = "route-stop-input";
      row.dataset.index = String(index);
      row.innerHTML = `
        <label>
          <span>Stop ${index + 1}</span>
          <input type="search" autocomplete="off" placeholder="Search for a stop" />
        </label>
        <div class="route-stop-actions">
          <button class="icon-button route-row-up route-stop-up" type="button" aria-label="Move stop up" title="Move stop up"><span class="material-symbols-rounded" aria-hidden="true">arrow_upward</span></button>
          <button class="icon-button route-row-down route-stop-down" type="button" aria-label="Move stop down" title="Move stop down"><span class="material-symbols-rounded" aria-hidden="true">arrow_downward</span></button>
          <button class="icon-button route-stop-remove" type="button" aria-label="Remove stop" title="Remove stop"><span class="material-symbols-rounded" aria-hidden="true">close</span></button>
        </div>
      `;
      const input = row.querySelector("input");
      input.value = draft.value || place.name || "";
      input.dataset.place = draft.place ? JSON.stringify(draft.place) : "";
      input.addEventListener("change", () => {
        input.dataset.place = "";
      });
      row.querySelector(".route-stop-up").addEventListener("click", (event) => this.moveRouteInput(this.rowIndexFor(event.currentTarget), -1));
      row.querySelector(".route-stop-down").addEventListener("click", (event) => this.moveRouteInput(this.rowIndexFor(event.currentTarget), 1));
      row.querySelector(".route-stop-remove").addEventListener("click", () => this.removeStopInput(index));
      this.elements.stopInputList.append(row);
    });
    this.syncStopInputControls();
  }

  syncStopInputControls() {
    const rows = this.getRouteInputRows();
    const canReorder = rows.length >= 3;
    rows.forEach((row, index) => {
      const up = row.querySelector(".route-row-up");
      const down = row.querySelector(".route-row-down");
      if (up) up.disabled = !canReorder || index === 0;
      if (down) down.disabled = !canReorder || index === rows.length - 1;
    });
  }

  focusNavigationCamera() {
    const activeRoute = this.activeRoute;
    if (!activeRoute?.line.length) return;

    const first = activeRoute.line[0];
    const second = activeRoute.line[1] || first;
    const livePoint = this.locationLayer.hasLiveLocation ? this.state.currentPlace : null;
    const cameraPoint = livePoint && Number.isFinite(livePoint.lng) && Number.isFinite(livePoint.lat)
      ? [livePoint.lng, livePoint.lat]
      : first;
    const heading = this.locationLayer.heading ?? bearingBetween(first, second);
    this.state.navigation.heading = heading;
    this.locationLayer.setHeading(heading);
    if (!this.locationLayer.hasLiveLocation) this.locationLayer.setSimulatedLocation(first, heading);
    this.recordNavigationTrace(cameraPoint);
    this.locationLayer.followCurrentLocation({ lat: cameraPoint[1], lng: cameraPoint[0] }, { force: true, heading });
  }

  renderDirections() {
    const activeRoute = this.activeRoute;
    const steps = activeRoute.steps?.length ? activeRoute.steps : generatedSteps(activeRoute);
    activeRoute.displaySteps = steps;
    this.elements.directionsList.innerHTML = "";

    steps.forEach((step) => {
      const item = document.createElement("li");
      item.innerHTML = `
        <span class="material-symbols-rounded direction-icon" aria-hidden="true">${iconForManeuver(step.maneuver)}</span>
        <div>
          <strong class="direction-instruction"></strong>
          <span class="direction-distance"></span>
        </div>
      `;
      item.querySelector(".direction-instruction").textContent = step.instruction;
      item.querySelector(".direction-distance").textContent = step.distance ? formatDistance(step.distance) : "Continue";
      this.elements.directionsList.append(item);
    });
  }

  updateCurrentInstruction() {
    if (this.rerouteInstructionLoading) return;
    const activeRoute = this.activeRoute;
    const steps = activeRoute?.displaySteps || generatedSteps(activeRoute);
    const step = steps[Math.min(this.state.navigation.progressIndex, steps.length - 1)];
    if (!step) return;
    this.elements.nextStepIcon.textContent = iconForManeuver(step.maneuver);
    this.elements.nextStepPrimary.textContent = step.instruction;
    this.elements.nextStepSecondary.textContent = step.distance ? `${formatDistance(step.distance)} ahead` : "Follow the highlighted route.";
    if (this.state.navigation.active) {
      this.sheet.update(step.instruction, step.distance ? `${formatDistance(step.distance)} ahead` : "Follow the highlighted route.", {
        icon: iconForManeuver(step.maneuver)
      });
    }
  }

  startSimulation() {
    const activeRoute = this.activeRoute;
    if (!activeRoute?.line.length) return;

    this.state.navigation.simulating = true;
    this.state.navigation.paused = false;
    this.state.navigation.manualControl = false;
    this.stopManualLoop();
    this.elements.pauseSimulation.disabled = false;
    this.elements.manualControl.disabled = true;
    this.elements.pauseSimulation.querySelector("span:last-child").textContent = "Pause";
    this.syncSimulationButtons();
    window.clearInterval(this.simulationTimer);

    this.simulationTimer = window.setInterval(() => {
      if (this.state.navigation.paused) return;
      this.advanceAlongRoute();
    }, 700);
  }

  togglePause() {
    if (!this.state.navigation.simulating && !this.state.navigation.paused) {
      this.state.navigation.paused = true;
    } else {
      this.state.navigation.paused = !this.state.navigation.paused;
    }
    this.elements.pauseSimulation.querySelector("span:last-child").textContent = this.state.navigation.paused ? "Resume" : "Pause";
    this.elements.manualControl.disabled = !this.state.navigation.paused;
    if (!this.state.navigation.paused) {
      this.state.navigation.manualControl = false;
      this.stopManualLoop();
    }
    this.syncSimulationButtons();
  }

  toggleManualControl() {
    if (!this.state.navigation.paused) {
      this.state.navigation.paused = true;
      this.elements.pauseSimulation.querySelector("span:last-child").textContent = "Resume";
      this.elements.manualControl.disabled = false;
    }
    this.state.navigation.manualControl = !this.state.navigation.manualControl;
    if (this.state.navigation.manualControl) {
      this.startManualLoop();
    } else {
      this.stopManualLoop();
    }
    this.syncSimulationButtons();
  }

  advanceAlongRoute() {
    const activeRoute = this.activeRoute;
    const nextIndex = Math.min(this.state.navigation.progressIndex + 1, activeRoute.line.length - 1);
    this.state.navigation.progressIndex = nextIndex;
    const point = activeRoute.line[nextIndex];
    const previous = activeRoute.line[Math.max(0, nextIndex - 1)];
    const heading = bearingBetween(previous, point);
    this.state.navigation.heading = heading;
    this.state.navigation.routeProgressMeters = nearestRouteProgress(point, activeRoute.line).metersAlong;
    this.locationLayer.setSimulatedLocation(point, heading);
    this.recordNavigationTrace(point);
    this.state.map.easeTo({ center: point, bearing: heading, duration: 500 });
    this.updateCurrentInstruction();

    if (nextIndex >= activeRoute.line.length - 1 || this.hasArrived(point)) {
      this.finishNavigation(point);
    }
  }

  syncSimulationButtons() {
    const navigation = this.state.navigation;
    this.elements.simulateRoute.classList.toggle("simulating", navigation.simulating && !navigation.paused);
    this.elements.pauseSimulation.classList.toggle("paused", navigation.simulating && navigation.paused);
    this.elements.manualControl.classList.toggle("active", navigation.manualControl);
  }

  handleKeydown(event) {
    if (!this.state.navigation.active || !this.state.navigation.paused || !this.state.navigation.manualControl) return;
    const key = event.key.toLowerCase();
    if (!["w", "a", "s", "d", "shift"].includes(key)) return;
    event.preventDefault();
    this.manualKeys.add(key);
    this.startManualLoop();
  }

  handleKeyup(event) {
    const key = event.key.toLowerCase();
    if (!["w", "a", "s", "d", "shift"].includes(key)) return;
    this.manualKeys.delete(key);
  }

  startManualLoop() {
    if (this.manualFrame) return;
    this.lastManualFrame = performance.now();
    this.manualFrame = window.requestAnimationFrame((timestamp) => this.tickManualControl(timestamp));
  }

  stopManualLoop() {
    if (this.manualFrame) window.cancelAnimationFrame(this.manualFrame);
    this.manualFrame = null;
    this.manualKeys.clear();
    this.lastManualFrame = 0;
  }

  tickManualControl(timestamp) {
    this.manualFrame = null;
    if (!this.state.navigation.active || !this.state.navigation.paused || !this.state.navigation.manualControl) {
      this.stopManualLoop();
      return;
    }

    const elapsed = Math.min(80, timestamp - (this.lastManualFrame || timestamp));
    this.lastManualFrame = timestamp;
    const seconds = elapsed / 1000;
    const turnRate = 95;
    const moveRate = this.manualKeys.has("shift") ? 36 : 18;
    let bearing = this.state.navigation.heading ?? this.state.map.getBearing();

    if (this.manualKeys.has("a")) bearing -= turnRate * seconds;
    if (this.manualKeys.has("d")) bearing += turnRate * seconds;
    bearing = (bearing + 360) % 360;

    let next = [this.state.currentPlace.lng, this.state.currentPlace.lat];
    const direction = (this.manualKeys.has("w") ? 1 : 0) + (this.manualKeys.has("s") ? -1 : 0);
    if (direction !== 0) {
      next = movePoint(next, direction > 0 ? bearing : (bearing + 180) % 360, moveRate * seconds);
    }

    this.state.navigation.heading = bearing;
    this.locationLayer.setSimulatedLocation(next, bearing);
    this.recordNavigationTrace(next);
    this.state.map.easeTo({ center: next, bearing, duration: 0 });

    if (direction !== 0 && this.hasArrived(next)) {
      this.finishNavigation(next);
      return;
    }

    if (direction !== 0 && timestamp - this.lastDeviationCheck > DEVIATION_CHECK_INTERVAL_MS) {
      this.lastDeviationCheck = timestamp;
      this.checkDeviation(next).finally(() => this.updateCurrentInstruction());
    }

    this.manualFrame = window.requestAnimationFrame((nextTimestamp) => this.tickManualControl(nextTimestamp));
  }

  async checkDeviation(point) {
    const activeRoute = this.activeRoute;
    if (!activeRoute) return;
    if (this.hasArrived(point)) {
      this.finishNavigation(point);
      return;
    }
    const progress = nearestRouteProgress(point, activeRoute.line);
    const expectedIndex = this.state.navigation.progressIndex || 0;
    const expectedMeters = this.state.navigation.routeProgressMeters || 0;
    const skippedMeters = progress.metersAlong - expectedMeters;
    const skippedIndexes = progress.nearestIndex - expectedIndex;
    const isOffRoute = progress.distance >= OFF_ROUTE_DISTANCE_METERS;
    const isShortcut = progress.distance < ON_ROUTE_DISTANCE_METERS && skippedMeters >= SHORTCUT_DISTANCE_METERS && skippedIndexes >= SHORTCUT_INDEX_COUNT;
    const trackedDeviation = this.trackedDeviation();

    if (!isOffRoute && !isShortcut) {
      if (skippedMeters > 0) {
        this.state.navigation.progressIndex = Math.max(expectedIndex, progress.nearestIndex);
        this.state.navigation.routeProgressMeters = Math.max(expectedMeters, progress.metersAlong);
      }
      if (trackedDeviation && this.hasRejoinedRoute(trackedDeviation, progress)) {
        this.updateTrackedDeviation(trackedDeviation, point, progress, { rejoined: true });
      }
      return;
    }

    const deviation = trackedDeviation && !trackedDeviation.rejoinedAt ? trackedDeviation : this.startDeviation(point, progress, {
      activeRoute,
      expectedIndex,
      isShortcut,
      skippedMeters
    });
    this.updateTrackedDeviation(deviation, point, progress, {
      isShortcut,
      skippedMeters
    });
    if (!deviation.dismissed) this.showDeviationPrompt();

    const destination = this.state.endPlace;
    if (!destination) return;
    const now = performance.now();
    if (this.deviationRerouteInFlight || now - this.lastDeviationReroute < DEVIATION_REROUTE_INTERVAL_MS) return;
    this.deviationRerouteInFlight = true;
    this.lastDeviationReroute = now;
    this.setRouteDetails("Re-routing");
    this.setRerouteInstructionLoading(true);
    this.showRouteError("");
    let rerouteFailed = false;
    try {
      const origin = { name: "Current location", lat: point[1], lng: point[0] };
      const routes = await fetchRoute({
        origin,
        destination,
        stops: this.state.routeStops,
        profile: this.state.activeMode,
        provider: this.state.preferences.routingProvider
      });
      if (!this.state.navigation.active) return;
      if (!routes.length) throw new Error("No revised route found.");
      deviation.reroutedAt = new Date().toISOString();
      deviation.rerouteCount = (Number(deviation.rerouteCount) || 0) + 1;
      deviation.lastRerouteRouteId = routes[0].id;
      deviation.rejoinProgressThresholdMeters = REJOIN_PROGRESS_METERS;
      deviation.rejoinStartedAt = point;
      this.state.route.routes = routes;
      this.state.route.activeIndex = 0;
      this.state.navigation.progressIndex = 0;
      this.state.navigation.routeProgressMeters = 0;
      this.renderRoute();
      this.renderDirections();
      this.setRouteDetails("Rerouted");
      this.updateCurrentInstruction();
      this.updateRouteChip();
      this.setStatus("Revised route ready. Keep moving and report the deviation if needed.");
    } catch (error) {
      console.error(error);
      rerouteFailed = true;
      await this.waitForMinimumRerouteInstructionLoading();
      if (!this.state.navigation.active) return;
      this.setRerouteInstructionError(error.message || "routing failed");
      this.showRouteError(error.message || "Could not revise route yet.");
      this.setStatus(`Could not revise route yet: ${error.message || "routing failed"}`);
    } finally {
      this.deviationRerouteInFlight = false;
      if (!rerouteFailed) await this.clearRerouteInstructionLoading();
    }
  }

  setRerouteInstructionLoading(loading) {
    this.rerouteInstructionLoading = Boolean(loading);
    this.rerouteInstructionLoadingStartedAt = loading ? performance.now() : 0;
    const nextStep = this.elements.nextStepPrimary.closest(".next-step");
    nextStep?.classList.toggle("is-loading", loading);
    this.elements.sheetHandle?.classList.toggle("is-loading", loading);
    if (!loading) {
      nextStep?.classList.remove("is-error");
      this.elements.sheetHandle?.classList.remove("is-error");
      this.updateCurrentInstruction();
      return;
    }

    this.elements.nextStepIcon.textContent = "progress_activity";
    this.elements.nextStepPrimary.textContent = "Re-routing";
    this.elements.nextStepSecondary.textContent = "Finding a revised route...";
    if (this.state.navigation.active) {
      this.sheet.update("Re-routing", "Finding a revised route...", {
        icon: "progress_activity"
      });
    }
  }

  async clearRerouteInstructionLoading() {
    const startedAt = this.rerouteInstructionLoadingStartedAt;
    if (!startedAt) return;
    await this.waitForMinimumRerouteInstructionLoading(startedAt);
    if (this.rerouteInstructionLoadingStartedAt !== startedAt) return;
    this.setRerouteInstructionLoading(false);
  }

  waitForMinimumRerouteInstructionLoading(startedAt = this.rerouteInstructionLoadingStartedAt) {
    if (!startedAt) return Promise.resolve();
    const remaining = MIN_REROUTE_INSTRUCTION_MS - (performance.now() - startedAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
  }

  setRerouteInstructionError(message) {
    this.rerouteInstructionLoading = false;
    this.rerouteInstructionLoadingStartedAt = 0;
    const nextStep = this.elements.nextStepPrimary.closest(".next-step");
    nextStep?.classList.remove("is-loading");
    nextStep?.classList.add("is-error");
    this.elements.sheetHandle?.classList.remove("is-loading");
    this.elements.sheetHandle?.classList.add("is-error");
    this.elements.nextStepIcon.textContent = "sync_problem";
    this.elements.nextStepPrimary.textContent = "Reroute failed";
    this.elements.nextStepSecondary.textContent = message || "Try moving closer to a routable path.";
    if (this.state.navigation.active) {
      this.sheet.update("Reroute failed", message || "Try moving closer to a routable path.", {
        icon: "sync_problem"
      });
    }
    window.setTimeout(() => {
      nextStep?.classList.remove("is-error");
      this.elements.sheetHandle?.classList.remove("is-error");
      this.updateCurrentInstruction();
    }, 2800);
  }

  hasRejoinedRoute(deviation, progress) {
    if (!deviation) return false;
    if (progress.distance > REJOIN_DISTANCE_METERS) return false;
    const threshold = Number(deviation.rejoinProgressThresholdMeters) || 0;
    return !deviation.reroutedAt || progress.metersAlong >= threshold;
  }

  startDeviation(point, progress, { activeRoute, expectedIndex, isShortcut, skippedMeters }) {
    const suggestedLine = activeRoute.line.slice(
      Math.max(0, progress.nearestIndex - 24),
      Math.min(activeRoute.line.length, progress.nearestIndex + 25)
    );
    const trace = this.state.navigation.trace || [];
    const actualLine = trace.length >= 2
      ? trace.slice(-50)
      : [activeRoute.line[expectedIndex], point].filter(Boolean);
    const deviation = {
      at: new Date().toISOString(),
      distance: progress.distance,
      shortcut: isShortcut,
      skippedMeters: Math.max(0, skippedMeters),
      point,
      suggestedLine,
      actualLine,
      reason: null,
      rejoinedAt: null,
      reroutedAt: null,
      rerouteCount: 0,
      rejoinProgressThresholdMeters: 0
    };
    this.state.navigation.deviations.push(deviation);
    return deviation;
  }

  updateTrackedDeviation(deviation, point, progress, { isShortcut = deviation.shortcut, skippedMeters = deviation.skippedMeters, rejoined = false } = {}) {
    if (!deviation) return;
    deviation.point = point;
    deviation.distance = progress.distance;
    deviation.shortcut = Boolean(deviation.shortcut || isShortcut);
    deviation.skippedMeters = Math.max(Number(deviation.skippedMeters) || 0, Math.max(0, skippedMeters || 0));
    deviation.actualLine = appendDeviationPoint(deviation.actualLine, point);
    if (rejoined && !deviation.rejoinedAt) deviation.rejoinedAt = new Date().toISOString();
    if (!this.elements.deviationCategoryPanel.hidden) this.renderDeviationPreview();
  }

  showDeviationPrompt() {
    const wasHidden = this.elements.deviationPrompt.hidden;
    this.elements.deviationPrompt.hidden = false;
    if (wasHidden) {
      this.elements.deviationCategoryPanel.hidden = true;
      this.elements.deviationReportPanel.hidden = true;
    }
  }

  trackedDeviation() {
    const latest = this.state.navigation.deviations.at(-1);
    return latest && !latest.reason ? latest : null;
  }

  alignCameraAfterReroute(point, route) {
    if (!Array.isArray(point)) return;
    const current = { lat: point[1], lng: point[0] };
    if (this.locationLayer.hasOrientationHeading && Number.isFinite(this.locationLayer.heading)) {
      this.state.navigation.heading = this.locationLayer.heading;
      this.locationLayer.followCurrentLocation(current, { force: true, heading: this.locationLayer.heading });
      return;
    }

    const first = route?.line?.[0] || point;
    const second = route?.line?.[1] || first;
    const heading = bearingBetween(first, second);
    this.state.navigation.heading = heading;
    this.locationLayer.followCurrentLocation(current, { force: true, heading });
  }

  trackRealLocation(point) {
    if (!this.state.navigation.active || this.state.navigation.simulating || this.state.navigation.manualControl) return;
    const activeRoute = this.activeRoute;
    if (!activeRoute?.line.length) return;

    this.recordNavigationTrace(point);
    if (this.hasArrived(point)) {
      this.finishNavigation(point);
      return;
    }
    const now = performance.now();
    if (now - this.lastDeviationCheck > DEVIATION_CHECK_INTERVAL_MS) {
      this.lastDeviationCheck = now;
      this.checkDeviation(point).finally(() => this.updateCurrentInstruction());
      return;
    }

    const progress = nearestRouteProgress(point, activeRoute.line);
    if (progress.distance < 70 && progress.metersAlong >= this.state.navigation.routeProgressMeters) {
      this.state.navigation.progressIndex = Math.max(this.state.navigation.progressIndex, progress.nearestIndex);
      this.state.navigation.routeProgressMeters = progress.metersAlong;
      this.updateCurrentInstruction();
    }
  }

  hasArrived(point) {
    const activeRoute = this.activeRoute;
    if (!activeRoute?.line.length || !Array.isArray(point)) return false;
    const destination = this.destinationPoint();
    if (!destination) return false;

    return distanceBetweenPoints(point, destination) <= arrivalThreshold();
  }

  destinationPoint() {
    if (this.state.endPlace && Number.isFinite(this.state.endPlace.lng) && Number.isFinite(this.state.endPlace.lat)) {
      return [this.state.endPlace.lng, this.state.endPlace.lat];
    }
    return this.activeRoute?.line?.at(-1) || null;
  }

  finishNavigation(point = null) {
    if (!this.state.navigation.active) return;
    if (isLngLat(point)) this.recordNavigationTrace(point);
    this.state.lastTripStats = this.actualTripStats(point);
    this.finalizeDeviationAtArrival(point);
    if (!this.elements.deviationPrompt.hidden) {
      this.stopNavigation({ arrived: true, keepDeviationPrompt: true });
      return;
    }
    this.stopNavigation({ arrived: true });
  }

  actualTripStats(point = null) {
    const navigation = this.state.navigation;
    const endedAt = Date.now();
    navigation.endedAt = endedAt;
    const startedAt = Number(navigation.startedAt) || endedAt;
    const distance = Number(navigation.actualDistanceMeters) || 0;
    return {
      distance: Math.max(0, distance),
      duration: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
      arrivedAt: endedAt,
      point
    };
  }

  finalizeDeviationAtArrival(point = null) {
    const deviation = this.trackedDeviation();
    if (!deviation) return;

    const finalPoint = isLngLat(point)
      ? point
      : this.state.currentPlace
        ? [this.state.currentPlace.lng, this.state.currentPlace.lat]
        : null;
    const destination = this.destinationPoint();

    if (finalPoint) {
      const progress = this.activeRoute?.line?.length
        ? nearestRouteProgress(finalPoint, this.activeRoute.line)
        : { distance: 0, nearestIndex: 0, metersAlong: 0 };
      this.updateTrackedDeviation(deviation, finalPoint, progress, {
        isShortcut: deviation.shortcut,
        skippedMeters: deviation.skippedMeters
      });
    }

    if (destination) {
      deviation.actualLine = appendDeviationPoint(deviation.actualLine, destination);
      deviation.arrivalPoint = finalPoint || destination;
      deviation.point = destination;
    }
    deviation.arrivedAt = new Date().toISOString();

    if (!deviation.dismissed) this.showDeviationPrompt();
    if (!this.elements.deviationCategoryPanel.hidden) this.renderDeviationPreview();
  }

  recordDeviation(reason) {
    const latest = this.state.navigation.deviations.at(-1);
    if (latest) latest.reason = reason;
    if (latest?.point) {
      this.publishDeviationReport(reason, latest);
    }
    this.elements.deviationPrompt.hidden = true;
    this.elements.deviationCategoryPanel.hidden = true;
    this.elements.deviationReportPanel.hidden = true;
    this.setStatus(`Deviation noted: ${reason}.`);
  }

  dismissDeviationPrompt() {
    const latest = this.trackedDeviation();
    if (latest) latest.dismissed = true;
    this.elements.deviationPrompt.hidden = true;
    this.elements.deviationCategoryPanel.hidden = true;
    this.elements.deviationReportPanel.hidden = true;
    this.setStatus("Deviation prompt dismissed.");
  }

  recordNavigationTrace(point) {
    const trace = this.state.navigation.trace || [];
    const previous = this.state.navigation.lastTracePoint || trace.at(-1);
    if (!previous || distanceBetweenPoints(previous, point) > 1) {
      if (previous) {
        this.state.navigation.actualDistanceMeters = (Number(this.state.navigation.actualDistanceMeters) || 0) + distanceBetweenPoints(previous, point);
      }
      trace.push(point);
      this.state.navigation.lastTracePoint = point;
      this.state.navigation.trace = trace.slice(-90);
    }
  }

  renderDeviationPreview() {
    const container = this.elements.deviationPreview;
    const activeRoute = this.activeRoute;
    const latest = this.state.navigation.deviations.at(-1);

    if (!activeRoute?.line?.length || !latest?.point) {
      this.showDeviationPreviewMessage("Deviation map unavailable");
      return;
    }

    const progress = nearestRouteProgress(latest.point, activeRoute.line);
    const routeSegment = Array.isArray(latest.suggestedLine) && latest.suggestedLine.length >= 2
      ? latest.suggestedLine
      : activeRoute.line.slice(
          Math.max(0, progress.nearestIndex - 24),
          Math.min(activeRoute.line.length, progress.nearestIndex + 25)
        );
    const trace = Array.isArray(latest.actualLine) && latest.actualLine.length
      ? latest.actualLine
      : (this.state.navigation.trace || []).slice(-40);
    const actualSegment = trace.length >= 2 ? trace : [routeSegment[0], latest.point].filter(Boolean);

    if (routeSegment.length < 2 || actualSegment.length < 1) {
      this.showDeviationPreviewMessage("Deviation map unavailable");
      return;
    }

    const data = { routeSegment, actualSegment, point: latest.point };
    this.ensureDeviationMap(() => this.updateDeviationMap(data));
    for (const delay of [80, 250, 600]) {
      window.setTimeout(() => {
        this.deviationMap?.resize();
        this.updateDeviationMap(data);
      }, delay);
    }
  }

  refreshDeviationPreviewMap(data) {
    window.requestAnimationFrame(() => {
      this.deviationMap?.resize();
      this.updateDeviationMap(data);
    });
  }

  showDeviationPreviewMessage(message) {
    if (this.deviationMap) {
      this.deviationMap.remove();
      this.deviationMap = null;
    }
    this.elements.deviationPreview.classList.add("is-empty");
    this.elements.deviationPreview.textContent = message;
  }

  ensureDeviationMap(onReady) {
    const container = this.elements.deviationPreview;
    container.classList.remove("is-empty");
    if (!this.deviationMap) {
      container.textContent = "";
      this.deviationMap = new maplibregl.Map({
        container,
        style: "/api/osm-style",
        center: [this.state.defaultCenter.lng, this.state.defaultCenter.lat],
        zoom: 15,
        interactive: false,
        attributionControl: false
      });
      this.deviationMap.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      this.deviationMap.on("load", () => {
        this.installDeviationMapLayers();
        onReady();
      });
      return;
    }

    if (!this.deviationMap.isStyleLoaded()) {
      this.deviationMap.once("load", () => {
        this.installDeviationMapLayers();
        onReady();
      });
      return;
    }
    this.installDeviationMapLayers();
    onReady();
  }

  installDeviationMapLayers() {
    const map = this.deviationMap;
    if (!map) return;

    if (!map.getSource("deviation-route")) {
      map.addSource("deviation-route", { type: "geojson", data: emptyFeatureCollection() });
    }
    if (!map.getSource("deviation-trace")) {
      map.addSource("deviation-trace", { type: "geojson", data: emptyFeatureCollection() });
    }
    if (!map.getSource("deviation-point")) {
      map.addSource("deviation-point", { type: "geojson", data: emptyFeatureCollection() });
    }

    if (!map.getLayer("deviation-route-casing")) {
      map.addLayer({
        id: "deviation-route-casing",
        type: "line",
        source: "deviation-route",
        paint: {
          "line-color": "#ffffff",
          "line-width": 8,
          "line-opacity": 0.96
        }
      });
    }
    if (!map.getLayer("deviation-route-line")) {
      map.addLayer({
        id: "deviation-route-line",
        type: "line",
        source: "deviation-route",
        paint: {
          "line-color": "#2563eb",
          "line-width": 5,
          "line-opacity": 0.95
        }
      });
    }
    if (!map.getLayer("deviation-trace-casing")) {
      map.addLayer({
        id: "deviation-trace-casing",
        type: "line",
        source: "deviation-trace",
        paint: {
          "line-color": "#ffffff",
          "line-width": 8,
          "line-opacity": 0.96
        }
      });
    }
    if (!map.getLayer("deviation-trace-line")) {
      map.addLayer({
        id: "deviation-trace-line",
        type: "line",
        source: "deviation-trace",
        paint: {
          "line-color": "#c26a28",
          "line-width": 5,
          "line-opacity": 0.95
        }
      });
    }
    if (!map.getLayer("deviation-point-circle")) {
      map.addLayer({
        id: "deviation-point-circle",
        type: "circle",
        source: "deviation-point",
        paint: {
          "circle-color": "#c26a28",
          "circle-radius": 6,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3
        }
      });
    }
  }

  updateDeviationMap({ routeSegment, actualSegment, point }) {
    const map = this.deviationMap;
    if (!map || !map.isStyleLoaded()) return;

    map.getSource("deviation-route")?.setData(deviationLineFeature(routeSegment));
    map.getSource("deviation-trace")?.setData(deviationLineFeature(actualSegment.length >= 2 ? actualSegment : [point, point]));
    map.getSource("deviation-point")?.setData(deviationPointFeature(point));
    fitDeviationPreviewMap(map, [...routeSegment, ...actualSegment, point]);
  }

  publishDeviationReport(reason, deviation) {
    const reports = readStoredReports();
    const point = deviation.point;
    const context = this.state.endPlace
      ? `Navigation deviation toward ${this.state.endPlace.name}`
      : "Navigation deviation";
    const report = {
      id: crypto.randomUUID(),
      type: reason,
      context,
      mode: this.state.activeMode,
      lat: point[1],
      lng: point[0],
      deviation: {
        point,
        suggestedLine: sanitizeLine(deviation.suggestedLine),
        actualLine: sanitizeLine(deviation.actualLine)
      },
      createdAt: new Date().toISOString()
    };
    reports.unshift(report);
    localStorage.setItem("street-smart-reports", JSON.stringify(reports.slice(0, 200)));
    this.state.reports = reports;
    window.dispatchEvent(new CustomEvent("street-smart-reports-changed"));
    publishReport(report).catch((error) => {
      console.warn("Deviation report saved locally but could not be sent to Studio.", error);
    });
  }

  showDeviationCategory(category) {
    this.elements.deviationCategoryPanel.hidden = true;
    this.elements.deviationReportPanel.hidden = false;
    this.elements.deviationReportGroups.forEach((group) => {
      group.hidden = group.dataset.categoryPanel !== category;
    });
  }

  showDeviationCategories() {
    this.elements.deviationReportPanel.hidden = true;
    this.elements.deviationCategoryPanel.hidden = false;
    this.elements.deviationReportGroups.forEach((group) => {
      group.hidden = true;
    });
    this.renderDeviationPreview();
  }

  renderAlternatives() {
    const routes = this.state.route.routes;
    this.elements.routeAlternatives.innerHTML = "";
    if (routes.length <= 1) return;

    routes.forEach((route, index) => {
      const button = document.createElement("button");
      button.className = `route-option${index === this.state.route.activeIndex ? " active" : ""}`;
      button.type = "button";
      button.innerHTML = `
        <strong></strong>
        <span></span>
      `;
      button.querySelector("strong").textContent = index === 0 ? "Best route" : `Alternative ${index}`;
      button.querySelector("span").textContent = `${formatDistance(route.distance)} - ${formatDuration(route.duration)}`;
      button.addEventListener("click", () => this.selectRoute(index));
      this.elements.routeAlternatives.append(button);
    });
  }

  updateRouteChip() {
    const activeRoute = this.activeRoute;
    if (!activeRoute || !this.state.startPlace || !this.state.endPlace) return;
    this.elements.routeChip.hidden = false;
    const provider = routeProviderLabel(activeRoute);
    const traffic = activeRoute.trafficSummary?.label || "Traffic-aware";
    this.elements.routeChip.textContent = `${formatDistance(activeRoute.distance)} - ${formatDuration(activeRoute.duration)} - ${traffic} - ${provider} - ${this.state.startPlace.name} to ${this.state.endPlace.name}`;
  }

  prepareCurrentLocation() {
    this.locationLayer.request();
    if (this.elements.startInput.value === "Current location") {
      this.state.startPlace = this.state.currentPlace;
    }
  }

  async resolvePlace(value, fallback) {
    const query = value.trim();
    if (!query) return fallback || null;
    if (query.toLowerCase() === "current location") return this.state.currentPlace || fallback;

    const coordinate = parseLatLng(query);
    if (coordinate) return { ...coordinate, name: formatLatLng(coordinate), address: "" };
    if (fallback && query === fallback.name) return fallback;

    return this.searchPanel.findFirst(query);
  }

  setRouteLoading(loading) {
    this.elements.startRouteButton.disabled = loading;
    this.elements.startRouteButton.classList.toggle("is-loading", loading);
    const idleLabel = this.routeEditMode ? "Update route" : "Start route";
    this.elements.startRouteButton.querySelector("span:last-child").textContent = loading
      ? (this.routeEditMode ? "Updating..." : "Starting...")
      : idleLabel;
  }

  syncRouteSubmitLabel() {
    this.elements.startRouteButton.querySelector("span:last-child").textContent = this.routeEditMode ? "Update route" : "Start route";
  }

  showRouteError(message) {
    this.elements.routeError.hidden = !message;
    this.elements.routeError.textContent = message;
  }

  updateRouteProvider(route) {
    if (route?.provider === "osrm" && route?.trafficProvider === "grabmaps") {
      this.elements.routePoweredByLink.href = "https://project-osrm.org/";
      this.elements.routePoweredByLink.textContent = "OSRM, traffic data from GrabMaps";
      return;
    }
    const isOsrm = route?.provider === "osrm";
    this.elements.routePoweredByLink.href = isOsrm ? "https://project-osrm.org/" : "https://grabmaps.grab.com/";
    this.elements.routePoweredByLink.textContent = isOsrm ? "OSRM" : "GrabMaps";
  }
}

function routeProviderLabel(route) {
  if (route?.provider === "osrm" && route?.trafficProvider === "grabmaps") return "OSRM + Grab traffic";
  return route?.provider === "osrm" ? "OSRM" : "GrabMaps";
}

function makeAnchorMarker(label, place) {
  const element = document.createElement("div");
  element.className = "anchor-marker";
  element.textContent = label;
  return new maplibregl.Marker({ element }).setLngLat([place.lng, place.lat]);
}

function readInputPlace(input) {
  try {
    return input.dataset.place ? JSON.parse(input.dataset.place) : null;
  } catch {
    return null;
  }
}

function routePaddingForSheet() {
  if (window.matchMedia("(max-width: 720px)").matches) {
    return { top: 170, right: 70, bottom: 110, left: 40 };
  }

  return { top: 130, right: 80, bottom: 130, left: 500 };
}

function generatedSteps(route) {
  if (!route?.line?.length) return [];
  const total = route.distance || 0;
  return [
    {
      id: "generated-0",
      instruction: "Head toward the highlighted route",
      distance: Math.min(250, total || 250),
      maneuver: "depart"
    },
    {
      id: "generated-1",
      instruction: "Continue to your destination",
      distance: total,
      maneuver: "straight"
    }
  ];
}

function iconForManeuver(maneuver = "") {
  if (maneuver.includes("left")) return "turn_left";
  if (maneuver.includes("right")) return "turn_right";
  if (maneuver.includes("roundabout")) return "roundabout_right";
  if (maneuver.includes("arrive")) return "flag";
  if (maneuver.includes("depart")) return "near_me";
  return "straight";
}

function routeStatusMessage(routes) {
  const provider = routes[0]?.provider;
  const count = routes.length;
  const fallbackReason = routes[0]?.fallback?.reason;
  if (provider === "osrm") {
    if (fallbackReason) return count > 1 ? `${count} OSRM fallback route options found.` : "Using OSRM fallback route.";
    return count > 1 ? `${count} OSRM route options found.` : "Using OSRM route.";
  }
  return count > 1 ? `${count} Grab route options found.` : "Route ready.";
}

function formatActualDuration(duration) {
  const seconds = Math.max(0, Math.round(Number(duration) || 0));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return remainderSeconds ? `${minutes} min ${remainderSeconds} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes ? `${hours} hr ${remainderMinutes} min` : `${hours} hr`;
}

function readStoredReports() {
  try {
    const parsed = JSON.parse(localStorage.getItem("street-smart-reports") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function distanceBetweenPoints(a, b) {
  const dx = (a[0] - b[0]) * 111320 * Math.cos((a[1] + b[1]) * Math.PI / 360);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

function arrivalThreshold() {
  return 20;
}

function appendDeviationPoint(line = [], point) {
  const nextLine = Array.isArray(line) ? [...line.filter(isLngLat)] : [];
  if (!isLngLat(point)) return nextLine;
  const previous = nextLine.at(-1);
  if (!previous || distanceBetweenPoints(previous, point) > 1) {
    nextLine.push(point);
  }
  return nextLine.slice(-MAX_DEVIATION_PATH_POINTS);
}

const DEVIATION_CHECK_INTERVAL_MS = 2500;
const DEVIATION_MONITOR_INTERVAL_MS = 1000;
const DEVIATION_REROUTE_INTERVAL_MS = 5000;
const MIN_REROUTE_INSTRUCTION_MS = 1000;
const OFF_ROUTE_DISTANCE_METERS = 70;
const ON_ROUTE_DISTANCE_METERS = 45;
const REJOIN_DISTANCE_METERS = 35;
const REJOIN_PROGRESS_METERS = 45;
const SHORTCUT_DISTANCE_METERS = 90;
const SHORTCUT_INDEX_COUNT = 6;
const MAX_DEVIATION_PATH_POINTS = 500;

function deviationLineFeature(coordinates) {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: coordinates.filter(isLngLat)
    }
  };
}

function deviationPointFeature(point) {
  return {
    type: "FeatureCollection",
    features: isLngLat(point)
      ? [{
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: point }
        }]
      : []
  };
}

function sanitizeLine(line) {
  return Array.isArray(line) ? line.filter(isLngLat) : [];
}

function fitDeviationPreviewMap(map, points) {
  const validPoints = points.filter(isLngLat);
  if (!validPoints.length) return;

  const bounds = new maplibregl.LngLatBounds(validPoints[0], validPoints[0]);
  validPoints.slice(1).forEach((point) => bounds.extend(point));
  map.resize();
  map.fitBounds(bounds, {
    padding: { top: 28, right: 28, bottom: 58, left: 28 },
    maxZoom: 18,
    duration: 0
  });
}

function isLngLat(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]));
}
