export enum ExchangeType {
  KRAKEN = 'kraken',
  BINANCE = 'binance',
  NEXO_PRO = 'nexo-pro',
  NEXO_MANUAL = 'nexo-manual',
}

export const SUPPORTED_EXCHANGES = Object.values(ExchangeType);
