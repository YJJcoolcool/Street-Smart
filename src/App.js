import { fetchConfig } from "./lib/api.js";
import { makeCurrentPlace, createState } from "./state/createState.js";
import { BottomSheet } from "./components/BottomSheet.js";
import { SearchPanel } from "./components/SearchPanel.js";
import { RoutePanel } from "./components/RoutePanel.js?v=20260424-1915";
import { ReportPanel } from "./components/ReportPanel.js?v=20260424-1905";
import { LocationLayer } from "./components/LocationLayer.js";

export async function createStreetSmartApp() {
  const state = createState();
  const elements = collectElements();
  state.preferences = readPreferences();
  syncSettingsControls(state, elements);

  state.config = await fetchConfig().catch(() => ({}));
  if (state.config?.defaultCenter) {
    state.defaultCenter = state.config.defaultCenter;
    state.currentPlace = makeCurrentPlace(state.defaultCenter);
  }

  state.map = createMap(state, elements);
  window.streetSmartMap = state.map;

  const sheet = new BottomSheet(elements);
  const locationLayer = new LocationLayer({ state });
  const searchPanel = new SearchPanel({
    state,
    elements,
    sheet,
    onNavigate: (payload) => routePanel.open(payload)
  });
  const routePanel = new RoutePanel({
    state,
    elements,
    sheet,
    searchPanel,
    locationLayer,
    setStatus: (message) => {
      elements.status.textContent = message;
    }
  });
  locationLayer.setNavigationTracker((point) => routePanel.trackRealLocation(point));
  locationLayer.setRecenterButton(elements.recenterButton);
  locationLayer.setLocateButton(elements.locateButton);
  const reportPanel = new ReportPanel({ state, elements, sheet });

  searchPanel.bind();
  routePanel.bind();
  reportPanel.bind();
  reportPanel.load();
  locationLayer.request();
  locationLayer.watchHeading();
  elements.locateButton.addEventListener("click", () => {
    locationLayer.watchHeading({ requestPermission: true });
    const centered = locationLayer.centerOnCurrent();
    if (!centered) elements.status.textContent = "Waiting for a GPS fix before centering the map.";
  });
  elements.recenterButton.addEventListener("click", () => {
    const centered = locationLayer.recenterNavigation();
    if (!centered) elements.status.textContent = "Waiting for a GPS fix before recentering.";
  });
  bindModeButtons(state, elements, routePanel);
  bindSettings(state, elements);

  sheet.setMode("search", { expand: false });
  elements.mapKeyWarning.hidden = Boolean(state.config?.hasDirectGrabKey);
  if (state.config?.hasDirectGrabKey) elements.mapKeyWarning.remove();

  if (!state.config?.hasGrabKey) {
    elements.status.textContent = "GrabMaps key missing. Add it to .env.local before searching.";
  } else if (!state.config?.hasDirectGrabKey) {
    elements.mapKeyWarning.hidden = false;
    elements.status.textContent = "Grab routing is connected. Add a direct GrabMaps display key for the basemap.";
  }
}

function collectElements() {
  return {
    mapKeyWarning: document.querySelector("#map-key-warning"),
    topControls: document.querySelector(".top-controls"),
    form: document.querySelector("#search-form"),
    input: document.querySelector("#search-input"),
    navigateButton: document.querySelector("#navigate-button"),
    locateButton: document.querySelector("#locate-button"),
    recenterButton: document.querySelector("#recenter-button"),
    editMapButton: document.querySelector("#edit-map-button"),
    settingsButton: document.querySelector("#settings-button"),
    settingsPanel: document.querySelector("#settings-panel"),
    settingsClose: document.querySelector("#settings-close"),
    settingsCategoryList: document.querySelector("#settings-category-list"),
    settingsDetail: document.querySelector("#settings-detail"),
    settingsBack: document.querySelector("#settings-back"),
    settingsCategoryButtons: [...document.querySelectorAll("[data-settings-category]")],
    settingsDetailPanels: [...document.querySelectorAll("[data-settings-panel]")],
    mapProviderSelect: document.querySelector("#map-provider-select"),
    routingProviderSelect: document.querySelector("#routing-provider-select"),
    searchAreaButton: document.querySelector("#search-area-button"),
    results: document.querySelector("#results-list"),
    poweredByLink: document.querySelector("#powered-by-link"),
    count: document.querySelector("#result-count"),
    status: document.querySelector("#status-line"),
    modeButtons: [...document.querySelectorAll(".mode-chip")],
    sheet: document.querySelector("#bottom-sheet"),
    sheetHandle: document.querySelector("#sheet-handle"),
    sheetTitle: document.querySelector("#sheet-title"),
    sheetSubtitle: document.querySelector("#sheet-subtitle"),
    sheetTurnIcon: document.querySelector("#sheet-turn-icon"),
    searchPanel: document.querySelector("#search-panel"),
    routePanel: document.querySelector("#route-panel"),
    editPanel: document.querySelector("#edit-panel"),
    routeForm: document.querySelector("#route-form"),
    startRouteButton: document.querySelector("#start-route-button"),
    routeError: document.querySelector("#route-error"),
    startInput: document.querySelector("#start-input"),
    stopInputList: document.querySelector("#route-stop-list"),
    endInput: document.querySelector("#end-input"),
    routeCancelButton: document.querySelector("#route-cancel-button"),
    routeDetails: document.querySelector("#route-details"),
    routeTitle: document.querySelector("#route-title"),
    routeStatus: document.querySelector("#route-status"),
    routePoweredByLink: document.querySelector("#route-powered-by-link"),
    routeDistance: document.querySelector("#route-distance"),
    routeDuration: document.querySelector("#route-duration"),
    routeLocationList: document.querySelector("#route-location-list"),
    editRouteLocations: document.querySelector("#edit-route-locations"),
    addStop: document.querySelector("#add-stop"),
    routeAlternatives: document.querySelector("#route-alternatives"),
    navigationCard: document.querySelector("#navigation-card"),
    nextStepIcon: document.querySelector("#next-step-icon"),
    nextStepPrimary: document.querySelector("#next-step-primary"),
    nextStepSecondary: document.querySelector("#next-step-secondary"),
    directionsList: document.querySelector("#directions-list"),
    simulateRoute: document.querySelector("#simulate-route"),
    pauseSimulation: document.querySelector("#pause-simulation"),
    manualControl: document.querySelector("#manual-control"),
    deviationPrompt: document.querySelector("#deviation-prompt"),
    deviationClose: document.querySelector("#deviation-close"),
    tellUsWhy: document.querySelector("#tell-us-why"),
    deviationCategoryPanel: document.querySelector("#deviation-category-panel"),
    deviationPreview: document.querySelector("#deviation-preview"),
    deviationCategoryButtons: [...document.querySelectorAll(".report-category-button")],
    deviationReportPanel: document.querySelector("#deviation-report-panel"),
    deviationReportBack: document.querySelector("#deviation-report-back"),
    deviationReportGroups: [...document.querySelectorAll("[data-category-panel]")],
    deviationButtons: [...document.querySelectorAll(".deviation-report-option")],
    routeChip: document.querySelector("#route-chip"),
    clearRoute: document.querySelector("#clear-route"),
    reportButtons: [...document.querySelectorAll(".report-button")],
    signalList: document.querySelector("#signal-list"),
    signalCount: document.querySelector("#signal-count"),
    emptySignal: document.querySelector("#empty-signal")
  };
}

function createMap(state, elements) {
  state.mapProvider = normalizeMapProvider(state.preferences.mapProvider);
  const map = new maplibregl.Map({
    container: "map",
    style: styleUrlForProvider(state.mapProvider, state),
    center: [state.defaultCenter.lng, state.defaultCenter.lat],
    zoom: 11
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.on("styleimagemissing", (event) => {
    addMaterialSymbolImage(map, event.id);
  });
  map.on("error", (event) => {
    if (!state.config?.hasDirectGrabKey && elements.mapKeyWarning.isConnected) {
      elements.mapKeyWarning.hidden = false;
    }
    if (shouldFallbackMapProvider(event, state)) {
      fallbackMapProvider(map, state, elements);
    }
  });

  return map;
}

function shouldFallbackMapProvider(event, state) {
  const message = String(event?.error?.message || event?.error || "");
  const status = Number(event?.error?.status || event?.status || 0);
  const transient = [429, 502, 503, 504].includes(status);
  if (isGrabMapProvider(state.mapProvider)) {
    return message.includes("/api/grab-resource")
      || message.includes("grab-resource")
      || transient;
  }
  return message.includes("tile.openstreetmap.org")
    || message.includes("/api/osm-style")
    || transient;
}

function fallbackMapProvider(map, state, elements) {
  const failedProvider = state.mapProvider;
  state.failedMapProviders.add(failedProvider);
  const nextProvider = isGrabMapProvider(failedProvider) ? "osm" : "grab";
  if (state.failedMapProviders.has(nextProvider)) return;

  state.mapProvider = nextProvider;
  map.setStyle(styleUrlForProvider(nextProvider, state));
  elements.status.textContent = isGrabMapProvider(failedProvider)
    ? "Grab Maps tiles are unavailable, so the map switched to OpenStreetMap."
    : "OpenStreetMap tiles are unavailable, so the map switched to Grab Maps.";
}

function setPreferredMapProvider(provider, state, elements) {
  const nextProvider = normalizeMapProvider(provider);
  state.preferences.mapProvider = nextProvider;
  state.mapProvider = nextProvider;
  state.failedMapProviders.clear();
  setCookie("street-smart-map-provider", nextProvider);
  state.map.setStyle(styleUrlForProvider(nextProvider, state));
  elements.status.textContent = `Using ${labelForMapProvider(nextProvider)} as the preferred map provider.`;
}

function styleUrlForProvider(provider, state) {
  if (provider === "osm") return "/api/osm-style";
  const baseUrl = state.config?.mapStyleUrl || "/api/map-style";
  const theme = grabThemeForProvider(provider);
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}theme=${theme}`;
}

function normalizeMapProvider(provider) {
  return new Set(["grab", "grab-dark", "grab-satellite", "osm"]).has(provider) ? provider : "grab";
}

function normalizeRoutingProvider(provider) {
  return provider === "osrm" ? "osrm" : "grab";
}

function labelForMapProvider(provider) {
  return {
    grab: "Grab Maps",
    "grab-dark": "Grab Maps Dark Mode",
    "grab-satellite": "Grab Maps Satellite",
    osm: "OpenStreetMap"
  }[provider] || "Grab Maps";
}

function grabThemeForProvider(provider) {
  if (provider === "grab-dark") return "dark";
  if (provider === "grab-satellite") return "satellite";
  return "basic";
}

function isGrabMapProvider(provider) {
  return provider !== "osm";
}

function readPreferences() {
  return {
    mapProvider: normalizeMapProvider(getCookie("street-smart-map-provider")),
    routingProvider: normalizeRoutingProvider(getCookie("street-smart-routing-provider"))
  };
}

function syncSettingsControls(state, elements) {
  elements.mapProviderSelect.value = state.preferences.mapProvider;
  elements.routingProviderSelect.value = state.preferences.routingProvider;
}

function bindSettings(state, elements) {
  elements.settingsButton.addEventListener("click", () => {
    const willOpen = elements.settingsPanel.hidden;
    elements.settingsPanel.hidden = !willOpen;
    if (willOpen) showSettingsCategories(elements);
  });
  elements.settingsClose.addEventListener("click", () => {
    elements.settingsPanel.hidden = true;
    showSettingsCategories(elements);
  });
  elements.settingsBack.addEventListener("click", () => {
    showSettingsCategories(elements);
  });
  elements.settingsCategoryButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showSettingsCategory(elements, button.dataset.settingsCategory);
    });
  });
  elements.mapProviderSelect.addEventListener("change", () => {
    setPreferredMapProvider(elements.mapProviderSelect.value, state, elements);
  });
  elements.routingProviderSelect.addEventListener("change", () => {
    const provider = normalizeRoutingProvider(elements.routingProviderSelect.value);
    state.preferences.routingProvider = provider;
    setCookie("street-smart-routing-provider", provider);
    elements.status.textContent = `Using ${provider === "osrm" ? "OSRM" : "Grab Maps"} as the preferred routing provider.`;
  });
}

function showSettingsCategories(elements) {
  elements.settingsCategoryList.hidden = false;
  elements.settingsDetail.hidden = true;
  elements.settingsDetailPanels.forEach((panel) => {
    panel.hidden = true;
  });
}

function showSettingsCategory(elements, category) {
  elements.settingsCategoryList.hidden = true;
  elements.settingsDetail.hidden = false;
  elements.settingsDetailPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== category;
  });
}

function getCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function setCookie(name, value) {
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax`;
}

function addMaterialSymbolImage(map, id) {
  if (!id || map.hasImage(id)) return;
  const symbol = symbolForStyleImage(id);
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  context.clearRect(0, 0, size, size);
  context.beginPath();
  context.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#0f8f68";
  context.stroke();
  context.fillStyle = "#0f8f68";
  context.font = '500 25px "Material Symbols Rounded"';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(symbol, size / 2, size / 2 + 1);

  map.addImage(id, canvas, { pixelRatio: 2 });
}

function symbolForStyleImage(id) {
  const key = id.replace(/_\d+$/, "").replace(/-/g, "_").toLowerCase();
  const symbols = {
    airport: "flight",
    bank: "account_balance",
    bar: "local_bar",
    cafe: "local_cafe",
    casino: "casino",
    cinema: "movie",
    education: "school",
    emergency: "emergency",
    entertainment: "attractions",
    food: "restaurant",
    government_building: "account_balance",
    hospital: "local_hospital",
    hotel: "hotel",
    parking: "local_parking",
    place_of_worship: "temple_buddhist",
    police: "local_police",
    restaurant: "restaurant",
    school: "school",
    station: "train",
    supermarket: "local_grocery_store",
    transit: "directions_transit",
    utilities: "electrical_services"
  };
  return symbols[key] || "location_on";
}

function bindModeButtons(state, elements, routePanel) {
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeMode = button.dataset.mode;
      elements.modeButtons.forEach((candidate) => {
        const isActive = candidate === button;
        candidate.classList.toggle("active", isActive);
        candidate.setAttribute("aria-checked", String(isActive));
      });
      if (state.route.routes.length) routePanel.calculate();
    });
  });
}
