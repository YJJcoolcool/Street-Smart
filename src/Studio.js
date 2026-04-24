import { fetchConfig, fetchStudioReports, publishReport, sendJson } from "./lib/api.js";

const defaultCenter = { lat: 1.2966, lng: 103.852 };
const storageKey = "street-smart-reports";
const STUDIO_REPORT_CLUSTER_RADIUS = 30;
const STUDIO_REPORT_CLUSTER_MAX_ZOOM = 12;

const elements = {
  map: document.querySelector("#studio-map"),
  status: document.querySelector("#studio-status"),
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
  loginButton: document.querySelector("#osm-login-button"),
  loginLabel: document.querySelector("#osm-login-label"),
  loginStatus: document.querySelector("#osm-login-status"),
  authPanel: document.querySelector("#studio-auth-panel"),
  authClose: document.querySelector("#studio-auth-close"),
  authMessage: document.querySelector("#studio-auth-message"),
  authSession: document.querySelector("#studio-auth-session"),
  authUser: document.querySelector("#studio-auth-user"),
  authRole: document.querySelector("#studio-auth-role"),
  logoutButton: document.querySelector("#studio-logout-button"),
  loginForm: document.querySelector("#studio-login-form"),
  loginIdentity: document.querySelector("#studio-login-identity"),
  loginPassword: document.querySelector("#studio-login-password"),
  loginSwitch: document.querySelector("#studio-login-switch"),
  createForm: document.querySelector("#studio-create-form"),
  createIdentity: document.querySelector("#studio-create-identity"),
  createPassword: document.querySelector("#studio-create-password"),
  createSwitch: document.querySelector("#studio-create-switch"),
  resetForm: document.querySelector("#studio-reset-form"),
  resetIdentity: document.querySelector("#studio-reset-identity"),
  resetCurrentPassword: document.querySelector("#studio-reset-current-password"),
  resetPassword: document.querySelector("#studio-reset-password"),
  resetSwitch: document.querySelector("#studio-reset-switch"),
  authModeButtons: [...document.querySelectorAll("[data-auth-mode]")],
  adminPanel: document.querySelector("#studio-admin-panel"),
  adminCount: document.querySelector("#studio-admin-count"),
  adminList: document.querySelector("#studio-admin-list"),
  adminForm: document.querySelector("#studio-admin-form"),
  adminIdentity: document.querySelector("#studio-admin-identity"),
  adminPassword: document.querySelector("#studio-admin-password"),
  count: document.querySelector("#studio-report-count"),
  visibleCount: document.querySelector("#studio-visible-count"),
  list: document.querySelector("#studio-report-list"),
  empty: document.querySelector("#studio-empty"),
  accordions: [...document.querySelectorAll(".studio-accordion")],
  reportButtons: [...document.querySelectorAll("[data-signal]")],
  mapEditButtons: [...document.querySelectorAll("[data-map-edit]")],
  editToolbar: document.querySelector("#studio-edit-toolbar"),
  editTitle: document.querySelector("#studio-edit-title"),
  editModeLabel: document.querySelector("#studio-edit-mode-label"),
  editInstructions: document.querySelector("#studio-edit-instructions"),
  saveLocation: document.querySelector("#studio-save-location"),
  cancelEdit: document.querySelector("#studio-cancel-edit"),
  roadEditor: document.querySelector("#studio-road-editor"),
  draftCount: document.querySelector("#studio-draft-count"),
  drawModeButtons: [...document.querySelectorAll("[data-draw-mode]")],
  undoNode: document.querySelector("#studio-undo-node"),
  clearDraft: document.querySelector("#studio-clear-draft"),
  saveDraft: document.querySelector("#studio-save-draft")
};

const state = {
  config: await fetchConfig().catch(() => ({})),
  reports: readReports(),
  preferences: readPreferences(),
  studioSession: readStudioSession(),
  admins: [],
  mapProvider: "grab",
  failedMapProviders: new Set(),
  selectedReportId: null,
  editingReportId: null,
  creationMode: null,
  pendingReportType: null,
  locationEditMode: false,
  reportPlacementMarker: null,
  draftNodeMarkers: [],
  drawMode: "road",
  draftNodes: [],
  ignoreNextMapClick: false,
  map: null
};

syncSettingsControls();
state.mapProvider = preferredAvailableMapProvider(state.preferences.mapProvider);
const center = state.config?.defaultCenter || defaultCenter;
state.map = new maplibregl.Map({
  container: "studio-map",
  style: styleUrlForProvider(state.mapProvider),
  center: [center.lng, center.lat],
  zoom: 12
});
window.streetSmartStudioMap = state.map;
updateProviderLabel();

state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
state.map.on("styleimagemissing", (event) => addMaterialSymbolImage(state.map, event.id));
state.map.on("load", () => {
  installReportLayers();
  renderReports();
});
["moveend", "zoomend"].forEach((eventName) => {
  state.map.on(eventName, () => renderReports());
});
state.map.on("styledata", () => {
  if (state.map.isStyleLoaded()) {
    installReportLayers();
    renderMapReports();
  }
});
state.map.on("error", (event) => {
  if (shouldFallbackMapProvider(event)) fallbackMapProvider();
});
state.map.on("click", (event) => handleStudioMapClick(event));

elements.reportButtons.forEach((button) => {
  button.addEventListener("click", () => startNewReportPlacement(button.dataset.signal));
});
elements.mapEditButtons.forEach((button) => {
  button.addEventListener("click", () => startMapEdit(button.dataset.mapEdit));
});
bindSettings();
bindStudioAuth();
bindReportEditing();
bindStudioAccordions();
await refreshStudioSession();
renderStudioAuth();
await loadReports();

renderReports();

function startMapEdit(kind) {
  if (kind === "missing-road") {
    startMissingRoadEditor();
    return;
  }
  if (kind === "missing-place") {
    startNewReportPlacement("Missing place", { mode: "missing-place" });
  }
}

function startNewReportPlacement(type, { mode = "report" } = {}) {
  if (!state.studioSession?.token) {
    elements.status.textContent = "Login to Street Smart Studio before submitting map edits.";
    elements.loginButton.focus();
    return;
  }

  state.creationMode = mode;
  state.pendingReportType = type;
  state.editingReportId = null;
  state.locationEditMode = true;
  state.selectedReportId = null;
  state.draftNodes = [];
  clearSelectedReportLayers();

  elements.editToolbar.hidden = false;
  elements.editTitle.textContent = type;
  elements.editModeLabel.textContent = mode === "missing-place" ? "Place" : "Report";
  elements.editInstructions.textContent = "Drag the marker to the report location, then save.";
  elements.roadEditor.hidden = true;
  elements.saveLocation.hidden = false;
  setSaveLocationButton("location_on", mode === "missing-place" ? "Save place" : "Save report");

  const center = state.map.getCenter();
  ensureReportPlacementMarker();
  state.reportPlacementMarker.setLngLat(center).addTo(state.map);
  state.reportPlacementMarker.getElement().hidden = false;
  elements.status.textContent = `${type}: drag the marker to the right location, then save.`;
}

function startMissingRoadEditor(report = null) {
  if (!state.studioSession?.token) {
    elements.status.textContent = "Login to Street Smart Studio before submitting map edits.";
    elements.loginButton.focus();
    return;
  }

  state.creationMode = report ? null : "missing-road";
  state.pendingReportType = "Missing road";
  state.selectedReportId = report?.id || null;
  state.editingReportId = report?.id || null;
  state.locationEditMode = false;
  state.drawMode = "road";
  state.draftNodes = report?.editorDraft?.nodes?.filter(isLngLat) || [];

  if (state.reportPlacementMarker) state.reportPlacementMarker.getElement().hidden = true;
  elements.editToolbar.hidden = false;
  elements.editTitle.textContent = report?.type || "Add a missing road";
  elements.editModeLabel.textContent = "Road";
  elements.editInstructions.textContent = "Click the map to add road nodes. Drag nodes to adjust, or click a node to delete it.";
  elements.roadEditor.hidden = false;
  elements.saveLocation.hidden = true;
  renderEditorDraft(report);
  elements.status.textContent = "Road editor ready. Add at least two nodes for the missing road.";
}

async function addReport(type, point, extra = {}) {
  if (!state.studioSession?.token) {
    elements.status.textContent = "Login to Street Smart Studio before submitting map edits.";
    elements.loginButton.focus();
    return null;
  }

  const location = point || state.map.getCenter();
  const report = {
    id: crypto.randomUUID(),
    type,
    context: `${type} placed at ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`,
    mode: "studio",
    lat: location.lat,
    lng: location.lng,
    createdBy: userLabel(state.studioSession.user),
    createdAt: new Date().toISOString(),
    ...extra
  };
  state.reports.unshift(report);
  state.reports = state.reports.slice(0, 200);
  writeReports();
  renderReports();
  try {
    await publishReport(report);
    await loadReports({ render: false });
    renderReports();
    elements.status.textContent = `${type} published.`;
  } catch (error) {
    elements.status.textContent = `${type} saved locally. Studio server sync failed: ${error.message}`;
  }
  return report;
}

function bindStudioAuth() {
  elements.loginButton.addEventListener("click", () => {
    elements.authPanel.hidden = !elements.authPanel.hidden;
    if (!elements.authPanel.hidden && state.studioSession?.user?.role === "superadmin") loadAdmins();
  });
  elements.authClose.addEventListener("click", () => {
    elements.authPanel.hidden = true;
  });
  elements.logoutButton.addEventListener("click", () => logoutStudio());
  elements.authModeButtons.forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loginStudio(elements.loginIdentity.value, elements.loginPassword.value);
  });
  elements.createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createStudioAccount(elements.createIdentity.value, elements.createPassword.value);
  });
  elements.resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await resetStudioPassword(elements.resetIdentity.value, elements.resetCurrentPassword.value, elements.resetPassword.value);
  });
  elements.adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addAdmin(elements.adminIdentity.value, elements.adminPassword.value);
  });
  setAuthMode("login");
}

function setAuthMode(mode) {
  const nextMode = new Set(["login", "create", "reset"]).has(mode) ? mode : "login";
  const modeMap = [
    [elements.loginForm, elements.loginSwitch, "login"],
    [elements.createForm, elements.createSwitch, "create"],
    [elements.resetForm, elements.resetSwitch, "reset"]
  ];
  const loggedIn = Boolean(state.studioSession?.user);
  modeMap.forEach(([form, switcher, formMode]) => {
    const active = formMode === nextMode;
    form.dataset.authActive = String(active);
    switcher.dataset.authActive = String(active);
    form.hidden = loggedIn || !active;
    switcher.hidden = loggedIn || !active;
  });
}

async function loginStudio(login, password) {
  try {
    elements.authMessage.textContent = "Logging in...";
    const data = await studioApi("/api/studio/auth/login", {
      method: "POST",
      body: { login, password },
      auth: false
    });
    setStudioSession(data.session);
    elements.loginForm.reset();
    elements.authMessage.textContent = `Logged in as ${userLabel(state.studioSession.user)}.`;
    renderStudioAuth();
    if (state.studioSession.user.role === "superadmin") await loadAdmins();
  } catch (error) {
    elements.authMessage.textContent = error.message || "Login failed.";
  }
}

async function createStudioAccount(login, password) {
  try {
    elements.authMessage.textContent = "Creating account...";
    const data = await studioApi("/api/studio/auth/register", {
      method: "POST",
      body: { login, password },
      auth: false
    });
    setStudioSession(data.session);
    elements.createForm.reset();
    elements.authMessage.textContent = `Account created for ${userLabel(state.studioSession.user)}.`;
    renderStudioAuth();
  } catch (error) {
    elements.authMessage.textContent = error.message || "Could not create account.";
  }
}

async function resetStudioPassword(login, currentPassword, password) {
  try {
    elements.authMessage.textContent = "Resetting password...";
    const data = await studioApi("/api/studio/auth/reset-password", {
      method: "POST",
      body: { login, currentPassword, password },
      auth: false
    });
    elements.resetForm.reset();
    elements.authMessage.textContent = data.message || "Password reset complete.";
  } catch (error) {
    elements.authMessage.textContent = error.message || "Password reset failed.";
  }
}

async function logoutStudio() {
  try {
    if (state.studioSession?.token) {
      await studioApi("/api/studio/auth/logout", { method: "POST" }).catch(() => null);
    }
  } finally {
    clearStudioSession();
    state.admins = [];
    elements.authMessage.textContent = "Logged out.";
    renderStudioAuth();
    setAuthMode("login");
    renderReports();
  }
}

async function refreshStudioSession() {
  if (!state.studioSession?.token) return;
  try {
    const data = await studioApi("/api/studio/auth/me");
    state.studioSession.user = data.user;
    writeStudioSession();
    if (data.user?.role === "superadmin") await loadAdmins();
  } catch {
    clearStudioSession();
  }
}

function renderStudioAuth() {
  const user = state.studioSession?.user;
  const loggedIn = Boolean(user);
  const canManageReports = canRemoveReports();
  elements.loginButton.classList.toggle("logged-in", loggedIn);
  elements.loginButton.title = loggedIn ? "Studio account" : "Login to Studio";
  elements.loginLabel.textContent = loggedIn ? userLabel(user) : "Login";
  elements.loginButton.querySelector(".material-symbols-rounded").textContent = loggedIn ? "verified_user" : "account_circle";
  elements.loginStatus.textContent = loggedIn
    ? `${roleLabel(user.role)} connected. ${canManageReports ? "You can remove user reports." : "You can publish map edits."}`
    : "Login with a Street Smart account before submitting map edits.";

  elements.authSession.hidden = !loggedIn;
  elements.logoutButton.hidden = !loggedIn;
  elements.authUser.textContent = loggedIn ? userLabel(user) : "Not logged in";
  elements.authRole.textContent = loggedIn ? roleLabel(user.role) : "User";
  elements.adminPanel.hidden = user?.role !== "superadmin";
  elements.loginForm.hidden = loggedIn || elements.loginForm.dataset.authActive !== "true";
  elements.createForm.hidden = loggedIn || elements.createForm.dataset.authActive !== "true";
  elements.resetForm.hidden = loggedIn || elements.resetForm.dataset.authActive !== "true";
  elements.loginSwitch.hidden = loggedIn || elements.loginSwitch.dataset.authActive !== "true";
  elements.createSwitch.hidden = loggedIn || elements.createSwitch.dataset.authActive !== "true";
  elements.resetSwitch.hidden = loggedIn || elements.resetSwitch.dataset.authActive !== "true";
  if (!loggedIn && !state.config?.studioAuth?.superadminConfigured) {
    elements.authMessage.textContent = "Superadmin login is not configured yet.";
  }
}

async function loadAdmins() {
  if (state.studioSession?.user?.role !== "superadmin") return;
  try {
    const data = await studioApi("/api/studio/admins");
    state.admins = data.admins || [];
    renderAdmins();
  } catch (error) {
    elements.authMessage.textContent = error.message || "Could not load admins.";
  }
}

function renderAdmins() {
  elements.adminCount.textContent = String(state.admins.length);
  elements.adminList.innerHTML = "";
  state.admins.forEach((admin) => {
    const item = document.createElement("li");
    item.className = "studio-admin-item";
    item.innerHTML = `
      <div>
        <strong></strong>
        <span></span>
      </div>
    `;
    item.querySelector("strong").textContent = userLabel(admin);
    item.querySelector("span").textContent = roleLabel(admin.role);
    if (admin.removable) {
      const remove = document.createElement("button");
      remove.className = "signal-remove-button";
      remove.type = "button";
      remove.title = "Remove admin";
      remove.setAttribute("aria-label", `Remove ${userLabel(admin)} as admin`);
      remove.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">person_remove</span>`;
      remove.addEventListener("click", () => removeAdmin(admin.id));
      item.append(remove);
    }
    elements.adminList.append(item);
  });
}

async function addAdmin(login, password) {
  try {
    elements.authMessage.textContent = "Adding admin...";
    const data = await studioApi("/api/studio/admins", {
      method: "POST",
      body: { login, password }
    });
    state.admins = data.admins || [];
    elements.adminForm.reset();
    renderAdmins();
    elements.authMessage.textContent = "Admin list updated.";
  } catch (error) {
    elements.authMessage.textContent = error.message || "Could not add admin.";
  }
}

async function removeAdmin(adminId) {
  try {
    const data = await studioApi(`/api/studio/admins/${encodeURIComponent(adminId)}`, {
      method: "DELETE"
    });
    state.admins = data.admins || [];
    renderAdmins();
    elements.authMessage.textContent = "Admin removed.";
  } catch (error) {
    elements.authMessage.textContent = error.message || "Could not remove admin.";
  }
}

function readStudioSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem("street-smart-studio-session") || "null");
    return parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

function setStudioSession(session) {
  state.studioSession = session?.token ? session : null;
  writeStudioSession();
}

function writeStudioSession() {
  if (!state.studioSession?.token) return clearStudioSession();
  localStorage.setItem("street-smart-studio-session", JSON.stringify(state.studioSession));
}

function clearStudioSession() {
  state.studioSession = null;
  localStorage.removeItem("street-smart-studio-session");
}

async function studioApi(url, { method = "GET", body, auth = true } = {}) {
  return sendJson(url, {
    method,
    body,
    token: auth ? state.studioSession?.token : undefined
  });
}

function userLabel(user = {}) {
  return user.displayName || user.username || user.email || "Studio user";
}

function roleLabel(role = "user") {
  return role === "superadmin" ? "Superadmin" : role === "admin" ? "Admin" : "User";
}

function canRemoveReports() {
  return ["admin", "superadmin"].includes(state.studioSession?.user?.role);
}

function installReportLayers() {
  if (!state.map.isStyleLoaded()) return;
  if (!state.map.getSource("studio-reports")) {
    state.map.addSource("studio-reports", {
      type: "geojson",
      data: reportFeatureCollection(),
      cluster: true,
      clusterRadius: STUDIO_REPORT_CLUSTER_RADIUS,
      clusterMaxZoom: STUDIO_REPORT_CLUSTER_MAX_ZOOM
    });
  }
  if (!state.map.getSource("studio-report-suggested")) {
    state.map.addSource("studio-report-suggested", { type: "geojson", data: emptyFeatureCollection() });
  }
  if (!state.map.getSource("studio-report-actual")) {
    state.map.addSource("studio-report-actual", { type: "geojson", data: emptyFeatureCollection() });
  }
  if (!state.map.getSource("studio-report-focus")) {
    state.map.addSource("studio-report-focus", { type: "geojson", data: emptyFeatureCollection() });
  }
  if (!state.map.getSource("studio-editor-draft")) {
    state.map.addSource("studio-editor-draft", { type: "geojson", data: emptyFeatureCollection() });
  }

  if (!state.map.getLayer("studio-report-clusters")) {
    state.map.addLayer({
      id: "studio-report-clusters",
      type: "circle",
      source: "studio-reports",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#c26a28",
        "circle-radius": ["step", ["get", "point_count"], 18, 8, 24, 25, 32],
        "circle-opacity": 0.94,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3
      }
    });
  }

  if (!state.map.getLayer("studio-report-cluster-count")) {
    state.map.addLayer({
      id: "studio-report-cluster-count",
      type: "symbol",
      source: "studio-reports",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-size": 12,
        "text-font": ["Noto Sans Bold"]
      },
      paint: {
        "text-color": "#ffffff"
      }
    });
  }

  if (!state.map.getLayer("studio-report-point-halo")) {
    state.map.addLayer({
      id: "studio-report-point-halo",
      type: "circle",
      source: "studio-reports",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": "#c26a28",
        "circle-radius": 14,
        "circle-opacity": 0.92,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3
      }
    });
  }

  if (!state.map.getLayer("studio-report-point")) {
    state.map.addLayer({
      id: "studio-report-point",
      type: "symbol",
      source: "studio-reports",
      filter: ["!", ["has", "point_count"]],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": 0.85,
        "icon-allow-overlap": true
      }
    });
  }

  if (!state.map.getLayer("studio-report-suggested-casing")) {
    state.map.addLayer({
      id: "studio-report-suggested-casing",
      type: "line",
      source: "studio-report-suggested",
      paint: {
        "line-color": "#ffffff",
        "line-width": 14,
        "line-opacity": 0.95
      },
      layout: {
        "line-cap": "round",
        "line-join": "round"
      }
    });
  }
  if (!state.map.getLayer("studio-report-suggested-line")) {
    state.map.addLayer({
      id: "studio-report-suggested-line",
      type: "line",
      source: "studio-report-suggested",
      paint: {
        "line-color": "#2563eb",
        "line-width": 8,
        "line-opacity": 1
      },
      layout: {
        "line-cap": "round",
        "line-join": "round"
      }
    });
  }
  if (!state.map.getLayer("studio-report-actual-casing")) {
    state.map.addLayer({
      id: "studio-report-actual-casing",
      type: "line",
      source: "studio-report-actual",
      paint: {
        "line-color": "#ffffff",
        "line-width": 14,
        "line-opacity": 0.95
      },
      layout: {
        "line-cap": "round",
        "line-join": "round"
      }
    });
  }
  if (!state.map.getLayer("studio-report-actual-line")) {
    state.map.addLayer({
      id: "studio-report-actual-line",
      type: "line",
      source: "studio-report-actual",
      paint: {
        "line-color": "#c26a28",
        "line-width": 8,
        "line-opacity": 1
      },
      layout: {
        "line-cap": "round",
        "line-join": "round"
      }
    });
  }
  if (!state.map.getLayer("studio-report-focus-point")) {
    state.map.addLayer({
      id: "studio-report-focus-point",
      type: "circle",
      source: "studio-report-focus",
      paint: {
        "circle-color": "#c26a28",
        "circle-radius": 7,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3
      }
    });
  }
  if (!state.map.getLayer("studio-editor-area")) {
    state.map.addLayer({
      id: "studio-editor-area",
      type: "fill",
      source: "studio-editor-draft",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#0f8f68",
        "fill-opacity": 0.18
      }
    });
  }
  if (!state.map.getLayer("studio-editor-line")) {
    state.map.addLayer({
      id: "studio-editor-line",
      type: "line",
      source: "studio-editor-draft",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": "#0f8f68",
        "line-width": 5,
        "line-dasharray": [1.2, 0.7]
      }
    });
  }
  if (!state.map.getLayer("studio-editor-nodes")) {
    state.map.addLayer({
      id: "studio-editor-nodes",
      type: "circle",
      source: "studio-editor-draft",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": "#0f8f68",
        "circle-radius": 6,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3
      }
    });
  }

  if (!state.boundReportLayerEvents) {
    state.map.on("click", "studio-report-clusters", openCluster);
    state.map.on("click", "studio-report-point-halo", openReport);
    state.map.on("click", "studio-report-point", openReport);
    state.boundReportLayerEvents = true;
  }
}

function openCluster(event) {
  const feature = event.features?.[0];
  if (!feature) return;
  const source = state.map.getSource("studio-reports");
  source.getClusterExpansionZoom(feature.properties.cluster_id, (error, zoom) => {
    if (error) return;
    state.map.easeTo({
      center: feature.geometry.coordinates,
      zoom: Math.min(zoom + 1, 18),
      duration: 500
    });
  });
}

function openReport(event) {
  const feature = event.features?.[0];
  if (!feature) return;
  state.ignoreNextMapClick = true;
  const report = state.reports.find((item) => item.id === feature.properties.id);
  if (!report) return;
  focusReport(report);
}

async function loadReports({ render = true } = {}) {
  const localReports = readReports();
  try {
    await Promise.all(localReports.map((report) => publishReport(report).catch(() => null)));
    state.reports = (await fetchStudioReports()).map(normalizeReportLocation).filter(Boolean);
    writeReports();
  } catch (error) {
    console.warn("Using local report cache.", error);
    state.reports = localReports;
  }
  if (render) renderReports();
}

function renderReports() {
  const visibleReports = reportsInView();
  elements.count.textContent = `${state.reports.length} open`;
  elements.visibleCount.textContent = visibleReports.length > 20 ? "Clustered" : `${visibleReports.length} visible`;
  elements.empty.hidden = visibleReports.length > 0;
  elements.list.innerHTML = "";

  visibleReports.forEach((report) => {
    const item = document.createElement("li");
    item.className = `signal-item${canRemoveReports() ? " with-actions" : ""}`;
    const time = new Date(report.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    item.innerHTML = `
      <button class="signal-item-button" type="button">
        <strong></strong>
        <span></span>
      </button>
    `;
    item.querySelector("strong").textContent = report.type;
    item.querySelector("span").textContent = `${report.context || formatReportLocation(report)} - ${time}`;
    item.querySelector(".signal-item-button").addEventListener("click", () => {
      focusReport(report);
    });
    if (canRemoveReports()) {
      const remove = document.createElement("button");
      remove.className = "signal-remove-button";
      remove.type = "button";
      remove.title = "Remove report";
      remove.setAttribute("aria-label", `Remove ${report.type}`);
      remove.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">delete</span>`;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeReport(report.id);
      });
      item.append(remove);
    }
    elements.list.append(item);
  });
  renderMapReports();
}

function renderMapReports() {
  if (!state.map?.isStyleLoaded() || !state.map.getSource("studio-reports")) return;
  state.map.getSource("studio-reports").setData(reportFeatureCollection(reportsInView()));
  renderSelectedReportPath();
}

function focusReport(report) {
  const point = reportPoint(report);
  if (!point) {
    elements.status.textContent = "This report does not have a valid location.";
    return;
  }
  state.selectedReportId = report.id;
  showSelectedReport(report);
  renderSelectedReportPath();
  const suggestedCount = reportDeviationLine(report, "suggestedLine").length;
  const actualCount = reportDeviationLine(report, "actualLine").length;
  elements.status.textContent = `${report.type}: ${suggestedCount + actualCount} deviation path points loaded.`;
  const points = reportPathPoints(report);
  if (points.length >= 2) {
    fitReportPath(points);
  } else {
    state.map.easeTo({ center: point, zoom: Math.max(state.map.getZoom(), 16), duration: 500 });
  }
}

async function removeReport(reportId) {
  if (!canRemoveReports()) {
    elements.status.textContent = "Admin login required to remove reports.";
    return;
  }
  try {
    const data = await studioApi(`/api/studio/reports/${encodeURIComponent(reportId)}`, {
      method: "DELETE"
    });
    state.reports = (data.reports || []).map(normalizeReportLocation).filter(Boolean);
    if (state.selectedReportId === reportId) {
      state.selectedReportId = null;
      stopReportEditing();
      clearSelectedReportLayers();
    }
    writeReports();
    renderReports();
    renderMapReports();
    elements.status.textContent = "Report removed.";
  } catch (error) {
    elements.status.textContent = error.message || "Could not remove report.";
  }
}

function renderSelectedReportPath() {
  if (!state.map?.isStyleLoaded()) {
    state.map?.once("idle", () => renderSelectedReportPath());
    return;
  }
  installReportLayers();
  const report = state.reports.find((item) => item.id === state.selectedReportId);
  const suggestedLine = report ? reportDeviationLine(report, "suggestedLine") : [];
  const actualLine = report ? reportDeviationLine(report, "actualLine") : [];
  state.map.getSource("studio-report-suggested")?.setData(lineFeature(suggestedLine));
  state.map.getSource("studio-report-actual")?.setData(lineFeature(actualLine));
  state.map.getSource("studio-report-focus")?.setData(report ? pointFeature(reportPoint(report)) : emptyFeatureCollection());
  moveSelectedReportLayersToTop();
  state.map.triggerRepaint();
  renderEditorDraft(report);
}

function bindReportEditing() {
  elements.saveLocation.addEventListener("click", () => {
    if (state.creationMode === "report" || state.creationMode === "missing-place") saveNewPlacedReport();
    else if (state.locationEditMode) saveReportLocation();
    else startReportPlacement(selectedReport());
  });
  elements.cancelEdit.addEventListener("click", () => stopReportEditing());
  elements.drawModeButtons.forEach((button) => {
    button.addEventListener("click", () => setDrawMode(button.dataset.drawMode));
  });
  elements.undoNode.addEventListener("click", () => {
    state.draftNodes.pop();
    renderEditorDraft();
  });
  elements.clearDraft.addEventListener("click", () => {
    state.draftNodes = [];
    renderEditorDraft();
  });
  elements.saveDraft.addEventListener("click", () => saveEditorDraft());
}

function bindStudioAccordions() {
  elements.accordions.forEach((accordion) => {
    accordion.addEventListener("toggle", () => {
      if (!accordion.open) return;
      elements.accordions.forEach((other) => {
        if (other !== accordion) other.open = false;
      });
    });
  });
}

function showSelectedReport(report) {
  state.editingReportId = null;
  state.creationMode = null;
  state.pendingReportType = null;
  state.locationEditMode = false;
  elements.editToolbar.hidden = false;
  elements.editTitle.textContent = report.type;
  elements.editModeLabel.textContent = "Location";
  elements.editInstructions.textContent = "";
  elements.roadEditor.hidden = true;
  elements.saveLocation.hidden = false;
  setLocationEditButton(false);
  if (state.reportPlacementMarker) state.reportPlacementMarker.getElement().hidden = true;
  clearDraftNodeMarkers();
  renderEditorDraft(report);
}

function startReportPlacement(report) {
  if (!report) return;
  if (isMissingRoadReport(report)) {
    startMissingRoadEditor(report);
    return;
  }
  const position = reportPoint(report);
  if (!position) {
    elements.status.textContent = "This report does not have a valid location.";
    return;
  }

  state.creationMode = null;
  state.pendingReportType = null;
  state.editingReportId = report.id;
  state.locationEditMode = true;
  elements.editToolbar.hidden = false;
  elements.editTitle.textContent = report.type;
  elements.editModeLabel.textContent = "Location";
  elements.editInstructions.textContent = "Drag the marker to the report location, then save.";
  setLocationEditButton(true);
  elements.roadEditor.hidden = true;
  elements.saveLocation.hidden = false;
  state.draftNodes = [];

  ensureReportPlacementMarker();
  state.reportPlacementMarker.setLngLat(position).addTo(state.map);
  state.reportPlacementMarker.getElement().hidden = false;
  renderEditorDraft(report);
}

function stopReportEditing() {
  state.editingReportId = null;
  state.creationMode = null;
  state.pendingReportType = null;
  state.locationEditMode = false;
  state.draftNodes = [];
  elements.editToolbar.hidden = true;
  elements.saveLocation.hidden = false;
  if (state.reportPlacementMarker) state.reportPlacementMarker.getElement().hidden = true;
  clearDraftNodeMarkers();
  renderEditorDraft();
}

async function saveNewPlacedReport() {
  if (!state.pendingReportType || !state.reportPlacementMarker) return;
  const point = state.reportPlacementMarker.getLngLat();
  const report = await addReport(state.pendingReportType, point);
  if (report) {
    stopReportEditing();
    const synced = state.reports.find((item) => item.id === report.id) || report;
    focusReport(synced);
  }
}

async function saveReportLocation() {
  const report = selectedReport();
  if (!report || !state.reportPlacementMarker) return;
  const point = state.reportPlacementMarker.getLngLat();
  await updateSelectedReport({
    lat: point.lat,
    lng: point.lng,
    context: `${report.type} placed at ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
  }, "Report location saved.");
}

function setLocationEditButton(editing) {
  setSaveLocationButton(editing ? "location_on" : "edit_location_alt", editing ? "Save location" : "Edit report location");
}

function setSaveLocationButton(icon, label) {
  elements.saveLocation.querySelector(".material-symbols-rounded").textContent = icon;
  elements.saveLocation.querySelector("span:last-child").textContent = label;
}

function handleStudioMapClick(event) {
  if (state.ignoreNextMapClick) {
    state.ignoreNextMapClick = false;
    return;
  }
  const roadEditorActive = !elements.roadEditor.hidden && (state.creationMode === "missing-road" || state.editingReportId);
  if (!roadEditorActive) return;
  if (state.drawMode !== "road") return;
  state.draftNodes.push([event.lngLat.lng, event.lngLat.lat]);
  renderEditorDraft();
}

function setDrawMode(mode) {
  state.drawMode = mode === "road" ? "road" : "road";
  elements.drawModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.drawMode === state.drawMode);
  });
  elements.editModeLabel.textContent = "Road";
  if (!elements.roadEditor.hidden) {
    elements.editInstructions.textContent = "Click the map to add road nodes. Drag nodes to adjust, or click a node to delete it.";
  }
  renderEditorDraft();
}

async function saveEditorDraft() {
  const report = selectedReport();
  if (!state.draftNodes.length) {
    elements.status.textContent = "Add at least one node before saving the draft.";
    return;
  }
  if (state.drawMode === "road" && state.draftNodes.length < 2) {
    elements.status.textContent = "A missing road needs at least two nodes.";
    return;
  }
  const editorDraft = {
    mode: "road",
    nodes: state.draftNodes
  };
  if (state.creationMode === "missing-road") {
    const firstNode = state.draftNodes[0];
    const created = await addReport("Missing road", { lng: firstNode[0], lat: firstNode[1] }, { editorDraft });
    if (created) {
      stopReportEditing();
      const synced = state.reports.find((item) => item.id === created.id) || created;
      focusReport(synced);
    }
    return;
  }
  if (!report) return;
  await updateSelectedReport({
    editorDraft: {
      mode: "road",
      nodes: state.draftNodes
    }
  }, "Missing road draft saved.");
}

async function updateSelectedReport(patch, message) {
  const report = selectedReport();
  if (!report || !state.studioSession?.token) {
    elements.status.textContent = "Studio login required to edit reports.";
    return;
  }
  try {
    const data = await studioApi(`/api/studio/reports/${encodeURIComponent(report.id)}`, {
      method: "PATCH",
      body: { report: patch }
    });
    const updated = normalizeReportLocation(data.report);
    if (!updated) throw new Error("Updated report was not valid.");
    state.reports = state.reports.map((item) => item.id === updated.id ? updated : item);
    writeReports();
    renderReports();
    renderMapReports();
    if (state.editingReportId === updated.id) startReportPlacement(updated);
    elements.status.textContent = message;
  } catch (error) {
    elements.status.textContent = error.message || "Could not update report.";
  }
}

function selectedReport() {
  return state.reports.find((report) => report.id === state.selectedReportId || report.id === state.editingReportId);
}

function clearSelectedReportLayers() {
  state.map.getSource("studio-report-suggested")?.setData(emptyFeatureCollection());
  state.map.getSource("studio-report-actual")?.setData(emptyFeatureCollection());
  state.map.getSource("studio-report-focus")?.setData(emptyFeatureCollection());
  state.map.getSource("studio-editor-draft")?.setData(emptyFeatureCollection());
  clearDraftNodeMarkers();
}

function renderEditorDraft(report = selectedReport()) {
  if (!state.map?.isStyleLoaded() || !state.map.getSource("studio-editor-draft")) return;
  const editingDraft = state.editingReportId || state.creationMode === "missing-road";
  const nodes = editingDraft
    ? state.draftNodes
    : (report?.editorDraft?.nodes || []);
  const mode = editingDraft ? state.drawMode : report?.editorDraft?.mode;
  state.map.getSource("studio-editor-draft").setData(editorDraftFeatureCollection(nodes, mode));
  elements.draftCount.textContent = `${nodes.length} node${nodes.length === 1 ? "" : "s"}`;
  if (editingDraft && !elements.roadEditor.hidden) renderDraftNodeMarkers(nodes);
  else clearDraftNodeMarkers();
}

function makeReportPlacementMarker() {
  const marker = document.createElement("div");
  marker.className = "studio-placement-marker";
  marker.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">location_on</span>`;
  return marker;
}

function ensureReportPlacementMarker() {
  if (state.reportPlacementMarker) return;
  state.reportPlacementMarker = new maplibregl.Marker({
    draggable: true,
    element: makeReportPlacementMarker()
  });
  state.reportPlacementMarker.on("dragend", () => {
    const point = state.reportPlacementMarker.getLngLat();
    elements.status.textContent = `Marker moved to ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}.`;
  });
}

function renderDraftNodeMarkers(nodes = state.draftNodes) {
  clearDraftNodeMarkers();
  nodes.filter(isLngLat).forEach((point, index) => {
    let lastDraggedAt = 0;
    const marker = new maplibregl.Marker({
      draggable: true,
      element: makeDraftNodeMarker(index)
    })
      .setLngLat(point)
      .addTo(state.map);

    marker.on("dragstart", () => {
      lastDraggedAt = Date.now();
    });
    marker.on("dragend", () => {
      lastDraggedAt = Date.now();
      const moved = marker.getLngLat();
      state.draftNodes[index] = [moved.lng, moved.lat];
      renderEditorDraft();
    });

    marker.getElement().addEventListener("click", (event) => {
      event.stopPropagation();
      if (Date.now() - lastDraggedAt < 350) return;
      state.draftNodes.splice(index, 1);
      renderEditorDraft();
    });

    state.draftNodeMarkers.push(marker);
  });
}

function clearDraftNodeMarkers() {
  state.draftNodeMarkers.forEach((marker) => marker.remove());
  state.draftNodeMarkers = [];
}

function makeDraftNodeMarker(index) {
  const marker = document.createElement("button");
  marker.className = "studio-draft-node-marker";
  marker.type = "button";
  marker.title = "Drag to adjust, click to delete";
  marker.setAttribute("aria-label", `Road node ${index + 1}`);
  marker.textContent = String(index + 1);
  return marker;
}

function editorDraftFeatureCollection(nodes = [], mode = "node") {
  const validNodes = nodes.filter(isLngLat);
  const features = [];
  if (mode === "road" && validNodes.length >= 2) {
    features.unshift({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: validNodes }
    });
  }
  return {
    type: "FeatureCollection",
    features
  };
}

function isMissingRoadReport(report) {
  return String(report?.type || "").toLowerCase().includes("missing road");
}

function reportFeatureCollection(reports = state.reports) {
  return {
    type: "FeatureCollection",
    features: reports
      .map((report) => normalizeReportLocation(report))
      .filter(Boolean)
      .map((report) => ({
        type: "Feature",
        properties: {
          id: report.id,
          type: report.type,
          icon: iconForReport(report.type)
        },
        geometry: {
          type: "Point",
          coordinates: reportPoint(report)
        }
      }))
  };
}

function reportsInView() {
  if (!state.map) return state.reports;
  const bounds = state.map.getBounds();
  return state.reports.filter((report) => {
    const point = reportPoint(report);
    return point && bounds.contains(point);
  });
}

function reportDeviationLine(report, key) {
  return Array.isArray(report.deviation?.[key])
    ? report.deviation[key].filter(isLngLat)
    : [];
}

function reportPathPoints(report) {
  const point = reportPoint(report);
  return [
    ...reportDeviationLine(report, "suggestedLine"),
    ...reportDeviationLine(report, "actualLine"),
    point
  ].filter(isLngLat);
}

function fitReportPath(points) {
  const validPoints = points.filter(isLngLat);
  if (!validPoints.length) return;
  const bounds = new maplibregl.LngLatBounds(validPoints[0], validPoints[0]);
  validPoints.slice(1).forEach((point) => bounds.extend(point));
  state.map.fitBounds(bounds, {
    padding: 72,
    maxZoom: 17,
    duration: 600
  });
}

function lineFeature(coordinates) {
  const line = coordinates.filter(isLngLat);
  if (line.length < 2) return emptyFeatureCollection();
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: line
      }
    }]
  };
}

function moveSelectedReportLayersToTop() {
  [
    "studio-report-suggested-casing",
    "studio-report-suggested-line",
    "studio-report-actual-casing",
    "studio-report-actual-line",
    "studio-report-focus-point",
    "studio-editor-area",
    "studio-editor-line",
    "studio-editor-nodes"
  ].forEach((layerId) => {
    if (state.map.getLayer(layerId)) state.map.moveLayer(layerId);
  });
}

function pointFeature(point) {
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

function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: []
  };
}

function readReports() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeReportLocation).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeReports() {
  localStorage.setItem(storageKey, JSON.stringify(state.reports));
}

function normalizeReportLocation(report) {
  const deviation = normalizeDeviation(report.deviation);
  const point = reportPoint({ ...report, deviation });
  if (!point) return null;
  const [lng, lat] = point;
  return {
    ...report,
    lat,
    lng,
    deviation,
    editorDraft: normalizeEditorDraft(report.editorDraft)
  };
}

function normalizeDeviation(deviation) {
  if (!deviation) return null;
  return {
    point: isLngLat(deviation.point) ? deviation.point : null,
    suggestedLine: Array.isArray(deviation.suggestedLine) ? deviation.suggestedLine.filter(isLngLat) : [],
    actualLine: Array.isArray(deviation.actualLine) ? deviation.actualLine.filter(isLngLat) : []
  };
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
  const suggestedLine = Array.isArray(report?.deviation?.suggestedLine)
    ? report.deviation.suggestedLine.filter(isLngLat)
    : [];
  if (suggestedLine.length) return suggestedLine.at(-1);
  return null;
}

function normalizeEditorDraft(draft) {
  if (!draft) return null;
  return {
    mode: ["node", "road", "area"].includes(draft.mode) ? draft.mode : "road",
    nodes: Array.isArray(draft.nodes) ? draft.nodes.filter(isLngLat) : []
  };
}

function isLngLat(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]));
}

function formatReportLocation(report) {
  return `${Number(report.lat).toFixed(5)}, ${Number(report.lng).toFixed(5)}`;
}

function iconForReport(type = "") {
  const text = type.toLowerCase();
  if (text.includes("missing road")) return "studio_add_road";
  if (text.includes("access") || text.includes("blocked")) return "studio_block";
  if (text.includes("crossing")) return "studio_remove_road";
  if (text.includes("place")) return "studio_wrong_location";
  if (text.includes("flood")) return "studio_flood";
  if (text.includes("construction")) return "studio_construction";
  return "studio_report";
}

function shouldFallbackMapProvider(event) {
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

function fallbackMapProvider() {
  const failedProvider = state.mapProvider;
  state.failedMapProviders.add(failedProvider);
  const nextProvider = isGrabMapProvider(failedProvider) ? "osm" : "grab";
  if (state.failedMapProviders.has(nextProvider)) return;

  state.mapProvider = nextProvider;
  state.map.setStyle(styleUrlForProvider(nextProvider));
  updateProviderLabel(isGrabMapProvider(failedProvider)
    ? "Grab Maps unavailable, using OpenStreetMap"
    : "OpenStreetMap unavailable, using Grab Maps");
}

function bindSettings() {
  elements.settingsButton.addEventListener("click", () => {
    const willOpen = elements.settingsPanel.hidden;
    elements.settingsPanel.hidden = !willOpen;
    if (willOpen) showSettingsCategories();
  });
  elements.settingsClose.addEventListener("click", () => {
    elements.settingsPanel.hidden = true;
    showSettingsCategories();
  });
  elements.settingsBack.addEventListener("click", () => {
    showSettingsCategories();
  });
  elements.settingsCategoryButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showSettingsCategory(button.dataset.settingsCategory);
    });
  });
  elements.mapProviderSelect.addEventListener("change", () => {
    const provider = normalizeMapProvider(elements.mapProviderSelect.value);
    state.preferences.mapProvider = provider;
    state.mapProvider = preferredAvailableMapProvider(provider);
    state.failedMapProviders.clear();
    setCookie("street-smart-map-provider", provider);
    state.map.setStyle(styleUrlForProvider(state.mapProvider));
    updateProviderLabel(`${labelForMapProvider(state.mapProvider)} selected`);
  });
  elements.routingProviderSelect.addEventListener("change", () => {
    const provider = normalizeRoutingProvider(elements.routingProviderSelect.value);
    state.preferences.routingProvider = provider;
    setCookie("street-smart-routing-provider", provider);
    elements.status.textContent = `${provider === "osrm" ? "OSRM" : "Grab Maps"} saved as preferred routing provider.`;
  });
}

function showSettingsCategories() {
  elements.settingsCategoryList.hidden = false;
  elements.settingsDetail.hidden = true;
  elements.settingsDetailPanels.forEach((panel) => {
    panel.hidden = true;
  });
}

function showSettingsCategory(category) {
  elements.settingsCategoryList.hidden = true;
  elements.settingsDetail.hidden = false;
  elements.settingsDetailPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== category;
  });
}

function preferredAvailableMapProvider(provider) {
  if (isGrabMapProvider(provider) && !state.config?.hasDirectGrabKey) return "osm";
  return normalizeMapProvider(provider);
}

function styleUrlForProvider(provider) {
  if (provider === "osm") return "/api/osm-style";
  const baseUrl = state.config?.mapStyleUrl || "/api/map-style";
  const theme = grabThemeForProvider(provider);
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}theme=${theme}`;
}

function updateProviderLabel(message = "") {
  if (message) elements.status.textContent = message;
}

function readPreferences() {
  return {
    mapProvider: normalizeMapProvider(getCookie("street-smart-map-provider")),
    routingProvider: normalizeRoutingProvider(getCookie("street-smart-routing-provider"))
  };
}

function syncSettingsControls() {
  elements.mapProviderSelect.value = state.preferences.mapProvider;
  elements.routingProviderSelect.value = state.preferences.routingProvider;
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
  const symbol = symbolForImage(id);
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#c26a28";
  context.stroke();
  context.fillStyle = "#c26a28";
  context.font = '500 25px "Material Symbols Rounded"';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(symbol, size / 2, size / 2 + 1);
  map.addImage(id, canvas, { pixelRatio: 2 });
}

function symbolForImage(id) {
  const symbols = {
    studio_add_road: "add_road",
    studio_block: "block",
    studio_remove_road: "remove_road",
    studio_wrong_location: "wrong_location",
    studio_flood: "flood",
    studio_construction: "construction",
    studio_report: "report"
  };
  return symbols[id] || "location_on";
}
