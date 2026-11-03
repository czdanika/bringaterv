#!/usr/bin/env bash
# Böngészős tesztek futtatása a Pi ellen (alap) vagy BT_BASE-re.
#   tests/run.sh                       – minden teszt, minden eszköz
#   tests/run.sh -k iphone             – csak iPhone
#   tests/run.sh tests/test_planning.py
# Belépés: BT_USER / BT_PASS környezeti változó (vagy tests/.env).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x tests/.venv/bin/pytest ]; then
  python3 -m venv tests/.venv
  tests/.venv/bin/pip install -q playwright pytest
fi
[ -f tests/.env ] && set -a && . tests/.env && set +a

tests/.venv/bin/pytest -c tests/pytest.ini --rootdir . "$@"
