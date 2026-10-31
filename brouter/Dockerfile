# ── Bringaterv – saját BRouter útvonaltervező ────────────────────────────────
#
# A BRouter (https://github.com/abrensch/brouter) szervere a stack belső hálózatán,
# a 17777-es porton; kívülről csak a frontend nginx-én át érhető el (/brouter).
# A térképadat-csempék (.rd5) a /data kötetbe kerülnek: első induláskor letöltődnek,
# utána hetente frissülnek (entrypoint.sh). Részletek: brouter/README.md

FROM eclipse-temurin:21-jre

ARG BROUTER_VERSION=1.7.10

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/brouter.zip \
      "https://github.com/abrensch/brouter/releases/download/v${BROUTER_VERSION}/brouter-${BROUTER_VERSION}.zip" \
 && unzip -q /tmp/brouter.zip -d /opt \
 && mv "/opt/brouter-${BROUTER_VERSION}" /opt/brouter \
 && mv "/opt/brouter/brouter-${BROUTER_VERSION}-all.jar" /opt/brouter/brouter.jar \
 && rm -f /tmp/brouter.zip /opt/brouter/*.apk /opt/brouter/brouter-*-ro.jar \
 && mkdir -p /opt/brouter/customprofiles

# Saját tervezési profilok (bringaterv-*.brf) a gyári profilok mellé
COPY profiles/ /opt/brouter/profiles2/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && rm -f /opt/brouter/profiles2/README.md

ENV BROUTER_VERSION=${BROUTER_VERSION} \
    TILES="E15_N45 E20_N45" \
    SEGMENTS_URL="https://brouter.de/brouter/segments4" \
    JAVA_MEM=1g \
    THREADS=4 \
    UPDATE_DAYS=7

EXPOSE 17777
VOLUME /data
CMD ["/entrypoint.sh"]
