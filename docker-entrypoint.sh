#!/bin/sh
# Generálja a config.js-t a környezeti változókból induláskor
cat > /usr/share/nginx/html/src/config.js << EOF
// ── App configuration ─────────────────────────────────────
// Automatically generated at container startup from environment variables.

export const config = {
  login: ${LOGIN_ENABLED:-true},
  user: "${LOGIN_USER:-bringa}",
  password: "${LOGIN_PASSWORD:-terv}",
};
EOF

exec "$@"
