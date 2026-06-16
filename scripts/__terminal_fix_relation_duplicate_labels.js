const fs = require('fs');
const path = require('path');

const relationPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-relation.seed.json');
const relation = JSON.parse(fs.readFileSync(relationPath, 'utf8'));

const canonicalTypes = {
  '互联网平台': '行业',
  '本地生活平台': '行业',
  '半导体基础设施': '行业',

  '人工智能': '概念',
  '云计算': '概念',
  '游戏': '概念',
  '内容平台': '概念',
  '电商平台': '概念',
  '本地生活': '概念',
  '数字广告': '概念',
  '数字经济': '概念',
  '算力网络': '概念',
  '智能终端': '概念',
  '自动驾驶': '概念',
  '供应链物流': '概念',
  '即时零售': '概念',
  '直播电商': '概念'
};

let touchedItems = 0;
let changedPlates = 0;
let removedDuplicates = 0;

for (const item of Object.values(relation.items || {})) {
  if (!item || !Array.isArray(item.plateEast)) {
    continue;
  }

  let touched = false;

  item.plateEast = item.plateEast.map((plate) => {
    const name = String(plate && plate.plate_name || '').trim();
    const canonicalType = canonicalTypes[name];

    if (canonicalType && String(plate.plate_type || '').trim() !== canonicalType) {
      changedPlates += 1;
      touched = true;
      return {
        ...plate,
        plate_type: canonicalType
      };
    }

    return plate;
  });

  const seen = new Set();
  const next = [];

  for (const plate of item.plateEast) {
    const type = String(plate && plate.plate_type || '').trim();
    const name = String(plate && plate.plate_name || '').trim();

    if (!type || !name) {
      removedDuplicates += 1;
      touched = true;
      continue;
    }

    const key = `${type}:${name}`;

    if (seen.has(key)) {
      removedDuplicates += 1;
      touched = true;
      continue;
    }

    seen.add(key);
    next.push({
      ...plate,
      plate_code: plate.plate_code || name,
      plate_name: name,
      plate_type: type
    });
  }

  item.plateEast = next;

  if (touched) {
    touchedItems += 1;
    item.updatedAt = new Date().toISOString();
  }
}

relation.generatedAt = new Date().toISOString();
relation.total = Object.keys(relation.items || {}).length;
relation.done = Object.values(relation.items || {}).filter(x => x && x.status === 'DONE').length;
relation.failed = Object.values(relation.items || {}).filter(x => x && x.status === 'FAILED').length;

fs.writeFileSync(relationPath, JSON.stringify(relation, null, 2) + '\n', 'utf8');

console.log('[OK] 关系图重复 label 类型已统一');
console.log({ touchedItems, changedPlates, removedDuplicates, total: relation.total });
