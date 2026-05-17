import { config } from "./config.js";

const SESSION_KEY = "bringaterv_auth";

export function isAuthenticated() {
  if (!config.login) return true;
  return sessionStorage.getItem(SESSION_KEY) === "1";
}

export function login(user, password) {
  if (user === config.user && password === config.password) {
    sessionStorage.setItem(SESSION_KEY, "1");
    return true;
  }
  return false;
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

/** Call at the top of main.js — redirects to login.html if not authenticated. */
export function requireAuth() {
  if (!isAuthenticated()) {
    window.location.replace("./login.html");
  }
}
