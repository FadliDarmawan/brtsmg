#!/usr/bin/env node
/**
 * shapes/build-all-shapes.js
 *
 * Wrapper di sekitar build-route-shapes.js (TIDAK DIMODIFIKASI, dipakai apa
 * adanya sebagai library-per-koridor) yang otomatis:
 *   1. Ambil stops TERKINI dari /api/stops (deployment yang lagi jalan, atau
 *      lokal kalau kamu jalanin `vercel dev`)
 *   2. Loop semua koridor yang ada di shapes/shapes.config.json + punya file
 *      routes/<kode>.json
 *   3. Jalanin build-route-shapes.js buat masing-masing, pakai flag
 *      (--start/--order/--patch/--reverse) dari config, bukan diketik manual
 *   4. Cetak ringkasan: berapa koridor OK, berapa GAGAL (exit code != 0)
 *
 * KENAPA INI GAK DIPICU OTOMATIS DARI /api/upload ATAU /api/review-resolve:
 *
 *   (a) Constraint teknis: Vercel serverless function jalan di filesystem
 *       read-only buat static asset -- gak bisa nulis balik ke
 *       routes/<kode>.json di repo. File itu cuma keupdate kalau redeploy
 *       dari git.
 *
 *   (b) Constraint desain: build-route-shapes.js SENGAJA fail loudly kalau
 *       loop gak nutup / arah kebalik / stop meleset jauh dari garis --
 *       itu bug yang gak kelihatan di disk, cuma ketauan pas nyoba klik
 *       "leg A ke B" di browser. Auto-run tanpa manusia liat output-nya
 *       ngilangin exact safety net yang emang sengaja dipasang di sana.
 *
 * JADI: jalanin ini MANUAL (lokal, abis edit halte yang signifikan --
 * ganti koordinat, tambah/hapus halte dari suatu koridor) sebelum commit,
 * ATAU sebagai GitHub Action yang bikin PR (bukan auto-commit ke main) --
 * lihat shapes/README.md buat kedua opsi itu.
 *
 * USAGE:
 *   node shapes/build-all-shapes.js --api=https://semarang-brt.vercel.app
 *   node shapes/build-all-shapes.js --api=http://localhost:3000   (vercel dev)
 *   node shapes/build-all-shapes.js --api=... --only=1,3A,F2C     (subset)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const https = require("https");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const ROUTES_DIR = path.join(ROOT, "routes");
const CONFIG_PATH = path.join(__dirname, "shapes.config.json");
const STOPS_CACHE_PATH = path.join(__dirname, ".stops-cache.json");
const BUILD_SCRIPT = path.join(__dirname, "build-route-shapes.js");

const args = process.argv.slice(2);
const apiArg = args.find((a) => a.startsWith("--api="));
const onlyArg = args.find((a) => a.startsWith("--only="));

if (!apiArg) {
  console.error("Wajib kasih --api=<base url>, contoh: --api=https://semarang-brt.vercel.app");
  process.exit(1);
}
const apiBase = apiArg.slice("--api=".length).replace(/\/$/, "");
const onlyKodes = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()) : null;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  console.log(`Mengambil stops dari ${apiBase}/api/stops ...`);
  const stops = await fetchJson(`${apiBase}/api/stops`);
  fs.writeFileSync(STOPS_CACHE_PATH, JSON.stringify(stops));
  console.log(`  -> ${stops.length} halte diambil, disimpan sementara di shapes/.stops-cache.json`);

  // start_stop_name dari DB (diisi lewat koridor-admin.html) dipakai sebagai
  // FALLBACK buat --start kalau shapes.config.json entry-nya kosong -- biar
  // gak perlu isi nama yang sama di dua tempat yang gampang ke-drift. Kalau
  // shapes.config.json EKSPLISIT ngisi start, itu yang menang (kadang nama
  // buat vertex-matching perlu beda dikit dari yang dipakai runtime, lihat
  // README).
  console.log(`Mengambil koridor dari ${apiBase}/api/koridor ...`);
  let koridorByKode = {};
  try {
    const koridorList = await fetchJson(`${apiBase}/api/koridor`);
    koridorByKode = Object.fromEntries(koridorList.map((k) => [k.kode, k]));
    console.log(`  -> ${koridorList.length} koridor diambil.`);
  } catch (err) {
    console.warn(`  ! Gagal ambil /api/koridor (${err.message}) -- lanjut tanpa fallback --start dari DB.`);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const kodes = Object.keys(config).filter((k) => !k.startsWith("_"));

  const targets = (onlyKodes ? kodes.filter((k) => onlyKodes.includes(k)) : kodes).filter((kode) => {
    const routeFile = path.join(ROUTES_DIR, `${kode}.json`);
    if (!fs.existsSync(routeFile)) {
      console.warn(`  ! Lewati "${kode}": routes/${kode}.json gak ketemu.`);
      return false;
    }
    return true;
  });

  console.log(`\nMemproses ${targets.length} koridor: ${targets.join(", ")}\n`);

  const results = { ok: [], warned: [], failed: [] };

  for (const kode of targets) {
    const cfg = config[kode] || {};
    const routeFile = path.join(ROUTES_DIR, `${kode}.json`);
    const cliArgs = [BUILD_SCRIPT, kode, routeFile, STOPS_CACHE_PATH, routeFile];
    const startName = cfg.start || koridorByKode[kode]?.start_stop_name || null;
    if (startName) cliArgs.push(`--start=${startName}`);
    else console.warn(`  ! "${kode}": gak ada --start (bukan di shapes.config.json, bukan di koridor.start_stop_name juga) -- lanjut tanpa cek arah.`);
    if (cfg.order) cliArgs.push(`--order=${path.join(ROOT, cfg.order)}`);
    if (cfg.patch) cliArgs.push(`--patch=${path.join(ROOT, cfg.patch)}`);
    if (cfg.reverse) cliArgs.push("--reverse");

    console.log(`--- ${kode} ---------------------------------------------`);
    try {
      const output = execFileSync("node", cliArgs, { encoding: "utf-8" });
      process.stdout.write(output);
      if (output.includes("! ")) results.warned.push(kode);
      else results.ok.push(kode);
    } catch (err) {
      // build-route-shapes.js exit(1) -> execFileSync throws; stdout/stderr
      // dari proses anak ada di err.stdout/err.stderr, bukan ke-print otomatis.
      if (err.stdout) process.stdout.write(err.stdout);
      if (err.stderr) process.stderr.write(err.stderr);
      results.failed.push(kode);
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(`OK tanpa warning : ${results.ok.length}  (${results.ok.join(", ") || "-"})`);
  console.log(`OK dengan warning: ${results.warned.length}  (${results.warned.join(", ") || "-"})  <- cek manual, biasanya stop >300m dari garis`);
  console.log(`GAGAL            : ${results.failed.length}  (${results.failed.join(", ") || "-"})  <- WAJIB dibenerin sebelum deploy`);
  console.log("=".repeat(60));

  if (results.failed.length) {
    console.error("\nAda koridor GAGAL -- routes/*.json TIDAK ditulis untuk koridor itu (build-route-shapes.js exit sebelum nulis file kalau ada error fatal). Perbaiki dulu (biasanya butuh --patch atau geometri sumbernya perlu ditrace ulang) sebelum commit.");
    process.exit(1);
  }
  if (results.warned.length) {
    console.warn("\nAda koridor dengan warning (bukan fatal, tapi file TETAP ditulis) -- cek manual sebelum commit, biasanya berarti ada halte yang jauh dari garis rute atau butuh --order.");
  }
}

main().catch((err) => {
  console.error("Gagal jalanin build-all-shapes:", err.message);
  process.exit(1);
});
