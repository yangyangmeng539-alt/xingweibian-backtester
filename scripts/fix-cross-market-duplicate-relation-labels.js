const fs = require('fs');
const path = require('path');

const relationPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-relation.seed.json');

if (!fs.existsSync(relationPath)) {
  throw new Error(`缺少文件：${relationPath}`);
}

const seed = JSON.parse(fs.readFileSync(relationPath, 'utf8'));

for (const item of Object.values(seed.items || {})) {
  const plateEast = Array.isArray(item.plateEast) ? item.plateEast : [];
  const industryNames = new Set(
    plateEast
      .filter((plate) => String(plate && plate.plate_type || '').trim() === '行业')
      .map((plate) => String(plate && plate.plate_name || '').trim())
      .filter(Boolean)
  );

  const seen = new Set();
  const cleaned = [];

  for (const plate of plateEast) {
    const name = String(plate && plate.plate_name || '').trim();
    const type = String(plate && plate.plate_type || '').trim();

    if (!name) {
      continue;
    }

    if (type === '概念' && industryNames.has(name)) {
      continue;
    }

    const key = `${type}:${name}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    cleaned.push(plate);
  }

  item.plateEast = cleaned;
}

seed.generatedAt = new Date().toISOString();
seed.description = `${seed.description || ''}｜已清理行业/概念同名重复节点。`;

fs.writeFileSync(relationPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

console.log('已清理行业/概念同名重复节点');
console.log('当前节点数:', Object.keys(seed.items || {}).length);
