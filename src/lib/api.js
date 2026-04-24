import { normalizePlaces, normalizeRoutes } from "./geo.js";

export async function fetchConfig() {
  return fetchJson("/api/config");
}

export async function searchPlaces({ keyword, center, limit = 50 }) {
  const params = new URLSearchParams({
    keyword,
    country: "SGP",
    location: `${center.lat},${center.lng}`,
    limit: String(limit)
  });
  const data = await fetchJson(`/api/search?${params}`);
  const places = normalizePlaces(data);
  places.provider = data.provider || "grabmaps";
  return places;
}

export async function nearbyPlaces({ center, radius = 25, limit = 10 }) {
  const params = new URLSearchParams({
    location: `${center.lat},${center.lng}`,
    radius: String(radius),
    limit: String(limit),
    rankBy: "distance"
  });
  const data = await fetchJson(`/api/nearby?${params}`);
  const places = normalizePlaces(data);
  places.provider = data.provider || "grabmaps";
  return places;
}

export async function fetchRoute({ origin, destination, stops = [], profile, provider = "grab" }) {
  const params = new URLSearchParams({ profile, provider });
  [origin, ...stops, destination].forEach((place) => {
    params.append("coordinates", `${place.lat},${place.lng}`);
  });

  const data = await fetchJson(`/api/route?${params}`, { timeoutMs: 45000, timeoutMessage: "Route request timed out. Please try again." });
  return normalizeRoutes(data);
}

export async function fetchStudioReports() {
  const data = await fetchJson("/api/studio/reports");
  return Array.isArray(data.reports) ? data.reports : [];
}

export async function publishReport(report) {
  const data = await sendJson("/api/studio/reports", {
    method: "POST",
    body: { report }
  });
  return data.report;
}

export async function fetchJson(url, { timeoutMs = 30000, timeoutMessage = "Request timed out. Please try again." } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Request failed: ${response.status}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function sendJson(url, { method = "POST", body, token, timeoutMs = 30000, timeoutMessage = "Request timed out. Please try again." } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Request failed: ${response.status}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
