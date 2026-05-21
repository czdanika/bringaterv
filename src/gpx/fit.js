/**
 * FIT (Flexible and Interoperable Data Transfer) fájl importer
 * ============================================================
 * Minimális, böngészőben futó decoder — csak az elemzéshez szükséges
 * Record (#20) és Session (#18) üzeneteket olvassa ki, és GPX 1.1 stringre
 * konvertálja Garmin TrackPointExtension + PowerExtension mezőkkel.
 *
 * Használat:
 *   import { fitToGpx } from "./fit.js";
 *   const gpxString = fitToGpx(arrayBuffer, "ride.fit");
 *
 * Korlátok:
 *  - Compressed timestamp header-rel nem foglalkozunk (modern eszközök
 *    ritkán használják track-pontoknál)
 *  - Csak Record üzenetből veszünk pontokat (Course Point, Lap nem)
 *  - Developer field-eket átugorjuk (megolvassuk a méretüket, de nem mentjük)
 *
 * Forrás: FIT Protocol 2.x specifikáció (Garmin nyilvános dokumentáció)
 */

// ── FIT epoch: 1989-12-31T00:00:00Z (628992000 másodperc a Unix epoch-tól) ────
const FIT_EPOCH_OFFSET_SEC = 631065600;

// ── Base type → bájtméret (alsó 5 bit a base_type bájtból) ──────────────────
const BASE_TYPE_SIZE = {
  0x00: 1, 0x01: 1, 0x02: 1, 0x03: 2, 0x04: 2,
  0x05: 4, 0x06: 4, 0x07: 1, 0x08: 4, 0x09: 8,
  0x0a: 1, 0x0b: 2, 0x0c: 4, 0x0d: 1, 0x0e: 8, 0x0f: 8, 0x10: 8,
};

// ── Globális üzenettípusok – csak amik kellenek ─────────────────────────────
const MSG_RECORD  = 20;
const MSG_SESSION = 18;
const MSG_LAP     = 19;
const MSG_FILE_ID = 0;

/**
 * Részletes FIT parser. Visszaadja az értelmes üzeneteket.
 * @param {ArrayBuffer} buffer
 * @returns {{ records: Array, sessions: Array, fileId: object|null }}
 */
export function parseFit(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 14) throw new Error("FIT fájl túl rövid");

  const headerSize = dv.getUint8(0);
  if (headerSize !== 12 && headerSize !== 14) {
    throw new Error(`Érvénytelen FIT header méret: ${headerSize}`);
  }
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== ".FIT") throw new Error("Nem érvényes FIT aláírás");

  const dataSize = dv.getUint32(4, true);
  const dataEnd  = headerSize + dataSize;

  // local msg type → { globalMsgNum, littleEndian, fields: [{num, size, baseType}], devSize }
  const defs = new Map();
  const records  = [];
  const sessions = [];
  let fileId = null;

  let p = headerSize;
  while (p < dataEnd) {
    const recHeader = dv.getUint8(p++);
    // Compressed timestamp header – nem támogatott, kihagyjuk a következő record-ig
    if (recHeader & 0x80) {
      const localType = (recHeader >> 5) & 0x03;
      const def = defs.get(localType);
      if (!def) break; // nincs def, biztos hibás
      p += def.totalSize;
      continue;
    }

    const localType   = recHeader & 0x0f;
    const isDefMsg    = (recHeader & 0x40) !== 0;
    const hasDevData  = (recHeader & 0x20) !== 0;

    if (isDefMsg) {
      // Definíciós üzenet
      p++; // reserved
      const arch = dv.getUint8(p++);   // 0 = LE, 1 = BE
      const littleEndian = arch === 0;
      const globalMsgNum = littleEndian ? dv.getUint16(p, true) : dv.getUint16(p, false);
      p += 2;
      const numFields = dv.getUint8(p++);
      const fields = [];
      let totalSize = 0;
      for (let i = 0; i < numFields; i++) {
        const num      = dv.getUint8(p++);
        const size     = dv.getUint8(p++);
        const baseType = dv.getUint8(p++);
        fields.push({ num, size, baseType });
        totalSize += size;
      }
      let devTotalSize = 0;
      if (hasDevData) {
        const numDev = dv.getUint8(p++);
        for (let i = 0; i < numDev; i++) {
          /* num */ dv.getUint8(p++);
          const size = dv.getUint8(p++);
          /* devIdx */ dv.getUint8(p++);
          devTotalSize += size;
        }
      }
      defs.set(localType, { globalMsgNum, littleEndian, fields, totalSize: totalSize + devTotalSize, devTotalSize });
    } else {
      // Adat üzenet
      const def = defs.get(localType);
      if (!def) {
        // Nincs hozzá definíció – nem tudjuk, mekkora; le kell állni
        break;
      }
      const out = {};
      for (const f of def.fields) {
        out[f.num] = readField(dv, p, f.size, f.baseType, def.littleEndian);
        p += f.size;
      }
      p += def.devTotalSize; // developer mezőket átugorjuk

      switch (def.globalMsgNum) {
        case MSG_RECORD:
          records.push(decodeRecord(out));
          break;
        case MSG_SESSION:
          sessions.push(decodeSession(out));
          break;
        case MSG_FILE_ID:
          if (!fileId) fileId = decodeFileId(out);
          break;
        // Lap / egyéb üzeneteket figyelmen kívül hagyjuk
      }
    }
  }
  return { records, sessions, fileId };
}

/**
 * FIT mezőérték kiolvasása a base type alapján.
 * Invalid értékeket (mind 0xFF) null-ra alakítjuk.
 */
function readField(dv, offset, size, baseType, littleEndian) {
  const type = baseType & 0x1f;
  const elemSize = BASE_TYPE_SIZE[type] ?? 1;

  // String típus
  if (type === 0x07) {
    let s = "";
    for (let i = 0; i < size; i++) {
      const c = dv.getUint8(offset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s || null;
  }

  // Array (size > elemSize) → tömb
  if (size > elemSize) {
    const out = [];
    for (let i = 0; i < size; i += elemSize) {
      out.push(readScalar(dv, offset + i, type, littleEndian));
    }
    return out;
  }

  return readScalar(dv, offset, type, littleEndian);
}

function readScalar(dv, off, type, le) {
  switch (type) {
    case 0x00: { const v = dv.getUint8(off);  return v === 0xff ? null : v; }
    case 0x01: { const v = dv.getInt8(off);   return v === 0x7f ? null : v; }
    case 0x02: { const v = dv.getUint8(off);  return v === 0xff ? null : v; }
    case 0x03: { const v = dv.getInt16(off, le);  return v === 0x7fff ? null : v; }
    case 0x04: { const v = dv.getUint16(off, le); return v === 0xffff ? null : v; }
    case 0x05: { const v = dv.getInt32(off, le);  return v === 0x7fffffff ? null : v; }
    case 0x06: { const v = dv.getUint32(off, le); return v === 0xffffffff ? null : v; }
    case 0x08: { const v = dv.getFloat32(off, le); return Number.isFinite(v) ? v : null; }
    case 0x09: { const v = dv.getFloat64(off, le); return Number.isFinite(v) ? v : null; }
    case 0x0a: { const v = dv.getUint8(off);  return v === 0 ? null : v; }
    case 0x0b: { const v = dv.getUint16(off, le); return v === 0 ? null : v; }
    case 0x0c: { const v = dv.getUint32(off, le); return v === 0 ? null : v; }
    case 0x0d: { const v = dv.getUint8(off);  return v === 0xff ? null : v; }
    default:  return null;
  }
}

// ── Üzenettípusok dekódolása értelmes mezőkre ───────────────────────────────

function decodeRecord(raw) {
  // Record (#20) – field id-k a FIT profil szerint
  const semiToDeg = s => s == null ? null : s * (180 / 2147483648);
  const lat = semiToDeg(raw[0]);    // position_lat
  const lon = semiToDeg(raw[1]);    // position_long
  if (lat == null || lon == null)   return null;
  // enhanced_altitude (78) ha van, egyébként altitude (2)
  let altRaw = raw[78] != null ? raw[78] : raw[2];
  let ele = altRaw != null ? altRaw / 5 - 500 : null;
  if (ele != null && (ele < -1000 || ele > 9000)) ele = null;
  const ts  = raw[253] != null ? new Date((raw[253] + FIT_EPOCH_OFFSET_SEC) * 1000) : null;
  // enhanced_speed (73) ha van, egyébként speed (6)
  const spd = raw[73] != null ? raw[73] / 1000 : (raw[6] != null ? raw[6] / 1000 : null);
  return {
    lat, lon, ele,
    time:  ts,
    hr:    raw[3]  ?? null,         // heart_rate (bpm)
    cad:   raw[4]  ?? null,         // cadence (rpm)
    dist:  raw[5]  != null ? raw[5] / 100 : null,  // m
    spd,                             // m/s
    power: raw[7]  ?? null,         // power (W)
    temp:  raw[13] ?? null,         // °C
  };
}

function decodeSession(raw) {
  return {
    sport:        raw[5]   ?? null,
    startTime:    raw[2]   != null ? new Date((raw[2]   + FIT_EPOCH_OFFSET_SEC) * 1000) : null,
    totalTime:    raw[7]   != null ? raw[7] / 1000 : null,   // sec
    totalDist:    raw[9]   != null ? raw[9] / 100  : null,   // m
    totalAscent:  raw[22]  ?? null,                          // m
    avgHr:        raw[16]  ?? null,
    maxHr:        raw[17]  ?? null,
    avgPower:     raw[20]  ?? null,
  };
}

function decodeFileId(raw) {
  return {
    type:      raw[0] ?? null,    // 4 = activity
    manufact:  raw[1] ?? null,
    product:   raw[2] ?? null,
    timeCreated: raw[4] != null ? new Date((raw[4] + FIT_EPOCH_OFFSET_SEC) * 1000) : null,
  };
}

// ── GPX kimenet ─────────────────────────────────────────────────────────────

/**
 * FIT ArrayBuffer → GPX 1.1 string (Garmin TrackPointExtension + PowerExtension).
 * A meglévő GPX parser (gpx.js) ezeket a `<gpxtpx:hr>`, `<gpxtpx:cad>` stb.
 * mezőket namespace-agnoszikusan beolvassa.
 *
 * @param {ArrayBuffer} buffer
 * @param {string} [filename] – metaadatként kerül a `<trk><name>` mezőbe
 * @returns {string} GPX XML
 */
export function fitToGpx(buffer, filename = "FIT import") {
  const { records, sessions } = parseFit(buffer);
  const pts = records.filter(Boolean);
  if (pts.length === 0) throw new Error("Nincs érvényes track pont a FIT fájlban");

  const sess = sessions[0] ?? {};
  const trackName = filename.replace(/\.fit$/i, "");

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="Bringaterv (FIT import)"');
  lines.push('  xmlns="http://www.topografix.com/GPX/1/1"');
  lines.push('  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"');
  lines.push('  xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1">');

  // Metaadatok
  if (sess.startTime) {
    lines.push(`  <metadata><time>${sess.startTime.toISOString()}</time></metadata>`);
  }

  lines.push('  <trk>');
  lines.push(`    <name>${escapeXml(trackName)}</name>`);
  lines.push('    <trkseg>');
  for (const p of pts) {
    lines.push(`      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`);
    if (p.ele != null)  lines.push(`        <ele>${p.ele.toFixed(2)}</ele>`);
    if (p.time)         lines.push(`        <time>${p.time.toISOString()}</time>`);

    // Extensions: HR / cadence / temp / power
    const hasTpx   = p.hr != null || p.cad != null || p.temp != null;
    const hasPower = p.power != null;
    if (hasTpx || hasPower) {
      lines.push('        <extensions>');
      if (hasTpx) {
        lines.push('          <gpxtpx:TrackPointExtension>');
        if (p.hr   != null) lines.push(`            <gpxtpx:hr>${p.hr}</gpxtpx:hr>`);
        if (p.cad  != null) lines.push(`            <gpxtpx:cad>${p.cad}</gpxtpx:cad>`);
        if (p.temp != null) lines.push(`            <gpxtpx:atemp>${p.temp}</gpxtpx:atemp>`);
        lines.push('          </gpxtpx:TrackPointExtension>');
      }
      if (hasPower) {
        lines.push('          <gpxpx:PowerExtension>');
        lines.push(`            <gpxpx:PowerInWatts>${p.power}</gpxpx:PowerInWatts>`);
        lines.push('          </gpxpx:PowerExtension>');
      }
      lines.push('        </extensions>');
    }

    lines.push('      </trkpt>');
  }
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
