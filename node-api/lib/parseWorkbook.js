// lib/parseWorkbook.js
//
// Port dari merge_halte.py (bagian parse_workbook + resolve_coord + normalisasi).
// Baca by HEADER NAME, bukan posisi kolom -- tiap sheet excel kamu punya jumlah
// kolom trailing kosong yang beda-beda (ada yang sampe kolom AB), jadi parsing
// by index gampang salah.

const XLSX = require("xlsx");

const LAT_MIN = -7.25, LAT_MAX = -6.85;
const LNG_MIN = 110.20, LNG_MAX = 110.55;

const TROTOAR_MAP = { ya: true, tidak: false };
const RAMBU_MAP = {
  halte: "halte",
  rambu: "rambu",
  "tidak ada halte/rambu": "tidak_ada",
};
const DIRECTION_TAGS = new Set(["utara", "selatan", "barat", "timur"]);

function normTxt(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t.length ? t : null;
}
function normKey(v) {
  const t = normTxt(v);
  return t ? t.toLowerCase() : null;
}

function parseCorridorName(sheetName) {
  // '3A Pelabuhan-Kagok (H)' -> { kode: '3A', nama: 'Pelabuhan-Kagok' }
  let s = sheetName.trim().replace(/\(H\)\s*$/i, "").trim();
  const m = s.match(/^([A-Za-z0-9]+)\s+(.+)$/);
  if (!m) return { kode: null, nama: s };
  return { kode: m[1], nama: m[2].trim() };
}

function extractDirectionTag(name) {
  if (!name) return null;
  const m = name.match(/\[([^\]]*)\]/);
  if (!m) return null;
  const tag = m[1].trim().toLowerCase();
  return DIRECTION_TAGS.has(tag) ? tag : null;
}

function isInBounds(lat, lng) {
  return (
    typeof lat === "number" && typeof lng === "number" &&
    lat >= LAT_MIN && lat <= LAT_MAX && lng >= LNG_MIN && lng <= LNG_MAX
  );
}

/** Prioritas: Aktual -> Kor Lain -> Aplikasi. Return null kalau semuanya kosong. */
function resolveCoord(row) {
  const candidates = [
    ["aktual", row.lat_aktual, row.lng_aktual],
    ["kor_lain", row.lat_korlain, row.lng_korlain],
    ["aplikasi", row.lat_aplikasi, row.lng_aplikasi],
  ];
  for (const [source, lat, lng] of candidates) {
    if (lat == null || lng == null) continue;
    if (isInBounds(lat, lng)) {
      const confidence = source === "aktual" ? "high" : source === "kor_lain" ? "medium" : "low";
      return { lat, lng, source, confidence, note: null };
    }
  }
  for (const [source, lat, lng] of candidates) {
    if (lat != null && lng != null) {
      return { lat, lng, source, confidence: "invalid", note: "koordinat di luar bounding box Semarang" };
    }
  }
  return { lat: null, lng: null, source: null, confidence: "missing", note: "tidak ada koordinat sama sekali" };
}

/** Bangun header map { field: colIndex } dari baris pertama sheet. */
function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((raw, idx) => {
    const h = normTxt(raw);
    if (!h) return;
    const key = h.toLowerCase();
    if (key.startsWith("no") && key.length <= 3) map.no = idx;
    else if (key.includes("nama halte")) map.nama_halte = idx;
    else if (key.includes("lintang") && key.includes("aplikasi")) map.lat_aplikasi = idx;
    else if (key.includes("bujur") && key.includes("aplikasi")) map.lng_aplikasi = idx;
    else if (key.includes("lintang") && key.includes("aktual")) map.lat_aktual = idx;
    else if (key.includes("bujur") && key.includes("aktual")) map.lng_aktual = idx;
    else if (key.includes("lintang") && key.includes("kor")) map.lat_korlain = idx;
    else if (key.includes("bujur") && key.includes("kor")) map.lng_korlain = idx;
    else if (key.startsWith("arah")) map.arah = idx;
    else if (key.includes("fungsi jalan")) map.fungsi_jalan = idx;
    else if (key.includes("trotoar")) map.trotoar = idx;
    else if (key.includes("rambu")) map.rambu_halte = idx;
    else if (key.startsWith("transit")) map.transit = idx;
  });
  return map;
}

/**
 * Parse 1 workbook buffer -> { koridorList, halteByKoridorKode, warnings }
 *   koridorList: [{ kode, nama, sheetName }]
 *   halteByKoridorKode: { [kode]: [ record, ... ] }
 */
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const koridorList = [];
  const halteByKoridorKode = {};
  const warnings = [];

  for (const sheetName of wb.SheetNames) {
    if (sheetName.toLowerCase().includes("template")) continue;

    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    if (!rows.length) continue;

    const { kode, nama } = parseCorridorName(sheetName);
    if (!kode) {
      warnings.push(`[${sheetName}] tidak bisa extract kode koridor dari nama sheet -> dilewati`);
      continue;
    }

    const headerMap = buildHeaderMap(rows[0]);
    const required = ["no", "nama_halte", "lat_aktual", "lng_aktual"];
    const missing = required.filter((k) => !(k in headerMap));
    if (missing.length) {
      warnings.push(`[${sheetName}] header wajib tidak ditemukan: ${missing.join(", ")} -> sheet dilewati`);
      continue;
    }

    koridorList.push({ kode, nama, sheetName });
    const records = [];

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const get = (key) => (headerMap[key] != null ? row[headerMap[key]] : null);

      const noVal = get("no");
      if (noVal === null || noVal === "") continue;

      const raw = {
        nama_halte: normTxt(get("nama_halte")),
        lat_aplikasi: numOrNull(get("lat_aplikasi")),
        lng_aplikasi: numOrNull(get("lng_aplikasi")),
        lat_aktual: numOrNull(get("lat_aktual")),
        lng_aktual: numOrNull(get("lng_aktual")),
        lat_korlain: numOrNull(get("lat_korlain")),
        lng_korlain: numOrNull(get("lng_korlain")),
        arah: normTxt(get("arah")),
        fungsi_jalan: normTxt(get("fungsi_jalan")),
        trotoar_raw: normTxt(get("trotoar")),
        rambu_raw: normTxt(get("rambu_halte")),
        transit_raw: normTxt(get("transit")),
      };

      const coord = resolveCoord(raw);
      const trotoar = TROTOAR_MAP[normKey(raw.trotoar_raw)] ?? null;
      const rambu = RAMBU_MAP[normKey(raw.rambu_raw)] ?? null;
      const transit = TROTOAR_MAP[normKey(raw.transit_raw)] ?? null;

      const issues = [];
      if (!raw.nama_halte) issues.push("nama halte kosong");
      if (coord.confidence === "invalid" || coord.confidence === "missing") issues.push(coord.note);
      if (raw.trotoar_raw && trotoar === null) issues.push(`nilai trotoar tak dikenal: '${raw.trotoar_raw}'`);
      if (raw.rambu_raw && rambu === null) issues.push(`nilai rambu/halte tak dikenal: '${raw.rambu_raw}'`);

      records.push({
        no_urut: Number(noVal),
        nama_halte: raw.nama_halte,
        direction_tag: extractDirectionTag(raw.nama_halte),
        arah: raw.arah,
        fungsi_jalan: raw.fungsi_jalan,
        trotoar,
        rambu_halte: rambu,
        transit,
        lat_aplikasi: raw.lat_aplikasi, lng_aplikasi: raw.lng_aplikasi,
        lat_aktual: raw.lat_aktual, lng_aktual: raw.lng_aktual,
        lat_korlain: raw.lat_korlain, lng_korlain: raw.lng_korlain,
        lat: coord.lat, lng: coord.lng,
        coord_source: coord.source,
        coord_confidence: coord.confidence,
        issues,
      });
    }

    halteByKoridorKode[kode] = records;
  }

  return { koridorList, halteByKoridorKode, warnings };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseWorkbook, parseCorridorName, extractDirectionTag };
