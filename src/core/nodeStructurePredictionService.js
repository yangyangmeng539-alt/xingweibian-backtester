'use strict';

const DEFAULT_FORECAST_DAYS = 20;

function clamp(value, min, max) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return min;
  }

  return Math.max(min, Math.min(max, num));
}

function formatNumber(value, digits = 2) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return '-';
  }

  return num.toFixed(digits);
}

function formatPercent(value, digits = 1) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return '-';
  }

  return `${num.toFixed(digits)}%`;
}

function hasNodePredictionTextKeyword(text, keywords) {
  const value = String(text || '').toUpperCase();

  return (Array.isArray(keywords) ? keywords : []).some((keyword) => {
    return value.includes(String(keyword || '').toUpperCase());
  });
}

function getForecastDays(nodePredictionAnalysis) {
  const futurePathStats = Array.isArray(nodePredictionAnalysis && nodePredictionAnalysis.futurePathStats)
    ? nodePredictionAnalysis.futurePathStats
    : [];

  const maxDay = futurePathStats.reduce((max, item) => {
    const day = Number(item && item.day);
    return Number.isFinite(day) ? Math.max(max, day) : max;
  }, 0);

  if (maxDay > 0) {
    return maxDay;
  }

  const d20 = nodePredictionAnalysis
    && nodePredictionAnalysis.horizonSummary
    && nodePredictionAnalysis.horizonSummary.d20
    ? nodePredictionAnalysis.horizonSummary.d20
    : {};

  const d20Day = Number(d20.day);

  if (Number.isFinite(d20Day) && d20Day > 0) {
    return d20Day;
  }

  return DEFAULT_FORECAST_DAYS;
}

function getObservationMatrixPointAtOffset(timeline, offset) {
  const list = Array.isArray(timeline) ? timeline : [];
  return list.find((point) => Number(point && point.offset) === Number(offset)) || null;
}

function isObservationMatrixPointLoaded(point) {
  return Boolean(point && point.stateStatus === 'loaded');
}

function isObservationStrongShape(point) {
  const type = String(point && point.shapeType || '');

  return [
    'VOLUME_BREAKOUT',
    'MA_TURN_STRONG',
    'CLOSE_ABOVE_KEY_MA',
    'BREAKOUT_PREPARE',
    'BASE_REPAIR',
    'OVERSOLD_REBOUND',
    'PULLBACK'
  ].includes(type);
}

function isObservationStrongChange(point) {
  const type = String(point && point.changeType || '');

  return [
    'STRENGTHENING',
    'CONTINUING_UP',
    'PULLBACK_STABLE',
    'TURN_UP',
    'BREAKOUT_CONFIRM',
    'STABILIZED'
  ].includes(type);
}

function isObservationPositiveState(point) {
  const stateCode = String(point && point.stateCode || '');

  return [
    'LOW_STARTING',
    'PULLBACK_REPAIR',
    'MID_TREND_CONTINUING'
  ].includes(stateCode);
}

function isObservationOpportunityPoint(point) {
  const grade = String(point && point.opportunityGrade || '');
  const score = Number(point && point.opportunityScore);

  return grade === 'A' || grade === 'B' || (Number.isFinite(score) && score >= 60);
}

function isObservationStrongPoint(point) {
  if (!isObservationMatrixPointLoaded(point)) {
    return false;
  }

  return (
    isObservationStrongShape(point)
    || isObservationStrongChange(point)
    || isObservationPositiveState(point)
    || isObservationOpportunityPoint(point)
  );
}

function getObservationFirstStrongOffset(timeline, minOffset, maxOffset) {
  const list = Array.isArray(timeline) ? timeline : [];

  for (let offset = Number(minOffset); offset <= Number(maxOffset); offset += 1) {
    const point = getObservationMatrixPointAtOffset(list, offset);

    if (isObservationStrongPoint(point)) {
      return offset;
    }
  }

  return null;
}

function getObservationLayerKey(row) {
  const layers = Array.isArray(row && row.layers) ? row.layers : [];
  const firstLayer = layers[0] || {};

  return String(firstLayer.layerKey || 'unknown');
}

function getObservationLayerLabel(row) {
  const layers = Array.isArray(row && row.layers) ? row.layers : [];
  const firstLayer = layers[0] || {};

  return String(firstLayer.layerLabel || firstLayer.layerKey || '未知层级');
}

function isObservationPlaybackRelationRow(row) {
  const sources = Array.isArray(row && row.sources) ? row.sources : [];
  return sources.some((source) => String(source || '').includes('relation'));
}

function isObservationPlaybackSupplyChainRow(row) {
  const sources = Array.isArray(row && row.sources) ? row.sources : [];
  const layers = Array.isArray(row && row.layers) ? row.layers : [];

  return sources.some((source) => String(source || '').includes('supply_chain')) || layers.length > 0;
}

function summarizeNodePredictionObservationRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const loadedRows = list.filter((row) => {
    const timeline = Array.isArray(row && row.timeline) ? row.timeline : [];
    return timeline.some(isObservationMatrixPointLoaded);
  });

  let t0StrongCount = 0;
  let t0OpportunityCount = 0;
  let preStrongCount = 0;
  let nearStrongCount = 0;
  let earlyLeadCount = 0;
  const samples = [];

  loadedRows.forEach((row) => {
    const timeline = Array.isArray(row && row.timeline) ? row.timeline : [];
    const t0Point = getObservationMatrixPointAtOffset(timeline, 0);
    const firstPreStrongOffset = getObservationFirstStrongOffset(timeline, -20, -1);
    const firstNearStrongOffset = getObservationFirstStrongOffset(timeline, -5, 0);

    const t0Strong = isObservationStrongPoint(t0Point);
    const t0Opportunity = isObservationOpportunityPoint(t0Point);

    if (t0Strong) {
      t0StrongCount += 1;
    }

    if (t0Opportunity) {
      t0OpportunityCount += 1;
    }

    if (firstPreStrongOffset !== null) {
      preStrongCount += 1;
    }

    if (firstNearStrongOffset !== null) {
      nearStrongCount += 1;
    }

    if (firstPreStrongOffset !== null && firstPreStrongOffset <= -6) {
      earlyLeadCount += 1;
    }

    if (samples.length < 8 && (t0Strong || firstPreStrongOffset !== null || firstNearStrongOffset !== null)) {
      samples.push({
        code: row.code,
        name: row.name || '',
        layerLabel: getObservationLayerLabel(row),
        firstPreStrongOffset,
        t0Strong
      });
    }
  });

  const loadedCount = loadedRows.length;

  return {
    loadedCount,
    t0StrongCount,
    t0OpportunityCount,
    preStrongCount,
    nearStrongCount,
    earlyLeadCount,
    t0StrongRatio: loadedCount > 0 ? t0StrongCount / loadedCount : 0,
    t0OpportunityRatio: loadedCount > 0 ? t0OpportunityCount / loadedCount : 0,
    preStrongRatio: loadedCount > 0 ? preStrongCount / loadedCount : 0,
    nearStrongRatio: loadedCount > 0 ? nearStrongCount / loadedCount : 0,
    earlyLeadRatio: loadedCount > 0 ? earlyLeadCount / loadedCount : 0,
    samples
  };
}

function buildNodePredictionDominantLayer(rows) {
  const layerMap = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = getObservationLayerKey(row);
    const label = getObservationLayerLabel(row);

    if (!key || key === 'unknown') {
      return;
    }

    const existed = layerMap.get(key) || {
      layerKey: key,
      layerLabel: label,
      rows: []
    };

    existed.rows.push(row);
    layerMap.set(key, existed);
  });

  const layerItems = Array.from(layerMap.values()).map((item) => {
    const stats = summarizeNodePredictionObservationRows(item.rows);

    return {
      layerKey: item.layerKey,
      layerLabel: item.layerLabel,
      ...stats,
      score: stats.nearStrongRatio * 120
        + stats.t0StrongRatio * 110
        + stats.preStrongRatio * 70
        + stats.loadedCount * 0.01
    };
  });

  return layerItems.sort((left, right) => right.score - left.score)[0] || null;
}

function mixNodePredictionObservationRatio(left, right, key) {
  const leftLoaded = Number(left && left.loadedCount || 0);
  const rightLoaded = Number(right && right.loadedCount || 0);
  const total = leftLoaded + rightLoaded;

  if (total <= 0) {
    return 0;
  }

  return (
    Number(left && left[key] || 0) * leftLoaded
    + Number(right && right[key] || 0) * rightLoaded
  ) / total;
}

function buildNodePredictionObservationRefinement(context) {
  if (!context || !context.ok || !context.related || !Array.isArray(context.related.matrix)) {
    return {
      ok: false,
      title: '暂无结构预判',
      text: '观察上下文尚未生成，节点预判暂时只能使用当前股自身历史相似样本。'
    };
  }

  const matrix = context.related.matrix;
  const relationRows = matrix.filter(isObservationPlaybackRelationRow);
  const supplyChainRows = matrix.filter(isObservationPlaybackSupplyChainRow);

  const relation = summarizeNodePredictionObservationRows(relationRows);
  const supplyChain = summarizeNodePredictionObservationRows(supplyChainRows);
  const all = summarizeNodePredictionObservationRows(matrix);
  const dominantLayer = buildNodePredictionDominantLayer(supplyChainRows);

  const targetTimeline = context.currentStock && Array.isArray(context.currentStock.timeline)
    ? context.currentStock.timeline
    : [];

  const targetT0Point = getObservationMatrixPointAtOffset(targetTimeline, 0);
  const targetFirstPreStrongOffset = getObservationFirstStrongOffset(targetTimeline, -20, -1);
  const targetFirstStrongOffset = getObservationFirstStrongOffset(targetTimeline, -20, 0);

  const targetT0Strong = isObservationStrongPoint(targetT0Point);
  const targetT0Opportunity = isObservationOpportunityPoint(targetT0Point);

  const externalLoadedCount = relation.loadedCount + supplyChain.loadedCount;
  const externalPreRatio = mixNodePredictionObservationRatio(relation, supplyChain, 'preStrongRatio');
  const externalNearRatio = mixNodePredictionObservationRatio(relation, supplyChain, 'nearStrongRatio');
  const externalT0Ratio = mixNodePredictionObservationRatio(relation, supplyChain, 't0StrongRatio');

  const targetStateCode = String(targetT0Point && targetT0Point.stateCode || '');
  const targetStateName = String(targetT0Point && targetT0Point.stateName || '');
  const targetShapeType = String(targetT0Point && targetT0Point.shapeType || '');
  const targetShapeName = String(targetT0Point && (targetT0Point.shapeName || targetT0Point.shapeLabel) || '');
  const targetPositionType = String(targetT0Point && targetT0Point.positionType || '');
  const targetPositionName = String(targetT0Point && (targetT0Point.positionName || targetT0Point.positionLabel) || '');

  const targetShapeText = [
    targetStateCode,
    targetStateName,
    targetShapeType,
    targetShapeName
  ].join(' / ').toUpperCase();

  const targetPositionText = [
    targetPositionType,
    targetPositionName
  ].join(' / ').toUpperCase();

  function hasAnyKeyword(text, keywords) {
    return hasNodePredictionTextKeyword(text, keywords);
  }

  function percentText(ratio) {
    return formatPercent(Number(ratio || 0) * 100, 1);
  }

  const shapeUnknown = hasAnyKeyword(targetShapeText, [
    'UNKNOWN',
    'NO_SIGNAL',
    'NO_TRIGGER',
    'NO_CANDIDATE',
    'WAIT',
    '未明确',
    '无候选',
    '未触发',
    '观望',
    '等待'
  ]);

  const shapeHardRisk = !shapeUnknown && hasAnyKeyword(targetShapeText, [
    'BREAKDOWN',
    'WEAK_BREAKDOWN',
    'BREAKDOWN_RISK',
    'HIGH_VOLUME_STALL',
    'STALL',
    'TURN_DOWN',
    'WEAKENING',
    '破位',
    '转弱',
    '滞涨',
    '冲高回落',
    '顶部破坏'
  ]);

  const shapeSoftRisk = !shapeUnknown && !shapeHardRisk && hasAnyKeyword(targetShapeText, [
    'RISK',
    '风险'
  ]);

  const shapeRisk = shapeHardRisk || shapeSoftRisk;

  const shapeConstructive = !shapeRisk && (
    targetT0Opportunity
    || targetT0Strong
    || hasAnyKeyword(targetShapeText, [
      'BREAKOUT',
      'VOLUME_BREAKOUT',
      'BASE_REPAIR',
      'REPAIR',
      'MA_TURN_STRONG',
      'OVERSOLD_REBOUND',
      'TURN_STRONG',
      'ACCUMULATION',
      '突破',
      '放量',
      '修复',
      '转强',
      '超跌反弹',
      '蓄势'
    ])
  );

  let shapeVerdict = '中性形';
  let shapeLine = '观其形：当前节点未出现明确候选形态，先按中性形处理，不直接判风险。';

  if (shapeHardRisk) {
    shapeVerdict = '风险形';
    shapeLine = `观其形：${targetShapeName || targetStateName || targetShapeType || targetStateCode || '风险形态'}，出现明确形态破坏，风险优先。`;
  } else if (shapeSoftRisk) {
    shapeVerdict = '疑似风险形';
    shapeLine = `观其形：${targetShapeName || targetStateName || targetShapeType || targetStateCode || '疑似风险'}，但未形成明确破坏，需要结合位置和变化确认。`;
  } else if (shapeConstructive) {
    shapeVerdict = '候选形';
    shapeLine = `观其形：${targetShapeName || targetStateName || targetShapeType || targetStateCode || '候选形态'}，具备候选基础。`;
  } else if (shapeUnknown) {
    shapeVerdict = '未明形';
    shapeLine = '观其形：当前节点未明确触发候选形态，只能作为观察点，不能单独确认，也不能直接判风险。';
  }

  const positionHigh = hasAnyKeyword(targetPositionText, [
    'HIGH',
    'TOP',
    'HIGH_AREA',
    'HIGH_POSITION',
    'TOP_AREA',
    '高位',
    '顶部'
  ]);

  const positionLow = hasAnyKeyword(targetPositionText, [
    'LOW',
    'BOTTOM',
    'BASE',
    'LOW_AREA',
    'BOTTOM_AREA',
    '低位',
    '底部',
    '蓄势',
    '筑底'
  ]);

  const positionMid = hasAnyKeyword(targetPositionText, [
    'MID',
    'MIDDLE',
    'MID_AREA',
    '中位'
  ]);

  const targetAlreadyStrongEarly = targetFirstPreStrongOffset !== null
    && targetFirstPreStrongOffset <= -8;

  const targetRecentlyStrongBeforeT0 = targetFirstPreStrongOffset !== null
    && targetFirstPreStrongOffset <= -3;

  let positionVerdict = '位置不明';
  let positionLine = '知其位：当前节点位置不明确，预判不能放大。';

  if (positionHigh) {
    positionVerdict = '高位';
    positionLine = '知其位：当前节点处在高位或顶部区域，同样的强形在这里要按风险优先处理。';
  } else if (positionLow) {
    positionVerdict = '低位';
    positionLine = '知其位：当前节点处在低位或底部区域，若外部先行，可作为低位滞后观察。';
  } else if (positionMid) {
    positionVerdict = '中位';
    positionLine = '知其位：当前节点处在中位区域，不能简单判尾声，要区分强中继和透支。';
  }

  if (targetAlreadyStrongEarly) {
    positionLine += ` 当前股 T${formatNumber(targetFirstPreStrongOffset, 0)} 已提前转强，T0 更像趋势中的再确认，而不是初始启动。`;
  }

  const relationNearCrowded = relation.nearStrongRatio >= 0.65;
  const supplyNearCrowded = supplyChain.nearStrongRatio >= 0.65;
  const structureCrowded = relationNearCrowded && supplyNearCrowded;

  const relationExtremeCrowded = relation.nearStrongRatio >= 0.78;
  const supplyExtremeCrowded = supplyChain.nearStrongRatio >= 0.78;
  const structureExtremeCrowded = relationExtremeCrowded && supplyExtremeCrowded;

  const relationPreCrowded = relation.preStrongRatio >= 0.62;
  const supplyPreCrowded = supplyChain.preStrongRatio >= 0.62;
  const structurePreCrowded = relationPreCrowded && supplyPreCrowded;

  const externalFreshResonance = externalNearRatio >= 0.35
    && externalPreRatio < 0.28;

  const externalMatureResonance = externalNearRatio >= 0.45
    && externalPreRatio >= 0.35;

  const externalStrongContinuation = externalNearRatio >= 0.45
    && externalT0Ratio >= 0.35
    && externalPreRatio >= 0.30;

  const externalDecay = externalPreRatio >= 0.35
    && externalNearRatio < 0.20;

  const externalWeak = externalNearRatio < 0.18
    && externalT0Ratio < 0.18;

  const supplyLead = supplyChain.preStrongRatio >= relation.preStrongRatio + 0.12
    && supplyChain.nearStrongRatio >= 0.25;

  const relationLead = relation.preStrongRatio >= supplyChain.preStrongRatio + 0.12
    && relation.nearStrongRatio >= 0.25;

  let changeVerdict = '变化不足';
  let changeLine = `察其变：关系近端 ${percentText(relation.nearStrongRatio)}，产业近端 ${percentText(supplyChain.nearStrongRatio)}，外部结构尚未形成清晰方向。`;

  if (structureExtremeCrowded && positionHigh) {
    changeVerdict = '高位极端拥挤';
    changeLine = `察其变：关系近端 ${percentText(relation.nearStrongRatio)}，产业近端 ${percentText(supplyChain.nearStrongRatio)}，且发生在高位，优先视作拥挤风险。`;
  } else if (structureExtremeCrowded && !positionHigh) {
    changeVerdict = '强共振';
    changeLine = '察其变：关系圈和产业链一致性很高，但当前不是高位，不能直接判透支，需要结合当前股形态确认。';
  } else if (structureCrowded && positionHigh) {
    changeVerdict = '高位结构拥挤';
    changeLine = '察其变：关系圈和产业链同时大面积走强，且位置偏高，更像高位一致性风险。';
  } else if (externalStrongContinuation && (positionMid || positionLow) && !shapeHardRisk) {
    changeVerdict = '强中继';
    changeLine = '察其变：T0 前已有预热，近端仍保持强共振，且位置不在高位，更像趋势中继而不是尾声透支。';
  } else if (externalMatureResonance) {
    changeVerdict = '成熟共振';
    changeLine = '察其变：T0 前已有明显预热，近端仍在共振，当前属于成熟扩散段，需要看位置决定是中继还是透支。';
  } else if (externalFreshResonance) {
    changeVerdict = '近端新共振';
    changeLine = '察其变：T0 前外部未明显拥挤，T-5 到 T0 开始共振，属于较干净的近端确认。';
  } else if (externalDecay) {
    changeVerdict = '预热衰减';
    changeLine = '察其变：T0 前已经预热，但近端共振明显衰减，不能按正向确认处理。';
  } else if (supplyLead) {
    changeVerdict = '产业链先动';
    changeLine = '察其变：产业链提前强于关系圈，更像纵向传导观察。';
  } else if (relationLead) {
    changeVerdict = '关系圈先动';
    changeLine = '察其变：关系圈提前强于产业链，更像概念/板块横向扩散。';
  } else if (externalWeak) {
    changeVerdict = '外部弱';
    changeLine = '察其变：关系股和产业链均未形成有效响应，当前节点缺少外部结构支撑。';
  }

  let type = 'WEAK_STRUCTURE';
  let title = '弱结构预判';
  let tone = 'weak';
  let targetRole = '弱跟随观察节点';
  let text = '形、位、变没有形成有效合力，当前节点预判应降权。';

  const lateConfirmationRisk = targetT0Strong
    && targetFirstPreStrongOffset === null
    && externalPreRatio >= 0.50
    && externalNearRatio >= 0.55
    && positionHigh;

  const isolatedStrong = targetT0Strong
    && externalPreRatio < 0.15
    && externalNearRatio < 0.15
    && externalT0Ratio < 0.18;

  // 趋势中继不能只靠外部强共振。
  // 必须当前股自身也有确认，且不能是疑似风险形。
  // shapeUnknown 不能单独触发强中继，否则容易把熊市反抽/滞后共振判成中继。
  const targetOwnConfirmationForContinuation = targetT0Strong
    || targetRecentlyStrongBeforeT0
    || targetAlreadyStrongEarly
    || (shapeConstructive && !shapeUnknown);

  const trendContinuationCandidate = !positionHigh
    && !shapeHardRisk
    && !shapeSoftRisk
    && externalStrongContinuation
    && targetOwnConfirmationForContinuation;

  // 高位共振不能直接等于透支。
  // 只有出现明确破坏、预热衰减、后排确认，或“提前过度走强 + 预热拥挤”时，才判结构透支。
  const structureOverheated = positionHigh
    && targetT0Strong
    && (
      shapeHardRisk
      || externalDecay
      || lateConfirmationRisk
      || (
        structureExtremeCrowded
        && structurePreCrowded
        && targetAlreadyStrongEarly
        && !externalStrongContinuation
      )
      || (
        structureCrowded
        && structurePreCrowded
        && targetAlreadyStrongEarly
        && targetRecentlyStrongBeforeT0
        && !externalStrongContinuation
      )
    );

  const cleanStructureConfirmation = targetT0Strong
    && shapeConstructive
    && !shapeRisk
    && !positionHigh
    && externalFreshResonance
    && externalT0Ratio >= 0.22
    && !structureCrowded
    && !structurePreCrowded
    && !targetAlreadyStrongEarly;

  if (externalLoadedCount < 8) {
    type = 'INSUFFICIENT_STRUCTURE';
    title = '结构样本不足';
    tone = 'weak';
    targetRole = '样本不足';
    text = '关系股和产业链可用样本不足，不能用外部结构修正节点预判。';
   } else if (shapeHardRisk && (positionHigh || externalDecay || externalWeak)) {
    type = 'SHAPE_POSITION_RISK';
    title = '形位风险';
    tone = 'risk';
    targetRole = '形位破坏节点';
    text = '当前节点出现明确形态破坏，且位置或外部结构不支持继续确认，风险优先。';
  } else if (structureOverheated) {
    type = 'STRUCTURE_OVERHEATED';
    title = '结构透支';
    tone = 'risk';
    targetRole = '高位共振风险节点';
    text = '外部结构近端大面积一致，当前股也已确认或提前走强，且位置偏高，更像结构拥挤后的扩散尾声。';
  } else if (trendContinuationCandidate) {
    type = 'TREND_CONTINUATION';
    title = '趋势中继';
    tone = 'strong';
    targetRole = '强中继确认节点';
    text = '当前节点不在高位，且没有明确形态破坏；关系股和产业链在预热后仍保持近端共振，更像趋势中继，而不是尾声透支。';
  } else if (lateConfirmationRisk) {
    type = 'LATE_CONFIRMATION';
    title = '后排确认';
    tone = 'risk';
    targetRole = '后排确认节点';
    text = '关系股和产业链已在 T0 前提前走强，当前股到 T0 才确认且位置偏高，更像后排扩散。';
  } else if (externalDecay) {
    type = 'PREHEAT_DECAY';
    title = '预热衰减';
    tone = 'risk';
    targetRole = '衰减观察节点';
    text = 'T0 前已有外部预热，但近端共振衰减，当前节点不是增强确认，而是结构走弱后的观察点。';
  } else if (isolatedStrong) {
    type = 'ISOLATED_NODE';
    title = '疑似孤立';
    tone = 'risk';
    targetRole = '目标股独动';
    text = '当前股自身较强，但关系股和产业链没有同步响应，缺少结构支撑。';
  } else if (cleanStructureConfirmation) {
    type = 'STRUCTURE_CONFIRMED';
    title = '结构确认';
    tone = 'strong';
    targetRole = '形位变共振确认节点';
    text = '当前股形态具备候选基础，位置未处在明显高位风险，关系股和产业链在近端形成新共振，符合形、位、变递进确认。';
  } else if (!targetT0Strong
    && (positionLow || positionMid)
    && !shapeHardRisk
    && (
      externalFreshResonance
      || (externalNearRatio >= 0.45 && externalPreRatio < 0.42)
      || (supplyLead && supplyChain.nearStrongRatio >= 0.30)
    )) {
    type = 'EXTERNAL_CONFIRMED_TARGET_WEAK';
    title = '外部强，目标待确认';
    tone = 'watch';
    targetRole = '低位/中位待确认节点';
    text = '外部结构已经响应，但当前股自身形态还没有完全确认；因位置不高，不能判风险，应等待目标股补形态确认。';
  } else if (supplyLead && supplyChain.nearStrongRatio >= 0.25) {
    type = 'SUPPLY_CHAIN_PREHEAT';
    title = '产业链预热';
    tone = 'watch';
    targetRole = targetT0Strong ? '产业链确认节点' : '产业链待确认节点';
    text = '产业链先于关系圈走强，更像纵向传导，但仍需当前股自身形位确认。';
  } else if (relationLead && relation.nearStrongRatio >= 0.25) {
    type = 'RELATION_PREHEAT';
    title = '关系圈预热';
    tone = 'watch';
    targetRole = targetT0Strong ? '关系圈确认节点' : '关系圈待确认节点';
    text = '关系圈先动更明显，产业链传导不足，更像横向板块扩散。';
  } else if (targetT0Strong && externalNearRatio >= 0.25 && externalT0Ratio >= 0.20) {
    type = 'LOW_LEVEL_CONFIRMATION';
    title = '低强度确认';
    tone = 'watch';
    targetRole = '低强度确认节点';
    text = '当前股自身有确认，但外部结构响应不足，只能作为低强度确认。';
  } else if (externalPreRatio >= 0.25 || externalNearRatio >= 0.25 || targetT0Opportunity) {
    type = 'STRUCTURE_WARMING';
    title = '结构预热';
    tone = 'watch';
    targetRole = targetT0Strong ? '预热确认节点' : '预热观察节点';
    text = '外部结构有一定预热，但形、位、变尚未形成完整确认。';
  }

  let rawScore = 0;

  if (shapeConstructive) {
    rawScore += 20;
  }

  if (shapeUnknown) {
    rawScore += 4;
  }

  if (shapeHardRisk) {
    rawScore -= 34;
  } else if (shapeSoftRisk) {
    rawScore -= 10;
  }

  if (positionLow) {
    rawScore += 14;
  } else if (positionMid) {
    rawScore += 10;
  } else if (positionHigh) {
    rawScore -= 24;
  }

  if (externalFreshResonance) {
    rawScore += 24;
  } else if (externalStrongContinuation && !positionHigh) {
    rawScore += 28;
  } else if (externalMatureResonance && !positionHigh) {
    rawScore += 16;
  } else if (externalMatureResonance && positionHigh) {
    rawScore -= 10;
  } else if (externalDecay) {
    rawScore -= 20;
  } else if (externalWeak) {
    rawScore -= 10;
  }

  rawScore += externalT0Ratio * 18;

  if (structureExtremeCrowded && positionHigh) {
    rawScore -= 28;
  } else if (structureCrowded && positionHigh) {
    rawScore -= 20;
  } else if (structureCrowded && !positionHigh) {
    rawScore += 6;
  }

  if (structurePreCrowded && positionHigh) {
    rawScore -= 16;
  }

  if (targetAlreadyStrongEarly && positionHigh) {
    rawScore -= 14;
  } else if (targetAlreadyStrongEarly && !positionHigh) {
    rawScore += 5;
  }

  if (type === 'TREND_CONTINUATION') {
    rawScore += 24;
  }

  if (type === 'STRUCTURE_CONFIRMED') {
    rawScore += 18;
  }

  if (tone === 'risk') {
    rawScore = Math.min(rawScore, 35);
  }

  if (type === 'SHAPE_POSITION_RISK' || type === 'STRUCTURE_OVERHEATED') {
    rawScore = Math.min(rawScore, 18);
  }

  const score = clamp(Math.round(rawScore * 10) / 10, 0, 100);

  const methodChain = {
    shape: shapeLine,
    position: positionLine,
    change: changeLine,
    decision: `最终预判：${title}｜${targetRole}。${text}`,
    shapeVerdict,
    positionVerdict,
    changeVerdict
  };

  return {
    ok: true,
    type,
    title,
    tone,
    score,
    text,
    targetRole,
    target: {
      t0Strong: targetT0Strong,
      t0Opportunity: targetT0Opportunity,
      firstStrongOffset: targetFirstStrongOffset,
      firstPreStrongOffset: targetFirstPreStrongOffset,
      stateCode: targetT0Point ? targetT0Point.stateCode || '' : '',
      stateName: targetT0Point ? targetT0Point.stateName || '' : '',
      shapeType: targetT0Point ? targetT0Point.shapeType || '' : '',
      shapeName: targetT0Point ? targetT0Point.shapeName || targetT0Point.shapeLabel || '' : '',
      positionType: targetT0Point ? targetT0Point.positionType || '' : '',
      positionName: targetT0Point ? targetT0Point.positionName || targetT0Point.positionLabel || '' : '',
      changeType: targetT0Point ? targetT0Point.changeType || '' : '',
      changeName: targetT0Point ? targetT0Point.changeName || targetT0Point.changeLabel || '' : ''
    },
    relation,
    supplyChain,
    all,
    dominantLayer,
    methodChain,
    diagnostics: {
      externalLoadedCount,
      externalPreRatio,
      externalNearRatio,
      externalT0Ratio,
      shapeUnknown,
      shapeHardRisk,
      shapeSoftRisk,
      shapeRisk,
      shapeConstructive,
      positionHigh,
      positionMid,
      positionLow,
      externalFreshResonance,
      externalMatureResonance,
      externalStrongContinuation,
      externalDecay,
      externalWeak,
      relationLead,
      supplyLead,
      structureCrowded,
      structureExtremeCrowded,
      structurePreCrowded,
      targetAlreadyStrongEarly,
      targetRecentlyStrongBeforeT0,
      lateConfirmationRisk,
      cleanStructureConfirmation,
      trendContinuationCandidate
    },
    metricsText: `形 ${shapeVerdict}｜位 ${positionVerdict}｜变 ${changeVerdict}｜结构分 ${formatNumber(score, 1)}`,
    oneLine: `${title}｜${targetRole}｜形 ${shapeVerdict}｜位 ${positionVerdict}｜变 ${changeVerdict}`
  };
}

function getStructureRefinementPositionBucket(refinement) {
  const target = refinement && refinement.target ? refinement.target : {};
  const positionText = [
    target.positionType,
    target.positionName,
    refinement && refinement.methodChain ? refinement.methodChain.positionVerdict : ''
  ].join(' / ');

  if (hasNodePredictionTextKeyword(positionText, ['LOW', 'BOTTOM', '低位', '底部', '蓄势', '筑底'])) {
    return 'low';
  }

  if (hasNodePredictionTextKeyword(positionText, ['HIGH', 'TOP', '高位', '顶部'])) {
    return 'high';
  }

  if (hasNodePredictionTextKeyword(positionText, ['MID', 'MIDDLE', '中位'])) {
    return 'mid';
  }

  return 'unknown';
}

function getNodeMarketEnvironment(nodePredictionAnalysis) {
  const env = nodePredictionAnalysis && nodePredictionAnalysis.marketEnvironment
    ? nodePredictionAnalysis.marketEnvironment
    : null;

  if (!env || !env.ok) {
    return {
      ok: false,
      regime: '',
      bias: '',
      title: '',
      medianReturn20Pct: null,
      bigDrop20Ratio: 0,
      nearStrongRatio: 0
    };
  }

  const combined = env.combined || {};

  return {
    ok: true,
    regime: String(env.regime || ''),
    bias: String(env.bias || ''),
    title: String(env.title || ''),
    medianReturn20Pct: Number(combined.medianReturn20Pct),
    bigDrop20Ratio: Number(combined.bigDrop20Ratio || 0),
    nearStrongRatio: Number(combined.nearStrongRatio || 0)
  };
}

function isHostileMarketRegime(regime) {
  return regime === 'BEAR'
    || regime === 'WEAK'
    || regime === 'TOP_CROWDING';
}

function isSupportiveMarketRegime(regime) {
  return regime === 'STRONG'
    || regime === 'WARM';
}

function isReboundRiskMarketRegime(regime) {
  return regime === 'REBOUND_RISK';
}

function getStructureForecastD20BiasPct(nodePredictionAnalysis) {
  const refinement = nodePredictionAnalysis && nodePredictionAnalysis.observationRefinement
    ? nodePredictionAnalysis.observationRefinement
    : null;

  if (!refinement || !refinement.ok) {
    return 0;
  }

  const type = String(refinement.type || '');
  const tone = String(refinement.tone || '');
  const positionBucket = getStructureRefinementPositionBucket(refinement);
  const diagnostics = refinement.diagnostics || {};
  const relation = refinement.relation || {};
  const supplyChain = refinement.supplyChain || {};
  const target = refinement.target || {};

  const relationNear = Number(relation.nearStrongRatio || 0);
  const supplyNear = Number(supplyChain.nearStrongRatio || 0);
  const externalNear = Number(diagnostics.externalNearRatio || 0);
  const targetT0Strong = Boolean(target.t0Strong);
  const marketEnv = getNodeMarketEnvironment(nodePredictionAnalysis);
  const marketRegime = marketEnv.regime;
  const marketMedian20 = marketEnv.medianReturn20Pct;
  const marketBigDropRatio = marketEnv.bigDrop20Ratio;
  const marketNearStrongRatio = marketEnv.nearStrongRatio;

  const hostileMarket = isHostileMarketRegime(marketRegime);
  const supportiveMarket = isSupportiveMarketRegime(marketRegime);
  const reboundRiskMarket = isReboundRiskMarketRegime(marketRegime);
  const deepBearMarket = marketRegime === 'BEAR'
    && (
      marketBigDropRatio >= 0.45
      || (Number.isFinite(marketMedian20) && marketMedian20 <= -8)
    );

  const shapeUnknown = Boolean(diagnostics.shapeUnknown);
  const shapeHardRisk = Boolean(diagnostics.shapeHardRisk);
  const shapeSoftRisk = Boolean(diagnostics.shapeSoftRisk);
  const externalFresh = Boolean(diagnostics.externalFreshResonance);
  const externalMature = Boolean(diagnostics.externalMatureResonance);
  const externalStrongContinuation = Boolean(diagnostics.externalStrongContinuation);
  const externalCrowded = Boolean(diagnostics.structureCrowded || diagnostics.structureExtremeCrowded);

  let bias = 0;

  if (type === 'TREND_CONTINUATION') {
    bias = 3;
  } else if (type === 'STRUCTURE_CONFIRMED') {
    bias = 12;
  } else if (type === 'LOW_LEVEL_CONFIRMATION') {
    bias = 3;
  } else if (type === 'SUPPLY_CHAIN_PREHEAT') {
    bias = 8;
  } else if (type === 'RELATION_PREHEAT') {
    bias = 6;
  } else if (type === 'STRUCTURE_WARMING') {
    bias = 2;
  } else if (type === 'EXTERNAL_CONFIRMED_TARGET_WEAK') {
    if (positionBucket === 'low' && !shapeHardRisk) {
      bias = 7;
    } else if (positionBucket === 'mid' && !shapeHardRisk) {
      bias = 5;
    } else {
      bias = 1;
    }
  } else if (type === 'SHAPE_POSITION_RISK') {
    bias = -14;
  } else if (type === 'STRUCTURE_OVERHEATED') {
    bias = -12;
  } else if (type === 'LATE_CONFIRMATION') {
    bias = -8;
  } else if (type === 'PREHEAT_DECAY') {
    bias = -9;
  } else if (type === 'ISOLATED_NODE') {
    bias = -6;
  }

  if ((positionBucket === 'mid' || positionBucket === 'low') && !shapeHardRisk && externalStrongContinuation) {
    bias += 6;
  }

  if ((positionBucket === 'mid' || positionBucket === 'low') && !shapeHardRisk && externalMature && externalNear >= 0.45) {
    bias += 4;
  }

  if (positionBucket === 'low' && !shapeHardRisk && !targetT0Strong && externalNear >= 0.55) {
    bias += 4;
  }

  if ((positionBucket === 'mid' || positionBucket === 'low') && !shapeHardRisk && relationNear >= 0.55 && supplyNear >= 0.55) {
    bias += 3;
  }

  if (externalFresh && !shapeHardRisk) {
    bias += 3;
  }

  if (externalCrowded && positionBucket === 'high') {
    // 高位拥挤只是风险提示，不等于立刻反转。
    // 只有硬破坏才大幅扣分；软风险或未明形只轻微降权。
    bias -= shapeHardRisk ? 8 : 2;
  } else if (externalCrowded && (positionBucket === 'mid' || positionBucket === 'low') && !shapeHardRisk) {
    bias += 2;
  }

  if (shapeHardRisk) {
    bias -= 10;
  } else if (shapeSoftRisk) {
    bias -= 1;
  }

  if (shapeUnknown && (positionBucket === 'mid' || positionBucket === 'low') && externalNear >= 0.45) {
    bias += 2;
  }

  if (tone === 'risk') {
    bias = Math.min(bias, shapeHardRisk || type === 'SHAPE_POSITION_RISK' ? -6 : -2);
  }

  if (positionBucket === 'high') {
    bias = Math.min(bias, 2);
  }

  if (type === 'TREND_CONTINUATION') {
    // 120样本显示：趋势中继方向有价值，但幅度严重过高。
    // 先把 D20 加成控制在温和区间，避免 structureD20 动不动十几二十点。
    const trendCap = shapeSoftRisk || shapeUnknown ? 4 : 6;
    bias = clamp(bias, -4, trendCap);
  } else if (type === 'EXTERNAL_CONFIRMED_TARGET_WEAK') {
    // 目标股未确认，不允许大幅上调。
    bias = clamp(bias, -3, externalFresh ? 7 : 5);
  } else if (type === 'STRUCTURE_WARMING') {
    // 结构预热不是确认，只能轻修正。
    // 高位预热尤其不能继续大幅看多。
    const warmingCap = positionBucket === 'high' ? 3 : 5;
    const warmingFloor = shapeHardRisk ? -6 : -3;
    bias = clamp(bias, warmingFloor, warmingCap);
  } else if (type === 'LOW_LEVEL_CONFIRMATION') {
    // 低强度确认是有效分类，但不是强确认。
    bias = clamp(bias, -4, positionBucket === 'high' ? 4 : 6);
  } else if (type === 'SHAPE_POSITION_RISK') {
    // 风险形只在高位重罚；中低位风险形可能是修复/洗盘。
    bias = clamp(
      bias,
      positionBucket === 'high' ? -12 : -6,
      positionBucket === 'high' ? -3 : -1
    );
  } else if (type === 'SUPPLY_CHAIN_PREHEAT') {
    bias = clamp(bias, -3, 6);
  } else if (type === 'RELATION_PREHEAT') {
    bias = clamp(bias, -3, 5);
  }
    // v3-path：市场环境闸门。
  // 120路径验证显示：REBOUND_RISK / WARM 结构增益明显；
  // 但 BEAR / WEAK 环境里，结构加成容易把 raw 本来正确的方向改坏。
  if (hostileMarket) {
    if (type === 'TREND_CONTINUATION') {
      if (deepBearMarket) {
        bias = Math.min(bias, 1);
      } else if (marketRegime === 'WEAK') {
        bias = Math.min(bias, 2);
      } else if (marketRegime === 'TOP_CROWDING') {
        bias = Math.min(bias, 3);
      } else {
        bias = Math.min(bias, 3);
      }
    } else if (type === 'STRUCTURE_WARMING') {
      if (deepBearMarket || marketRegime === 'WEAK') {
        bias = Math.min(bias, 1);
      } else {
        bias = Math.min(bias, 2);
      }
    } else if (type === 'LOW_LEVEL_CONFIRMATION') {
      if (deepBearMarket || marketRegime === 'TOP_CROWDING') {
        bias = Math.min(bias, 1);
      } else {
        bias = Math.min(bias, 2);
      }
    } else if (type === 'RELATION_PREHEAT' || type === 'SUPPLY_CHAIN_PREHEAT') {
      bias = Math.min(bias, 2);
    }
  }

  // 强环境并不等于无脑追高。
  // 如果已经是高位，或者结构拥挤，只允许确认，不允许继续大幅放大。
  if (supportiveMarket && positionBucket === 'high' && externalCrowded) {
    bias = Math.min(bias, 2);
  }

  // 反抽共振是这次验证里表现最好的环境之一，不能一刀砍掉。
  // 但高位反抽仍然只允许小幅确认。
  if (reboundRiskMarket && positionBucket === 'high' && externalCrowded) {
    bias = Math.min(bias, 2);
  }

  // 深度退潮里，如果目标自身 T0 没强，不允许外部结构把它硬抬成强预判。
  if (deepBearMarket && !targetT0Strong && bias > 0) {
    bias = Math.min(bias, 1);
  }

  return clamp(bias, -14, 14);
}

function getStructureAdjustedForecastReturnPct(nodePredictionAnalysis, day, rawReturnPct, band = 'median') {
  const raw = Number(rawReturnPct);

  if (!Number.isFinite(raw)) {
    return rawReturnPct;
  }

  const refinement = nodePredictionAnalysis && nodePredictionAnalysis.observationRefinement
    ? nodePredictionAnalysis.observationRefinement
    : null;

  const type = String(refinement && refinement.type || '');
  const diagnostics = refinement && refinement.diagnostics ? refinement.diagnostics : {};
  const target = refinement && refinement.target ? refinement.target : {};

  const forecastDays = Math.max(1, getForecastDays(nodePredictionAnalysis));
  const progress = clamp(Number(day || 0) / forecastDays, 0, 1);
  const d20Bias = getStructureForecastD20BiasPct(nodePredictionAnalysis);
  const power = Math.pow(progress, 0.88);

  let adjusted = raw + d20Bias * power;

  if (band === 'q1') {
    adjusted -= Math.abs(d20Bias) * 0.18 * power;
  } else if (band === 'q3') {
    adjusted += Math.abs(d20Bias) * 0.18 * power;
  }

  const rawAbs = Math.abs(raw);
  const rawPositive = raw > 0;
  const rawNegative = raw < 0;
  const adjustedPositive = adjusted > 0;
  const adjustedNegative = adjusted < 0;
  const directionFlipped = (rawPositive && adjustedNegative) || (rawNegative && adjustedPositive);

  if (!directionFlipped) {
    return adjusted;
  }

  const positionBucket = getStructureRefinementPositionBucket(refinement);
  const shapeHardRisk = Boolean(diagnostics.shapeHardRisk);
  const externalDecay = Boolean(diagnostics.externalDecay);
  const externalFresh = Boolean(diagnostics.externalFreshResonance);
  const externalStrongContinuation = Boolean(diagnostics.externalStrongContinuation);
  const supplyLead = Boolean(diagnostics.supplyLead);
  const relationLead = Boolean(diagnostics.relationLead);
  const externalNearRatio = Number(diagnostics.externalNearRatio || 0);
  const externalT0Ratio = Number(diagnostics.externalT0Ratio || 0);
  const targetT0Strong = Boolean(target.t0Strong);
  const marketEnv = getNodeMarketEnvironment(nodePredictionAnalysis);
  const marketRegime = marketEnv.regime;
  const marketMedian20 = marketEnv.medianReturn20Pct;
  const marketBigDropRatio = marketEnv.bigDrop20Ratio;
  const hostileMarket = isHostileMarketRegime(marketRegime);
  const deepBearMarket = marketRegime === 'BEAR'
    && (
      marketBigDropRatio >= 0.45
      || (Number.isFinite(marketMedian20) && marketMedian20 <= -8)
    );

  const allowPositiveFlip = (
    type === 'TREND_CONTINUATION'
    || type === 'STRUCTURE_CONFIRMED'
    || type === 'SUPPLY_CHAIN_PREHEAT'
    || type === 'RELATION_PREHEAT'
    || (
      type === 'EXTERNAL_CONFIRMED_TARGET_WEAK'
      && positionBucket !== 'high'
      && (
        externalFresh
        || supplyLead
        || relationLead
        || externalNearRatio >= 0.25
        || externalT0Ratio >= 0.20
      )
    )
  );

  const allowNegativeFlip = (
    type === 'SHAPE_POSITION_RISK'
    || type === 'PREHEAT_DECAY'
    || (
      type === 'STRUCTURE_WARMING'
      && shapeHardRisk
      && (positionBucket === 'high' || externalDecay)
    )
  );

    let allowFlip = rawNegative
    ? allowPositiveFlip
    : allowNegativeFlip;

    // v3-path：退潮/弱环境里，禁止弱结构把 raw 从跌翻成涨。
    // 这次路径验证显示 BEAR / WEAK 下结构 D20 反而弱于 raw，主要就是这里误翻。
    if (
    rawNegative
    && adjustedPositive
    && hostileMarket
    && (
        type === 'STRUCTURE_WARMING'
        || type === 'LOW_LEVEL_CONFIRMATION'
        || type === 'TREND_CONTINUATION'
    )
    ) {
    if (
        deepBearMarket
        || marketRegime === 'WEAK'
        || marketRegime === 'TOP_CROWDING'
        || !targetT0Strong
    ) {
        allowFlip = false;
    }
    }

  if (allowFlip) {
    return adjusted;
  }

  // 弱结构只调幅，不改方向。
  // 这一步专门防止 STRUCTURE_WARMING / LOW_LEVEL_CONFIRMATION 把 raw 方向翻错。
  if (rawPositive && adjustedNegative) {
    return Math.max(0.1, raw * 0.55);
  }

  if (rawNegative && adjustedPositive) {
    return Math.min(-0.1, raw * 0.55);
  }

  return adjusted;
}

function getStructureAdjustedD20MedianPct(nodePredictionAnalysis) {
  const d20Forecast = nodePredictionAnalysis
    && nodePredictionAnalysis.horizonSummary
    && nodePredictionAnalysis.horizonSummary.d20
    ? nodePredictionAnalysis.horizonSummary.d20
    : {};

  return getStructureAdjustedForecastReturnPct(
    nodePredictionAnalysis,
    getForecastDays(nodePredictionAnalysis),
    d20Forecast.medianReturnPct,
    'median'
  );
}

function enrichNodePredictionWithObservationContext(nodePredictionAnalysis, context) {
  if (!nodePredictionAnalysis || !nodePredictionAnalysis.ok || !context || !context.ok) {
    return nodePredictionAnalysis;
  }

  return {
    ...nodePredictionAnalysis,
    observationRefinement: buildNodePredictionObservationRefinement(context)
  };
}

module.exports = {
  buildNodePredictionObservationRefinement,
  getStructureForecastD20BiasPct,
  getStructureAdjustedForecastReturnPct,
  getStructureAdjustedD20MedianPct,
  enrichNodePredictionWithObservationContext,

  // 调试/验证用
  summarizeNodePredictionObservationRows,
  isObservationStrongPoint,
  isObservationOpportunityPoint,
  getObservationFirstStrongOffset,
  getObservationMatrixPointAtOffset
};