const fs = require('fs');
const path = require('path');

const relationPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-relation.seed.json');
const relation = JSON.parse(fs.readFileSync(relationPath, 'utf8'));

let changed = 0;
let removed = 0;

for (const item of Object.values(relation.items || {})) {
  if (!item || !Array.isArray(item.plateEast)) continue;

  item.plateEast.forEach((plate) => {
    if (String(plate.plate_name || '').trim() === '电商') {
      plate.plate_name = '电商平台';
      plate.plate_code = '电商平台';
      plate.plate_type = '概念';
      changed += 1;
    }
  });

  const seen = new Set();
  item.plateEast = item.plateEast.filter((plate) => {
    const type = String(plate.plate_type || '').trim();
    const name = String(plate.plate_name || '').trim();
    const key = `${type}:${name}`;

    if (!type || !name || seen.has(key)) {
      removed += 1;
      return false;
    }

    seen.add(key);
    return true;
  });
}

relation.generatedAt = new Date().toISOString();
fs.writeFileSync(relationPath, JSON.stringify(relation, null, 2) + '\n', 'utf8');

console.log('[OK] 已统一 电商 -> 电商平台');
console.log({ changed, removed });
