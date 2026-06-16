'use strict';

const {
  isObservationStrongPoint,
  getObservationMatrixPointAtOffset
} = require('./nodeStructurePredictionService');

function safeNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!list.length) {
    return null;
  }

  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) {
    return null;
  }

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function pctReturn(fromClose, toClose) {
  const from = Number(fromClose);
  const to = Number(toClose);

  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) {
    return null;
  }

  return ((to - from) / from) * 100;
}

function normalizeRowSources(row) {
  return Array.isArray(row && row.sources) ? row.sources.map(String) : [];
}

function normalizeRowLayers(row) {
  return Array.isArray(row && row.layers) ? row.layers : [];
}

function isRelationRow(row) {
  return normalizeRowSources(row).some((source) => source.includes('relation'));
}

function isSupplyChainRow(row) {
  return normalizeRowSources(row).some((source) => source.includes('supply_chain'))
    || normalizeRowLayers(row).length > 0;
}

function getCloseAtOffset(timeline, offset) {
  const point = getObservationMatrixPointAtOffset(timeline, offset);
  const close = safeNumber(point && point.close);

  return close;
}

function getReturnBetweenOffsets(timeline, fromOffset, toOffset) {
  const fromClose = getCloseAtOffset(timeline, fromOffset);
  const toClose = getCloseAtOffset(timeline, toOffset);

  return pctReturn(fromClose, toClose);
}

function hasStrongBetween(timeline, startOffset, endOffset) {
  const list = Array.isArray(timeline) ? timeline : [];

  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    const point = getObservationMatrixPointAtOffset(list, offset);

    if (isObservationStrongPoint(point)) {
      return true;
    }
  }

  return false;
}

function summarizeEnvironmentRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const loadedRows = list.filter((row) => {
    const timeline = Array.isArray(row && row.timeline) ? row.timeline : [];
    return timeline.some((point) => point && point.stateStatus === 'loaded');
  });

  const return20List = [];
  const return10List = [];
  const return5List = [];
  let t0StrongCount = 0;
  let nearStrongCount = 0;
  let preStrongCount = 0;
  let decayCount = 0;

  loadedRows.forEach((row) => {
    const timeline = Array.isArray(row && row.timeline) ? row.timeline : [];

    const return20 = getReturnBetweenOffsets(timeline, -20, 0);
    const return10 = getReturnBetweenOffsets(timeline, -10, 0);
    const return5 = getReturnBetweenOffsets(timeline, -5, 0);

    if (Number.isFinite(return20)) {
      return20List.push(return20);
    }

    if (Number.isFinite(return10)) {
      return10List.push(return10);
    }

    if (Number.isFinite(return5)) {
      return5List.push(return5);
    }

    const t0Point = getObservationMatrixPointAtOffset(timeline, 0);
    const hasPreStrong = hasStrongBetween(timeline, -20, -6);
    const hasNearStrong = hasStrongBetween(timeline, -5, 0);

    if (isObservationStrongPoint(t0Point)) {
      t0StrongCount += 1;
    }

    if (hasPreStrong) {
      preStrongCount += 1;
    }

    if (hasNearStrong) {
      nearStrongCount += 1;
    }

    if (hasPreStrong && !hasNearStrong) {
      decayCount += 1;
    }
  });

  const loadedCount = loadedRows.length;
  const valid20Count = return20List.length;
  const up20Count = return20List.filter((value) => value > 0).length;
  const down20Count = return20List.filter((value) => value < 0).length;
  const bigDrop20Count = return20List.filter((value) => value <= -8).length;
  const strongRise20Count = return20List.filter((value) => value >= 8).length;

  return {
    loadedCount,
    valid20Count,

    medianReturn20Pct: median(return20List),
    averageReturn20Pct: average(return20List),
    medianReturn10Pct: median(return10List),
    medianReturn5Pct: median(return5List),

    up20Ratio: valid20Count > 0 ? up20Count / valid20Count : 0,
    down20Ratio: valid20Count > 0 ? down20Count / valid20Count : 0,
    bigDrop20Ratio: valid20Count > 0 ? bigDrop20Count / valid20Count : 0,
    strongRise20Ratio: valid20Count > 0 ? strongRise20Count / valid20Count : 0,

    t0StrongRatio: loadedCount > 0 ? t0StrongCount / loadedCount : 0,
    preStrongRatio: loadedCount > 0 ? preStrongCount / loadedCount : 0,
    nearStrongRatio: loadedCount > 0 ? nearStrongCount / loadedCount : 0,
    decayRatio: loadedCount > 0 ? decayCount / loadedCount : 0
  };
}

function summarizeCurrentStockEnvironment(context) {
  const timeline = context && context.currentStock && Array.isArray(context.currentStock.timeline)
    ? context.currentStock.timeline
    : [];

  return {
    return20Pct: getReturnBetweenOffsets(timeline, -20, 0),
    return10Pct: getReturnBetweenOffsets(timeline, -10, 0),
    return5Pct: getReturnBetweenOffsets(timeline, -5, 0),
    t0Strong: isObservationStrongPoint(getObservationMatrixPointAtOffset(timeline, 0)),
    preStrong: hasStrongBetween(timeline, -20, -6),
    nearStrong: hasStrongBetween(timeline, -5, 0)
  };
}

function mixSummary(left, right) {
  const leftWeight = Number(left && left.valid20Count || left && left.loadedCount || 0);
  const rightWeight = Number(right && right.valid20Count || right && right.loadedCount || 0);
  const totalWeight = leftWeight + rightWeight;

  function weighted(key) {
    if (totalWeight <= 0) {
      return null;
    }

    const leftValue = Number(left && left[key]);
    const rightValue = Number(right && right[key]);
    const leftPart = Number.isFinite(leftValue) ? leftValue * leftWeight : 0;
    const rightPart = Number.isFinite(rightValue) ? rightValue * rightWeight : 0;

    return (leftPart + rightPart) / totalWeight;
  }

  function ratio(key) {
    return weighted(key) || 0;
  }

  return {
    loadedCount: Number(left && left.loadedCount || 0) + Number(right && right.loadedCount || 0),
    valid20Count: Number(left && left.valid20Count || 0) + Number(right && right.valid20Count || 0),

    medianReturn20Pct: weighted('medianReturn20Pct'),
    averageReturn20Pct: weighted('averageReturn20Pct'),
    medianReturn10Pct: weighted('medianReturn10Pct'),
    medianReturn5Pct: weighted('medianReturn5Pct'),

    up20Ratio: ratio('up20Ratio'),
    down20Ratio: ratio('down20Ratio'),
    bigDrop20Ratio: ratio('bigDrop20Ratio'),
    strongRise20Ratio: ratio('strongRise20Ratio'),

    t0StrongRatio: ratio('t0StrongRatio'),
    preStrongRatio: ratio('preStrongRatio'),
    nearStrongRatio: ratio('nearStrongRatio'),
    decayRatio: ratio('decayRatio')
  };
}

function classifyMarketEnvironment(summary, current) {
  const median20 = Number(summary && summary.medianReturn20Pct);
  const median10 = Number(summary && summary.medianReturn10Pct);
  const median5 = Number(summary && summary.medianReturn5Pct);

  const up20Ratio = Number(summary && summary.up20Ratio || 0);
  const bigDrop20Ratio = Number(summary && summary.bigDrop20Ratio || 0);
  const nearStrongRatio = Number(summary && summary.nearStrongRatio || 0);
  const preStrongRatio = Number(summary && summary.preStrongRatio || 0);
  const decayRatio = Number(summary && summary.decayRatio || 0);
  const t0StrongRatio = Number(summary && summary.t0StrongRatio || 0);

  const currentReturn20 = Number(current && current.return20Pct);
  const currentReturn5 = Number(current && current.return5Pct);

  const hasMedian20 = Number.isFinite(median20);
  const hasMedian10 = Number.isFinite(median10);
  const hasMedian5 = Number.isFinite(median5);

  const broadWeak = (hasMedian20 && median20 <= -4)
    || bigDrop20Ratio >= 0.22
    || up20Ratio <= 0.38;

  const broadBear = (hasMedian20 && median20 <= -7)
    || bigDrop20Ratio >= 0.35;

  const broadStrong = hasMedian20
    && median20 >= 4
    && up20Ratio >= 0.62
    && nearStrongRatio >= 0.38;

  const broadWarm = hasMedian20
    && median20 >= 1.5
    && up20Ratio >= 0.52;

  const reboundRisk = nearStrongRatio >= 0.55
    && preStrongRatio >= 0.45
    && (
      (hasMedian20 && median20 <= 1.5)
      || (hasMedian10 && median10 <= 0)
      || bigDrop20Ratio >= 0.18
    );

  const crowdedTopRisk = nearStrongRatio >= 0.70
    && t0StrongRatio >= 0.55
    && Number.isFinite(currentReturn20)
    && currentReturn20 >= 12
    && Number.isFinite(currentReturn5)
    && currentReturn5 <= 4;

  const decayRisk = decayRatio >= 0.25
    || (
      preStrongRatio >= 0.45
      && nearStrongRatio <= 0.25
    );

  if (broadBear) {
    return {
      regime: 'BEAR',
      bias: 'hostile',
      title: '系统退潮',
      suppressContinuation: true,
      suppressWarming: true,
      riskBoost: true
    };
  }

  if (crowdedTopRisk) {
    return {
      regime: 'TOP_CROWDING',
      bias: 'hostile',
      title: '高位拥挤',
      suppressContinuation: true,
      suppressWarming: true,
      riskBoost: true
    };
  }

  if (reboundRisk) {
    return {
      regime: 'REBOUND_RISK',
      bias: 'hostile',
      title: '反抽共振',
      suppressContinuation: true,
      suppressWarming: true,
      riskBoost: false
    };
  }

  if (broadWeak || decayRisk) {
    return {
      regime: 'WEAK',
      bias: 'weak',
      title: '弱环境',
      suppressContinuation: true,
      suppressWarming: true,
      riskBoost: false
    };
  }

  if (broadStrong) {
    return {
      regime: 'STRONG',
      bias: 'supportive',
      title: '强环境',
      suppressContinuation: false,
      suppressWarming: false,
      riskBoost: false
    };
  }

  if (broadWarm) {
    return {
      regime: 'WARM',
      bias: 'supportive',
      title: '温和扩散',
      suppressContinuation: false,
      suppressWarming: false,
      riskBoost: false
    };
  }

  return {
    regime: 'NEUTRAL',
    bias: 'neutral',
    title: '中性环境',
    suppressContinuation: false,
    suppressWarming: false,
    riskBoost: false
  };
}

function buildMarketEnvironmentContext(context) {
  if (!context || !context.ok || !context.related || !Array.isArray(context.related.matrix)) {
    return {
      ok: false,
      error: '观察上下文无效，无法生成市场环境。'
    };
  }

  const matrix = context.related.matrix;
  const relationRows = matrix.filter(isRelationRow);
  const supplyRows = matrix.filter(isSupplyChainRow);

  const relation = summarizeEnvironmentRows(relationRows);
  const supplyChain = summarizeEnvironmentRows(supplyRows);
  const combined = mixSummary(relation, supplyChain);
  const current = summarizeCurrentStockEnvironment(context);
  const classification = classifyMarketEnvironment(combined, current);

  return {
    ok: true,
    ...classification,
    current,
    relation,
    supplyChain,
    combined,
    oneLine: `${classification.title}｜相关20日中位 ${formatPct(combined.medianReturn20Pct)}｜近端强 ${formatRatio(combined.nearStrongRatio)}｜大跌占比 ${formatRatio(combined.bigDrop20Ratio)}`
  };
}

function formatPct(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : '-';
}

function formatRatio(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${(num * 100).toFixed(1)}%` : '-';
}

module.exports = {
  buildMarketEnvironmentContext,
  summarizeEnvironmentRows,
  summarizeCurrentStockEnvironment,
  classifyMarketEnvironment
};