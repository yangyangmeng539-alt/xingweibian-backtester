const Database = require('better-sqlite3');

const db = new Database('./data/cache/ashare-cache.sqlite');

console.log('\n=== TABLES ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables);

for (const row of tables) {
  const table = row.name;
  console.log(`\n=== ${table} columns ===`);
  console.log(db.prepare(`PRAGMA table_info(${table})`).all());

  console.log(`\n=== ${table} sample ===`);
  try {
    console.log(db.prepare(`SELECT * FROM ${table} LIMIT 3`).all());
  } catch (error) {
    console.log('sample failed:', error.message);
  }
}

db.close();
