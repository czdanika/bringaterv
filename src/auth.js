import { config } from "./config.js";

// ── Tárolási kulcsok ───────────────────────────────────────────────────────────
const JWT_KEY  = "bringaterv_jwt";
const USER_KEY = "bringaterv_user";
const SETTINGS_OWNER_KEY = "bringaterv_settings_owner";

// User-specifikus localStorage kulcsok – ezek a settings.json-ben is szinkronizálódnak,
// ezért userváltáskor le kell tisztítani őket, különben átkerülnek egyik fiókról a másikra.
const USER_SPECIFIC_KEYS = [
  "bringaterv.hrZones",
  "bringaterv.speedZones",
  "bringaterv.cadZones",
  "bringaterv.powerZones",
  "bringaterv.chartColors",
  "bringaterv.cyclistProfile",
  "bringaterv.startView",
  "bringaterv.settings.collapsed",
  "route4meMapStyle",
  "route4meUnit",
  "route4meTheme",
];

function clearUserSettings() {
  USER_SPECIFIC_KEYS.forEach(k => localStorage.removeItem(k));
  localStorage.removeItem(SETTINGS_OWNER_KEY);
}

/**
 * Owner-ellenőrzés: ha a localStorage-ban tárolt settings másik felhasználóhoz
 * tartozik (vagy nincs tárolva owner), törli őket és új ownert állít be.
 * Main.js induláskor, az IIFE-k előtt kell meghívni.
 *
 * @returns {boolean} true, ha mismatch volt és tisztítás történt
 */
export function ensureSettingsOwner() {
  const user = getUser();
  if (!user?.id) return false;
  const stored = localStorage.getItem(SETTINGS_OWNER_KEY);
  if (stored !== user.id) {
    USER_SPECIFIC_KEYS.forEach(k => localStorage.removeItem(k));
    localStorage.setItem(SETTINGS_OWNER_KEY, user.id);
    return true;
  }
  return false;
}

// ── Token kezelés ─────────────────────────────────────────────────────────────

export function getToken() {
  return localStorage.getItem(JWT_KEY);
}

export function getUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isAdmin() {
  return getUser()?.role === "admin";
}

/** Authorization fejléc objektum – minden API kéréshez */
export function authHeaders() {
  const token = getToken();
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

// ── Autentikáció ellenőrzés ───────────────────────────────────────────────────

export function isAuthenticated() {
  if (!config.login) return true;
  return !!getToken();
}

// ── Bejelentkezés ─────────────────────────────────────────────────────────────

/** JWT kérés a Flask API-tól */
export async function login(username, password) {
  const res = await fetch("/api/auth/login", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ email: username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Hibás felhasználónév vagy jelszó.");
  }
  const data = await res.json();
  localStorage.setItem(JWT_KEY,  data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data.user;
}

// ── Kijelentkezés ─────────────────────────────────────────────────────────────

export function logout() {
  clearUserSettings();
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
}

// ── Oldalvédelem ──────────────────────────────────────────────────────────────

/** main.js tetején hívandó – nem auth. felhasználót login.html-re dob */
export function requireAuth() {
  if (!isAuthenticated()) {
    window.location.replace("./login.html");
  }
}

/** admin.html tetején hívandó */
export function requireAdmin() {
  if (!isAuthenticated()) {
    window.location.replace("./login.html");
    return;
  }
  if (!isAdmin()) {
    window.location.replace("./index.html");
  }
}

/** 401 hiba kezelés – token lejárt, újra kell bejelentkezni */
export function handle401() {
  logout();
  window.location.replace("./login.html");
}
