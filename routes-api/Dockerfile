# ── Bringaterv Routes API – Dockerfile ──────────────────────────────────────
#
# Debian slim alapú Python image (az osmium csomaghoz kész wheel kell), gunicorn-nal futtatva.
# Minta GPX fájlok a /samples könyvtárba kerülnek (image-be égetve).
# Felhasználói adatok: Docker volume → /data/routes (nem kerül az image-be).

FROM python:3.13-slim

# Munkakönyvtár
WORKDIR /app

# Az osmium (burkolat-adatbázis építése) az expat könyvtárat igényli
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*

# Függőségek telepítése (külön réteg → Docker layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Alkalmazás kód (app.py + modulok: config, db, auth, api_*, strava_service, ...)
COPY *.py ./
# E-mail sablon képei (logó)
COPY assets/ ./assets/

# Minta GPX + JSON fájlok beégetése az image-be
# (ha a samples/ mappa üres, a COPY nem hibázik, csak kihagyja)
COPY samples/ /samples/

# Adatkönyvtár előkészítése (volume mount pont)
RUN mkdir -p /data/routes/user

# Környezeti változók alapértékei
ENV DATA_DIR=/data/routes
ENV SAMPLES_DIR=/samples
ENV FLASK_ENV=production

# Port (belső, nginx proxy-n át érhető el kívülről)
EXPOSE 5001

# Gunicorn: 2 worker × 4 thread (gthread) – így egy lassú külső hívás (pl. élő
# Garmin lekérés) nem blokkolja a többi kérést. 120s timeout nagy GPX-ekhez.
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--workers", "2", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "app:app"]
