const fs = require('fs');
const { TextDecoder } = require('util');
const { upsertDailyBars, getCachePath } = require('../core/localCache');

const FIELD_ALIASES = {
  date: ['date', 'trade_date', '日期'],
  open: ['open', '开盘'],
  close: ['close', '收盘'],
  high: ['high', '最高'],
  low: ['low', '最低'],
  volume: ['volume', 'vol', '成交量'],
  amount: ['amount', '成交额'],
  amplitude: ['amplitude', '振幅'],
  pctChange: ['pctChange', 'pct_change', '涨跌幅'],
  changeAmount: ['changeAmount', 'change_amount', '涨跌额'],
  turnover: ['turnover', '换手率']
};

const REQUIRED_FIELDS = ['date', 'open', 'close', 'high', 'low', 'volume'];

function normalizeSymbol(symbol) {
  const clean = String(symbol || '').trim();

  if (!/^\d{6}$/.test(clean)) {
    throw new Error(`请输入 6 位 A 股代码，例如 600519。当前输入：${symbol}`);
  }

  return clean;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((items) => items.some((item) => String(item || '').trim() !== ''));
}

function normalizeHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim();
}

function buildFieldIndex(headers) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const fieldIndex = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = normalizedHeaders.findIndex((header) => {
      return aliases.some((alias) => header.toLowerCase() === alias.toLowerCase());
    });

    if (index >= 0) {
      fieldIndex[field] = index;
    }
  }

  return fieldIndex;
}

function getCell(row, fieldIndex, field) {
  const index = fieldIndex[field];

  if (!Number.isInteger(index)) {
    return '';
  }

  return row[index];
}

function toFloat(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');

  if (!text || text === '-' || text.toLowerCase() === 'nan') {
    return null;
  }

  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    const parts = text.split('-');
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }

  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(text)) {
    const parts = text.split('/');
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }

  return text.slice(0, 10);
}

function validateHeaders(fieldIndex) {
  const missing = REQUIRED_FIELDS.filter((field) => !Number.isInteger(fieldIndex[field]));

  if (missing.length > 0) {
    throw new Error(`CSV 缺少必要字段：${missing.join(', ')}`);
  }
}

function parseDailyBarsFromCsv(csvText) {
  const rows = parseCsv(csvText);

  if (rows.length < 2) {
    throw new Error('CSV 至少需要包含表头和一行历史日线。');
  }

  const fieldIndex = buildFieldIndex(rows[0]);
  validateHeaders(fieldIndex);

  return rows.slice(1).map((row) => ({
    date: normalizeDate(getCell(row, fieldIndex, 'date')),
    open: toFloat(getCell(row, fieldIndex, 'open')),
    close: toFloat(getCell(row, fieldIndex, 'close')),
    high: toFloat(getCell(row, fieldIndex, 'high')),
    low: toFloat(getCell(row, fieldIndex, 'low')),
    volume: toFloat(getCell(row, fieldIndex, 'volume')),
    amount: toFloat(getCell(row, fieldIndex, 'amount')),
    amplitude: toFloat(getCell(row, fieldIndex, 'amplitude')),
    pctChange: toFloat(getCell(row, fieldIndex, 'pctChange')),
    changeAmount: toFloat(getCell(row, fieldIndex, 'changeAmount')),
    turnover: toFloat(getCell(row, fieldIndex, 'turnover'))
  })).filter((bar) => {
    return (
      bar.date &&
      Number.isFinite(Number(bar.open)) &&
      Number.isFinite(Number(bar.close)) &&
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)) &&
      Number.isFinite(Number(bar.volume))
    );
  });
}

function decodeCsvBuffer(buffer) {
  const utf8Text = buffer.toString('utf8');

  try {
    parseDailyBarsFromCsv(utf8Text);
    return utf8Text;
  } catch (error) {
    if (!/CSV 缺少必要字段/.test(error.message)) {
      return utf8Text;
    }
  }

  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch (_error) {
    return utf8Text;
  }
}

async function importCsvDailyBars(symbol, csvPath) {
  const cleanSymbol = normalizeSymbol(symbol);
  const cleanPath = String(csvPath || '').trim();

  if (!cleanPath) {
    throw new Error('请选择 CSV 文件。');
  }

  const text = decodeCsvBuffer(fs.readFileSync(cleanPath));
  const bars = parseDailyBarsFromCsv(text);

  if (bars.length === 0) {
    throw new Error('CSV 中没有可导入的历史日线。');
  }

  const result = await upsertDailyBars(cleanSymbol, bars);

  return {
    ok: true,
    symbol: cleanSymbol,
    count: result.inserted,
    cachePath: result.cachePath || getCachePath()
  };
}

module.exports = {
  importCsvDailyBars,
  parseDailyBarsFromCsv
};
