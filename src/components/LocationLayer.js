import { makeCurrentPlace } from "../state/createState.js";

export class LocationLayer {
  constructor({ state }) {
    this.state = state;
    this.marker = null;
    this.element = null;
    this.heading = null;
    this.watchId = null;
    this.headingWatching = false;
    this.headingPermissionRequested = false;
    this.hasLiveLocation = false;
    this.lastCameraUpdate = 0;
    this.navigationMode = false;
    this.navigationTracker = null;
    this.headingSamples = [];
    this.hasOrientationHeading = false;
    this.lastAccuracyPoint = null;
    this.accuracyFrame = null;
    this.autoFollowNavigation = true;
    this.recenterButton = null;
    this.locateButton = null;
    this.locateIcon = null;
    this.locateSearching = false;
    this.pendingCenterOnFix = false;
    this.state.map.on("styledata", () => {
      if (!this.lastAccuracyPoint || this.state.navigation?.simulating || this.state.navigation?.manualControl) return;
      this.updateAccuracyCircle(this.lastAccuracyPoint);
    });
    this.state.map.on("zoom", () => this.queueAccuracyCircleRefresh());
    this.state.map.on("dragstart", () => this.pauseNavigationFollow());
    this.state.map.on("pitch", () => this.updateMarkerTransform());
    this.state.map.on("rotate", () => this.updateMarkerTransform());
  }

  request() {
    if (this.state.locationRequested) return;
    this.state.locationRequested = true;

    if (!navigator.geolocation) {
      this.update(this.state.defaultCenter);
      return;
    }

    this.startPositionWatch();
  }

  startPositionWatch() {
    if (this.watchId !== null) return;
    const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 };
    navigator.geolocation.getCurrentPosition(
      (position) => this.capturePosition(position),
      (error) => this.handlePositionError(error),
      options
    );
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.capturePosition(position),
      (error) => this.handlePositionError(error),
      options
    );
  }

  capturePosition(position) {
    const point = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: Number(position.coords.accuracy)
    };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;

    this.hasLiveLocation = true;
    this.setLocateSearching(false);
    const syntheticNavigation = this.state.navigation?.simulating || this.state.navigation?.manualControl;
    if (syntheticNavigation) {
      this.clearAccuracyCircle();
    } else {
      this.update(point);
    }

    const gpsHeading = Number(position.coords.heading);
    const gpsSpeed = Number(position.coords.speed);
    if (!this.hasOrientationHeading && Number.isFinite(gpsHeading) && gpsHeading >= 0 && (!Number.isFinite(gpsSpeed) || gpsSpeed > 0.4)) {
      this.setHeading(gpsHeading);
    }

    if (this.state.navigation.active && !syntheticNavigation) {
      this.navigationTracker?.([point.lng, point.lat]);
      this.followCurrentLocation(point);
    }

    if (this.pendingCenterOnFix && !syntheticNavigation) {
      this.pendingCenterOnFix = false;
      this.centerOnCurrent();
    }
  }

  handlePositionError() {
    this.hasLiveLocation = false;
    this.pendingCenterOnFix = false;
    this.setLocateSearching(false);
    this.clearAccuracyCircle();
    if (!this.marker) this.update(this.state.defaultCenter);
  }

  update(point, { showAccuracy = true } = {}) {
    this.state.currentPlace = makeCurrentPlace(point);
    if (!this.marker) {
      this.element = document.createElement("div");
      this.element.className = "current-location-marker";
      this.element.classList.toggle("navigating", this.navigationMode);
      this.marker = new maplibregl.Marker({ element: this.element }).setLngLat([point.lng, point.lat]).addTo(this.state.map);
    } else {
      this.marker.setLngLat([point.lng, point.lat]);
    }
    this.updateMarkerTransform();
    if (showAccuracy) this.updateAccuracyCircle(point);
  }

  setSimulatedLocation(point, heading = null) {
    this.update({ lat: point[1], lng: point[0] }, { showAccuracy: false });
    this.clearAccuracyCircle();
    if (heading !== null) this.setHeading(heading);
  }

  setNavigationMode(active) {
    this.navigationMode = active;
    this.autoFollowNavigation = active;
    if (this.element) this.element.classList.toggle("navigating", active);
    this.syncRecenterButton();
    if (active) this.watchHeading();
  }

  setHeading(heading, { force = false } = {}) {
    const normalizedHeading = normalizeHeading(heading);
    if (!Number.isFinite(normalizedHeading)) return;
    if (!force && Number.isFinite(this.heading) && headingDelta(this.heading, normalizedHeading) < MARKER_HEADING_DEADBAND_DEG) return;
    this.heading = normalizedHeading;
    this.updateMarkerTransform();
  }

  updateMarkerTransform() {
    if (!this.element) return;
    const screenHeading = Number.isFinite(this.heading)
      ? normalizeHeading(this.heading - this.state.map.getBearing())
      : 0;
    this.element.style.setProperty("--heading", `${screenHeading}deg`);
    this.element.style.setProperty("--pitch", `${this.state.map.getPitch()}deg`);
  }

  centerOnCurrent() {
    const canUseGeolocation = Boolean(navigator.geolocation);
    this.request();
    this.watchHeading({ requestPermission: true });
    if (!this.hasLiveLocation) {
      this.pendingCenterOnFix = canUseGeolocation;
      this.setLocateSearching(canUseGeolocation);
      return false;
    }

    this.setLocateSearching(false);

    const point = this.state.currentPlace;
    if (this.state.navigation.active) {
      this.autoFollowNavigation = true;
      this.syncRecenterButton();
      this.followCurrentLocation(point, { force: true });
      return true;
    }

    const bearing = this.navigationBearing();
    this.state.map.easeTo({
      center: [point.lng, point.lat],
      zoom: Math.max(this.state.map.getZoom(), 16),
      bearing,
      duration: 600
    });
    return true;
  }

  async watchHeading({ requestPermission = false } = {}) {
    if (!("DeviceOrientationEvent" in window)) return false;
    if (requestPermission && typeof DeviceOrientationEvent.requestPermission === "function" && !this.headingPermissionRequested) {
      this.headingPermissionRequested = true;
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== "granted") return false;
      } catch {
        return false;
      }
    }
    if (this.headingWatching) return true;
    this.headingWatching = true;
    window.addEventListener("deviceorientationabsolute", (event) => this.captureHeading(event), true);
    window.addEventListener("deviceorientation", (event) => this.captureHeading(event), true);
    return true;
  }

  captureHeading(event) {
    const rawHeading = headingFromOrientation(event);
    if (!Number.isFinite(rawHeading)) return;
    this.hasOrientationHeading = true;
    const averagedHeading = this.averageHeading(rawHeading);
    const previousHeading = Number.isFinite(this.heading) ? this.heading : averagedHeading;
    if (headingDelta(previousHeading, averagedHeading) < ORIENTATION_HEADING_DEADBAND_DEG) return;

    const heading = smoothHeading(previousHeading, averagedHeading, ORIENTATION_HEADING_SMOOTHING);
    this.setHeading(heading, { force: true });
    if (!this.state.navigation.active || this.state.navigation.simulating || this.state.navigation.manualControl) return;

    this.state.navigation.heading = heading;
    this.followCurrentLocation(this.state.currentPlace, { heading });
  }

  followCurrentLocation(point = this.state.currentPlace, { force = false, heading = this.heading } = {}) {
    if (!point || !Number.isFinite(point.lng) || !Number.isFinite(point.lat)) return;
    if (this.state.navigation.active && !this.autoFollowNavigation && !force) return;
    const now = performance.now();
    if (!force && now - this.lastCameraUpdate < CAMERA_UPDATE_INTERVAL_MS) return;
    this.lastCameraUpdate = now;

    const targetBearing = this.navigationBearing(heading);
    const currentBearing = this.state.map.getBearing();
    const shouldRotateCamera = force || headingDelta(currentBearing, targetBearing) >= CAMERA_BEARING_DEADBAND_DEG;
    const cameraBearing = force
      ? targetBearing
      : shouldRotateCamera
        ? smoothHeading(currentBearing, targetBearing, CAMERA_BEARING_SMOOTHING)
        : currentBearing;
    this.state.navigation.heading = targetBearing;
    this.setHeading(targetBearing);
    this.state.map.easeTo({
      center: [point.lng, point.lat],
      zoom: Math.max(this.state.map.getZoom(), 17),
      pitch: 45,
      bearing: cameraBearing,
      duration: force ? 700 : 650
    });
  }

  setNavigationTracker(callback) {
    this.navigationTracker = callback;
  }

  setRecenterButton(button) {
    this.recenterButton = button;
    this.syncRecenterButton();
  }

  setLocateButton(button) {
    this.locateButton = button;
    this.locateIcon = button?.querySelector(".material-symbols-rounded") || null;
    this.syncLocateButton();
  }

  setLocateSearching(searching) {
    const nextSearching = Boolean(searching);
    if (this.locateSearching === nextSearching) return;
    this.locateSearching = nextSearching;
    this.syncLocateButton();
  }

  syncLocateButton() {
    if (!this.locateButton) return;
    this.locateButton.classList.toggle("searching", this.locateSearching);
    this.locateButton.setAttribute("aria-busy", String(this.locateSearching));
    this.locateButton.title = this.locateSearching ? "Searching for your location" : "Go to my location";
    this.locateButton.setAttribute("aria-label", this.locateSearching ? "Searching for your location" : "Go to my location");
    if (this.locateIcon) {
      this.locateIcon.textContent = this.locateSearching ? "location_searching" : "my_location";
    }
  }

  pauseNavigationFollow() {
    if (!this.state.navigation.active || this.state.navigation.simulating || this.state.navigation.manualControl) return;
    this.autoFollowNavigation = false;
    this.syncRecenterButton();
  }

  recenterNavigation() {
    this.request();
    this.watchHeading({ requestPermission: true });
    if (!this.hasLiveLocation) {
      this.pendingCenterOnFix = true;
      return false;
    }

    this.autoFollowNavigation = true;
    this.syncRecenterButton();
    const point = this.state.currentPlace;
    this.followCurrentLocation(point, { force: true });
    return true;
  }

  syncRecenterButton() {
    if (!this.recenterButton) return;
    this.recenterButton.hidden = !this.state.navigation.active || this.autoFollowNavigation;
  }

  navigationBearing(fallbackHeading = null) {
    if (this.hasOrientationHeading && Number.isFinite(this.heading)) return this.heading;
    if (Number.isFinite(fallbackHeading)) return normalizeHeading(fallbackHeading);
    if (this.state.navigation.active && Number.isFinite(this.state.navigation.heading)) {
      return normalizeHeading(this.state.navigation.heading);
    }
    return this.state.map.getBearing();
  }

  averageHeading(heading) {
    const now = performance.now();
    this.headingSamples.push({ heading, timestamp: now });
    this.headingSamples = this.headingSamples.filter((sample) => now - sample.timestamp <= ORIENTATION_AVERAGE_WINDOW_MS);
    return averageHeadings(this.headingSamples.map((sample) => sample.heading)) ?? heading;
  }

  updateAccuracyCircle(point) {
    if (!point) return;
    const accuracy = Number(point.accuracy);
    if (!Number.isFinite(accuracy) || accuracy <= 0) {
      this.clearAccuracyCircle();
      return;
    }

    this.lastAccuracyPoint = { lat: point.lat, lng: point.lng, accuracy };
    if (!this.state.map.isStyleLoaded()) {
      this.state.map.once("styledata", () => this.updateAccuracyCircle(this.lastAccuracyPoint));
      return;
    }

    this.installAccuracyLayer();
    this.state.map.getSource(ACCURACY_SOURCE_ID)?.setData(accuracyPointFeature(point, accuracy));
    this.refreshAccuracyCircleRadius();
  }

  clearAccuracyCircle() {
    this.lastAccuracyPoint = null;
    if (!this.state.map?.isStyleLoaded() || !this.state.map.getSource(ACCURACY_SOURCE_ID)) return;
    this.state.map.getSource(ACCURACY_SOURCE_ID).setData(emptyFeatureCollection());
  }

  installAccuracyLayer() {
    const map = this.state.map;
    if (!map.getSource(ACCURACY_SOURCE_ID)) {
      map.addSource(ACCURACY_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getLayer(ACCURACY_CIRCLE_LAYER_ID)) {
      map.addLayer({
        id: ACCURACY_CIRCLE_LAYER_ID,
        type: "circle",
        source: ACCURACY_SOURCE_ID,
        paint: {
          "circle-color": "#1a73e8",
          "circle-opacity": 0.14,
          "circle-radius": 0,
          "circle-stroke-color": "#1a73e8",
          "circle-stroke-width": 2,
          "circle-stroke-opacity": 0.34,
          "circle-pitch-alignment": "map",
          "circle-pitch-scale": "map"
        }
      });
    }
  }

  queueAccuracyCircleRefresh() {
    if (!this.lastAccuracyPoint || this.accuracyFrame) return;
    this.accuracyFrame = requestAnimationFrame(() => {
      this.accuracyFrame = null;
      this.refreshAccuracyCircleRadius();
    });
  }

  refreshAccuracyCircleRadius() {
    if (!this.lastAccuracyPoint || !this.state.map?.isStyleLoaded() || !this.state.map.getLayer(ACCURACY_CIRCLE_LAYER_ID)) return;
    this.state.map.setPaintProperty(
      ACCURACY_CIRCLE_LAYER_ID,
      "circle-radius",
      accuracyPixelRadius(this.lastAccuracyPoint, this.state.map.getZoom())
    );
  }
}

const ORIENTATION_AVERAGE_WINDOW_MS = 2000;
const ORIENTATION_HEADING_SMOOTHING = 0.16;
const ORIENTATION_HEADING_DEADBAND_DEG = 3.5;
const MARKER_HEADING_DEADBAND_DEG = 1.2;
const CAMERA_BEARING_SMOOTHING = 0.12;
const CAMERA_BEARING_DEADBAND_DEG = 4;
const CAMERA_UPDATE_INTERVAL_MS = 850;
const ACCURACY_SOURCE_ID = "current-location-accuracy";
const ACCURACY_CIRCLE_LAYER_ID = "current-location-accuracy-circle";

function headingFromOrientation(event) {
  const webkitHeading = Number(event.webkitCompassHeading);
  if (Number.isFinite(webkitHeading)) return normalizeHeading(webkitHeading);

  const alpha = Number(event.alpha);
  if (!Number.isFinite(alpha)) return null;
  return normalizeHeading(360 - alpha);
}

function normalizeHeading(heading) {
  const number = Number(heading);
  if (!Number.isFinite(number)) return null;
  return (number % 360 + 360) % 360;
}

function averageHeadings(headings) {
  if (!headings.length) return null;
  let x = 0;
  let y = 0;
  headings.forEach((heading) => {
    const radians = normalizeHeading(heading) * Math.PI / 180;
    x += Math.cos(radians);
    y += Math.sin(radians);
  });
  if (Math.hypot(x, y) < 0.0001) return normalizeHeading(headings.at(-1));
  return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function smoothHeading(current, target, amount) {
  const normalizedCurrent = normalizeHeading(current);
  const normalizedTarget = normalizeHeading(target);
  if (!Number.isFinite(normalizedCurrent)) return normalizedTarget;
  if (!Number.isFinite(normalizedTarget)) return normalizedCurrent;
  const delta = ((((normalizedTarget - normalizedCurrent) % 360) + 540) % 360) - 180;
  return normalizeHeading(normalizedCurrent + delta * amount);
}

function headingDelta(a, b) {
  const normalizedA = normalizeHeading(a);
  const normalizedB = normalizeHeading(b);
  if (!Number.isFinite(normalizedA) || !Number.isFinite(normalizedB)) return Infinity;
  return Math.abs(((((normalizedB - normalizedA) % 360) + 540) % 360) - 180);
}

function accuracyPointFeature(point, radiusMeters) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        accuracy: radiusMeters
      },
      geometry: {
        type: "Point",
        coordinates: [point.lng, point.lat]
      }
    }]
  };
}

function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: []
  };
}

function accuracyPixelRadius(point, zoom) {
  const latitude = Math.max(-85, Math.min(85, Number(point.lat)));
  const metersPerPixel = Math.cos(latitude * Math.PI / 180) * 2 * Math.PI * EARTH_RADIUS_METERS / (TILE_SIZE * 2 ** zoom);
  const radius = Number(point.accuracy) / metersPerPixel;
  return Math.max(MIN_ACCURACY_PIXEL_RADIUS, Math.min(MAX_ACCURACY_PIXEL_RADIUS, radius));
}

const TILE_SIZE = 512;
const EARTH_RADIUS_METERS = 6371000;
const MIN_ACCURACY_PIXEL_RADIUS = 3;
const MAX_ACCURACY_PIXEL_RADIUS = 600;
