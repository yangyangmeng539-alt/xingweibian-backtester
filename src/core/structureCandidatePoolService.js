const { getDailyBarsBySymbols, getCachePath } = require('./localCache');
const { buildMarketStateAnalysis } = require('./marketStateService');
const { loadStockUniverse } = require('../data/stockUniverseService');
const { loadHongKongStockUniverse } = require('../data/hkStockUniverseService');
const { loadCacheIndex } = require('../data/cacheIndexService');

const STRUCTURE_CANDIDATE_POOL_VERSION = 'xwb-structure-candidate-pool-v0';

const CANDIDATE_GROUP_LABELS = {
  STRUCTURE_RESILIENT: '逆势强结构',
  STRUCTURE_REPAIR: '修复候选',
  STRUCTURE_BREAKDOWN_RISK: '破位风险',
  STRUCTURE_MOMENTUM: '强势延续'
};

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 2) {
  const number = safeNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return text.slice(0, 10);
}

function toRequestDate(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

function addCalendarDays(dateText, offsetDays) {
  const normalized = normalizeDate(dateText);
  const date = new Date(`${normalized}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return normalized;
  }

  date.setDate(date.getDate() + Number(offsetDays || 0));

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function normalizeMarket(value) {
  const text = String(value || '').trim().toUpperCase();
  return text === 'HK' || text === 'HKG' ? 'HK' : 'CN_A';
}

function normalizeAshareSymbol(value) {
  const text = String(value || '').trim().toUpperCase();
  const match = text.match(/(\d{6})/);
  return match ? match[1] : '';
}

function normalizeHongKongSymbol(value) {
  const text = String(value || '').trim().toUpperCase();

  if (/^HK:\d{5}$/.test(text)) return text;
  if (/^\d{1,5}$/.test(text)) return `HK:${text.padStart(5, '0')}`;
  if (/^\d{1,5}\.HK$/.test(text)) return `HK:${text.replace(/\.HK$/, '').padStart(5, '0')}`;

  return '';
}

function getBarDate(bar) {
  return normalizeDate(bar && (bar.date || bar.tradeDate || bar.trade_date));
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) return null;

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function getReturnPct(currentClose, previousClose) {
  const current = safeNumber(currentClose);
  const previous = safeNumber(previousClose);

  if (current === null || previous === null || previous <= 0) return null;

  return (current - previous) / previous * 100;
}

function getPctChange(bar, prevBar) {
  const direct = safeNumber(bar && (bar.pctChange !== undefined ? bar.pctChange : bar.pct_change));

  if (direct !== null) return direct;

  return getReturnPct(bar && bar.close, prevBar && prevBar.close);
}

function getActiveValue(bar, market) {
  const amount = safeNumber(bar && bar.amount);

  if (market !== 'HK' && amount !== null && amount > 0) {
    return amount;
  }

  const close = safeNumber(bar && bar.close);
  const volume = safeNumber(bar && bar.volume);

  if (close === null || volume === null || close <= 0 || volume <= 0) {
    return null;
  }

  return close * volume;
}

function getMa(bars, index, days) {
  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, index - size + 1);
  return average(bars.slice(start, index + 1).map((bar) => safeNumber(bar && bar.close)));
}

function getPreviousClose(bars, index, days) {
  const bar = bars[index - Number(days)];
  return safeNumber(bar && bar.close);
}

function getPreviousWindow(bars, index, days) {
  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, index - size);
  return bars.slice(start, index);
}

function getRecentLow(bars, index, days) {
  const lows = getPreviousWindow(bars, index, days)
    .map((bar) => safeNumber(bar && bar.low))
    .filter(Number.isFinite);

  return lows.length ? Math.min(...lows) : null;
}

function getRecentHigh(bars, index, days) {
  const highs = getPreviousWindow(bars, index, days)
    .map((bar) => safeNumber(bar && bar.high))
    .filter(Number.isFinite);

  return highs.length ? Math.max(...highs) : null;
}

function normalizeManualSymbols(symbols, market) {
  const rawList = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(/[,，\s]+/);

  const seen = new Set();
  const result = [];

  for (const item of rawList) {
    const symbol = market === 'HK'
      ? normalizeHongKongSymbol(item)
      : normalizeAshareSymbol(item);

    if (!symbol || seen.has(symbol)) continue;

    seen.add(symbol);
    result.push(symbol);
  }

  return result;
}

function getCacheIndexSymbolsByMarket(market) {
  try {
    const index = loadCacheIndex({ reload: true });
    const items = index && index.items && typeof index.items === 'object'
      ? index.items
      : {};

    return Object.keys(items)
      .filter((symbol) => market === 'HK' ? /^HK:\d{5}$/.test(symbol) : /^\d{6}$/.test(symbol))
      .sort();
  } catch (_error) {
    return [];
  }
}

async function getUniverseByMarket(market, options = {}) {
  const manualSymbols = normalizeManualSymbols(options.symbols, market);

  if (manualSymbols.length) {
    return {
      symbols: manualSymbols,
      namesBySymbol: {},
      universeSource: 'manual',
      sampleMode: 'manual_symbols'
    };
  }

  if (market === 'HK') {
    const universe = loadHongKongStockUniverse();
    const namesBySymbol = {};
    const symbols = Array.from(new Set(
      (Array.isArray(universe && universe.stocks) ? universe.stocks : [])
        .map((stock) => {
          const symbol = normalizeHongKongSymbol(stock && stock.symbol);
          if (symbol) {
            namesBySymbol[symbol] = stock.name || stock.shortName || stock.companyName || '';
          }
          return symbol;
        })
        .filter(Boolean)
    ));

    if (symbols.length) {
      return {
        symbols,
        namesBySymbol,
        universeSource: universe.source || 'hk-stock-universe',
        sampleMode: 'hk_universe'
      };
    }

    const fallback = getCacheIndexSymbolsByMarket('HK');

    return {
      symbols: fallback,
      namesBySymbol: {},
      universeSource: 'cache-index',
      sampleMode: 'cache_index_hk'
    };
  }

  const universe = await loadStockUniverse();
  const namesBySymbol = {};
  const symbols = Array.from(new Set(
    (Array.isArray(universe && universe.stocks) ? universe.stocks : [])
      .filter((stock) => String(stock && stock.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
      .map((stock) => {
        const symbol = normalizeAshareSymbol(stock && stock.symbol);
        if (symbol) {
          namesBySymbol[symbol] = stock.name || stock.shortName || '';
        }
        return symbol;
      })
      .filter(Boolean)
  ));

  if (symbols.length) {
    return {
      symbols,
      namesBySymbol,
      universeSource: universe.source || 'stock-universe',
      sampleMode: 'a_share_universe'
    };
  }

  const fallback = getCacheIndexSymbolsByMarket('CN_A');

  return {
    symbols: fallback,
    namesBySymbol: {},
    universeSource: 'cache-index',
    sampleMode: 'cache_index_a_share'
  };
}

function pickLatestCoveredDate(barsBySymbol, minCount, maxDate = '') {
  const countByDate = new Map();
  const normalizedMaxDate = normalizeDate(maxDate);

  Object.values(barsBySymbol || {}).forEach((bars) => {
    (Array.isArray(bars) ? bars : []).forEach((bar) => {
      const date = getBarDate(bar);

      if (!date) {
        return;
      }

      if (normalizedMaxDate && date > normalizedMaxDate) {
        return;
      }

      countByDate.set(date, (countByDate.get(date) || 0) + 1);
    });
  });

  const dates = Array.from(countByDate.entries())
    .filter(([, count]) => count >= minCount)
    .map(([date]) => date)
    .sort();

  return dates[dates.length - 1] || '';
}

function buildSymbolSnapshot({ symbol, name, bars, targetDate, market }) {
  const list = (Array.isArray(bars) ? bars : [])
    .filter(Boolean)
    .sort((left, right) => String(getBarDate(left)).localeCompare(String(getBarDate(right))));

  const date = normalizeDate(targetDate);
  const index = list.findIndex((bar) => getBarDate(bar) === date);

  if (index < 60) {
    return null;
  }

  const bar = list[index];
  const prevBar = list[index - 1];
  const close = safeNumber(bar.close);

  if (close === null || close <= 0) {
    return null;
  }

  const pctChange = getPctChange(bar, prevBar);
  const return5Pct = getReturnPct(close, getPreviousClose(list, index, 5));
  const return20Pct = getReturnPct(close, getPreviousClose(list, index, 20));
  const return60Pct = getReturnPct(close, getPreviousClose(list, index, 60));
  const ma20 = getMa(list, index, 20);
  const ma60 = getMa(list, index, 60);
  const recentLow20 = getRecentLow(list, index, 20);
  const recentHigh20 = getRecentHigh(list, index, 20);

  const activeValue = getActiveValue(bar, market);
  const activeAvg20 = average(
    getPreviousWindow(list, index, 20)
      .map((item) => getActiveValue(item, market))
      .filter((value) => value !== null)
  );

  const activeRatio = activeValue !== null && activeAvg20 !== null && activeAvg20 > 0
    ? activeValue / activeAvg20
    : null;

  const aboveMa20 = ma20 !== null && close >= ma20;
  const aboveMa60 = ma60 !== null && close >= ma60;
  const belowMa20 = ma20 !== null && close < ma20;
  const belowMa60 = ma60 !== null && close < ma60;
  const nearLow20 = recentLow20 !== null && close <= recentLow20 * 1.015;
  const breakdown = recentLow20 !== null && close <= recentLow20 * 1.005;
  const nearHigh20 = recentHigh20 !== null && close >= recentHigh20 * 0.985;

  const strong = (
    return20Pct !== null
    && return5Pct !== null
    && return20Pct >= 5
    && return5Pct >= -1
    && aboveMa20
  );

  const weak = (
    (return20Pct !== null && return20Pct <= -6)
    || (return5Pct !== null && return5Pct <= -4)
    || (belowMa20 && belowMa60)
  );

  return {
    symbol,
    name: name || '',
    date,
    close,
    pctChange,
    return5Pct,
    return20Pct,
    return60Pct,
    ma20,
    ma60,
    activeRatio,
    flags: {
      aboveMa20,
      aboveMa60,
      belowMa20,
      belowMa60,
      nearLow20,
      breakdown,
      nearHigh20,
      strong,
      weak
    }
  };
}

function getMarketMode(regime) {
  const value = String(regime || '').toUpperCase();

  if (/PANIC|BREAKDOWN|WEAK|RISK/.test(value)) {
    return 'DEFENSIVE';
  }

  if (/STRONG|WARM|REBOUND/.test(value)) {
    return 'OFFENSIVE';
  }

  return 'NEUTRAL';
}

function createCandidate(snapshot, type, score, reasonParts) {
  return {
    type,
    label: CANDIDATE_GROUP_LABELS[type] || type,
    symbol: snapshot.symbol,
    name: snapshot.name,
    date: snapshot.date,
    score: roundNumber(score, 2),
    close: roundNumber(snapshot.close, 3),
    pctChange: roundNumber(snapshot.pctChange, 2),
    return5Pct: roundNumber(snapshot.return5Pct, 2),
    return20Pct: roundNumber(snapshot.return20Pct, 2),
    return60Pct: roundNumber(snapshot.return60Pct, 2),
    activeRatio: roundNumber(snapshot.activeRatio, 3),
    flags: snapshot.flags,
    reason: reasonParts.filter(Boolean).join('；')
  };
}

function buildCandidatesFromSnapshot(snapshot, marketMode) {
  const result = [];
  const active = Number(snapshot.activeRatio) || 1;
  const r5 = Number(snapshot.return5Pct) || 0;
  const r20 = Number(snapshot.return20Pct) || 0;
  const r60 = Number(snapshot.return60Pct) || 0;

  if (
    snapshot.flags.strong
    && snapshot.flags.aboveMa20
    && r20 >= 5
    && r5 >= -1
  ) {
    const score = 45 + r20 * 1.2 + r5 * 1.8 + (active - 1) * 12 + (snapshot.flags.aboveMa60 ? 8 : 0);

    result.push(createCandidate(snapshot, 'STRUCTURE_RESILIENT', score, [
      '市场弱势下仍保持相对强结构',
      `20日 ${roundNumber(r20)}%`,
      `5日 ${roundNumber(r5)}%`,
      snapshot.flags.aboveMa60 ? '站上MA60' : '站上MA20'
    ]));
  }

  if (
    r20 <= -6
    && r5 >= 0.8
    && (
      snapshot.flags.aboveMa20
      || active >= 1.08
      || !snapshot.flags.nearLow20
    )
  ) {
    const score = 36 + r5 * 2.4 + Math.max(0, active - 1) * 18 + Math.min(20, Math.abs(r20));

    result.push(createCandidate(snapshot, 'STRUCTURE_REPAIR', score, [
      '前期弱势后出现修复',
      `20日 ${roundNumber(r20)}%`,
      `5日 ${roundNumber(r5)}%`,
      active >= 1.08 ? `活跃 ${roundNumber(active, 2)}x` : ''
    ]));
  }

  if (
    snapshot.flags.breakdown
    || (
      snapshot.flags.weak
      && snapshot.flags.belowMa20
      && r20 <= -8
    )
  ) {
    const score = 40 + Math.abs(Math.min(0, r20)) * 1.6 + Math.abs(Math.min(0, r5)) * 1.8 + (snapshot.flags.belowMa60 ? 12 : 0);

    result.push(createCandidate(snapshot, 'STRUCTURE_BREAKDOWN_RISK', score, [
      snapshot.flags.breakdown ? '接近/跌破20日低位' : '弱势延续',
      snapshot.flags.belowMa20 ? '低于MA20' : '',
      snapshot.flags.belowMa60 ? '低于MA60' : '',
      `20日 ${roundNumber(r20)}%`
    ]));
  }

  if (
    marketMode !== 'DEFENSIVE'
    && snapshot.flags.nearHigh20
    && r20 >= 8
    && r5 >= 0
    && active >= 0.9
  ) {
    const score = 42 + r20 * 1.1 + r5 * 1.5 + (active - 1) * 10;

    result.push(createCandidate(snapshot, 'STRUCTURE_MOMENTUM', score, [
      '接近20日高位',
      `20日 ${roundNumber(r20)}%`,
      `活跃 ${roundNumber(active, 2)}x`
    ]));
  }

  return result;
}

function sortCandidates(items) {
  return items
    .slice()
    .sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
      return String(left.symbol).localeCompare(String(right.symbol));
    });
}

async function runStructureCandidatePool(payload = {}) {
  const input = payload || {};
  const market = normalizeMarket(input.market);
  const universe = await getUniverseByMarket(market, input);

  if (!universe.symbols.length) {
    return {
      version: STRUCTURE_CANDIDATE_POOL_VERSION,
      ok: false,
      market,
      reason: 'EMPTY_MARKET_UNIVERSE'
    };
  }

  const requestedDate = normalizeDate(input.date || input.clickedDate || input.selectedNodeDate || '');
  const queryEndDate = normalizeDate(input.endDate || requestedDate || '');
  const endDate = queryEndDate || normalizeDate(new Date().toISOString().slice(0, 10));
  const lookbackCalendarDays = Math.max(130, Math.min(520, Number(input.lookbackCalendarDays) || 260));
  const startDate = normalizeDate(input.startDate || addCalendarDays(endDate, -lookbackCalendarDays));
  const requestedPerGroupLimit = Number(input.perGroupLimit);
  const perGroupLimit = Number.isFinite(requestedPerGroupLimit) && requestedPerGroupLimit > 0
    ? Math.floor(requestedPerGroupLimit)
    : 999999;

  const batchResult = await getDailyBarsBySymbols(
    universe.symbols,
    toRequestDate(startDate),
    toRequestDate(endDate)
  );

  const barsBySymbol = batchResult.barsBySymbol || {};
  const minCoveredCount = Math.max(5, Math.ceil(universe.symbols.length * 0.25));
  const targetDate = pickLatestCoveredDate(
    barsBySymbol,
    minCoveredCount,
    requestedDate || endDate
  ) || requestedDate;

  const marketState = buildMarketStateAnalysis({
    market,
    date: targetDate,
    barsBySymbol
  });

  const marketMode = getMarketMode(marketState && marketState.regime);
  const allCandidates = [];
  let snapshotCount = 0;

  for (const symbol of universe.symbols) {
    const snapshot = buildSymbolSnapshot({
      symbol,
      name: universe.namesBySymbol[symbol] || '',
      bars: barsBySymbol[symbol],
      targetDate,
      market
    });

    if (!snapshot) continue;

    snapshotCount += 1;
    allCandidates.push(...buildCandidatesFromSnapshot(snapshot, marketMode));
  }

  const grouped = Object.keys(CANDIDATE_GROUP_LABELS).map((type) => {
    const items = sortCandidates(allCandidates.filter((item) => item.type === type)).slice(0, perGroupLimit);

    return {
      type,
      label: CANDIDATE_GROUP_LABELS[type],
      count: allCandidates.filter((item) => item.type === type).length,
      items
    };
  });

  const visibleGroups = marketMode === 'DEFENSIVE'
    ? ['STRUCTURE_RESILIENT', 'STRUCTURE_REPAIR', 'STRUCTURE_BREAKDOWN_RISK', 'STRUCTURE_MOMENTUM']
    : ['STRUCTURE_MOMENTUM', 'STRUCTURE_RESILIENT', 'STRUCTURE_REPAIR', 'STRUCTURE_BREAKDOWN_RISK'];

  grouped.sort((left, right) => visibleGroups.indexOf(left.type) - visibleGroups.indexOf(right.type));

  return {
    version: STRUCTURE_CANDIDATE_POOL_VERSION,
    ok: true,
    market,
    date: targetDate,
    queryStartDate: startDate,
    queryEndDate: endDate,
    marketMode,
    marketState: marketState && marketState.ok ? {
      regime: marketState.regime,
      label: marketState.label,
      score: marketState.score,
      summaryText: marketState.summaryText
    } : null,
    sampleMode: universe.sampleMode,
    universeSource: universe.universeSource,
    universeCount: universe.symbols.length,
    symbolCount: universe.symbols.length,
    sampleCount: snapshotCount,
    candidateCount: allCandidates.length,
    perGroupLimit,
    cachePath: getCachePath(),
    batch: {
      rowCount: batchResult.rowCount || 0,
      backend: batchResult.backend || ''
    },
    groups: grouped,
    summaryText: `${market}结构候选池：${marketMode}｜样本 ${snapshotCount}/${universe.symbols.length}｜候选 ${allCandidates.length}`
  };
}

module.exports = {
  STRUCTURE_CANDIDATE_POOL_VERSION,
  CANDIDATE_GROUP_LABELS,
  runStructureCandidatePool
};