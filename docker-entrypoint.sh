#!/bin/sh
# Generálja a config.js-t a környezeti változókból induláskor
cat > /usr/share/nginx/html/src/config.js << EOF
// ── App configuration ─────────────────────────────────────
// Automatically generated at container startup from environment variables.

export const config = {
  login: ${LOGIN_ENABLED:-true},
  shareBaseUrl: "${SHARE_BASE_URL:-}",
  contactEmail: "${CONTACT_EMAIL:-}",
};
EOF

# Cache-busting a belépési scriptekre: minden indításkor egyedi token, így a
# böngésző (Safari is) garantáltan friss main.js-t (a teljes import-gráfot) és
# version.js-t tölt deploy után – az index.html-ben és a login.html-ben egyaránt.
# Idempotens: a meglévő ?b=... tokent felülírja.
BUST=$(date +%s)
for F in /usr/share/nginx/html/index.html /usr/share/nginx/html/login.html /usr/share/nginx/html/view.html; do
  [ -f "$F" ] && sed -i -E "s#(src=\"\./src/(main|version|view)\.js)(\?b=[0-9]+)?\"#\1?b=${BUST}\"#g" "$F"
done

exec "$@"
