const RAPID_CHANGE_ANALYSIS_VERSION = 'rapid-change-v1.0.0';

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value, digits = 2) {
  const number = toNumber(value);

  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : '-';
}

function getClose(bar) {
  return toNumber(bar && bar.close);
}

function getReturnPctFromBars(bars, clickedIndex, day) {
  const offset = Number(day);

  if (!Array.isArray(bars) || !Number.isInteger(clickedIndex) || !Number.isFinite(offset)) {
    return null;
  }

  const currentClose = getClose(bars[clickedIndex]);
  const futureClose = getClose(bars[clickedIndex + offset]);

  if (!Number.isFinite(currentClose) || !Number.isFinite(futureClose) || currentClose <= 0) {
    return null;
  }

  return (futureClose / currentClose - 1) * 100;
}

function buildPathExtremeFromBars(bars, clickedIndex, forecastDays) {
  const days = Math.max(1, Number(forecastDays || 20));

  if (!Array.isArray(bars) || !Number.isInteger(clickedIndex)) {
    return {
      maxUpPct: null,
      maxUpDay: null,
      maxDownPct: null,
      maxDownDay: null
    };
  }

  const currentClose = getClose(bars[clickedIndex]);

  if (!Number.isFinite(currentClose) || currentClose <= 0) {
    return {
      maxUpPct: null,
      maxUpDay: null,
      maxDownPct: null,
      maxDownDay: null
    };
  }

  let maxUpPct = null;
  let maxUpDay = null;
  let maxDownPct = null;
  let maxDownDay = null;

  for (let day = 1; day <= days; day += 1) {
    const futureClose = getClose(bars[clickedIndex + day]);

    if (!Number.isFinite(futureClose)) {
      continue;
    }

    const returnPct = (futureClose / currentClose - 1) * 100;

    if (!Number.isFinite(maxUpPct) || returnPct > maxUpPct) {
      maxUpPct = returnPct;
      maxUpDay = day;
    }

    if (!Number.isFinite(maxDownPct) || returnPct < maxDownPct) {
      maxDownPct = returnPct;
      maxDownDay = day;
    }
  }

  return {
    maxUpPct,
    maxUpDay,
    maxDownPct,
    maxDownDay
  };
}

function classifyRapidChange(metrics) {
  const d3 = toNumber(metrics && metrics.d3ReturnPct);
  const d5 = toNumber(metrics && metrics.d5ReturnPct);
  const d10 = toNumber(metrics && metrics.d10ReturnPct);
  const d20 = toNumber(metrics && metrics.d20ReturnPct);
  const maxUp = toNumber(metrics && metrics.maxUpPct);
  const maxDown = toNumber(metrics && metrics.maxDownPct);

  const hasD3 = Number.isFinite(d3);
  const hasD5 = Number.isFinite(d5);
  const hasD10 = Number.isFinite(d10);
  const hasD20 = Number.isFinite(d20);

  if (!hasD3 && !hasD5 && !hasD10 && !hasD20) {
    return {
      rapidType: 'NO_ACTUAL_PATH',
      rapidTitle: '无真实路径',
      rapidSignal: 'unknown',
      rapidScore: 0
    };
  }

  if (hasD3 && hasD5 && hasD20 && d3 >= 3 && d5 >= 5 && d20 < 0) {
    return {
      rapidType: 'FAST_TAKE_PROFIT_DECAY',
      rapidTitle: '急拉后回落',
      rapidSignal: 'take_profit',
      rapidScore: 5
    };
  }

  if (hasD3 && hasD5 && hasD10 && d3 <= -3 && d5 <= -5 && d10 <= -5) {
    return {
      rapidType: 'FAST_BREAKDOWN',
      rapidTitle: '急杀确认',
      rapidSignal: 'danger',
      rapidScore: -5
    };
  }

  if (hasD3 && hasD5 && hasD20 && d3 <= -3 && d5 <= -3 && d20 > 3) {
    return {
      rapidType: 'KILL_THEN_REPAIR',
      rapidTitle: '先杀后修',
      rapidSignal: 'repair',
      rapidScore: 4
    };
  }

  if (Number.isFinite(maxUp) && hasD20 && maxUp >= 6 && d20 <= 1) {
    return {
      rapidType: 'INTRADAY_WINDOW_ONLY',
      rapidTitle: '窗口短促',
      rapidSignal: 'short_window',
      rapidScore: 3
    };
  }

  if (hasD3 && hasD5 && hasD10 && hasD20 && d3 > 0 && d5 > 0 && d10 > 0 && d20 > 0) {
    return {
      rapidType: 'FAST_TREND_EXTEND',
      rapidTitle: '急启延续',
      rapidSignal: 'trend',
      rapidScore: 5
    };
  }

  if (hasD3 && hasD5 && hasD10 && hasD20 && d3 < 0 && d5 < 0 && d10 < 0 && d20 < 0) {
    return {
      rapidType: 'SLOW_BLEED',
      rapidTitle: '持续走弱',
      rapidSignal: 'danger',
      rapidScore: -4
    };
  }

  if (
    hasD3
    && hasD5
    && hasD10
    && hasD20
    && Math.abs(d3) <= 1.5
    && Math.abs(d5) <= 2.5
    && d10 > 0
    && d20 > 3
  ) {
    return {
      rapidType: 'SLOW_START_EXTEND',
      rapidTitle: '慢启动延续',
      rapidSignal: 'trend',
      rapidScore: 4
    };
  }

  if (hasD3 && hasD5 && hasD10 && hasD20 && d3 > 0 && d5 > 0 && d10 < 0 && d20 < 0) {
    return {
      rapidType: 'REBOUND_DECAY',
      rapidTitle: '反抽衰减',
      rapidSignal: 'decay',
      rapidScore: -2
    };
  }

  if (hasD3 && d3 >= 3) {
    return {
      rapidType: 'D3_FAST_UP',
      rapidTitle: 'D3急拉',
      rapidSignal: 'fast_up',
      rapidScore: 2
    };
  }

  if (hasD3 && d3 <= -3) {
    return {
      rapidType: 'D3_FAST_DOWN',
      rapidTitle: 'D3急杀',
      rapidSignal: 'fast_down',
      rapidScore: -2
    };
  }

  return {
    rapidType: 'NORMAL_DRIFT',
    rapidTitle: '普通漂移',
    rapidSignal: 'neutral',
    rapidScore: 0
  };
}

function buildRapidSummaryText(analysis) {
  if (!analysis || !analysis.ok) {
    return '该节点暂无足够未来路径用于急变观察。';
  }

  const type = analysis.rapidType;
  const d3 = formatPct(analysis.d3ReturnPct);
  const d5 = formatPct(analysis.d5ReturnPct);
  const d10 = formatPct(analysis.d10ReturnPct);
  const d20 = formatPct(analysis.d20ReturnPct);

  if (type === 'FAST_TREND_EXTEND') {
    return `急变类型：急启延续。T+3 ${d3}，T+5 ${d5}，T+10 ${d10}，T+20 ${d20}，短线启动后继续扩散。`;
  }

  if (type === 'FAST_BREAKDOWN') {
    return `急变类型：急杀确认。T+3 ${d3}，T+5 ${d5}，T+10 ${d10}，短线快速转弱并延续。`;
  }

  if (type === 'FAST_TAKE_PROFIT_DECAY') {
    return `急变类型：急拉后回落。T+3 ${d3}，T+5 ${d5}，但 T+20 ${d20}，更像短线兑现窗口。`;
  }

  if (type === 'INTRADAY_WINDOW_ONLY') {
    return `急变类型：窗口短促。过程最大上冲 ${formatPct(analysis.maxUpPct)}，但 T+20 ${d20}，机会窗口偏短。`;
  }

  if (type === 'KILL_THEN_REPAIR') {
    return `急变类型：先杀后修。T+3 ${d3}，T+5 ${d5}，但 T+20 ${d20}，属于先抑后修复路径。`;
  }

  if (type === 'SLOW_BLEED') {
    return `急变类型：持续走弱。T+3 ${d3}，T+5 ${d5}，T+20 ${d20}，弱势没有快速修复。`;
  }

  if (type === 'SLOW_START_EXTEND') {
    return `急变类型：慢启动延续。T+3 ${d3}，T+5 ${d5}，T+20 ${d20}，短线不急但后段走强。`;
  }

  if (type === 'REBOUND_DECAY') {
    return `急变类型：反抽衰减。T+3/T+5 有反应，但 T+10/T+20 转弱，偏反抽兑现。`;
  }

  if (type === 'D3_FAST_UP') {
    return `急变类型：D3急拉。T+3 ${d3}，短线启动很快，需要继续看 T+5/T+10 是否延续。`;
  }

  if (type === 'D3_FAST_DOWN') {
    return `急变类型：D3急杀。T+3 ${d3}，短线风险快速出现，需要观察是否修复。`;
  }

  return `急变类型：普通漂移。T+3 ${d3}，T+5 ${d5}，T+10 ${d10}，T+20 ${d20}，未出现明确急拉或急杀。`;
}

function buildRapidChangeAnalysisFromBars(options) {
  const input = options || {};
  const bars = Array.isArray(input.bars) ? input.bars : [];
  const clickedIndex = Number(input.clickedIndex);
  const forecastDays = Number(input.forecastDays || 20);

  const d3ReturnPct = getReturnPctFromBars(bars, clickedIndex, 3);
  const d5ReturnPct = getReturnPctFromBars(bars, clickedIndex, 5);
  const d10ReturnPct = getReturnPctFromBars(bars, clickedIndex, 10);
  const d20ReturnPct = getReturnPctFromBars(bars, clickedIndex, 20);

  const extreme = buildPathExtremeFromBars(bars, clickedIndex, forecastDays);

  const classified = classifyRapidChange({
    d3ReturnPct,
    d5ReturnPct,
    d10ReturnPct,
    d20ReturnPct,
    maxUpPct: extreme.maxUpPct,
    maxDownPct: extreme.maxDownPct
  });

  const ok = Number.isFinite(toNumber(d3ReturnPct))
    || Number.isFinite(toNumber(d5ReturnPct))
    || Number.isFinite(toNumber(d10ReturnPct))
    || Number.isFinite(toNumber(d20ReturnPct));

  const analysis = {
    version: RAPID_CHANGE_ANALYSIS_VERSION,
    ok,
    ...classified,
    d3ReturnPct,
    d5ReturnPct,
    d10ReturnPct,
    d20ReturnPct,
    maxUpPct: extreme.maxUpPct,
    maxUpDay: extreme.maxUpDay,
    maxDownPct: extreme.maxDownPct,
    maxDownDay: extreme.maxDownDay
  };

  return {
    ...analysis,
    summaryText: buildRapidSummaryText(analysis)
  };
}

module.exports = {
  RAPID_CHANGE_ANALYSIS_VERSION,
  toNumber,
  formatPct,
  getReturnPctFromBars,
  buildPathExtremeFromBars,
  classifyRapidChange,
  buildRapidChangeAnalysisFromBars
};