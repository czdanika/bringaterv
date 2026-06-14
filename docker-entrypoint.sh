#!/bin/sh
# Generálja a config.js-t a környezeti változókból induláskor
cat > /usr/share/nginx/html/src/config.js << EOF
// ── App configuration ─────────────────────────────────────
// Automatically generated at container startup from environment variables.

export const config = {
  login: ${LOGIN_ENABLED:-true},
};
EOF

# Cache-busting a belépési modul-scriptekre: minden indításkor egyedi token,
# így a böngésző (Safari is) garantáltan friss main.js / garmin.js-t tölt.
# Idempotens: előbb letörli a meglévő ?b=... tokent, majd újat tesz.
BUST=$(date +%s)
INDEX=/usr/share/nginx/html/index.html
if [ -f "$INDEX" ]; then
  sed -i -E "s#(src=\"\./src/main\.js)(\?b=[0-9]+)?\"#\1?b=${BUST}\"#g; s#(src=\"\./src/ui/garmin\.js)(\?b=[0-9]+)?\"#\1?b=${BUST}\"#g" "$INDEX"
fi

exec "$@"
