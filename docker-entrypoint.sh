#!/bin/sh
# Generálja a config.js-t a környezeti változókból induláskor
cat > /usr/share/nginx/html/src/config.js << EOF
// ── App configuration ─────────────────────────────────────
// Automatically generated at container startup from environment variables.

export const config = {
  login: ${LOGIN_ENABLED:-true},
};
EOF

# Cache-busting a belépési modul-scriptre: minden indításkor egyedi token,
# így a böngésző (Safari is) garantáltan friss main.js-t (és a teljes import-
# gráfot) tölt deploy után. Idempotens: a meglévő ?b=... tokent felülírja.
BUST=$(date +%s)
INDEX=/usr/share/nginx/html/index.html
if [ -f "$INDEX" ]; then
  sed -i -E "s#(src=\"\./src/main\.js)(\?b=[0-9]+)?\"#\1?b=${BUST}\"#g" "$INDEX"
fi

exec "$@"
