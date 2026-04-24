import { nearbyPlaces, searchPlaces } from "../lib/api.js";
import { distanceMeters, mapCenter, placeFeatureCollection } from "../lib/geo.js";
import { formatLatLng } from "../lib/format.js";

export class SearchPanel {
  constructor({ state, elements, sheet, onNavigate }) {
    this.state = state;
    this.elements = elements;
    this.sheet = sheet;
    this.onNavigate = onNavigate;
    this.layersInstalled = false;
    this.resultLayerIds = ["search-clusters", "search-cluster-count", "search-point"];
    this.longPressTimer = null;
    this.longPressStart = null;
    this.longPressDelay = 560;
    this.selectedMarker = null;
  }

  bind() {
    this.elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.search(this.elements.input.value, { expand: true });
    });

    this.elements.searchAreaButton.addEventListener("click", () => {
      this.searchCurrentArea();
    });

    this.state.map.on("load", () => {
      this.installLayers();
    });

    ["moveend", "zoomend", "dragend"].forEach((eventName) => {
      this.state.map.on(eventName, () => this.showSearchAreaPrompt());
    });

    this.bindLongPress();
  }

  async search(query, { expand = true, center = mapCenter(this.state.map), fitResults = true } = {}) {
    const keyword = query.trim();
    if (!keyword) {
      this.setStatus("Enter a place name first.");
      this.sheet.setMode("search", { expand });
      return [];
    }

    this.state.lastSearchQuery = keyword;
    if (this.state.route.routes.length) this.clearStaleRoute();
    this.clearSelectedMarker();
    this.elements.input.value = keyword;
    this.elements.searchAreaButton.hidden = true;
    this.sheet.setMode("search", { expand, subtitle: "Searching GrabMaps..." });
    this.setStatus("Searching GrabMaps in this map area...");
    this.elements.results.innerHTML = "";
    this.elements.count.textContent = "0";

    try {
      const places = await searchPlaces({ keyword, center, limit: 50 });
      this.state.places = places;
      this.updatePoweredBy(places.provider);
      this.renderResults();
      this.renderMapResults(places);
      if (fitResults) this.fitSearchResults(places);
      this.updateSearchStatus(places);
      this.sheet.update("Street Smart", places.length ? `${places.length} results near map center` : "No nearby results");
      return places;
    } catch (error) {
      console.error(error);
      this.setStatus("Search failed. Check the GrabMaps credential.");
      this.updatePoweredBy("grabmaps");
      return [];
    }
  }

  async searchCurrentArea() {
    await this.search(this.state.lastSearchQuery || this.elements.input.value, {
      expand: true,
      center: mapCenter(this.state.map),
      fitResults: false
    });
  }

  showSearchAreaPrompt() {
    if (this.state.suppressAreaPrompt || !this.state.lastSearchQuery) return;
    this.elements.searchAreaButton.hidden = false;
  }

  async findFirst(query) {
    const places = await searchPlaces({
      keyword: query,
      center: mapCenter(this.state.map),
      limit: 1
    });
    return places[0] || null;
  }

  selectPlace(placeId, { fly = true } = {}) {
    const place = this.state.places.find((candidate) => candidate.id === placeId);
    if (!place) return null;

    this.state.selectedPlace = place;
    this.showSelectedMarker(place);
    this.elements.input.value = place.name;
    document.querySelectorAll(".result-item").forEach((button) => {
      button.classList.toggle("active", button.dataset.placeId === placeId);
    });

    if (fly) {
      this.state.map.flyTo({
        center: [place.lng, place.lat],
        zoom: Math.max(this.state.map.getZoom(), 16),
        duration: 600
      });
    }

    return place;
  }

  showPlaceDetails(place, { fly = true } = {}) {
    if (!place) return;
    this.state.selectedPlace = place;
    this.showSelectedMarker(place);
    this.elements.input.value = place.name || formatLatLng(place);
    document.querySelectorAll(".result-item").forEach((button) => {
      button.classList.toggle("active", button.dataset.placeId === place.id);
    });

    if (fly) {
      this.state.map.flyTo({
        center: [place.lng, place.lat],
        zoom: Math.max(this.state.map.getZoom(), 16),
        duration: 600
      });
    }

    this.sheet.setMode("search", {
      expand: true,
      title: place.name || "Selected location",
      subtitle: place.address || place.category || formatLatLng(place)
    });
    this.renderPlaceDetails(place);
  }

  renderPlaceDetails(place) {
    this.elements.count.textContent = "Details";
    this.elements.results.innerHTML = "";

    const item = document.createElement("li");
    item.className = "place-detail-card";
    item.innerHTML = `
      <div class="place-detail-heading">
        <span class="place-type-icon material-symbols-rounded" aria-hidden="true"></span>
        <div>
          <strong></strong>
          <span></span>
        </div>
      </div>
      <dl class="place-detail-meta"></dl>
      <div class="place-detail-actions">
        <button class="quiet-button place-detail-back" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">list</span>
          <span>Results</span>
        </button>
        <button class="start-route-button place-detail-navigate" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">directions</span>
          <span>Navigate</span>
        </button>
      </div>
    `;

    item.querySelector(".place-type-icon").textContent = iconForPlace(place);
    item.querySelector(".place-detail-heading strong").textContent = place.name || "Selected location";
    item.querySelector(".place-detail-heading span:not(.place-type-icon)").textContent = place.address || place.category || formatLatLng(place);
    const meta = item.querySelector(".place-detail-meta");
    addDetailRow(meta, "Coordinates", formatLatLng(place));
    if (place.category) addDetailRow(meta, "Type", place.category);
    if (Number.isFinite(place.distance)) addDetailRow(meta, "Distance", `${Math.round(place.distance)} m`);
    item.querySelector(".place-detail-back").addEventListener("click", () => {
      this.renderResults();
      this.sheet.update("Street Smart", this.state.places.length ? `${this.state.places.length} results near map center` : "Search or start navigation");
    });
    item.querySelector(".place-detail-navigate").addEventListener("click", () => {
      this.clearSelectedMarker();
      this.onNavigate({
        endText: place.name || formatLatLng(place),
        endPlace: place,
        calculate: true
      });
    });

    this.elements.results.append(item);
    this.setStatus("Review the location details or start navigation.");
  }

  installLayers() {
    const map = this.state.map;
    if (!map.getSource("search-results")) {
      map.addSource("search-results", {
        type: "geojson",
        data: placeFeatureCollection([]),
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 16
      });
    }

    if (!map.getLayer("search-clusters")) {
      map.addLayer({
        id: "search-clusters",
        type: "circle",
        source: "search-results",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#0f8f68",
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, 32],
          "circle-opacity": 0.92,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3
        }
      });
    }

    if (!map.getLayer("search-cluster-count")) {
      map.addLayer({
        id: "search-cluster-count",
        type: "symbol",
        source: "search-results",
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

    if (!map.getLayer("search-point")) {
      map.addLayer({
        id: "search-point",
        type: "circle",
        source: "search-results",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#0f8f68",
          "circle-radius": 8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3
        }
      });
    }

    if (!this.layersInstalled) {
      map.on("click", "search-clusters", (event) => this.openCluster(event));
      map.on("click", "search-point", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const place = this.selectPlace(feature.properties.id, { fly: false });
        this.showPlaceDetails(place, { fly: true });
      });
    }
    this.layersInstalled = true;
  }

  async openCluster(event) {
    const map = this.state.map;
    const feature = event.features?.[0];
    if (!feature) return;

    const clusterId = feature.properties.cluster_id;
    const source = map.getSource("search-results");
    if (!source) return;

    try {
      const [expansionZoom, leaves] = await Promise.all([
        getClusterExpansionZoom(source, clusterId),
        getClusterLeaves(source, clusterId)
      ]);
      const camera = cameraForCluster(map, feature, leaves, expansionZoom);
      this.state.suppressAreaPrompt = true;
      map.easeTo({
        ...camera,
        duration: 550
      });
      map.once("moveend", async () => {
        this.state.suppressAreaPrompt = false;
        await this.searchCurrentArea();
      });
    } catch (error) {
      console.warn("Could not expand search cluster.", error);
    }
  }

  renderResults() {
    this.elements.count.textContent = String(this.state.places.length);
    this.elements.results.innerHTML = "";

    this.state.places.forEach((place) => {
      const item = document.createElement("li");
      item.className = "result-row";

      const placeButton = document.createElement("button");
      placeButton.className = "result-item";
      placeButton.type = "button";
      placeButton.dataset.placeId = place.id;
      placeButton.innerHTML = `
        <span class="place-type-icon material-symbols-rounded" aria-hidden="true"></span>
        <span class="result-title"></span>
        <span class="result-meta"></span>
      `;
      placeButton.querySelector(".place-type-icon").textContent = iconForPlace(place);
      placeButton.querySelector(".result-title").textContent = place.name;
      placeButton.querySelector(".result-meta").textContent = place.address || place.category || formatLatLng(place);
      placeButton.addEventListener("click", () => this.showPlaceDetails(place));

      const navigateButton = document.createElement("button");
      navigateButton.className = "navigate-result";
      navigateButton.type = "button";
      navigateButton.setAttribute("aria-label", `Navigate to ${place.name}`);
      navigateButton.title = "Navigate";
      navigateButton.innerHTML = `
        <span class="material-symbols-rounded" aria-hidden="true">directions</span>
      `;
      navigateButton.addEventListener("click", () => {
        const selected = this.selectPlace(place.id, { fly: false });
        this.clearSelectedMarker();
        this.onNavigate({ endText: place.name, endPlace: selected, calculate: true });
      });

      item.append(placeButton, navigateButton);
      this.elements.results.append(item);
    });
  }

  renderMapResults(places) {
    if (!this.state.map.isStyleLoaded()) return;
    this.installLayers();
    this.state.map.getSource("search-results").setData(placeFeatureCollection(places));
    this.setMapResultsVisible(!this.state.navigation.active || this.state.addingStop);
  }

  fitSearchResults(places) {
    const validPlaces = places.filter((place) => Number.isFinite(place.lng) && Number.isFinite(place.lat));
    if (!validPlaces.length) return;
    this.state.suppressAreaPrompt = true;
    const camera = cameraForPlaces(this.state.map, validPlaces);
    this.state.map.easeTo({
      ...camera,
      duration: 650
    });
    this.state.map.once("moveend", () => {
      this.state.suppressAreaPrompt = false;
    });
  }

  clearMapResults() {
    if (!this.state.map.isStyleLoaded()) return;
    this.installLayers();
    this.state.map.getSource("search-results").setData(placeFeatureCollection([]));
    this.setMapResultsVisible(false);
    this.clearSelectedMarker();
  }

  setMapResultsVisible(visible) {
    if (!this.state.map.isStyleLoaded()) return;
    this.installLayers();
    this.resultLayerIds.forEach((layerId) => {
      if (this.state.map.getLayer(layerId)) {
        this.state.map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    });
  }

  updateSearchStatus(places) {
    if (places.length === 0) {
      this.setStatus("No nearby results. Zoom out, then use Search this area to expand.");
    } else if (places.length <= 3) {
      this.setStatus(`Only ${places.length} nearby result${places.length === 1 ? "" : "s"}. Zoom out to expand the search.`);
    } else if (places.length >= 25) {
      this.setStatus(`Showing ${places.length} results. Clusters refine as you zoom in.`);
    } else {
      this.setStatus("Select a place or tap Navigate.");
    }
  }

  setStatus(message) {
    this.elements.status.textContent = message;
  }

  updatePoweredBy(provider = "grabmaps") {
    const isNominatim = provider === "nominatim";
    this.elements.poweredByLink.href = isNominatim ? "https://nominatim.org/" : "https://grabmaps.grab.com/";
    this.elements.poweredByLink.textContent = isNominatim ? "Nominatim" : "GrabMaps";
  }

  clearStaleRoute() {
    Object.values(this.state.anchorMarkers || {}).forEach((marker) => marker?.remove());
    this.state.anchorMarkers = { origin: null, destination: null };
    this.state.route = { routes: [], activeIndex: 0, loading: false, error: null };
    this.state.routeStops = [];
    this.state.navigation = { active: false, simulating: false, paused: false, manualControl: false, progressIndex: 0, routeProgressMeters: 0, heading: null, trace: [], lastTracePoint: null, startedAt: null, endedAt: null, actualDistanceMeters: 0, deviations: [] };
    this.state.lastTripStats = null;
    this.elements.routeChip.hidden = true;
    if (this.state.map?.isStyleLoaded()) {
      if (this.state.map.getSource("route-active")) this.state.map.getSource("route-active").setData({ type: "FeatureCollection", features: [] });
      if (this.state.map.getSource("route-alternatives")) this.state.map.getSource("route-alternatives").setData({ type: "FeatureCollection", features: [] });
    }
  }

  bindLongPress() {
    const map = this.state.map;
    map.on("mousedown", (event) => this.startLongPress(event));
    map.on("touchstart", (event) => this.startLongPress(event));
    ["mouseup", "touchend", "touchcancel", "touchmove", "dragstart", "move"].forEach((eventName) => {
      map.on(eventName, () => this.cancelLongPress());
    });
  }

  startLongPress(event) {
    if (this.state.navigation.active || this.state.addingStop) return;
    if (event.originalEvent?.button !== undefined && event.originalEvent.button !== 0) return;
    this.cancelLongPress();
    const point = event.point || event.points?.[0];
    const lngLat = event.lngLat || event.lngLats?.[0];
    if (!point || !lngLat) return;
    this.longPressStart = {
      point,
      lngLat
    };
    this.longPressTimer = window.setTimeout(() => {
      this.selectLongPressedLocation(this.longPressStart.point, this.longPressStart.lngLat);
      this.longPressTimer = null;
    }, this.longPressDelay);
  }

  cancelLongPress() {
    if (this.longPressTimer) window.clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    this.longPressStart = null;
  }

  placeFromMapPoint(point, lngLat) {
    const searchFeature = this.state.map.getLayer("search-point")
      ? this.state.map.queryRenderedFeatures(point, { layers: ["search-point"] })?.[0]
      : null;
    if (searchFeature?.properties?.id) {
      const place = this.state.places.find((candidate) => candidate.id === searchFeature.properties.id);
      if (place) return place;
    }

    const bbox = [
      [point.x - 8, point.y - 8],
      [point.x + 8, point.y + 8]
    ];
    const poiFeature = this.state.map.queryRenderedFeatures(bbox)
      .find((feature) => feature.properties && feature.geometry?.type === "Point" && feature.properties.name);
    const name = poiFeature?.properties?.name || poiFeature?.properties?.name_en || "";
    const category = poiFeature?.properties?.class || poiFeature?.properties?.type || poiFeature?.properties?.category || "";
    const coordinates = Array.isArray(poiFeature?.geometry?.coordinates)
      ? poiFeature.geometry.coordinates
      : [lngLat.lng, lngLat.lat];
    const canSnapToRenderedPoi = name && distanceMeters([lngLat.lng, lngLat.lat], coordinates) <= LONG_PRESS_SNAP_METERS;

    return {
      id: canSnapToRenderedPoi ? `map-poi-${coordinates[0]}-${coordinates[1]}` : `coordinate-${lngLat.lng}-${lngLat.lat}`,
      name: canSnapToRenderedPoi ? name : "Dropped pin",
      address: canSnapToRenderedPoi ? category : "",
      category: canSnapToRenderedPoi ? category : "",
      lng: canSnapToRenderedPoi ? coordinates[0] : lngLat.lng,
      lat: canSnapToRenderedPoi ? coordinates[1] : lngLat.lat
    };
  }

  async selectLongPressedLocation(point, lngLat) {
    const fallbackPlace = this.placeFromMapPoint(point, lngLat);
    this.setStatus("Checking nearby POIs...");
    const selected = await this.snapToNearbyPoi(lngLat).catch((error) => {
      console.warn("Nearby POI lookup failed.", error);
      return null;
    });
    this.showPlaceDetails(selected || fallbackPlace, { fly: false });
    if (selected) this.setStatus("Snapped to a nearby POI within 5 m.");
  }

  async snapToNearbyPoi(lngLat) {
    const center = { lat: lngLat.lat, lng: lngLat.lng };
    const places = await nearbyPlaces({ center, radius: LONG_PRESS_NEARBY_RADIUS_METERS, limit: 10 });
    const selectedPoint = [lngLat.lng, lngLat.lat];
    return places
      .map((place) => ({
        place,
        distance: distanceMeters(selectedPoint, [place.lng, place.lat])
      }))
      .filter(({ distance }) => distance <= LONG_PRESS_SNAP_METERS)
      .sort((a, b) => a.distance - b.distance)[0]?.place || null;
  }

  showSelectedMarker(place) {
    if (!place || !Number.isFinite(place.lng) || !Number.isFinite(place.lat)) return;
    if (!this.selectedMarker) {
      const element = document.createElement("div");
      element.className = "place-marker selected-place-marker";
      element.innerHTML = `<span aria-hidden="true"></span>`;
      this.selectedMarker = new maplibregl.Marker({
        element,
        anchor: "bottom"
      });
    }
    this.selectedMarker.setLngLat([place.lng, place.lat]).addTo(this.state.map);
  }

  clearSelectedMarker() {
    this.selectedMarker?.remove();
    this.selectedMarker = null;
  }
}

function addDetailRow(container, label, value) {
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value;
  container.append(term, description);
}

function iconForPlace(place) {
  const text = `${place.category || ""} ${place.name || ""}`.toLowerCase();
  if (text.includes("petrol") || text.includes("gas") || text.includes("shell")) return "local_gas_station";
  if (text.includes("mrt") || text.includes("station")) return "train";
  if (text.includes("hotel")) return "hotel";
  if (text.includes("food") || text.includes("restaurant") || text.includes("chicken")) return "restaurant";
  if (text.includes("airport")) return "flight";
  if (text.includes("park")) return "park";
  if (text.includes("hospital") || text.includes("clinic")) return "local_hospital";
  if (text.includes("school") || text.includes("education")) return "school";
  if (text.includes("parking")) return "local_parking";
  return "location_on";
}

function cameraForPlaces(map, places) {
  if (places.length === 1) {
    return {
      center: [places[0].lng, places[0].lat],
      zoom: Math.max(map.getZoom(), SEARCH_SINGLE_RESULT_ZOOM)
    };
  }

  const bounds = new maplibregl.LngLatBounds();
  places.forEach((place) => bounds.extend([place.lng, place.lat]));
  return clampedBoundsCamera(map, bounds, {
    minZoom: SEARCH_FIT_MIN_ZOOM,
    maxZoom: SEARCH_FIT_MAX_ZOOM,
    padding: searchFitPadding()
  });
}

function cameraForCluster(map, feature, leaves, expansionZoom) {
  const currentZoom = map.getZoom();
  const targetZoom = Math.max(currentZoom + 1, Number(expansionZoom) + 0.6);
  const points = leaves
    .map((leaf) => leaf?.geometry?.coordinates)
    .filter(isLngLat);

  if (points.length >= 2) {
    const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
    points.slice(1).forEach((point) => bounds.extend(point));
    const camera = clampedBoundsCamera(map, bounds, {
      minZoom: targetZoom,
      maxZoom: SEARCH_CLUSTER_MAX_ZOOM,
      padding: searchFitPadding()
    });
    return {
      ...camera,
      zoom: Math.max(camera.zoom, Math.min(targetZoom, SEARCH_CLUSTER_MAX_ZOOM))
    };
  }

  return {
    center: feature.geometry.coordinates,
    zoom: Math.min(targetZoom, SEARCH_CLUSTER_MAX_ZOOM)
  };
}

function clampedBoundsCamera(map, bounds, { minZoom, maxZoom, padding }) {
  const fallbackCenter = bounds.getCenter();
  const camera = map.cameraForBounds?.(bounds, { padding, maxZoom }) || {
    center: [fallbackCenter.lng, fallbackCenter.lat],
    zoom: map.getZoom()
  };
  const zoom = clamp(Number(camera.zoom), minZoom, maxZoom);
  return {
    center: camera.center || [fallbackCenter.lng, fallbackCenter.lat],
    zoom,
    bearing: 0,
    pitch: 0
  };
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

function getClusterLeaves(source, clusterId) {
  return new Promise((resolve) => {
    if (!source.getClusterLeaves) return resolve([]);
    const result = source.getClusterLeaves(clusterId, SEARCH_CLUSTER_LEAF_LIMIT, 0, (error, leaves) => {
      resolve(error ? [] : leaves || []);
    });
    if (result?.then) result.then((leaves) => resolve(leaves || [])).catch(() => resolve([]));
  });
}

function searchFitPadding() {
  return window.matchMedia("(max-width: 720px)").matches
    ? { top: 160, right: 44, bottom: 190, left: 44 }
    : { top: 170, right: 90, bottom: 150, left: 520 };
}

function isLngLat(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const SEARCH_FIT_MIN_ZOOM = 10;
const SEARCH_FIT_MAX_ZOOM = 15.5;
const SEARCH_SINGLE_RESULT_ZOOM = 15;
const SEARCH_CLUSTER_MAX_ZOOM = 17.5;
const SEARCH_CLUSTER_LEAF_LIMIT = 200;
const LONG_PRESS_NEARBY_RADIUS_METERS = 25;
const LONG_PRESS_SNAP_METERS = 5;
