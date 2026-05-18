const profileMap = {
  asphalt: "fastbike",
  gravel:  "gravel",
  mtb:     "mtb",
  walking: "trekking",
  cycling: "fastbike", // backwards compatibility
};

const esriAttrib = 'Tiles &copy; <a href="https://www.esri.com">Esri</a>';
const cartoAttrib = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>';

const tileLayers = {
  standard: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  },
  cycling: {
    url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; CyclOSM' },
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 17, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; OpenTopoMap' },
  },
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    options: { maxZoom: 19, attribution: cartoAttrib, subdomains: "abcd" },
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    options: { maxZoom: 19, attribution: cartoAttrib, subdomains: "abcd" },
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, attribution: esriAttrib },
  },
  hybrid: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, attribution: esriAttrib },
    overlay: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: "", pane: "shadowPane" },
    },
  },
};

export function createMapAdapter({ elementId, onMapClick, onRouteClick, onRouteFallback, onMarkerDrag, onWaypointDelete, onWaypointUpdate, onMeasureUpdate, onReturnRoute, onRoundTrip, startView }) {
  const defaultCenter = startView ? [startView.lat, startView.lng] : [47.4979, 19.0402];
  const defaultZoom   = startView?.zoom ?? 12;
  const map = L.map(elementId, { zoomControl: false }).setView(defaultCenter, defaultZoom);
  const markers = L.layerGroup().addTo(map);
  const routeLayer = L.polyline([], {
    color: "#1976d2",
    opacity: 0.95,
    weight: 5,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);
  let userLocationMarker;
  let userAccuracyCircle;
  let elevationMarker = null;

  // Hover tooltip state
  let hoverGeometry = [];
  let hoverMarker = null;
  const hoverTooltip = L.tooltip({ permanent: true, direction: "top", offset: [0, -10], className: "route-hover-tooltip" });
  const HOVER_PX_THRESHOLD = 20;

  let nearRouteFlag = false; // true ha az egér közel van az útvonalhoz
  let routeClickEnabled = true; // false = Elemzés fülön (crosshair + click tiltva)

  map.on("mousemove", (e) => {
    if (!hoverGeometry.length) {
      if (nearRouteFlag) { map.getContainer().style.cursor = ""; nearRouteFlag = false; }
      return;
    }
    const nearest = findNearestPoint(hoverGeometry, e.latlng);
    if (!nearest) return;

    const nearestPx = map.latLngToContainerPoint([nearest.lat, nearest.lng]);
    const dist = e.containerPoint.distanceTo(nearestPx);

    if (dist > HOVER_PX_THRESHOLD) {
      hoverMarker?.remove();
      hoverMarker = null;
      if (map.hasLayer(hoverTooltip)) hoverTooltip.remove();
      if (nearRouteFlag) { map.getContainer().style.cursor = ""; nearRouteFlag = false; }
      return;
    }

    // Közel vagyunk az útvonalhoz – crosshair kurzor (csak ha kattintás engedélyezett)
    if (routeClickEnabled && !nearRouteFlag) { map.getContainer().style.cursor = "crosshair"; nearRouteFlag = true; }
    else if (!routeClickEnabled && nearRouteFlag) { map.getContainer().style.cursor = ""; nearRouteFlag = false; }

    const parts = [];
    if (nearest.speed != null) parts.push(`🚴 ${nearest.speed} km/h`);
    if (nearest.hr != null) parts.push(`❤️ ${nearest.hr} bpm`);
    if (nearest.cad != null) parts.push(`⚙️ ${nearest.cad} rpm`);
    if (nearest.ele != null) parts.push(`⛰ ${Math.round(nearest.ele)} m`);

    const latlng = [nearest.lat, nearest.lng];
    if (!hoverMarker) {
      hoverMarker = L.circleMarker(latlng, {
        radius: 6, color: "#fff", weight: 2, fillColor: "#1976d2", fillOpacity: 1,
      }).addTo(map);
    } else {
      hoverMarker.setLatLng(latlng);
    }

    // Tooltip: magasság és adatok mutatása
    hoverTooltip.setContent(parts.length ? parts.join("  ·  ") : "").setLatLng(latlng);
    if (!map.hasLayer(hoverTooltip)) hoverTooltip.addTo(map);
  });

  map.on("mouseout", () => {
    hoverMarker?.remove();
    hoverMarker = null;
    if (map.hasLayer(hoverTooltip)) hoverTooltip.remove();
    if (nearRouteFlag) { map.getContainer().style.cursor = ""; nearRouteFlag = false; }
  });

  // Measurement mode
  let activeTool = "route";
  let measurePoints = [];
  const measureLine = L.polyline([], {
    color: "#fc4c02", weight: 3, dashArray: "8 6", opacity: 0.9,
    lineCap: "round", lineJoin: "round",
  });
  const measureGroup = L.layerGroup();

  function handleMeasureClick(latlng) {
    measurePoints.push(latlng);
    measureLine.setLatLngs(measurePoints);
    if (!map.hasLayer(measureLine)) measureLine.addTo(map);
    if (!map.hasLayer(measureGroup)) measureGroup.addTo(map);

    L.circleMarker(latlng, {
      radius: 5, color: "#fff", fillColor: "#fc4c02", fillOpacity: 1, weight: 2, interactive: false,
    }).addTo(measureGroup);

    if (measurePoints.length > 1) {
      const prev = measurePoints[measurePoints.length - 2];
      const segDist = haversineDistance([
        { lat: prev.lat, lng: prev.lng },
        { lat: latlng.lat, lng: latlng.lng },
      ]);
      const midLat = (prev.lat + latlng.lat) / 2;
      const midLng = (prev.lng + latlng.lng) / 2;
      L.marker([midLat, midLng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="measure-label">${formatDist(segDist)}</div>`,
          iconAnchor: [0, 10],
        }),
        interactive: false,
      }).addTo(measureGroup);
    }

    const total = haversineDistance(measurePoints.map((p) => ({ lat: p.lat, lng: p.lng })));
    onMeasureUpdate?.(total, measurePoints.length);
  }

  function clearMeasurement() {
    measurePoints = [];
    measureLine.setLatLngs([]);
    measureGroup.clearLayers();
    if (map.hasLayer(measureLine)) map.removeLayer(measureLine);
    if (map.hasLayer(measureGroup)) map.removeLayer(measureGroup);
    onMeasureUpdate?.(0, 0);
  }

  L.control.zoom({ position: "bottomright" }).addTo(map);
  let baseLayer = createTileLayer("standard").addTo(map);
  let overlayLayer = null;

  map.on("click", (event) => {
    const { lat, lng } = event.latlng;
    if (activeTool === "measure") {
      handleMeasureClick(event.latlng);
      return;
    }

    // Ha közel vagyunk az útvonalhoz → waypoint közbeszúrás (csak ha engedélyezett)
    if (routeClickEnabled && hoverGeometry.length && onRouteClick) {
      const nearest = findNearestPoint(hoverGeometry, event.latlng);
      if (nearest) {
        const nearestPx = map.latLngToContainerPoint([nearest.lat, nearest.lng]);
        const dist = event.containerPoint.distanceTo(nearestPx);
        if (dist <= HOVER_PX_THRESHOLD) {
          const geomIndex = findGeometryIndex(hoverGeometry, nearest);
          onRouteClick({ lat: nearest.lat, lng: nearest.lng, geometryIndex: geomIndex });
          return;
        }
      }
    }

    onMapClick({ lat, lng });
  });

  function renderWaypoints(waypoints) {
    markers.clearLayers();
    waypoints.forEach((point, index) => {
      const isDestination = waypoints.length > 1 && index === waypoints.length - 1;
      const marker = L.marker([point.lat, point.lng], {
        title: point.name || `Point ${index + 1}`,
        draggable: true,
        icon: isDestination ? destinationIcon() : defaultIcon(index + 1),
      });

      marker.on("dragend", () => {
        const { lat, lng } = marker.getLatLng();
        onMarkerDrag?.(point.id, lat, lng);
      });

      const popup = buildMarkerPopup(point, index, marker, isDestination);
      marker.bindPopup(popup, { minWidth: 240, maxWidth: 300, className: "marker-popup-wrap" });


      marker.addTo(markers);
    });
  }

  function defaultIcon(label) {
    return L.divIcon({
      className: "wpt-icon-outer",
      html: `<div class="wpt-marker">${label}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16],
    });
  }

  function destinationIcon() {
    return L.divIcon({
      className: "wpt-icon-outer",
      html: `<div class="dest-marker">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44" fill="none">
          <line x1="5" y1="3" x2="5" y2="44" stroke="#222" stroke-width="2.5" stroke-linecap="round"/>
          <rect x="5" y="3" width="24" height="18" fill="#fff"/>
          <rect x="5"  y="3"  width="6" height="6" fill="#222"/>
          <rect x="17" y="3"  width="6" height="6" fill="#222"/>
          <rect x="11" y="9"  width="6" height="6" fill="#222"/>
          <rect x="23" y="9"  width="6" height="6" fill="#222"/>
          <rect x="5"  y="15" width="6" height="6" fill="#222"/>
          <rect x="17" y="15" width="6" height="6" fill="#222"/>
          <rect x="5" y="3" width="24" height="18" fill="none" stroke="#555" stroke-width="0.5"/>
        </svg>
      </div>`,
      iconSize: [32, 44],
      iconAnchor: [5, 44],
      popupAnchor: [14, -44],
    });
  }

  function buildMarkerPopup(point, index, marker, isDestination = false) {
    const el = document.createElement("div");
    el.className = "marker-popup";

    // Header: sorszám + kuka ikon
    const header = document.createElement("div");
    header.className = "marker-popup-header";

    const title = document.createElement("span");
    title.textContent = `${index + 1}. pont`;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "marker-popup-trash";
    deleteBtn.title = "Pont törlése";
    deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    deleteBtn.addEventListener("click", () => {
      marker.closePopup();
      onWaypointDelete?.(point.id);
    });

    header.append(title, deleteBtn);

    // Név mező
    const nameLabel = document.createElement("label");
    nameLabel.className = "marker-popup-label";
    nameLabel.textContent = "Név";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "marker-popup-input";
    nameInput.value = point.name || "";
    nameInput.placeholder = "Névtelen pont";
    nameLabel.append(nameInput);

    // Megjegyzés mező
    const noteLabel = document.createElement("label");
    noteLabel.className = "marker-popup-label";
    noteLabel.textContent = "Megjegyzés";
    const noteTextarea = document.createElement("textarea");
    noteTextarea.className = "marker-popup-textarea";
    noteTextarea.rows = 2;
    noteTextarea.placeholder = "pl. szállás, ebédszünet, kilátó…";
    noteTextarea.value = point.note || "";
    noteLabel.append(noteTextarea);

    // Gombok: Mégse + Mentés
    const actions = document.createElement("div");
    actions.className = "marker-popup-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "marker-popup-cancel";
    cancelBtn.textContent = "Mégse";
    cancelBtn.addEventListener("click", () => marker.closePopup());

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "marker-popup-save";
    saveBtn.textContent = "Mentés";
    saveBtn.addEventListener("click", () => {
      marker.closePopup();
      onWaypointUpdate?.(point.id, {
        name: nameInput.value.trim(),
        note: noteTextarea.value.trim(),
      });
    });

    actions.append(cancelBtn, saveBtn);
    el.append(header, nameLabel, noteLabel, actions);

    // Cél-markernél: visszaút opciók
    if (isDestination && (onReturnRoute || onRoundTrip)) {
      const sep = document.createElement("div");
      sep.className = "marker-popup-sep";

      const returnBtn = document.createElement("button");
      returnBtn.type = "button";
      returnBtn.className = "marker-popup-return-btn";
      returnBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg> Visszaút`;
      returnBtn.addEventListener("click", () => {
        marker.closePopup();
        onReturnRoute?.();
      });

      const roundBtn = document.createElement("button");
      roundBtn.type = "button";
      roundBtn.className = "marker-popup-return-btn";
      roundBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> Oda-vissza (automatikus)`;
      roundBtn.addEventListener("click", () => {
        marker.closePopup();
        onRoundTrip?.();
      });

      el.append(sep, returnBtn, roundBtn);
    }

    return el;
  }

  // Speed-colored route
  const coloredRouteGroup = L.layerGroup();

  function speedColor(speed) {
    if (speed == null) return null;
    if (speed <  5) return "#9CA3AF";  // szürke    – megállás / tolás
    if (speed < 10) return "#1E3A8A";  // sötétkék  – nagyon lassú
    if (speed < 15) return "#3B82F6";  // kék       – lassú
    if (speed < 20) return "#06B6D4";  // cián      – közepes-lassú
    if (speed < 25) return "#22C55E";  // zöld      – közepes
    if (speed < 30) return "#EAB308";  // sárga     – gyors
    if (speed < 35) return "#F97316";  // narancs   – nagyon gyors
    if (speed < 40) return "#EF4444";  // piros     – sprint
    return "#A855F7";                  // lila      – 40+
  }

  function renderColoredRoute(geometry) {
    renderSegments(coloredRouteGroup, geometry, p => speedColor(p.speed), "#3B82F6");
    routeLayer.setLatLngs([]);
    if (!map.hasLayer(coloredRouteGroup)) coloredRouteGroup.addTo(map);
  }

  function clearColoredRoute() {
    coloredRouteGroup.clearLayers();
    if (map.hasLayer(coloredRouteGroup)) map.removeLayer(coloredRouteGroup);
  }

  // HR-colored route
  const hrRouteGroup = L.layerGroup();

  function hrColor(hr) {
    if (hr == null) return null;
    if (hr < 110) return "#3B82F6";  // kék    – könnyű
    if (hr < 130) return "#22C55E";  // zöld   – aerob
    if (hr < 150) return "#EAB308";  // sárga  – tempo
    if (hr < 165) return "#F97316";  // narancs – küszöb
    if (hr < 180) return "#EF4444";  // piros  – VO2 max
    return "#A855F7";                // lila   – anaerob
  }

  // Cadence-colored route
  const cadRouteGroup = L.layerGroup();

  // Grade-colored route
  const gradeRouteGroup = L.layerGroup();

  function cadColor(cad) {
    if (cad == null) return null;
    if (cad <  60) return "#9CA3AF";  // szürke  – nagyon lassú
    if (cad <  70) return "#3B82F6";  // kék     – lassú
    if (cad <  80) return "#22C55E";  // zöld    – közepes
    if (cad <  90) return "#84CC16";  // lime    – optimális
    if (cad < 100) return "#EAB308";  // sárga   – gyors
    if (cad < 110) return "#F97316";  // narancs – nagyon gyors
    return "#EF4444";                 // piros   – sprint
  }

  function renderCadRoute(geometry) {
    renderSegments(cadRouteGroup, geometry, p => cadColor(p.cad), "#22C55E");
    routeLayer.setLatLngs([]);
    if (!map.hasLayer(cadRouteGroup)) cadRouteGroup.addTo(map);
  }

  function clearCadRoute() {
    cadRouteGroup.clearLayers();
    if (map.hasLayer(cadRouteGroup)) map.removeLayer(cadRouteGroup);
  }

  function gradeColor(grade) {
    if (grade == null) return '#9CA3AF';
    if (grade > 8)   return '#7F1D1D';  // nagyon meredek emelkedő
    if (grade > 4)   return '#DC2626';  // meredek
    if (grade > 2)   return '#EF4444';  // közepes
    if (grade > 0.5) return '#FCA5A5';  // enyhe emelkedő
    if (grade > -0.5) return '#9CA3AF'; // egyenes
    if (grade > -2)  return '#86EFAC';  // enyhe süllyedő
    if (grade > -4)  return '#22C55E';  // közepes
    if (grade > -8)  return '#15803D';  // meredek
    return '#14532D';                   // nagyon meredek süllyedő
  }

  function renderSegments(group, geometry, valueFn, fallback) {
    group.clearLayers();
    let segStart = 0;
    let currentColor = valueFn(geometry[1]) ?? fallback;

    for (let i = 2; i <= geometry.length; i++) {
      const color = i < geometry.length ? (valueFn(geometry[i]) ?? fallback) : null;
      if (color !== currentColor || i === geometry.length) {
        const seg = geometry.slice(segStart, i).map(p => [p.lat, p.lng]);
        L.polyline(seg, { color: currentColor, weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" })
          .addTo(group);
        segStart = i - 1;
        currentColor = color;
      }
    }
  }

  function renderHrRoute(geometry) {
    renderSegments(hrRouteGroup, geometry, p => hrColor(p.hr), "#3B82F6");
    routeLayer.setLatLngs([]);
    if (!map.hasLayer(hrRouteGroup)) hrRouteGroup.addTo(map);
  }

  function clearHrRoute() {
    hrRouteGroup.clearLayers();
    if (map.hasLayer(hrRouteGroup)) map.removeLayer(hrRouteGroup);
  }

  function renderGradeRoute(geometry) {
    clearColoredRoute();
    clearHrRoute();
    clearCadRoute();

    // 1. Kumulatív távolság egyetlen menetben
    let acc = 0;
    const withDist = geometry.map((pt, i) => {
      if (i > 0) {
        const prev = geometry[i - 1];
        const dLat = (pt.lat - prev.lat) * Math.PI / 180;
        const dLng = (pt.lng - prev.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(prev.lat * Math.PI / 180) * Math.cos(pt.lat * Math.PI / 180) *
          Math.sin(dLng / 2) ** 2;
        acc += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
      return { ...pt, cumDist: acc };
    });

    // 2. 150m ablakos simítás – minden pontnál visszakeresünk ~150m-t
    const SMOOTH_M = 150;
    const withGrade = withDist.map((pt, i) => {
      if (i === 0 || pt.ele == null) return { ...pt, grade: null };
      // Visszafelé haladunk amíg el nem érjük a 150m-es ablakot
      let j = i - 1;
      while (j > 0 && (withDist[i].cumDist - withDist[j].cumDist) < SMOOTH_M) j--;
      const anchor = withDist[j];
      if (!anchor || anchor.ele == null) return { ...pt, grade: 0 };
      const dDist = pt.cumDist - anchor.cumDist;
      const dEle = pt.ele - anchor.ele;
      return { ...pt, grade: dDist > 1 ? (dEle / dDist) * 100 : 0 };
    });

    gradeRouteGroup.clearLayers();
    if (!map.hasLayer(gradeRouteGroup)) gradeRouteGroup.addTo(map);
    hoverGeometry = geometry;
    routeLayer.setLatLngs([]);
    renderSegments(gradeRouteGroup, withGrade, p => gradeColor(p.grade), '#9CA3AF');
  }

  function clearGradeRoute() {
    gradeRouteGroup.clearLayers();
    if (map.hasLayer(gradeRouteGroup)) map.removeLayer(gradeRouteGroup);
  }

  function renderRoute(geometry) {
    clearColoredRoute();
    clearHrRoute();
    clearCadRoute();
    clearGradeRoute();
    hoverGeometry = geometry;
    routeLayer.setLatLngs(geometry.map((point) => [point.lat, point.lng]));
    if (geometry.length > 1) {
      map.fitBounds(routeLayer.getBounds(), { padding: [44, 44], maxZoom: 15 });
    }
  }

  function showUserLocation({ lat, lng, accuracy }) {
    const latLng = [lat, lng];
    if (!userLocationMarker) {
      userLocationMarker = L.marker(latLng, {
        icon: L.divIcon({
          className: "",
          html: '<span class="user-location-marker"></span>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
        title: "Current location",
      }).addTo(map);
      userAccuracyCircle = L.circle(latLng, {
        color: "#fc4c02",
        fillColor: "#fc4c02",
        fillOpacity: 0.12,
        opacity: 0.35,
        radius: accuracy || 40,
        weight: 1,
      }).addTo(map);
    } else {
      userLocationMarker.setLatLng(latLng);
      userAccuracyCircle.setLatLng(latLng);
      userAccuracyCircle.setRadius(accuracy || 40);
    }
    map.setView(latLng, Math.max(map.getZoom(), 15));
  }

  async function calculateRoute({ waypoints, mode, snapToRoads }, forceSnapOff = false) {
    if (waypoints.length < 2) {
      return {
        geometry: waypoints,
        distanceMeters: 0,
      };
    }

    if (!snapToRoads || forceSnapOff) {
      return straightLineRoute(waypoints);
    }

    try {
      const coordinates = waypoints.map((point) => `${point.lng},${point.lat}`).join("|");
      const profile = profileMap[mode] ?? profileMap.walking;
      const url = `https://brouter.de/brouter?lonlats=${coordinates}&profile=${profile}&alternativeidx=0&format=geojson`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Routing failed");
      const data = await response.json();
      const feature = data.features?.[0];
      const coords = feature?.geometry?.coordinates ?? [];
      const geometry = coords.map(([lng, lat, ele]) => ({ lat, lng, ele: ele ?? null }));
      const distanceMeters = Number(feature?.properties?.["track-length"] ?? haversineDistance(geometry));
      const { ascentMeters, descentMeters } = calcElevation(coords);

      if (geometry.length < 2) throw new Error("No route geometry");
      return { geometry, distanceMeters, ascentMeters, descentMeters };
    } catch {
      onRouteFallback();
      return straightLineRoute(waypoints);
    }
  }

  return {
    calculateRoute,
    invalidateSize: () => map.invalidateSize({ pan: false }),
    fitRoute: () => {
      if (routeLayer.getLatLngs().length > 1) {
        map.fitBounds(routeLayer.getBounds(), { padding: [44, 44], maxZoom: 15 });
      }
    },
    focusWaypoint: (lat, lng) => map.setView([lat, lng], Math.max(map.getZoom(), 15)),
    renderRoute,
    renderColoredRoute: (geometry) => {
      hoverGeometry = geometry;
      renderColoredRoute(geometry);
      if (geometry.length > 1) {
        const bounds = L.latLngBounds(geometry.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [44, 44], maxZoom: 15 });
      }
    },
    clearColoredRoute,
    renderHrRoute: (geometry) => {
      hoverGeometry = geometry;
      renderHrRoute(geometry);
      if (geometry.length > 1) {
        const bounds = L.latLngBounds(geometry.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [44, 44], maxZoom: 15 });
      }
    },
    clearHrRoute,
    renderCadRoute: (geometry) => {
      hoverGeometry = geometry;
      renderCadRoute(geometry);
      if (geometry.length > 1) {
        const bounds = L.latLngBounds(geometry.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [44, 44], maxZoom: 15 });
      }
    },
    clearCadRoute,
    renderGradeRoute: (geometry) => {
      hoverGeometry = geometry;
      renderGradeRoute(geometry);
      if (geometry.length > 1) {
        const bounds = L.latLngBounds(geometry.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [44, 44], maxZoom: 15 });
      }
    },
    clearGradeRoute,
    renderWaypoints,
    setRouteInteractive: (enabled) => {
      // Ha false: a crosshair kurzor és a route click le van tiltva
      routeClickEnabled = enabled;
      if (!enabled && nearRouteFlag) {
        map.getContainer().style.cursor = "";
        nearRouteFlag = false;
      }
    },
    setMapStyle: (style) => {
      map.removeLayer(baseLayer);
      if (overlayLayer) { map.removeLayer(overlayLayer); overlayLayer = null; }
      const def = tileLayers[style] ?? tileLayers.standard;
      baseLayer = L.tileLayer(def.url, def.options).addTo(map);
      if (def.overlay) {
        overlayLayer = L.tileLayer(def.overlay.url, def.overlay.options).addTo(map);
      }
    },
    showUserLocation,
    setActiveTool: (tool) => {
      if (activeTool === "measure" && tool !== "measure") clearMeasurement();
      activeTool = tool;
      map.getContainer().style.cursor = tool === "measure" ? "crosshair" : "";
    },
    clearMeasurement,
    getCurrentView: () => ({
      lat: map.getCenter().lat,
      lng: map.getCenter().lng,
      zoom: map.getZoom(),
    }),
    setView: (lat, lng, zoom) => map.setView([lat, lng], zoom),

    // Szintprofil hover marker
    setElevationMarker(lat, lng) {
      if (!elevationMarker) {
        elevationMarker = L.circleMarker([lat, lng], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#fc4c02",
          fillOpacity: 1,
          interactive: false,
          pane: "markerPane",
        }).addTo(map);
      } else {
        elevationMarker.setLatLng([lat, lng]);
      }
    },
    clearElevationMarker() {
      if (elevationMarker) {
        map.removeLayer(elevationMarker);
        elevationMarker = null;
      }
    },
  };
}

function createTileLayer(style) {
  const layer = tileLayers[style] ?? tileLayers.standard;
  return L.tileLayer(layer.url, layer.options);
}

function calcElevation(coords) {
  let ascent = 0, descent = 0;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1][2];
    const curr = coords[i][2];
    if (prev == null || curr == null) continue;
    const diff = curr - prev;
    if (diff > 0) ascent += diff;
    else descent += Math.abs(diff);
  }
  return { ascentMeters: Math.round(ascent), descentMeters: Math.round(descent) };
}

function findNearestPoint(geometry, latlng) {
  let minDist = Infinity;
  let nearest = null;
  for (const pt of geometry) {
    const d = latlng.distanceTo([pt.lat, pt.lng]);
    if (d < minDist) { minDist = d; nearest = pt; }
  }
  return nearest;
}

function findGeometryIndex(geometry, point) {
  for (let i = 0; i < geometry.length; i++) {
    if (geometry[i] === point) return i;
  }
  // fallback: keresés koordináta szerint
  let minDist = Infinity;
  let idx = 0;
  geometry.forEach((pt, i) => {
    const d = Math.hypot(pt.lat - point.lat, pt.lng - point.lng);
    if (d < minDist) { minDist = d; idx = i; }
  });
  return idx;
}

export function straightLineRoute(waypoints) {
  return {
    geometry: waypoints.map(({ lat, lng }) => ({ lat, lng })),
    distanceMeters: haversineDistance(waypoints),
  };
}

export function haversineDistance(points) {
  return points.slice(1).reduce((total, point, index) => {
    const previous = points[index];
    const earthRadius = 6371000;
    const dLat = toRadians(point.lat - previous.lat);
    const dLng = toRadians(point.lng - previous.lng);
    const lat1 = toRadians(previous.lat);
    const lat2 = toRadians(point.lat);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return total + earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, 0);
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function formatDist(meters) {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(2)} km`
    : `${Math.round(meters)} m`;
}
