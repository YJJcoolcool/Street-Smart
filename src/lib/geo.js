export function normalizePlaces(data) {
  const rawPlaces = data?.places || data?.results || [];
  return rawPlaces
    .map((place, index) => {
      const point = extractPoint(place);
      return {
        id: place.id || place.place_id || place.poi_id || place.uuid || `place-${index}`,
        name: place.name || place.title || "Unnamed place",
        address: place.formatted_address || place.address || place.vicinity || "",
        category: place.category || place.business_type || "",
        distance: place.distance,
        raw: place,
        ...point
      };
    })
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
}

export function normalizeRoutes(data) {
  const rawRoutes = Array.isArray(data?.routes) ? data.routes : [data?.route || data].filter(Boolean);
  return rawRoutes
    .map((route, index) => {
      const geometry = route.geometry || route.polyline || route.overview_polyline?.points;
      const line = Array.isArray(geometry)
        ? geometry.map(normalizeLngLat).filter(Boolean)
        : decodePolyline(geometry || "", 6);
      const legs = Array.isArray(route.legs) ? route.legs : [];
      const steps = extractSteps(route);
      const distance = Number(route.distance ?? route.distanceMeters ?? sumBy(legs, "distance"));
      const duration = Number(route.duration ?? route.durationSeconds ?? sumBy(legs, "duration"));
      const profile = route.profile || data?.profile || "driving";
      const normalizedDistance = Number.isFinite(distance) ? distance : null;
      const normalizedDuration = Number.isFinite(duration) ? duration : null;
      const trafficProvider = route.trafficProvider || route.traffic?.provider || data?.trafficProvider || null;
      const trafficSegments = extractTrafficSegments({
        route,
        line,
        steps,
        legs,
        profile,
        distance: normalizedDistance,
        duration: normalizedDuration
      });

      return {
        id: route.id || route.route_id || `route-${index}`,
        index,
        provider: route.provider || data?.provider || "grabmaps",
        fallback: data?.fallback || null,
        trafficProvider,
        traffic: route.traffic || null,
        profile,
        line,
        distance: normalizedDistance,
        duration: normalizedDuration,
        trafficSegments,
        trafficSummary: summarizeTraffic(trafficSegments),
        steps,
        raw: route
      };
    })
    .filter((route) => route.line.length >= 2);
}

export function placeFeatureCollection(places) {
  return {
    type: "FeatureCollection",
    features: places.map((place) => ({
      type: "Feature",
      properties: {
        id: place.id,
        name: place.name,
        address: place.address || place.category || ""
      },
      geometry: {
        type: "Point",
        coordinates: [place.lng, place.lat]
      }
    }))
  };
}

export function lineFeature(route) {
  return {
    type: "Feature",
    properties: { id: route?.id || "route" },
    geometry: {
      type: "LineString",
      coordinates: route?.line || []
    }
  };
}

export function trafficFeatureCollection(route) {
  if (!route?.line?.length) return emptyFeatureCollection();
  const features = [];
  let cumulative = 0;
  const segments = route.trafficSegments?.length ? route.trafficSegments : [defaultTrafficSegment(route)];

  for (let index = 1; index < route.line.length; index += 1) {
    const from = route.line[index - 1];
    const to = route.line[index];
    const distance = distanceMeters(from, to);
    const midpoint = cumulative + distance / 2;
    const traffic = trafficForDistance(segments, midpoint);
    features.push({
      type: "Feature",
      properties: {
        id: `${route.id || "route"}-${index}`,
        trafficLevel: traffic.level,
        trafficLabel: traffic.label,
        trafficColor: traffic.color,
        speedKph: traffic.speedKph ?? null
      },
      geometry: {
        type: "LineString",
        coordinates: [from, to]
      }
    });
    cumulative += distance;
  }

  return {
    type: "FeatureCollection",
    features
  };
}

export function routeFeatureCollection(routes) {
  return {
    type: "FeatureCollection",
    features: routes.map(lineFeature)
  };
}

export function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: []
  };
}

export function emptyLineFeature() {
  return lineFeature({ id: "empty", line: [] });
}

export function parseLatLng(value) {
  const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function mapCenter(map) {
  const center = map.getCenter();
  return { lat: center.lat, lng: center.lng };
}

export function fitPlaces(map, places) {
  if (!places.length) return;
  const bounds = new maplibregl.LngLatBounds();
  places.forEach((place) => bounds.extend([place.lng, place.lat]));
  map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 700 });
}

export function fitRoute(map, route, origin, destination, padding = 80) {
  const bounds = new maplibregl.LngLatBounds();
  route.line.forEach((point) => bounds.extend(point));
  bounds.extend([origin.lng, origin.lat]);
  bounds.extend([destination.lng, destination.lat]);
  map.fitBounds(bounds, { padding, maxZoom: 16, duration: 700 });
}

export function bearingBetween(from, to) {
  const lat1 = toRadians(from[1]);
  const lat2 = toRadians(to[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function distanceMeters(a, b) {
  const earthRadius = 6371000;
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const deltaLat = toRadians(b[1] - a[1]);
  const deltaLng = toRadians(b[0] - a[0]);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function movePoint(point, bearing, meters) {
  const earthRadius = 6371000;
  const angularDistance = meters / earthRadius;
  const heading = toRadians(bearing);
  const lat1 = toRadians(point[1]);
  const lng1 = toRadians(point[0]);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(heading)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(heading) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [toDegrees(lng2), toDegrees(lat2)];
}

export function distanceToRoute(point, line) {
  return nearestRouteProgress(point, line).distance;
}

export function nearestRouteProgress(point, line) {
  if (!line.length) return { distance: Infinity, nearestIndex: 0, metersAlong: 0 };
  let minimum = Infinity;
  let nearestIndex = 0;
  let metersAlong = 0;
  let cumulative = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (index > 0) cumulative += distanceMeters(line[index - 1], line[index]);
    const distance = distanceMeters(point, line[index]);
    if (distance < minimum) {
      minimum = distance;
      nearestIndex = index;
      metersAlong = cumulative;
    }
  }
  return { distance: minimum, nearestIndex, metersAlong };
}

function extractPoint(place) {
  const location = place.location || place.coordinate || place.coordinates || place.geometry?.location;
  if (Array.isArray(location)) {
    const first = Number(location[0]);
    const second = Number(location[1]);
    if (Math.abs(first) <= 90 && Math.abs(second) > 90) return { lat: first, lng: second };
    return { lng: first, lat: second };
  }
  if (location && typeof location === "object") {
    return {
      lat: Number(location.lat ?? location.latitude),
      lng: Number(location.lng ?? location.lon ?? location.longitude)
    };
  }
  return {
    lat: Number(place.lat ?? place.latitude),
    lng: Number(place.lng ?? place.lon ?? place.longitude)
  };
}

function extractSteps(route) {
  const candidates = [
    route.steps,
    route.legs?.flatMap((leg) => leg.steps || []),
    route.legs?.flatMap((leg) => leg.maneuvers || [])
  ].find((steps) => Array.isArray(steps) && steps.length);

  if (!candidates) return [];

  return candidates.map((step, index) => ({
    id: step.id || `step-${index}`,
    instruction: step.instruction || step.name || step.maneuver?.instruction || step.maneuver?.type || "Continue",
    distance: Number(step.distance ?? step.distanceMeters ?? 0),
    duration: Number(step.duration ?? step.durationSeconds ?? 0),
    maneuver: step.maneuver?.type || step.type || ""
  }));
}

function extractTrafficSegments({ route, line, steps, legs, profile, distance, duration }) {
  const totalDistance = distance || routeDistanceFromLine(line);
  const traffic = route.traffic || {};
  const candidates = [
    normalizeTrafficItems(traffic.steps),
    normalizeTrafficItems(traffic.legs),
    normalizeTrafficItems(steps),
    normalizeTrafficItems(legs),
    route.annotations?.distance?.map((segmentDistance, index) => ({
      distance: segmentDistance,
      duration: route.annotations.duration?.[index]
    })).filter((item) => Number(item.distance) > 0 && Number(item.duration) > 0)
  ].find((items) => Array.isArray(items) && items.length);

  const trafficDistance = firstPositiveNumber(traffic.distance, traffic.distanceMeters);
  const trafficDuration = firstPositiveNumber(traffic.duration, traffic.durationSeconds);
  const source = candidates || [{
    distance: trafficDistance || totalDistance,
    duration: trafficDuration || duration || estimateFreeFlowDuration(totalDistance, profile)
  }];

  const sourceDistance = sumBy(source, "distance") || totalDistance || 1;
  const scale = totalDistance ? totalDistance / sourceDistance : 1;
  let cursor = 0;

  return source.map((segment, index) => {
    const segmentDistance = Number(segment.distance) * scale;
    const segmentDuration = Number(segment.duration);
    const severity = trafficSeverity(segmentDistance, segmentDuration, profile);
    const fromDistance = cursor;
    cursor += segmentDistance;
    return {
      id: `traffic-${index}`,
      fromDistance,
      toDistance: cursor,
      distance: segmentDistance,
      duration: segmentDuration,
      speedKph: severity.speedKph,
      level: severity.level,
      label: severity.label,
      color: severity.color
    };
  });
}

function normalizeTrafficItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      distance: firstPositiveNumber(item?.distance, item?.distanceMeters, item?.length),
      duration: firstPositiveNumber(item?.duration, item?.durationSeconds, item?.travelTime, item?.time)
    }))
    .filter((item) => Number(item.distance) > 0 && Number(item.duration) > 0);
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function trafficForDistance(segments, metersAlong) {
  return segments.find((segment) => metersAlong >= segment.fromDistance && metersAlong <= segment.toDistance)
    || segments.at(-1)
    || defaultTrafficSegment();
}

function defaultTrafficSegment(route = {}) {
  const severity = trafficSeverity(route.distance || routeDistanceFromLine(route.line || []), route.duration, route.profile || "driving");
  return {
    id: "traffic-default",
    fromDistance: 0,
    toDistance: route.distance || routeDistanceFromLine(route.line || []),
    distance: route.distance || routeDistanceFromLine(route.line || []),
    duration: route.duration || null,
    ...severity
  };
}

function summarizeTraffic(segments) {
  const order = { clear: 0, moderate: 1, heavy: 2, severe: 3, unknown: -1 };
  const worst = [...segments].sort((a, b) => (order[b.level] ?? -1) - (order[a.level] ?? -1))[0];
  return worst || { level: "unknown", label: "Traffic unavailable", color: "#2563eb" };
}

function trafficSeverity(distance, duration, profile) {
  if (!Number.isFinite(distance) || !Number.isFinite(duration) || distance <= 0 || duration <= 0) {
    return { level: "unknown", label: "Traffic unavailable", color: "#2563eb", speedKph: null };
  }

  const speedKph = distance / duration * 3.6;
  const thresholds = trafficThresholds(profile);
  if (speedKph < thresholds.severe) return { level: "severe", label: "Severe traffic", color: "#dc2626", speedKph };
  if (speedKph < thresholds.heavy) return { level: "heavy", label: "Heavy traffic", color: "#ea580c", speedKph };
  if (speedKph < thresholds.moderate) return { level: "moderate", label: "Moderate traffic", color: "#f5b301", speedKph };
  return { level: "clear", label: "Light traffic", color: "#0f8f68", speedKph };
}

function trafficThresholds(profile) {
  if (profile === "walking") return { severe: 2, heavy: 3.5, moderate: 5 };
  if (profile === "cycling") return { severe: 7, heavy: 12, moderate: 18 };
  return { severe: 12, heavy: 25, moderate: 45 };
}

function estimateFreeFlowDuration(distance, profile) {
  const speedKph = profile === "walking" ? 5 : profile === "cycling" ? 18 : 45;
  return distance / (speedKph / 3.6);
}

function routeDistanceFromLine(line) {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) {
    total += distanceMeters(line[index - 1], line[index]);
  }
  return total;
}

function normalizeLngLat(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const first = Number(point[0]);
    const second = Number(point[1]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
    return Math.abs(first) <= 90 && Math.abs(second) > 90 ? [second, first] : [first, second];
  }

  if (point && typeof point === "object") {
    const lat = Number(point.lat ?? point.latitude);
    const lng = Number(point.lng ?? point.lon ?? point.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lng, lat];
  }

  return null;
}

function decodePolyline(polyline, precision = 6) {
  const coordinates = [];
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < polyline.length) {
    const latResult = decodePolylineValue(polyline, index);
    index = latResult.index;
    const lngResult = decodePolylineValue(polyline, index);
    index = lngResult.index;
    lat += latResult.value;
    lng += lngResult.value;
    coordinates.push([lng / factor, lat / factor]);
  }

  return coordinates;
}

function decodePolylineValue(polyline, startIndex) {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte = null;

  do {
    byte = polyline.charCodeAt(index++) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20 && index < polyline.length);

  return {
    value: result & 1 ? ~(result >> 1) : result >> 1,
    index
  };
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + Number(item?.[key] || 0), 0);
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function toDegrees(radians) {
  return radians * 180 / Math.PI;
}
