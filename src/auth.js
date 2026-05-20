import { config } from "./config.js";

// ── Tárolási kulcsok ───────────────────────────────────────────────────────────
const SINGLE_KEY  = "bringaterv_auth";
const JWT_KEY     = "bringaterv_jwt";
const USER_KEY    = "bringaterv_user";

// ── Mód lekérdezés ────────────────────────────────────────────────────────────

export function isMultiMode() {
  return (config.mode ?? "single") === "multi";
}

// ── Token kezelés (multi mód) ─────────────────────────────────────────────────

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
  if (isMultiMode()) return !!getToken();
  return sessionStorage.getItem(SINGLE_KEY) === "1";
}

// ── Bejelentkezés ─────────────────────────────────────────────────────────────

/** Single mód: kliens oldali ellenőrzés config.js alapján */
export function login(user, password) {
  if (user === config.user && password === config.password) {
    sessionStorage.setItem(SINGLE_KEY, "1");
    return true;
  }
  return false;
}

/** Multi mód: JWT kérés a Flask API-tól */
export async function loginMulti(username, password) {
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
  sessionStorage.removeItem(SINGLE_KEY);
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
  if (isMultiMode() && !isAdmin()) {
    window.location.replace("./index.html");
  }
}

/** 401 hiba kezelés – token lejárt, újra kell bejelentkezni */
export function handle401() {
  logout();
  window.location.replace("./login.html");
}
