// Alaptérkép-rétegek – egyetlen forrás az apphoz (mapAdapter) és az admin térképéhez.
// Függőség nélküli modul: a Leafletet nem hívja, csak leírja a rétegeket.

const esriAttrib = 'Tiles &copy; <a href="https://www.esri.com">Esri</a>';

export const tileLayers = {
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
  // A CARTO basemap 2026-tól API-kulcsot kér ("API KEY REQUIRED" watermark),
  // ezért az Esri Gray Canvasre váltottunk (kulcs nélkül, ugyanaz mint a műholdas).
  // A címkék külön overlay-rétegben jönnek (a Gray Base címke nélküli).
  light: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, maxNativeZoom: 16, attribution: esriAttrib },
    overlay: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: "", pane: "shadowPane" },
    },
  },
  dark: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, maxNativeZoom: 16, attribution: esriAttrib },
    overlay: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: "", pane: "shadowPane" },
    },
  },
  // Terep: zöld erdős, domborzatos Esri topo térkép (a megosztó kép „Terep” háttere).
  // A filter a PDF-be rajzoláskor élénkíti a színeket (Leaflet nem használja).
  terrain: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 19, maxNativeZoom: 17, attribution: esriAttrib },
    filter: "saturate(1.45) contrast(1.06)",
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

// A felületen megjelenő nevek (ugyanaz, mint az app térképstílus-választójában)
export const TILE_LAYER_LABELS = {
  standard: "Standard", cycling: "Kerékpár", topo: "Domborzat", terrain: "Terep",
  satellite: "Műhold", hybrid: "Hybrid", light: "Világos", dark: "Sötét",
};
