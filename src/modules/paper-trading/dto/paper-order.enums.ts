export enum PaperOrderSide {
  BUY = 'buy',
  SELL = 'sell',
}

export enum PaperOrderType {
  MARKET = 'market',
  LIMIT = 'limit',
  STOP_LOSS = 'stop_loss',
  TAKE_PROFIT = 'take_profit',
}

export enum PaperOrderStatus {
  OPEN = 'open',
  FILLED = 'filled',
  CANCELED = 'canceled',
  REJECTED = 'rejected',
}
