const DEFAULT_FEE_CONFIG = {
  commissionRate: 0.00025,
  minCommission: 5,
  stampTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageRate: 0.0005
};

function getNonNegativeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function resolveFeeConfig(feeConfig) {
  const source = feeConfig || {};

  return {
    commissionRate: getNonNegativeNumber(source.commissionRate, DEFAULT_FEE_CONFIG.commissionRate),
    minCommission: getNonNegativeNumber(source.minCommission, DEFAULT_FEE_CONFIG.minCommission),
    stampTaxRate: getNonNegativeNumber(source.stampTaxRate, DEFAULT_FEE_CONFIG.stampTaxRate),
    transferFeeRate: getNonNegativeNumber(source.transferFeeRate, DEFAULT_FEE_CONFIG.transferFeeRate),
    slippageRate: getNonNegativeNumber(source.slippageRate, DEFAULT_FEE_CONFIG.slippageRate)
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function calculateBuyFee(buyAmount, feeConfig) {
  const config = resolveFeeConfig(feeConfig);

  const amount = Number(buyAmount || 0);
  const commission = amount > 0 ? Math.max(amount * config.commissionRate, config.minCommission) : 0;
  const transferFee = amount * config.transferFeeRate;

  return {
    buyCommission: roundMoney(commission),
    buyTransferFee: roundMoney(transferFee),
    totalBuyFee: roundMoney(commission + transferFee)
  };
}

function calculateSellFee(sellAmount, feeConfig) {
  const config = resolveFeeConfig(feeConfig);

  const amount = Number(sellAmount || 0);
  const commission = amount > 0 ? Math.max(amount * config.commissionRate, config.minCommission) : 0;
  const stampTax = amount * config.stampTaxRate;
  const transferFee = amount * config.transferFeeRate;

  return {
    sellCommission: roundMoney(commission),
    stampTax: roundMoney(stampTax),
    sellTransferFee: roundMoney(transferFee),
    totalSellFee: roundMoney(commission + stampTax + transferFee)
  };
}

function calculateTradeFees(input, feeConfig) {
  const buy = calculateBuyFee(input.buyAmount, feeConfig);
  const sell = calculateSellFee(input.sellAmount, feeConfig);

  return {
    ...buy,
    ...sell,
    totalFees: roundMoney(buy.totalBuyFee + sell.totalSellFee)
  };
}

function applyBuySlippage(price, feeConfig) {
  const config = resolveFeeConfig(feeConfig);

  return Number(price) * (1 + config.slippageRate);
}

function applySellSlippage(price, feeConfig) {
  const config = resolveFeeConfig(feeConfig);

  return Number(price) * (1 - config.slippageRate);
}

module.exports = {
  DEFAULT_FEE_CONFIG,
  resolveFeeConfig,
  calculateBuyFee,
  calculateSellFee,
  calculateTradeFees,
  applyBuySlippage,
  applySellSlippage,
  roundMoney
};
