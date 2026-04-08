export enum ExchangeType {
  KRAKEN = 'kraken',
  BINANCE = 'binance',
  BINANCE_MANUAL = 'binance-manual',
  COINBASE = 'coinbase',
  NEXO_PRO = 'nexo-pro',
  NEXO_MANUAL = 'nexo-manual',
}

export const SUPPORTED_EXCHANGES = Object.values(ExchangeType);
