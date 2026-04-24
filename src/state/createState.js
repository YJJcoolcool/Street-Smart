export function createState() {
  const defaultCenter = { lat: 1.2966, lng: 103.852 };

  return {
    map: null,
    mapProvider: "grab",
    failedMapProviders: new Set(),
    preferences: {
      mapProvider: "grab",
      routingProvider: "grab"
    },
    config: null,
    activeMode: "driving",
    defaultCenter,
    currentPlace: makeCurrentPlace(defaultCenter),
    places: [],
    selectedPlace: null,
    startPlace: null,
    endPlace: null,
    routeStops: [],
    addingStop: false,
    locationRequested: false,
    anchorMarkers: {
      origin: null,
      destination: null
    },
    lastSearchQuery: "",
    suppressAreaPrompt: false,
    route: {
      routes: [],
      activeIndex: 0,
      loading: false,
      error: null
    },
    navigation: {
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
      deviations: []
    },
    lastTripStats: null,
    reports: []
  };
}

export function makeCurrentPlace(point) {
  return {
    id: "current-location",
    name: "Current location",
    address: "",
    lat: point.lat,
    lng: point.lng
  };
}
