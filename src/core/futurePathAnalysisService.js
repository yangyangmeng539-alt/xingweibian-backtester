'use strict';

const DEFAULT_MILESTONE_DAYS = [5, 10, 20];

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundPct(value, digits = 2) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return null;
  }

  const pow = Math.pow(10, digits);
  return Math.round(num * pow) / pow;
}

function getPathPointDay(point) {
  return toNumber(point && point.day, null);
}

function getPathPointReturnPct(point) {
  return toNumber(
    point && (
      point.returnPct
      ?? point.actualReturnPct
      ?? point.closeReturnPct
      ?? point.pct
    ),
    null
  );
}

function getForecastReturnPct(point) {
  return toNumber(point && point.medianReturnPct, null);
}

function getForecastQ1Pct(point) {
  return toNumber(point && point.lowerQuartileReturnPct, null);
}

function getForecastQ3Pct(point) {
  return toNumber(point && point.upperQuartileReturnPct, null);
}

function getPointByDay(path, day) {
  const targetDay = Number(day);

  return (Array.isArray(path) ? path : []).find((point) => {
    return Number(getPathPointDay(point)) === targetDay;
  }) || null;
}

function getForecastStatByDay(futurePathStats, day) {
  const targetDay = Number(day);

  return (Array.isArray(futurePathStats) ? futurePathStats : []).find((point) => {
    return Number(point && point.day) === targetDay;
  }) || null;
}

function getActualReturnByDay(actualFuturePath, day) {
  const point = getPointByDay(actualFuturePath, day);
  return getPathPointReturnPct(point);
}

function classifyActualPathType(input) {
  const d5 = toNumber(input && input.d5);
  const d10 = toNumber(input && input.d10);
  const d20 = toNumber(input && input.d20);
  const maxUpPct = toNumber(input && input.maxUpPct);
  const maxDownPct = toNumber(input && input.maxDownPct);

  const hasD5 = Number.isFinite(d5);
  const hasD10 = Number.isFinite(d10);
  const hasD20 = Number.isFinite(d20);
  const hasMaxUp = Number.isFinite(maxUpPct);
  const hasMaxDown = Number.isFinite(maxDownPct);

  if (!hasD20) {
    return '路径不足';
  }

  if (hasMaxUp && maxUpPct >= 10 && d20 <= 2 && maxUpPct - d20 >= 6) {
    return '快速兑现回落';
  }

  if (hasMaxDown && maxDownPct <= -8 && d20 > 0) {
    return '先杀后修复';
  }

  if (hasD5 && hasD10 && d5 > 0 && d10 > 0 && d20 > 0 && (!hasMaxDown || maxDownPct > -5)) {
    return '趋势延续';
  }

  if (hasD5 && d5 > 0 && d20 < 0) {
    return '反抽衰减';
  }

  if (hasD5 && d5 < 0 && d20 > 0) {
    return '先抑后扬';
  }

  if (hasD5 && hasD10 && d5 < 0 && d10 < 0 && d20 < 0) {
    return '持续走弱';
  }

  if (d20 >= 8) {
    return '后程走强';
  }

  if (d20 <= -8) {
    return '后程走弱';
  }

  return '震荡';
}

function buildActualPathSummary(actualFuturePath, milestoneDays = DEFAULT_MILESTONE_DAYS) {
  const path = (Array.isArray(actualFuturePath) ? actualFuturePath : [])
    .map((point) => ({
      ...point,
      day: getPathPointDay(point),
      returnPct: getPathPointReturnPct(point)
    }))
    .filter((point) => Number.isFinite(point.day) && Number.isFinite(point.returnPct))
    .sort((left, right) => left.day - right.day);

  const milestones = {};

  milestoneDays.forEach((day) => {
    const value = getActualReturnByDay(path, day);

    milestones[`d${day}`] = {
      day,
      returnPct: roundPct(value)
    };
  });

  let maxUpPct = null;
  let maxUpDay = null;
  let maxUpDate = '';
  let maxDownPct = null;
  let maxDownDay = null;
  let maxDownDate = '';

  path.forEach((point) => {
    const value = Number(point.returnPct);

    if (!Number.isFinite(value)) {
      return;
    }

    if (maxUpPct === null || value > maxUpPct) {
      maxUpPct = value;
      maxUpDay = point.day;
      maxUpDate = point.date || '';
    }

    if (maxDownPct === null || value < maxDownPct) {
      maxDownPct = value;
      maxDownDay = point.day;
      maxDownDate = point.date || '';
    }
  });

  const d5 = milestones.d5 ? milestones.d5.returnPct : null;
  const d10 = milestones.d10 ? milestones.d10.returnPct : null;
  const d20 = milestones.d20 ? milestones.d20.returnPct : null;

  const pathType = classifyActualPathType({
    d5,
    d10,
    d20,
    maxUpPct,
    maxDownPct
  });

  return {
    ok: path.length > 0,
    pathType,
    milestones,
    d5,
    d10,
    d20,
    maxUpPct: roundPct(maxUpPct),
    maxUpDay,
    maxUpDate,
    maxDownPct: roundPct(maxDownPct),
    maxDownDay,
    maxDownDate,
    path
  };
}

function buildForecastMilestones(futurePathStats, milestoneDays = DEFAULT_MILESTONE_DAYS) {
  const milestones = {};

  milestoneDays.forEach((day) => {
    const stat = getForecastStatByDay(futurePathStats, day);

    milestones[`d${day}`] = {
      day,
      medianReturnPct: roundPct(getForecastReturnPct(stat)),
      lowerQuartileReturnPct: roundPct(getForecastQ1Pct(stat)),
      upperQuartileReturnPct: roundPct(getForecastQ3Pct(stat))
    };
  });

  return milestones;
}

function buildPathDisplayText(actualPathSummary) {
  if (!actualPathSummary || !actualPathSummary.ok) {
    return '真实路径：暂无足够未来走势';
  }

  const parts = [
    `真实路径：${actualPathSummary.pathType || '未知'}`,
    `D5 ${formatPct(actualPathSummary.d5)}`,
    `D10 ${formatPct(actualPathSummary.d10)}`,
    `D20 ${formatPct(actualPathSummary.d20)}`,
    `最大上冲 ${formatPct(actualPathSummary.maxUpPct)}${actualPathSummary.maxUpDay ? `/T+${actualPathSummary.maxUpDay}` : ''}`,
    `最大回撤 ${formatPct(actualPathSummary.maxDownPct)}${actualPathSummary.maxDownDay ? `/T+${actualPathSummary.maxDownDay}` : ''}`
  ];

  return parts.join('｜');
}

function formatPct(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : '-';
}

module.exports = {
  DEFAULT_MILESTONE_DAYS,
  buildActualPathSummary,
  buildForecastMilestones,
  classifyActualPathType,
  buildPathDisplayText,
  formatPct
};