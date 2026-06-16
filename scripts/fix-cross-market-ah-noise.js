const fs = require('fs');
const path = require('path');

const relationPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-relation.seed.json');

if (!fs.existsSync(relationPath)) {
  throw new Error(`缺少文件：${relationPath}`);
}

const seed = JSON.parse(fs.readFileSync(relationPath, 'utf8'));

const ahPairNames = {
  'HK:02318': '中国平安',
  '601318': '中国平安',
  'HK:03968': '招商银行',
  '600036': '招商银行',
  'HK:01398': '工商银行',
  '601398': '工商银行',
  'HK:00939': '建设银行',
  '601939': '建设银行',
  'HK:02628': '中国人寿',
  '601628': '中国人寿',
  'HK:02359': '药明康德',
  '603259': '药明康德',
  'HK:06160': '百济神州',
  '688235': '百济神州',
  'HK:00728': '中国电信',
  '601728': '中国电信',
  'HK:00941': '中国移动',
  '600941': '中国移动',
  'HK:00762': '中国联通',
  '600050': '中国联通',
  'HK:00883': '中国海油',
  '600938': '中国海油',
  'HK:00857': '中国石油',
  '601857': '中国石油',
  'HK:00386': '中国石化',
  '600028': '中国石化',
  'HK:02202': '万科',
  '000002': '万科'
};

function dedupePlateEast(item) {
  const plateEast = Array.isArray(item.plateEast) ? item.plateEast : [];
  const seen = new Set();
  const result = [];

  for (const plate of plateEast) {
    const name = String(plate && plate.plate_name || '').trim();

    if (!name) {
      continue;
    }

    if (name === 'A+H') {
      continue;
    }

    const key = `${String(plate.plate_type || '').trim()}:${name}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(plate);
  }

  const pairName = ahPairNames[item.code];

  if (pairName) {
    const mapName = `A+H映射：${pairName}`;
    const key = `概念:${mapName}`;

    if (!seen.has(key)) {
      result.push({
        plate_code: mapName,
        plate_name: mapName,
        plate_type: '概念',
        source: '跨市场seed'
      });
    }
  }

  return result;
}

for (const item of Object.values(seed.items || {})) {
  item.plateEast = dedupePlateEast(item);

  if (Array.isArray(item.concepts)) {
    item.concepts = item.concepts.filter((name) => String(name).trim() !== 'A+H');
  }
}

seed.generatedAt = new Date().toISOString();
seed.description = `${seed.description || ''}｜已清理泛 A+H 概念，改为公司级 A+H 映射关系。`;

fs.writeFileSync(relationPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

console.log('已清理 cross-market-relation.seed.json');
console.log('当前节点数:', Object.keys(seed.items || {}).length);
