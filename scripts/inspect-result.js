const { runBacktestForSymbol } = require('../src/core/backtestEngine');

function pct(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return '-';

  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(2)}%`;
}

function num(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return '-';

  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n.toFixed(2);
}

function verdictText(value) {
  if (value === 'STRONG_MATCH') return '强吻合';
  if (value === 'BASIC_MATCH') return '基本吻合';
  if (value === 'RANGE_MATCH') return '落在预测范围';
  if (value === 'DIRECTION_ONLY_MATCH') return '方向吻合但幅度偏离';
  if (value === 'RANGE_MATCH_DIRECTION_MISS') return '落在区间但方向不一致';
  if (value === 'OUT_OF_RANGE') return '超出预测范围';
  if (value === 'NO_ACTUAL_DATA') return '暂无真实走势，无法验证';
  return value || '-';
}

function actualReturnText(item) {
  if (!item || !item.hasActual) return '暂无';
  return pct(item.actualReturnPct);
}

function judgementText(value) {
  if (value === 'NO_ACTUAL_DATA') return '暂无未来真实数据，不能验证吻合度';
  return verdictText(value);
}

function nullableJudgeText(value) {
  if (value === null || value === undefined) return '无法判断';
  return value ? '吻合' : '不吻合';
}

function nullableRangeText(value) {
  if (value === null || value === undefined) return '无法判断';
  return value ? '落入' : '未落入';
}

function line(title) {
  console.log('\n' + '='.repeat(90));
  console.log(title);
  console.log('='.repeat(90));
}

function printLatestPrediction(result) {
  const latest = result?.predictionAnalysis?.latestPrediction;

  line('最近交易日：形位变预判');

  if (!latest) {
    console.log('没有 predictionAnalysis.latestPrediction 数据');
    return;
  }

  console.log(`日期：${latest.date}`);
  console.log(`收盘价：${num(latest.close)}`);
  console.log(`综合状态：${latest.stateName || '-'} / ${latest.stateCode || '-'}`);
  console.log(`观其形：${latest.shapeType || '-'} / 分=${num(latest.shapeScore)}`);
  console.log(`知其位：${latest.positionType || '-'} / 分=${num(latest.positionScore)}`);
  console.log(`复察其变：${latest.changeType || '-'} / 分=${num(latest.changeScore)}`);
  console.log(`预判方向：${latest.predictionDirectionText || '-'} / ${latest.predictionDirection || '-'}`);
  console.log(`预判分：${num(latest.predictionScore)}`);
  console.log(`预判等级：${latest.predictionGrade || '-'}`);
  console.log(`观察价值：${latest.observationValue || '-'}`);
  console.log(`风险等级：${latest.riskLevel || '-'}`);

  console.log('\n历史预判能力：');
  console.log(`样本数：${latest.sampleCount ?? '-'}`);
  console.log(`5日方向命中：${pct(latest.directionHitRate5)}`);
  console.log(`10日方向命中：${pct(latest.directionHitRate10)}`);
  console.log(`20日方向命中：${pct(latest.directionHitRate20)}`);
  console.log(`5日平均涨跌幅：${pct(latest.avgReturn5)}`);
  console.log(`10日平均涨跌幅：${pct(latest.avgReturn10)}`);
  console.log(`20日平均涨跌幅：${pct(latest.avgReturn20)}`);
  console.log(`20日中位涨跌幅：${pct(latest.medianReturn20)}`);
  console.log(`20日最大不利：${pct(latest.maxLoss20)}`);
  console.log(`20日最大有利：${pct(latest.maxGain20)}`);
  console.log(`20日有利不利比：${num(latest.riskReward20)}`);
  console.log(`20日假阳性：${pct(latest.falsePositiveRate20)}`);

  console.log('\n支持理由：');
  for (const item of latest.reasons || []) {
    console.log(`- ${item}`);
  }

  console.log('\n风险提示：');
  for (const item of latest.riskNotes || []) {
    console.log(`- ${item}`);
  }

  console.log('\n状态解释：');
  console.log(latest.stateSummary || '-');

  console.log('\n节点后真实走势字段：');
  const futureReturns = latest.futureReturns || {};
  console.log(`d5=${futureReturns.d5 === null || futureReturns.d5 === undefined ? '暂无未来数据' : pct(futureReturns.d5)}`);
  console.log(`d10=${futureReturns.d10 === null || futureReturns.d10 === undefined ? '暂无未来数据' : pct(futureReturns.d10)}`);
  console.log(`d20=${futureReturns.d20 === null || futureReturns.d20 === undefined ? '暂无未来数据' : pct(futureReturns.d20)}`);
}

function printHorizonSummary(title, summary) {
  console.log(`\n${title}`);

  if (!summary) {
    console.log('暂无数据');
    return;
  }

  console.log([
    `样本=${summary.sampleCount}`,
    `上涨概率=${pct(summary.upProbabilityPct)}`,
    `平均涨跌幅=${pct(summary.averageReturnPct)}`,
    `中位涨跌幅=${pct(summary.medianReturnPct)}`,
    `下四分位=${pct(summary.lowerQuartileReturnPct)}`,
    `上四分位=${pct(summary.upperQuartileReturnPct)}`,
    `最大不利=${pct(summary.maxAdverseReturnPct)}`,
    `最大有利=${pct(summary.maxFavorableReturnPct)}`
  ].join(' | '));
}

function printNodePrediction(result) {
  const data = result?.nodePredictionAnalysis;

  line('当前节点预判图数据');

  if (!data || !data.ok) {
    console.log(data && data.error ? data.error : '没有 nodePredictionAnalysis 数据');
    return;
  }

  const node = data.currentNode || {};
  const summary = data.horizonSummary || {};

  console.log(`点击日期：${data.clickedDate}`);
  console.log(`当前状态：${node.stateName || '-'} / ${node.stateCode || '-'}`);
  console.log(`当前收盘：${num(node.close)}`);
  console.log(`相似样本数：${data.similarSampleCount}`);
  console.log(`预判说明：${data.predictionText}`);
  console.log(`验证说明：${data.validationNote}`);

  printHorizonSummary('未来 5 日分布：', summary.d5);
  printHorizonSummary('未来 10 日分布：', summary.d10);
  printHorizonSummary('未来 20 日分布：', summary.d20);

  if (data.pathRisk) {
    console.log('\n路径风险：');
    console.log([
      `样本=${data.pathRisk.sampleCount}`,
      `平均最大不利=${pct(data.pathRisk.averageMaxAdversePct)}`,
      `中位最大不利=${pct(data.pathRisk.medianMaxAdversePct)}`,
      `最差最大不利=${pct(data.pathRisk.worstMaxAdversePct)}`,
      `平均最大有利=${pct(data.pathRisk.averageMaxFavorablePct)}`,
      `中位最大有利=${pct(data.pathRisk.medianMaxFavorablePct)}`,
      `最好最大有利=${pct(data.pathRisk.bestMaxFavorablePct)}`
    ].join(' | '));
  }

  if (data.actualComparison) {
    console.log('\n真实走势对照：');
    for (const key of ['d5', 'd10', 'd20']) {
      const item = data.actualComparison[key];
      if (!item) continue;

      console.log([
        key.toUpperCase(),
        `实际日期=${item.actualDate || '-'}`,
        `实际涨跌=${actualReturnText(item)}`,
        `预测中位=${pct(item.forecastMedianPct)}`,
        `预测Q1=${pct(item.forecastLowerQuartilePct)}`,
        `预测Q3=${pct(item.forecastUpperQuartilePct)}`,
        `预测下沿=${pct(item.forecastMaxAdversePct)}`,
        `预测上沿=${pct(item.forecastMaxFavorablePct)}`,
        `方向=${nullableJudgeText(item.directionMatched)}`,
        `IQR=${nullableRangeText(item.inInterQuartileRange)}`,
        `全区间=${nullableRangeText(item.inFullRange)}`,
        `偏离中位=${pct(item.medianDeviationPct)}`,
        `判定=${judgementText(item.verdict)}`
      ].join(' | '));
    }
  }

  if (data.actualComparisonSummary) {
    console.log('\n预判吻合度汇总：');
    console.log([
      `真实样本=${data.actualComparisonSummary.actualCount}`,
      `强吻合=${data.actualComparisonSummary.strongMatchCount}`,
      `基本吻合=${data.actualComparisonSummary.basicMatchCount}`,
      `区间吻合=${data.actualComparisonSummary.rangeMatchCount}`,
      `方向吻合=${data.actualComparisonSummary.directionMatchCount}`,
      `总体=${verdictText(data.actualComparisonSummary.overallVerdict)}`
    ].join(' | '));
  }

  console.log('\n相似样本 TOP 10：');
  for (const sample of (data.similarSamples || []).slice(0, 10)) {
    const futureReturns = sample.futureReturns || {};

    console.log([
      sample.sampleDate,
      `${sample.stateCode}/${sample.stateName}`,
      `形=${sample.shapeType}`,
      `位=${sample.positionType}`,
      `变=${sample.changeType}`,
      `相似=${num(sample.similarityScore)}`,
      `d5=${futureReturns.d5 === null || futureReturns.d5 === undefined ? '-' : pct(futureReturns.d5)}`,
      `d10=${futureReturns.d10 === null || futureReturns.d10 === undefined ? '-' : pct(futureReturns.d10)}`,
      `d20=${futureReturns.d20 === null || futureReturns.d20 === undefined ? '-' : pct(futureReturns.d20)}`
    ].join(' | '));
  }

  console.log('\n预判路径前 10 日：');
  for (const row of (data.futurePathStats || []).slice(0, 10)) {
    console.log([
      `D+${row.day}`,
      `样本=${row.sampleCount}`,
      `均值=${pct(row.averageReturnPct)}`,
      `中位=${pct(row.medianReturnPct)}`,
      `Q1=${pct(row.lowerQuartileReturnPct)}`,
      `Q3=${pct(row.upperQuartileReturnPct)}`,
      `上涨率=${pct(row.positiveRatePct)}`
    ].join(' | '));
  }
}

function printPredictionStats(result) {
  const list = result?.predictionAnalysis?.predictionStats || [];

  line('形位变状态预判能力排行');

  if (!list.length) {
    console.log('没有 predictionStats 数据');
    return;
  }

  for (const item of list.slice(0, 12)) {
    console.log([
      `${item.stateCode || '-'} / ${item.stateName || '-'}`,
      `样本=${item.sampleCount ?? '-'}`,
      `方向=${item.predictionDirectionText || '-'}`,
      `预判等级=${item.predictionGrade || '-'}`,
      `预判分=${num(item.predictionScore)}`,
      `观察价值=${item.observationValue || '-'}`,
      `风险=${item.riskLevel || '-'}`,
      `5日命中=${pct(item.directionHitRate5)}`,
      `10日命中=${pct(item.directionHitRate10)}`,
      `20日命中=${pct(item.directionHitRate20)}`,
      `20日均值=${pct(item.avgReturn20)}`,
      `20日中位=${pct(item.medianReturn20)}`,
      `20日最大不利=${pct(item.maxLoss20)}`,
      `20日最大有利=${pct(item.maxGain20)}`,
      `有利不利比=${num(item.riskReward20)}`,
      `假阳性=${pct(item.falsePositiveRate20)}`
    ].join(' | '));
  }
}

function printStateStats(result) {
  const list = result?.xwbStateAnalysis?.stateStats || [];

  line('原始状态统计 TOP');

  if (!list.length) {
    console.log('没有 stateStats 数据');
    return;
  }

  const sorted = [...list]
    .sort((a, b) => Number(b.sampleCount || 0) - Number(a.sampleCount || 0))
    .slice(0, 12);

  for (const s of sorted) {
    console.log([
      `${s.stateCode || '-'} / ${s.stateName || '-'}`,
      `样本=${s.sampleCount ?? '-'}`,
      `5日上涨率=${pct(s.winRate5)}`,
      `5日均值=${pct(s.avgReturn5)}`,
      `10日上涨率=${pct(s.winRate10)}`,
      `10日均值=${pct(s.avgReturn10)}`,
      `20日上涨率=${pct(s.winRate20)}`,
      `20日均值=${pct(s.avgReturn20)}`,
      `20日最大不利=${pct(s.maxLoss20)}`,
      `20日最大有利=${pct(s.maxGain20)}`
    ].join(' | '));
  }
}

async function main() {
  const symbol = process.argv[2] || '300750';
  const startDate = process.argv[3] || '20180101';
  const clickedDate = process.argv[4] || '';
  const endDate = process.argv[5] || '';

  const result = await runBacktestForSymbol({
    symbol,
    startDate,
    endDate,
    clickedDate,
    refresh: false,
    forecastDays: 20,
    maxSamples: 160
  });

  line(`预判结果检查工具：基础信息：${symbol}`);
  console.log(`数据区间：${result.barStart} → ${result.barEnd}`);
  console.log(`日线数量：${result.barCount}`);
  console.log(`选中节点：${result.selectedNodeDate || clickedDate || '最新交易日'}`);
  console.log(`数据来源：${result.source}`);
  console.log(`缓存路径：${result.cachePath}`);
  console.log(`预判版本：${result.predictionVersion || '-'}`);
  console.log(`节点预判版本：${result.nodePredictionVersion || '-'}`);
  if (result.warning) {
    console.log(`警告：${result.warning}`);
  }

  printLatestPrediction(result);
  printNodePrediction(result);
  printPredictionStats(result);
  printStateStats(result);
}

main().catch((error) => {
  console.error('\n运行失败：');
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
