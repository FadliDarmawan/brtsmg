// lib/db.js
//
// Pool di-cache di module scope supaya warm invocation Vercel function
// reuse koneksi yang sama, bukan bikin koneksi baru tiap request.
// Neon connection string HARUS yang varian pooled (host ...-pooler.neon.tech)
// kalau function-nya bisa concurrent -- kalau belum pooled dan traffic naik,
// ganti pakai @neondatabase/serverless (driver HTTP, gak butuh TCP pool sama sekali).

const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon selalu butuh SSL
      max: 5, // serverless function tunggal gak butuh pool gede
    });
  }
  return pool;
}

/**
 * Jalanin `fn(client)` di dalam satu transaction. Auto rollback kalau fn throw.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, withTransaction };
