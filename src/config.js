// ── App configuration ─────────────────────────────────────
// Set login to true to enable the login gate.
// Credentials are checked client-side — suitable for personal/local use.

export const config = {
  login: true,
  user: "bringa",
  password: "terv",
  // Publikus megosztási (QR) alap-URL. Üresen hagyva a böngésző origin-jét
  // használjuk. Pl. "https://bringaterv.czibolyahome.hu".
  shareBaseUrl: "",
};
