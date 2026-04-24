export function labelForMode(mode) {
  return {
    walking: "Walking",
    cycling: "Cycling",
    motorcycle: "Motorcycle",
    driving: "Driving"
  }[mode] || "Driving";
}

export function formatDistance(distance) {
  if (distance === null || distance === undefined) return "--";
  const numeric = Number(distance);
  if (!Number.isFinite(numeric)) return "";
  if (numeric >= 1000) return `${(numeric / 1000).toFixed(1)} km`;
  return `${Math.round(numeric)} m`;
}

export function formatDuration(duration) {
  if (duration === null || duration === undefined) return "--";
  const numeric = Number(duration);
  if (!Number.isFinite(numeric)) return "";
  const minutes = Math.max(1, Math.round(numeric / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

export function formatLatLng(place) {
  return `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;
}
