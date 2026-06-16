const path = require('path');
const { contextBridge, ipcRenderer } = require('electron');

const nodeStructurePredictionService = require(
  path.join(__dirname, 'src', 'core', 'nodeStructurePredictionService')
);

let marketEnvironmentService = null;
let nodePredictionValidationService = null;

try {
  marketEnvironmentService = require(
    path.join(__dirname, 'src', 'core', 'marketEnvironmentService')
  );
} catch (error) {
  marketEnvironmentService = null;
}

try {
  nodePredictionValidationService = require(
    path.join(__dirname, 'src', 'core', 'nodePredictionValidationService')
  );
} catch (error) {
  nodePredictionValidationService = null;
}

contextBridge.exposeInMainWorld('xwbApi', {
  runBacktest: (payload) => ipcRenderer.invoke('backtest:run', payload),
runMarketState: (payload) => ipcRenderer.invoke('market-state:run', payload),
getMarketIndexOverview: (payload) => ipcRenderer.invoke('market-index:overview', payload),
syncMarketIndexes: (payload) => ipcRenderer.invoke('market-index:sync', payload),
getMarketIndexSummary: (payload) => ipcRenderer.invoke('market-index:summary', payload),
runStructureCandidates: (payload) => ipcRenderer.invoke('structure-candidates:run', payload),
  runNodePrediction: (payload) => ipcRenderer.invoke('prediction:node-run', payload),
  refreshStockUniverse: () => ipcRenderer.invoke('sync:universe-refresh'),
  startFullMarketSync: (options) => ipcRenderer.invoke('sync:full-market-start', options),
  getFullMarketSyncStatus: () => ipcRenderer.invoke('sync:full-market-status'),
  stopFullMarketSync: () => ipcRenderer.invoke('sync:full-market-stop'),
  refreshHongKongStockUniverse: (options) => ipcRenderer.invoke('sync:hk-universe-refresh', options),
  startHongKongSync: (options) => ipcRenderer.invoke('sync:hk-start', options),
  getHongKongSyncStatus: () => ipcRenderer.invoke('sync:hk-status'),
  stopHongKongSync: () => ipcRenderer.invoke('sync:hk-stop'),
  importDataPack: () => ipcRenderer.invoke('data-pack:import'),
  getMarketGraphSummary: () => ipcRenderer.invoke('market-graph:relation-summary'),
  getMarketGraphRaw: (payload) => ipcRenderer.invoke('market-graph:relation-raw', payload),
  getMarketGraph: (payload) => ipcRenderer.invoke('market-graph:graph', payload),
  getMarketGraphSample: (payload) => ipcRenderer.invoke('market-graph:sample-graph', payload),
  getMarketGraphFetchStatus: () => ipcRenderer.invoke('market-graph:fetch-raw-status'),
  startMarketGraphRelationFetch: (payload) => ipcRenderer.invoke('market-graph:fetch-relation-start', payload),
  getMarketGraphRelationFetchStatus: () => ipcRenderer.invoke('market-graph:fetch-relation-status'),
  stopMarketGraphRelationFetch: () => ipcRenderer.invoke('market-graph:fetch-relation-stop'),
  getMarketGraphRelationFetchErrors: () => ipcRenderer.invoke('market-graph:fetch-relation-errors'),
  getSupplyChainSummary: () => ipcRenderer.invoke('supply-chain:summary'),
  listSupplyChainPrimaryChains: () => ipcRenderer.invoke('supply-chain:list-primary-chains'),
  listSupplyChainSecondaryChains: (payload) => ipcRenderer.invoke('supply-chain:list-secondary-chains', payload),
  queryStockSupplyChain: (payload) => ipcRenderer.invoke('supply-chain:query-stock', payload),
  querySupplyChain: (payload) => ipcRenderer.invoke('supply-chain:query-chain', payload),
  expandSupplyChainNode: (payload) => ipcRenderer.invoke('supply-chain:expand-node', payload),
  listSupplyChainUserOverrides: () => ipcRenderer.invoke('supply-chain:list-user-overrides'),
  listSupplyChainUserPrimaryChains: () => ipcRenderer.invoke('supply-chain-user:primary'),
listSupplyChainUserSecondaryChains: (payload) => ipcRenderer.invoke('supply-chain-user:secondary', payload),
querySupplyChainUserChain: (payload) => ipcRenderer.invoke('supply-chain-user:query', payload),
saveSupplyChainUserChain: (payload) => ipcRenderer.invoke('supply-chain-user:save', payload),
deleteSupplyChainUserChain: (payload) => ipcRenderer.invoke('supply-chain-user:delete', payload),
searchSupplyChainEditorStocks: (payload) => ipcRenderer.invoke('supply-chain-editor:search-stocks', payload),
  applySupplyChainUserOverride: (payload) => ipcRenderer.invoke('supply-chain:apply-user-override', payload),

onAppMenuOpenModal: (handler) => {
  if (typeof handler !== 'function') {
    return () => {};
  }

  const listener = (_event, payload) => {
    handler(payload || {});
  };

  ipcRenderer.on('app-menu:open-modal', listener);

  return () => {
    ipcRenderer.removeListener('app-menu:open-modal', listener);
  };
},

  buildNodeStructurePrediction: (context) => {
    return nodeStructurePredictionService.buildNodePredictionObservationRefinement(context);
  },

    buildMarketEnvironmentContext: (context) => {
    if (
      !marketEnvironmentService
      || typeof marketEnvironmentService.buildMarketEnvironmentContext !== 'function'
    ) {
      return {
        ok: false,
        error: '市场态模块未加载。'
      };
    }

    return marketEnvironmentService.buildMarketEnvironmentContext(context);
  },

  buildNodeMarketProjection: (payload) => {
    const input = payload || {};
    const nodePredictionAnalysis = input.nodePredictionAnalysis || null;

    if (
      !nodePredictionAnalysis
      || !nodePredictionValidationService
      || typeof nodePredictionValidationService.derivePredictionKind !== 'function'
      || typeof nodePredictionValidationService.applyMarketPredictionKindFilter !== 'function'
    ) {
      return {
        ok: false,
        error: 'C 层市场修正模块未加载。'
      };
    }

    const rawPredictionKind = nodePredictionValidationService.derivePredictionKind(
      nodePredictionAnalysis,
      'market'
    );

    const predictionKind = nodePredictionValidationService.applyMarketPredictionKindFilter(
      rawPredictionKind,
      nodePredictionAnalysis,
      'market'
    );

    let confidence = 0.3;

    if (typeof nodePredictionValidationService.getConfidence === 'function') {
      confidence = nodePredictionValidationService.getConfidence(
        nodePredictionAnalysis,
        'market'
      );
    } else if (Number.isFinite(Number(nodePredictionAnalysis.confidence))) {
      confidence = Number(nodePredictionAnalysis.confidence);
    }

    if (typeof nodePredictionValidationService.applyMarketConfidenceFilter === 'function') {
      confidence = nodePredictionValidationService.applyMarketConfidenceFilter(
        confidence,
        nodePredictionAnalysis,
        rawPredictionKind,
        predictionKind,
        'market'
      );
    }

    const cleanConfidence = Number.isFinite(Number(confidence))
      ? Math.max(0, Math.min(1, Number(confidence)))
      : 0.3;

    const confidenceBand = cleanConfidence >= 0.68
      ? 'HIGH'
      : cleanConfidence >= 0.40
        ? 'MID'
        : 'LOW';

    return {
      ok: true,
      rawPredictionKind,
      predictionKind,
      confidence: Math.round(cleanConfidence * 1000) / 1000,
      confidenceBand
    };
  },

  getStructureForecastD20BiasPct: (nodePredictionAnalysis) => {
    return nodeStructurePredictionService.getStructureForecastD20BiasPct(nodePredictionAnalysis);
  },

  getStructureAdjustedForecastReturnPct: (payload) => {
    const input = payload || {};

    return nodeStructurePredictionService.getStructureAdjustedForecastReturnPct(
      input.nodePredictionAnalysis,
      input.day,
      input.rawReturnPct,
      input.band || 'median'
    );
  },

  getStructureAdjustedD20MedianPct: (nodePredictionAnalysis) => {
    return nodeStructurePredictionService.getStructureAdjustedD20MedianPct(nodePredictionAnalysis);
  }
});
