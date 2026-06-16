const { STATE_NAMES } = require('./xwbStateClassifier');

const STATE_ORDER = [
  'LOW_STARTING',
  'MID_TREND_CONTINUING',
  'HIGH_CHASE_RISK',
  'HIGH_VOLUME_STALL',
  'PULLBACK_REPAIR',
  'LOW_WEAK_OBSERVE',
  'BREAKDOWN_RISK',
  'SIDEWAYS_WAITING',
  'UNKNOWN_STATE'
];

function roundNumber(value, digits = 2) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);

  if (!Number.isFinite(num)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function getFiniteReturns(values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && Math.abs(value) <= 200);
}

function average(values) {
  const valid = getFiniteReturns(values);

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values) {
  const valid = getFiniteReturns(values).sort((left, right) => left - right);

  if (valid.length === 0) {
    return null;
  }

  const middle = Math.floor(valid.length / 2);

  if (valid.length % 2 === 1) {
    return valid[middle];
  }

  return (valid[middle - 1] + valid[middle]) / 2;
}

function winRate(values) {
  const valid = getFiniteReturns(values);

  if (valid.length === 0) {
    return null;
  }

  const wins = valid.filter((value) => value > 0).length;
  return (wins / valid.length) * 100;
}

function maxValue(values) {
  const valid = getFiniteReturns(values);
  return valid.length ? Math.max(...valid) : null;
}

function minValue(values) {
  const valid = getFiniteReturns(values);
  return valid.length ? Math.min(...valid) : null;
}

function buildPeriodStats(values, suffix) {
  return {
    [`winRate${suffix}`]: roundNumber(winRate(values)),
    [`avgReturn${suffix}`]: roundNumber(average(values)),
    [`medianReturn${suffix}`]: roundNumber(median(values))
  };
}

function buildStateStats(dailyStates) {
  const groups = new Map();

  for (const item of Array.isArray(dailyStates) ? dailyStates : []) {
    const stateCode = item && item.stateCode ? item.stateCode : 'UNKNOWN_STATE';

    if (!groups.has(stateCode)) {
      groups.set(stateCode, {
        stateCode,
        stateName: (item && item.stateName) || STATE_NAMES[stateCode] || STATE_NAMES.UNKNOWN_STATE,
        samples: [],
        d5: [],
        d10: [],
        d20: []
      });
    }

    const group = groups.get(stateCode);
    const futureReturns = item && item.futureReturns ? item.futureReturns : {};

    group.samples.push(item);
    group.d5.push(futureReturns.d5);
    group.d10.push(futureReturns.d10);
    group.d20.push(futureReturns.d20);
  }

  return Array.from(groups.values())
    .map((group) => ({
      stateCode: group.stateCode,
      stateName: group.stateName,
      sampleCount: group.samples.length,
      ...buildPeriodStats(group.d5, '5'),
      ...buildPeriodStats(group.d10, '10'),
      ...buildPeriodStats(group.d20, '20'),
      maxLoss20: roundNumber(minValue(group.d20)),
      maxGain20: roundNumber(maxValue(group.d20))
    }))
    .sort((left, right) => {
      const leftOrder = STATE_ORDER.includes(left.stateCode) ? STATE_ORDER.indexOf(left.stateCode) : 99;
      const rightOrder = STATE_ORDER.includes(right.stateCode) ? STATE_ORDER.indexOf(right.stateCode) : 99;

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return right.sampleCount - left.sampleCount;
    });
}

module.exports = {
  buildStateStats
};
