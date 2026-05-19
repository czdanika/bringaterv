// crypto.randomUUID() csak Secure Context-ben elérhető (HTTPS/localhost)
// HTTP-n (pl. helyi hálózat) polyfill-t használunk
function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122 v4 UUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createRouteStore() {
  let state = {
    mode: "walking",
    snapToRoads: true,
    waypoints: [],
    routeGeometry: [],
    routeSegments: [],   // szegmensenként: [{ geometry, distanceMeters, ascentMeters, descentMeters, mode }]
    distanceMeters: 0,
    ascentMeters: 0,
    descentMeters: 0,
    importedRoute: false,
    sourcePointCount: 0,
  };
  let past = [];
  let future = [];
  const listeners = new Set();

  function emit() {
    listeners.forEach((listener) => listener(getState()));
  }

  function getState() {
    return { ...structuredClone(state), canUndo: past.length > 0, canRedo: future.length > 0 };
  }

  function snapshot() {
    past.push(structuredClone(state.waypoints));
    future = [];
  }

  function setState(patch) {
    state = { ...state, ...patch };
    emit();
  }

  function addWaypoint(point) {
    snapshot();
    state = {
      ...state,
      importedRoute: false,
      routeGeometry: [],
      sourcePointCount: 0,
      waypoints: [
        ...state.waypoints,
        {
          id: generateId(),
          name: point.name ?? "",
          note: point.note ?? "",
          lat: point.lat,
          lng: point.lng,
        },
      ],
    };
    emit();
  }

  function insertWaypointAt(index, point) {
    snapshot();
    const newWp = {
      id: generateId(),
      name: point.name ?? "",
      note: point.note ?? "",
      lat: point.lat,
      lng: point.lng,
    };
    const next = [...state.waypoints];
    next.splice(index, 0, newWp);
    // importedRoute és routeGeometry megmarad:
    // az importált vonal változatlan marad, nem triggereljük az újratervezést.
    // Ha a user vonszol egy pontot (updateWaypointPosition), az majd törli az importedRoute-ot.
    state = { ...state, waypoints: next };
    emit();
  }

  function removeWaypoint(id) {
    snapshot();
    state = {
      ...state,
      importedRoute: false,
      routeGeometry: [],
      routeSegments: [],
      sourcePointCount: 0,
      waypoints: state.waypoints.filter((point) => point.id !== id),
    };
    emit();
  }

  function replaceWaypoints(waypoints, options = {}) {
    snapshot();
    state = {
      ...state,
      waypoints: waypoints.map((point) => ({
        id: generateId(),
        name: point.name ?? "",
        note: point.note ?? "",
        lat: point.lat,
        lng: point.lng,
        ...(point.segmentMode != null ? { segmentMode: point.segmentMode } : {}),
      })),
      routeGeometry: options.geometry ?? [],
      routeSegments: [],
      importedRoute: Boolean(options.importedRoute),
      sourcePointCount: options.sourcePointCount ?? 0,
    };
    emit();
  }

  function clear() {
    snapshot();
    state = {
      ...state,
      waypoints: [],
      routeGeometry: [],
      routeSegments: [],
      distanceMeters: 0,
      ascentMeters: 0,
      descentMeters: 0,
      importedRoute: false,
      sourcePointCount: 0,
    };
    emit();
  }

  function reorderWaypoints(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    snapshot();
    const newWaypoints = [...state.waypoints];
    const [moved] = newWaypoints.splice(fromIndex, 1);
    newWaypoints.splice(toIndex, 0, moved);
    state = { ...state, waypoints: newWaypoints, routeGeometry: [], routeSegments: [], distanceMeters: 0, importedRoute: false };
    emit();
  }

  function updateWaypoint(id, changes) {
    state = {
      ...state,
      waypoints: state.waypoints.map((wp) => (wp.id === id ? { ...wp, ...changes } : wp)),
    };
    emit();
  }

  function updateWaypointPosition(id, lat, lng) {
    snapshot();
    state = {
      ...state,
      waypoints: state.waypoints.map((wp) => (wp.id === id ? { ...wp, lat, lng } : wp)),
      routeGeometry: [],
      routeSegments: [],
      distanceMeters: 0,
      importedRoute: false,
    };
    emit();
  }

  function undo() {
    if (!past.length) return;
    future.push(structuredClone(state.waypoints));
    state = { ...state, waypoints: past.pop(), routeGeometry: [], routeSegments: [], distanceMeters: 0, importedRoute: false };
    emit();
  }

  function redo() {
    if (!future.length) return;
    past.push(structuredClone(state.waypoints));
    state = { ...state, waypoints: future.pop(), routeGeometry: [], routeSegments: [], distanceMeters: 0, importedRoute: false };
    emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  return {
    addWaypoint,
    insertWaypointAt,
    clear,
    getState,
    removeWaypoint,
    replaceWaypoints,
    reorderWaypoints,
    undo,
    redo,
    updateWaypoint,
    updateWaypointPosition,
    setState,
    subscribe,
  };
}
