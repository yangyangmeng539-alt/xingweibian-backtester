const fs = require('fs');
const path = require('path');

const relationPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-relation.seed.json');

if (!fs.existsSync(relationPath)) {
  throw new Error(`缺少文件：${relationPath}`);
}

const seed = JSON.parse(fs.readFileSync(relationPath, 'utf8'));

const ahPairs = [
  ['HK:02318', '601318', '中国平安'],
  ['HK:03968', '600036', '招商银行'],
  ['HK:01398', '601398', '工商银行'],
  ['HK:00939', '601939', '建设银行'],
  ['HK:02628', '601628', '中国人寿'],
  ['HK:02359', '603259', '药明康德'],
  ['HK:06160', '688235', '百济神州'],
  ['HK:00728', '601728', '中国电信'],
  ['HK:00941', '600941', '中国移动'],
  ['HK:00762', '600050', '中国联通'],
  ['HK:00883', '600938', '中国海油'],
  ['HK:00857', '601857', '中国石油'],
  ['HK:00386', '600028', '中国石化'],
  ['HK:02202', '000002', '万科'],
  ['HK:06030', '600030', '中信证券'],
  ['HK:03908', '601995', '中金公司'],
  ['HK:06066', '601066', '中信建投'],
  ['HK:06886', '601688', '华泰证券'],
  ['HK:01776', '000776', '广发证券'],
  ['HK:06837', '600837', '海通证券'],
  ['HK:02333', '601633', '长城汽车'],
  ['HK:02238', '601238', '广汽集团'],
  ['HK:01772', '002460', '赣锋锂业'],
  ['HK:09696', '002466', '天齐锂业'],
  ['HK:00390', '601390', '中国中铁'],
  ['HK:01186', '601186', '中国铁建'],
  ['HK:01800', '601800', '中国交建'],
  ['HK:01766', '601766', '中国中车'],
  ['HK:00902', '600011', '华能国际'],
  ['HK:00991', '601991', '大唐发电'],
  ['HK:00916', '001289', '龙源电力'],
  ['HK:01088', '601088', '中国神华'],
  ['HK:01171', '600188', '兖矿能源'],
  ['HK:02899', '601899', '紫金矿业'],
  ['HK:03993', '603993', '洛阳钼业'],
  ['HK:00358', '600362', '江西铜业'],
  ['HK:02600', '601600', '中国铝业'],
  ['HK:01787', '600547', '山东黄金'],
  ['HK:02196', '600196', '复星医药'],
  ['HK:03759', '300759', '康龙化成'],
  ['HK:03347', '300347', '泰格医药'],
  ['HK:06690', '600690', '海尔智家'],
  ['HK:01919', '601919', '中远海控'],
  ['HK:01138', '600026', '中远海能'],
  ['HK:01385', '688385', '上海复旦'],
  ['HK:00763', '000063', '中兴通讯']
];

function ensurePlate(item, name, type = '概念') {
  item.plateEast = Array.isArray(item.plateEast) ? item.plateEast : [];

  const exists = item.plateEast.some((plate) => {
    return String(plate && plate.plate_name || '').trim() === name
      && String(plate && plate.plate_type || '').trim() === type;
  });

  if (!exists) {
    item.plateEast.push({
      plate_code: name,
      plate_name: name,
      plate_type: type,
      source: '跨市场seed'
    });
  }
}

function removeGenericAh(item) {
  item.plateEast = Array.isArray(item.plateEast) ? item.plateEast : [];

  item.plateEast = item.plateEast.filter((plate) => {
    return String(plate && plate.plate_name || '').trim() !== 'A+H';
  });
}

function dedupe(item) {
  item.plateEast = Array.isArray(item.plateEast) ? item.plateEast : [];
  const seen = new Set();
  const result = [];

  for (const plate of item.plateEast) {
    const name = String(plate && plate.plate_name || '').trim();
    const type = String(plate && plate.plate_type || '').trim();

    if (!name || !type) {
      continue;
    }

    const key = `${type}:${name}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(plate);
  }

  item.plateEast = result;
}

for (const [hkCode, aCode, pairName] of ahPairs) {
  const mapName = `A+H映射：${pairName}`;

  for (const code of [hkCode, aCode]) {
    const item = seed.items && seed.items[code];

    if (!item) {
      console.log('缺少 A+H 节点，跳过:', code, pairName);
      continue;
    }

    removeGenericAh(item);
    ensurePlate(item, mapName, '概念');
    dedupe(item);
  }
}

seed.generatedAt = new Date().toISOString();
seed.description = `${seed.description || ''}｜已强制补齐公司级 A+H 映射。`;

fs.writeFileSync(relationPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

console.log('已强制补齐 A+H 映射:', ahPairs.length);
console.log('当前关系节点数:', Object.keys(seed.items || {}).length);
