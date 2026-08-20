import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { PricesService } from '../prices/prices.service';
import {
  PaperAccount,
  PaperAccountDocument,
} from './schemas/paper-account.schema';
import { PaperOrder, PaperOrderDocument } from './schemas/paper-order.schema';
import {
  PaperPosition,
  PaperPositionDocument,
} from './schemas/paper-position.schema';
import {
  PaperEquitySnapshot,
  PaperEquitySnapshotDocument,
} from './schemas/paper-equity-snapshot.schema';
import { CreatePaperAccountDto } from './dto/create-paper-account.dto';
import { CreatePaperOrderDto } from './dto/create-paper-order.dto';
import {
  PaperOrderFilterDto,
  PaginationDto,
} from './dto/paper-order-filter.dto';
import {
  PaperOrderSide,
  PaperOrderStatus,
  PaperOrderType,
} from './dto/paper-order.enums';
import {
  PaginatedPaperOrdersDto,
  PaperAccountResponseDto,
  PaperOrderResponseDto,
  PaperPerformanceResponseDto,
  PaperPositionResponseDto,
} from './dto/paper-trading-response.dto';

export const PAPER_ORDER_FILLED_EVENT = 'paper.order.filled';

const MIN_NOTIONAL_USDT = 5;
const EPSILON = 1e-9;
const QUOTE_ASSET = 'USDT';
const EQUITY_CURVE_MAX_POINTS = 200;

interface FillResult {
  ok: boolean;
  reason?: string;
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(
    @InjectModel(PaperAccount.name)
    private readonly accountModel: Model<PaperAccountDocument>,
    @InjectModel(PaperOrder.name)
    private readonly orderModel: Model<PaperOrderDocument>,
    @InjectModel(PaperPosition.name)
    private readonly positionModel: Model<PaperPositionDocument>,
    @InjectModel(PaperEquitySnapshot.name)
    private readonly snapshotModel: Model<PaperEquitySnapshotDocument>,
    private readonly pricesService: PricesService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Accounts ────────────────────────────────────────────────────

  async createAccount(
    userId: string,
    dto: CreatePaperAccountDto,
  ): Promise<PaperAccountResponseDto> {
    const name = dto.name ?? 'default';
    const initialBalance = dto.initialBalance ?? 10000;

    const existing = await this.accountModel
      .findOne({ userId: new Types.ObjectId(userId), name })
      .exec();
    if (existing) {
      throw new ConflictException(
        `Paper account '${name}' already exists for this user`,
      );
    }

    const account = new this.accountModel({
      userId: new Types.ObjectId(userId),
      name,
      initialBalance,
      feeRate: dto.feeRate ?? 0.001,
      slippageBps: dto.slippageBps ?? 5,
      balances: { [QUOTE_ASSET]: { free: initialBalance, locked: 0 } },
      isActive: true,
    });
    await account.save();

    this.logger.log(`Paper account '${name}' created for user ${userId}`);
    return this.toAccountResponse(account, {});
  }

  async listAccounts(userId: string): Promise<PaperAccountResponseDto[]> {
    const accounts = await this.accountModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: 1 })
      .exec();

    const assets = new Set<string>();
    for (const account of accounts) {
      for (const asset of Object.keys(account.balances || {})) {
        if (asset !== QUOTE_ASSET) assets.add(asset);
      }
    }
    const pricesMap =
      assets.size > 0
        ? await this.pricesService.getPricesMap(Array.from(assets))
        : {};

    return accounts.map((account) =>
      this.toAccountResponse(account, pricesMap),
    );
  }

  async getAccountDetail(
    userId: string,
    accountId: string,
  ): Promise<PaperAccountResponseDto> {
    const account = await this.getAccountDoc(userId, accountId);
    const pricesMap = await this.getPricesForAccount(account);
    return this.toAccountResponse(account, pricesMap);
  }

  async resetAccount(
    userId: string,
    accountId: string,
  ): Promise<PaperAccountResponseDto> {
    const account = await this.getAccountDoc(userId, accountId);

    await this.orderModel.deleteMany({ accountId: account._id }).exec();
    await this.positionModel.deleteMany({ accountId: account._id }).exec();
    await this.snapshotModel.deleteMany({ accountId: account._id }).exec();

    account.balances = {
      [QUOTE_ASSET]: { free: account.initialBalance, locked: 0 },
    };
    account.markModified('balances');
    await account.save();

    this.logger.log(`Paper account ${accountId} reset for user ${userId}`);
    return this.toAccountResponse(account, {});
  }

  async deleteAccount(
    userId: string,
    accountId: string,
  ): Promise<{ deleted: boolean }> {
    const account = await this.getAccountDoc(userId, accountId);

    await this.orderModel.deleteMany({ accountId: account._id }).exec();
    await this.positionModel.deleteMany({ accountId: account._id }).exec();
    await this.snapshotModel.deleteMany({ accountId: account._id }).exec();
    await account.deleteOne();

    this.logger.log(`Paper account ${accountId} deleted for user ${userId}`);
    return { deleted: true };
  }

  // ── Orders ──────────────────────────────────────────────────────

  async createOrder(
    userId: string,
    dto: CreatePaperOrderDto,
  ): Promise<PaperOrderResponseDto> {
    this.validateOrderInput(dto);
    const { base } = this.parseSymbol(dto.symbol);
    const account = await this.getAccountDoc(userId, dto.accountId);

    const currentPrice = await this.getCurrentPrice(base);
    if (!currentPrice) {
      throw new BadRequestException(
        `No market price available for ${dto.symbol}; order rejected`,
      );
    }

    // Reference price used for quoteAmount conversion and min-notional check
    const referencePrice = this.getReferencePrice(dto, account, currentPrice);
    const amount = dto.amount ?? dto.quoteAmount / referencePrice;
    const notional = amount * referencePrice;
    if (notional < MIN_NOTIONAL_USDT - EPSILON) {
      throw new BadRequestException(
        `Order notional (${notional.toFixed(2)} USDT) is below the minimum of ${MIN_NOTIONAL_USDT} USDT`,
      );
    }

    const order = new this.orderModel({
      userId: new Types.ObjectId(userId),
      accountId: account._id,
      symbol: dto.symbol,
      side: dto.side,
      type: dto.type,
      status: PaperOrderStatus.OPEN,
      amount,
      quoteAmount: dto.quoteAmount,
      limitPrice: dto.limitPrice,
      stopPrice: dto.stopPrice,
      requestedPrice: currentPrice,
      note: dto.note,
    });

    const immediateFillPrice = this.getImmediateFillPrice(
      order,
      account,
      currentPrice,
    );

    // OCO secondary leg: validate the partner before any balance mutation.
    // An OCO leg must stay open (it shares the primary's lock), so a leg
    // that would fill synchronously at creation is rejected.
    let ocoPartner: PaperOrderDocument | null = null;
    if (dto.ocoPartnerId) {
      ocoPartner = await this.validateOcoPartner(userId, dto, account, amount);
      if (immediateFillPrice !== null) {
        throw new BadRequestException(
          'OCO order would trigger immediately at the current price; use a market order instead',
        );
      }
    }

    if (immediateFillPrice !== null) {
      // Taker fill, synchronous (market orders and already-triggered
      // limit/stop orders — documented behavior). Balance changes are
      // applied atomically ($inc guarded by funds conditions) so that
      // concurrent requests / fill-engine cycles cannot double-spend.
      const result = await this.executeFill(account, order, immediateFillPrice);
      if (!result.ok) {
        throw new BadRequestException(result.reason);
      }
      await order.save();
      this.eventEmitter.emit(PAPER_ORDER_FILLED_EVENT, {
        userId,
        order: this.toOrderResponse(order),
      });
    } else if (ocoPartner) {
      // OCO secondary leg: it shares the primary's base-asset lock, so it
      // must NOT lock funds itself. When either leg fills or is canceled
      // the partner cascade-cancels the other (see cancelOcoPartner).
      //
      // Back-link the primary atomically BEFORE persisting the secondary,
      // guarded by status OPEN and an unset ocoPartnerId: a partner that
      // filled / was canceled / got linked concurrently makes this update
      // match nothing and the secondary is never created.
      const linked = await this.orderModel
        .findOneAndUpdate(
          {
            _id: ocoPartner._id,
            status: PaperOrderStatus.OPEN,
            ocoPartnerId: null, // null matches a missing field in Mongo
          },
          { $set: { ocoPartnerId: order._id } },
        )
        .exec();
      if (!linked) {
        throw new BadRequestException('OCO partner is no longer open');
      }
      order.ocoPartnerId = ocoPartner._id as Types.ObjectId;
      try {
        await order.save();
      } catch (error) {
        // Roll back the back-link so the primary is not left pointing at
        // a secondary that was never persisted. Guarded by the secondary's
        // id so a concurrent re-link to another order is never clobbered.
        await this.orderModel
          .updateOne(
            { _id: ocoPartner._id, ocoPartnerId: order._id },
            { $unset: { ocoPartnerId: '' } },
          )
          .exec();
        throw error;
      }
      // Close the back-link window: between the back-link and the save
      // above, the primary may have filled or been canceled — its cascade
      // (cancelOcoPartner) matches nothing on a secondary that is not
      // persisted yet and no-ops silently, which would leave a live,
      // unlocked SELL leg pointing at a terminal partner. Re-verify the
      // link is still live now that the secondary exists; if not, claim
      // the just-saved secondary open -> canceled (it holds no lock, so
      // there is nothing to release) and reject. A primary transition
      // AFTER the save is covered by the normal cascade; both paths are
      // idempotent atomic claims, so the overlap is safe.
      const partnerStillOpen = await this.orderModel
        .findOne({
          _id: ocoPartner._id,
          status: PaperOrderStatus.OPEN,
          ocoPartnerId: order._id,
        })
        .exec();
      if (!partnerStillOpen) {
        await this.orderModel
          .findOneAndUpdate(
            { _id: order._id, status: PaperOrderStatus.OPEN },
            { $set: { status: PaperOrderStatus.CANCELED } },
          )
          .exec();
        throw new BadRequestException('OCO partner is no longer open');
      }
    } else {
      // Open order: lock funds (atomic balance update)
      await this.lockFundsForOpenOrder(account, order);
      await order.save();
    }

    return this.toOrderResponse(order);
  }

  async findOrders(
    userId: string,
    filter: PaperOrderFilterDto,
  ): Promise<PaginatedPaperOrdersDto> {
    const query: FilterQuery<PaperOrder> = {
      userId: new Types.ObjectId(userId),
    };
    if (filter.accountId) {
      query.accountId = new Types.ObjectId(filter.accountId);
    }
    if (filter.status) {
      query.status = filter.status;
    }
    if (filter.symbol) {
      query.symbol = filter.symbol;
    }

    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const [orders, total] = await Promise.all([
      this.orderModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments(query).exec(),
    ]);

    return {
      data: orders.map((order) => this.toOrderResponse(order)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOrderById(
    userId: string,
    orderId: string,
  ): Promise<PaperOrderResponseDto> {
    const order = await this.getOrderDoc(userId, orderId);
    return this.toOrderResponse(order);
  }

  async cancelOrder(
    userId: string,
    orderId: string,
  ): Promise<PaperOrderResponseDto> {
    const order = await this.getOrderDoc(userId, orderId);
    if (order.status !== PaperOrderStatus.OPEN) {
      throw new BadRequestException(
        `Only open orders can be canceled (current status: ${order.status})`,
      );
    }

    // Atomic open -> canceled transition: only the writer that wins this
    // claim releases the locked funds. A concurrent fill-engine cycle that
    // claims the order first makes this update match nothing, so a filled
    // order can never be reported as canceled (and vice versa).
    const claimed = await this.orderModel
      .findOneAndUpdate(
        { _id: order._id, status: PaperOrderStatus.OPEN },
        {
          $set: { status: PaperOrderStatus.CANCELED },
          $unset: { lockedAmount: '', lockedAsset: '' },
        },
      )
      .exec();
    if (!claimed) {
      throw new BadRequestException(
        'Only open orders can be canceled (the order was filled or canceled concurrently)',
      );
    }

    await this.releaseLockedFunds(
      order.accountId,
      claimed.lockedAsset,
      claimed.lockedAmount,
    );

    // OCO: cancelling one leg cancels the pair (Binance semantics).
    if (claimed.ocoPartnerId) {
      await this.cancelOcoPartner(claimed.ocoPartnerId, order.accountId);
    }

    order.status = PaperOrderStatus.CANCELED;
    order.lockedAmount = undefined;
    order.lockedAsset = undefined;
    return this.toOrderResponse(order);
  }

  // ── Positions / performance / trades ────────────────────────────

  async getPositions(
    userId: string,
    accountId: string,
  ): Promise<PaperPositionResponseDto[]> {
    const account = await this.getAccountDoc(userId, accountId);
    const positions = await this.positionModel
      .find({ accountId: account._id })
      .exec();

    const assets = positions.map((p) => p.asset);
    const pricesMap =
      assets.length > 0 ? await this.pricesService.getPricesMap(assets) : {};

    return positions.map((position) => {
      const currentPrice = pricesMap[position.asset] || 0;
      const valueUsd = position.amount * currentPrice;
      const costBasis = position.amount * position.avgEntryPrice;
      const unrealizedPnl =
        position.amount > 0 && currentPrice > 0 ? valueUsd - costBasis : 0;
      return {
        asset: position.asset,
        amount: position.amount,
        avgEntryPrice: position.avgEntryPrice,
        currentPrice,
        valueUsd,
        unrealizedPnl,
        unrealizedPnlPct:
          costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
        realizedPnl: position.realizedPnl,
      };
    });
  }

  async getPerformance(
    userId: string,
    accountId: string,
  ): Promise<PaperPerformanceResponseDto> {
    const account = await this.getAccountDoc(userId, accountId);
    const pricesMap = await this.getPricesForAccount(account);
    const equity = this.computeEquity(account, pricesMap);

    const positions = await this.positionModel
      .find({ accountId: account._id })
      .exec();
    const realizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const feesPaid = positions.reduce((sum, p) => sum + p.feesPaid, 0);
    const unrealizedPnl = positions.reduce((sum, p) => {
      const price = pricesMap[p.asset] || 0;
      if (p.amount <= 0 || price <= 0) return sum;
      return sum + (price - p.avgEntryPrice) * p.amount;
    }, 0);

    const [totalTrades, openOrders, sells] = await Promise.all([
      this.orderModel
        .countDocuments({
          accountId: account._id,
          status: PaperOrderStatus.FILLED,
        })
        .exec(),
      this.orderModel
        .countDocuments({
          accountId: account._id,
          status: PaperOrderStatus.OPEN,
        })
        .exec(),
      this.orderModel
        .find({
          accountId: account._id,
          status: PaperOrderStatus.FILLED,
          side: PaperOrderSide.SELL,
        })
        .select('realizedPnl')
        .exec(),
    ]);

    const winRate =
      sells.length > 0
        ? sells.filter((s) => (s.realizedPnl ?? 0) > 0).length / sells.length
        : null;

    const snapshots = await this.snapshotModel
      .find({ accountId: account._id })
      .sort({ timestamp: 1 })
      .exec();

    const equityCurve = this.downsampleEquityCurve(
      snapshots.map((s) => ({ timestamp: s.timestamp, equity: s.equity })),
    );
    const maxDrawdownPct = this.computeMaxDrawdownPct(
      snapshots.map((s) => s.equity),
    );

    return {
      initialBalance: account.initialBalance,
      equity,
      totalPnl: equity - account.initialBalance,
      totalPnlPct:
        ((equity - account.initialBalance) / account.initialBalance) * 100,
      realizedPnl,
      unrealizedPnl,
      feesPaid,
      totalTrades,
      winRate,
      maxDrawdownPct,
      openOrders,
      equityCurve,
    };
  }

  async getTrades(
    userId: string,
    accountId: string,
    pagination: PaginationDto,
  ): Promise<PaginatedPaperOrdersDto> {
    const account = await this.getAccountDoc(userId, accountId);
    const query: FilterQuery<PaperOrder> = {
      accountId: account._id,
      status: PaperOrderStatus.FILLED,
    };

    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const [orders, total] = await Promise.all([
      this.orderModel
        .find(query)
        .sort({ filledAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments(query).exec(),
    ]);

    return {
      data: orders.map((order) => this.toOrderResponse(order)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ── Fill engine entry points (used by PaperFillEngineService) ────

  async findOpenOrders(): Promise<PaperOrderDocument[]> {
    return this.orderModel
      .find({ status: PaperOrderStatus.OPEN })
      .sort({ accountId: 1, createdAt: 1 })
      .exec();
  }

  async findActiveAccounts(): Promise<PaperAccountDocument[]> {
    return this.accountModel.find({ isActive: true }).exec();
  }

  async findAccountById(
    accountId: Types.ObjectId,
  ): Promise<PaperAccountDocument | null> {
    return this.accountModel.findById(accountId).exec();
  }

  /**
   * Evaluates an open order against the current market price and fills it
   * if its trigger condition is met. Returns true when the order filled.
   */
  async processOpenOrder(
    order: PaperOrderDocument,
    account: PaperAccountDocument,
    currentPrice: number,
  ): Promise<boolean> {
    const fillPrice = this.evaluateTrigger(order, account, currentPrice);
    if (fillPrice === null) {
      return false;
    }

    // Atomic claim of the OPEN order. This guards against a concurrent
    // cancel (DELETE /orders/:id) and against another fill-engine
    // instance processing the same order: whoever wins the open ->
    // filled/canceled transition owns the locked funds.
    const claimed = await this.orderModel
      .findOneAndUpdate(
        { _id: order._id, status: PaperOrderStatus.OPEN },
        { $set: { status: PaperOrderStatus.FILLED } },
      )
      .exec();
    if (!claimed) {
      // Canceled (or processed by another instance) since the cycle
      // snapshot was taken: skip silently.
      return false;
    }

    // OCO: cancel the partner leg BEFORE executing the fill. When the
    // unlocked secondary leg triggers, cancelling the primary releases
    // the shared base lock back to free, so executeFill's funds
    // condition passes. When the primary fills, the secondary holds no
    // lock and the cascade releases nothing.
    if (claimed.ocoPartnerId) {
      await this.cancelOcoPartner(claimed.ocoPartnerId, order.accountId);
    }

    // Use the lock info from the claimed snapshot — the in-memory doc
    // from the cycle snapshot may be stale.
    order.lockedAmount = claimed.lockedAmount;
    order.lockedAsset = claimed.lockedAsset;

    let result = await this.executeFill(account, order, fillPrice);

    if (
      !result.ok &&
      order.side === PaperOrderSide.BUY &&
      (order.type === PaperOrderType.STOP_LOSS ||
        order.type === PaperOrderType.TAKE_PROFIT)
    ) {
      // The price overshot the stop between lock and trigger, so the
      // locked USDT (stopPrice + fee + slippage) no longer covers the
      // fill: clamp the amount to the funds actually available instead
      // of rejecting the protective order.
      if (this.clampBuyAmountToFunds(account, order, fillPrice)) {
        result = await this.executeFill(account, order, fillPrice);
      }
    }

    if (!result.ok) {
      // Funds no longer cover the fill: reject and release the lock
      // (executeFill did not touch balances when it failed).
      this.logger.warn(
        `Rejecting paper order ${order._id} at trigger: ${result.reason}`,
      );
      order.status = PaperOrderStatus.REJECTED;
      order.rejectReason = result.reason;
      await this.releaseLockedFunds(
        order.accountId,
        claimed.lockedAsset,
        claimed.lockedAmount,
      );
      order.lockedAmount = undefined;
      order.lockedAsset = undefined;
    }

    await order.save();

    if (result.ok) {
      this.eventEmitter.emit(PAPER_ORDER_FILLED_EVENT, {
        userId: order.userId.toString(),
        order: this.toOrderResponse(order),
      });
    }
    return result.ok;
  }

  async captureEquitySnapshots(): Promise<number> {
    const accounts = await this.findActiveAccounts();
    if (accounts.length === 0) {
      return 0;
    }

    const assets = new Set<string>();
    for (const account of accounts) {
      for (const asset of Object.keys(account.balances || {})) {
        if (asset !== QUOTE_ASSET) assets.add(asset);
      }
    }
    const pricesMap =
      assets.size > 0
        ? await this.pricesService.getPricesMap(Array.from(assets))
        : {};

    const timestamp = new Date();
    const snapshots: Partial<PaperEquitySnapshot>[] = [];
    for (const account of accounts) {
      // If any held asset has no current price, valuing it at 0 would
      // record a fake equity crash that permanently corrupts the equity
      // curve and maxDrawdownPct. Skip the account this cycle instead
      // (same semantics as open orders when a price is missing).
      const hasUnpricedHolding = Object.entries(account.balances || {}).some(
        ([asset, balance]) => {
          if (asset === QUOTE_ASSET) return false;
          const total = (balance.free || 0) + (balance.locked || 0);
          return total > EPSILON && !(pricesMap[asset] > 0);
        },
      );
      if (hasUnpricedHolding) {
        this.logger.warn(
          `Skipping equity snapshot for paper account ${account._id}: missing price for held asset(s)`,
        );
        continue;
      }
      snapshots.push({
        userId: account.userId,
        accountId: account._id as Types.ObjectId,
        timestamp,
        equity: this.computeEquity(account, pricesMap),
      });
    }
    if (snapshots.length === 0) {
      return 0;
    }
    await this.snapshotModel.insertMany(snapshots);
    return snapshots.length;
  }

  // ── Engine math (public for unit testing) ───────────────────────

  /**
   * Taker fill price with slippage applied against the order side.
   */
  applySlippage(
    price: number,
    side: PaperOrderSide,
    slippageBps: number,
  ): number {
    const factor =
      side === PaperOrderSide.BUY
        ? 1 + slippageBps / 10000
        : 1 - slippageBps / 10000;
    return price * factor;
  }

  /**
   * Returns the fill price for an open order given the current price,
   * or null if the trigger condition is not met.
   * - limit fills at the exact limitPrice (maker, no slippage)
   * - stop_loss / take_profit execute as market on trigger (slippage
   *   applied over the trigger price)
   */
  evaluateTrigger(
    order: Pick<PaperOrder, 'type' | 'side' | 'limitPrice' | 'stopPrice'>,
    account: Pick<PaperAccount, 'slippageBps'>,
    currentPrice: number,
  ): number | null {
    const isBuy = order.side === PaperOrderSide.BUY;

    if (order.type === PaperOrderType.LIMIT) {
      const triggered = isBuy
        ? currentPrice <= order.limitPrice
        : currentPrice >= order.limitPrice;
      return triggered ? order.limitPrice : null;
    }

    if (order.type === PaperOrderType.STOP_LOSS) {
      const triggered = isBuy
        ? currentPrice >= order.stopPrice
        : currentPrice <= order.stopPrice;
      return triggered
        ? this.applySlippage(currentPrice, order.side, account.slippageBps)
        : null;
    }

    if (order.type === PaperOrderType.TAKE_PROFIT) {
      const triggered = isBuy
        ? currentPrice <= order.stopPrice
        : currentPrice >= order.stopPrice;
      return triggered
        ? this.applySlippage(currentPrice, order.side, account.slippageBps)
        : null;
    }

    return null;
  }

  computeEquity(
    account: Pick<PaperAccount, 'balances'>,
    pricesMap: Record<string, number>,
  ): number {
    let equity = 0;
    for (const [asset, balance] of Object.entries(account.balances || {})) {
      const total = (balance.free || 0) + (balance.locked || 0);
      if (asset === QUOTE_ASSET) {
        equity += total;
      } else {
        equity += total * (pricesMap[asset] || 0);
      }
    }
    return equity;
  }

  computeMaxDrawdownPct(equities: number[]): number {
    let peak = 0;
    let maxDrawdown = 0;
    for (const equity of equities) {
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const drawdown = (peak - equity) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }
    }
    return maxDrawdown * 100;
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * Applies a fill atomically against account balances (a single $inc
   * update guarded by sufficient-funds conditions), then updates the
   * position and the order doc fields. The order's locked funds (if any)
   * are released as part of the same atomic update, so concurrent API
   * requests / fill-engine cycles can neither double-spend nor lose
   * updates. Does NOT save the order document.
   */
  private async executeFill(
    account: PaperAccountDocument,
    order: PaperOrderDocument,
    fillPrice: number,
  ): Promise<FillResult> {
    const { base } = this.parseSymbol(order.symbol);
    const notional = order.amount * fillPrice;
    const fee = account.feeRate * notional;
    const lockedAmount = order.lockedAmount ?? 0;
    const lockedAsset = lockedAmount > 0 ? order.lockedAsset : undefined;

    const deltas: Record<string, number> = {};
    const conditions: Record<string, number> = {};
    const addDelta = (path: string, value: number) => {
      deltas[path] = (deltas[path] ?? 0) + value;
    };

    // Release the order's own locked funds in the same atomic update
    if (lockedAsset) {
      addDelta(`${lockedAsset}.locked`, -lockedAmount);
      addDelta(`${lockedAsset}.free`, lockedAmount);
      conditions[`${lockedAsset}.locked`] = lockedAmount;
    }

    if (order.side === PaperOrderSide.BUY) {
      const cost = notional + fee;
      addDelta(`${QUOTE_ASSET}.free`, -cost);
      addDelta(`${base}.free`, order.amount);
      addDelta(`${base}.locked`, 0); // materialize the field if missing
      const requiredFree =
        cost - (lockedAsset === QUOTE_ASSET ? lockedAmount : 0);
      if (requiredFree > 0) {
        conditions[`${QUOTE_ASSET}.free`] = requiredFree;
      }
    } else {
      addDelta(`${base}.free`, -order.amount);
      addDelta(`${QUOTE_ASSET}.free`, notional - fee);
      const requiredFree =
        order.amount - (lockedAsset === base ? lockedAmount : 0);
      if (requiredFree > 0) {
        conditions[`${base}.free`] = requiredFree;
      }
    }

    const updated = await this.applyBalanceDeltas(
      account._id as Types.ObjectId,
      deltas,
      conditions,
    );
    if (!updated) {
      // Conditions not met: nothing was changed. Refresh the in-memory
      // balances so error messages / later cycles see current values.
      const fresh = await this.accountModel.findById(account._id).exec();
      if (fresh) {
        account.balances = fresh.balances;
      }
      const usdtFree = account.balances?.[QUOTE_ASSET]?.free ?? 0;
      const baseFree = account.balances?.[base]?.free ?? 0;
      if (order.side === PaperOrderSide.BUY) {
        const available =
          usdtFree + (lockedAsset === QUOTE_ASSET ? lockedAmount : 0);
        return {
          ok: false,
          reason: `Insufficient USDT balance: required ${(notional + fee).toFixed(2)} (notional + fee), available ${available.toFixed(2)}`,
        };
      }
      const availableBase =
        baseFree + (lockedAsset === base ? lockedAmount : 0);
      return {
        ok: false,
        reason: `Insufficient ${base} balance: required ${order.amount}, available ${availableBase}`,
      };
    }
    account.balances = updated.balances;
    order.lockedAmount = undefined;
    order.lockedAsset = undefined;

    const realizedPnl = await this.applyFillToPosition(
      order.userId,
      account._id as Types.ObjectId,
      base,
      order.side,
      order.amount,
      fillPrice,
      fee,
    );

    order.status = PaperOrderStatus.FILLED;
    order.filledPrice = fillPrice;
    order.filledAt = new Date();
    order.fee = fee;
    order.feeAsset = QUOTE_ASSET;
    if (order.side === PaperOrderSide.SELL) {
      order.realizedPnl = realizedPnl;
    }
    return { ok: true };
  }

  /**
   * Average-cost position accounting. Returns realized PnL for sells.
   */
  private async applyFillToPosition(
    userId: Types.ObjectId,
    accountId: Types.ObjectId,
    asset: string,
    side: PaperOrderSide,
    amount: number,
    fillPrice: number,
    fee: number,
  ): Promise<number | undefined> {
    let position = await this.positionModel
      .findOne({ accountId, asset })
      .exec();
    if (!position) {
      position = new this.positionModel({
        userId,
        accountId,
        asset,
        amount: 0,
        avgEntryPrice: 0,
        realizedPnl: 0,
        feesPaid: 0,
      });
    }

    let realizedPnl: number | undefined;
    if (side === PaperOrderSide.BUY) {
      const totalAmount = position.amount + amount;
      position.avgEntryPrice =
        totalAmount > 0
          ? (amount * fillPrice + position.amount * position.avgEntryPrice) /
            totalAmount
          : 0;
      position.amount = totalAmount;
    } else {
      let sellAmount = amount;
      if (sellAmount > position.amount + EPSILON) {
        this.logger.warn(
          `Paper position ${asset} (account ${accountId}): selling ${sellAmount} but position holds ${position.amount}; clamping`,
        );
        sellAmount = Math.max(position.amount, 0);
      }
      realizedPnl = (fillPrice - position.avgEntryPrice) * sellAmount - fee;
      position.realizedPnl += realizedPnl;
      position.amount = Math.max(position.amount - sellAmount, 0);
    }
    position.feesPaid += fee;
    await position.save();
    return realizedPnl;
  }

  /**
   * For orders that stay open: locks the funds needed for the eventual
   * fill, atomically and guarded by a sufficient-funds condition.
   * Buys lock USDT at the limit/stop price (fee included; stop/take-profit
   * buys also include taker slippage since they execute as market on
   * trigger); sells lock base.
   */
  private async lockFundsForOpenOrder(
    account: PaperAccountDocument,
    order: PaperOrderDocument,
  ): Promise<void> {
    const { base } = this.parseSymbol(order.symbol);

    if (order.side === PaperOrderSide.BUY) {
      const referencePrice =
        order.type === PaperOrderType.LIMIT
          ? order.limitPrice
          : order.stopPrice;
      // Limit buys fill at the exact limitPrice (maker, no slippage);
      // stop/take-profit buys execute as market on trigger, so the lock
      // must also cover the slippage over the trigger price.
      const slippageFactor =
        order.type === PaperOrderType.LIMIT
          ? 1
          : 1 + account.slippageBps / 10000;
      const lockAmount =
        order.amount * referencePrice * (1 + account.feeRate) * slippageFactor;
      const updated = await this.applyBalanceDeltas(
        account._id as Types.ObjectId,
        {
          [`${QUOTE_ASSET}.free`]: -lockAmount,
          [`${QUOTE_ASSET}.locked`]: lockAmount,
        },
        { [`${QUOTE_ASSET}.free`]: lockAmount },
      );
      if (!updated) {
        const free = account.balances?.[QUOTE_ASSET]?.free ?? 0;
        throw new BadRequestException(
          `Insufficient USDT balance: required ${lockAmount.toFixed(2)} to lock, available ${free.toFixed(2)}`,
        );
      }
      account.balances = updated.balances;
      order.lockedAmount = lockAmount;
      order.lockedAsset = QUOTE_ASSET;
    } else {
      const updated = await this.applyBalanceDeltas(
        account._id as Types.ObjectId,
        {
          [`${base}.free`]: -order.amount,
          [`${base}.locked`]: order.amount,
        },
        { [`${base}.free`]: order.amount },
      );
      if (!updated) {
        const free = account.balances?.[base]?.free ?? 0;
        throw new BadRequestException(
          `Insufficient ${base} balance: required ${order.amount}, available ${free}`,
        );
      }
      account.balances = updated.balances;
      order.lockedAmount = order.amount;
      order.lockedAsset = base;
    }
  }

  /**
   * Atomically applies per-path balance deltas ($inc) guarded by minimum
   * balance conditions. Returns the updated account doc, or null when a
   * condition is not met (insufficient funds) — in that case nothing is
   * modified.
   */
  private async applyBalanceDeltas(
    accountId: Types.ObjectId,
    deltas: Record<string, number>,
    conditions: Record<string, number> = {},
  ): Promise<PaperAccountDocument | null> {
    const filter: Record<string, unknown> = { _id: accountId };
    for (const [path, min] of Object.entries(conditions)) {
      filter[`balances.${path}`] = { $gte: min - EPSILON };
    }
    const inc: Record<string, number> = {};
    for (const [path, delta] of Object.entries(deltas)) {
      inc[`balances.${path}`] = delta;
    }
    return this.accountModel
      .findOneAndUpdate(filter, { $inc: inc }, { new: true })
      .exec();
  }

  /**
   * Releases funds locked by a single order back to free, exactly once
   * (callers must have atomically claimed the order's open -> terminal
   * transition first). Clamps defensively if the aggregate locked balance
   * no longer covers the order's lock, so other orders' locked funds are
   * never stolen.
   */
  private async releaseLockedFunds(
    accountId: Types.ObjectId,
    lockedAsset?: string,
    lockedAmount?: number,
  ): Promise<void> {
    if (!lockedAsset || !lockedAmount) {
      return;
    }
    const updated = await this.applyBalanceDeltas(
      accountId,
      {
        [`${lockedAsset}.locked`]: -lockedAmount,
        [`${lockedAsset}.free`]: lockedAmount,
      },
      { [`${lockedAsset}.locked`]: lockedAmount },
    );
    if (!updated) {
      // Should not happen with exactly-once claims; clamp to the actual
      // locked balance rather than driving it negative.
      const account = await this.accountModel.findById(accountId).exec();
      const currentLocked = account?.balances?.[lockedAsset]?.locked ?? 0;
      const release = Math.min(lockedAmount, Math.max(currentLocked, 0));
      this.logger.warn(
        `Locked balance mismatch on account ${accountId}: expected >= ${lockedAmount} ${lockedAsset} locked, found ${currentLocked}; releasing ${release}`,
      );
      if (release > 0) {
        await this.applyBalanceDeltas(accountId, {
          [`${lockedAsset}.locked`]: -release,
          [`${lockedAsset}.free`]: release,
        });
      }
    }
  }

  /**
   * Cancels the OCO partner leg of an order that just filled or was
   * canceled (One-Cancels-Other). The open -> canceled transition is
   * atomic, so only one writer ever releases the partner's locked funds;
   * the secondary leg holds no lock, so cancelling it releases nothing.
   * A partner already in a terminal status is a silent no-op (e.g. both
   * legs canceled each other concurrently).
   */
  private async cancelOcoPartner(
    partnerId: Types.ObjectId,
    accountId: Types.ObjectId,
  ): Promise<void> {
    const claimed = await this.orderModel
      .findOneAndUpdate(
        { _id: partnerId, status: PaperOrderStatus.OPEN },
        {
          $set: { status: PaperOrderStatus.CANCELED },
          $unset: { lockedAmount: '', lockedAsset: '' },
        },
      )
      .exec();
    if (!claimed) {
      return;
    }
    await this.releaseLockedFunds(
      accountId,
      claimed.lockedAsset,
      claimed.lockedAmount,
    );
  }

  /**
   * Validates the primary leg of a SELL-only OCO bracket. The new order
   * (secondary) shares the primary's base-asset lock, so both legs must
   * be open SELL orders on the same account/symbol with the same amount,
   * and the primary must not already belong to another OCO pair.
   */
  private async validateOcoPartner(
    userId: string,
    dto: CreatePaperOrderDto,
    account: PaperAccountDocument,
    amount: number,
  ): Promise<PaperOrderDocument> {
    const partner = await this.getOrderDoc(userId, dto.ocoPartnerId);
    if (dto.type === PaperOrderType.MARKET) {
      throw new BadRequestException(
        'OCO is not supported for market orders (an OCO leg must stay open)',
      );
    }
    if (
      dto.side !== PaperOrderSide.SELL ||
      partner.side !== PaperOrderSide.SELL
    ) {
      throw new BadRequestException(
        'OCO is only supported for sell brackets (both legs must be sell orders)',
      );
    }
    if (partner.status !== PaperOrderStatus.OPEN) {
      throw new BadRequestException(
        `OCO partner must be an open order (current status: ${partner.status})`,
      );
    }
    if (!partner.accountId.equals(account._id as Types.ObjectId)) {
      throw new BadRequestException(
        'OCO partner belongs to a different paper account',
      );
    }
    if (partner.symbol !== dto.symbol) {
      throw new BadRequestException(
        `OCO partner symbol (${partner.symbol}) does not match ${dto.symbol}`,
      );
    }
    if (Math.abs(partner.amount - amount) > EPSILON) {
      throw new BadRequestException(
        `OCO legs must have the same amount (partner: ${partner.amount}, this order: ${amount}); they share a single lock`,
      );
    }
    if (partner.ocoPartnerId) {
      throw new BadRequestException(
        'OCO partner is already linked to another OCO order',
      );
    }
    return partner;
  }

  /**
   * When a triggered stop/take-profit BUY no longer fits the available
   * funds (the price overshot the stop between lock and trigger), clamp
   * the amount to what the account can actually pay instead of rejecting
   * the protective order. Returns true when the amount was clamped.
   */
  private clampBuyAmountToFunds(
    account: PaperAccountDocument,
    order: PaperOrderDocument,
    fillPrice: number,
  ): boolean {
    const free = account.balances?.[QUOTE_ASSET]?.free ?? 0;
    const available =
      free +
      (order.lockedAsset === QUOTE_ASSET ? (order.lockedAmount ?? 0) : 0);
    const maxAmount =
      (available / (fillPrice * (1 + account.feeRate))) * (1 - 1e-9);
    if (!(maxAmount > 0) || maxAmount >= order.amount) {
      return false;
    }
    if (maxAmount * fillPrice < MIN_NOTIONAL_USDT) {
      return false;
    }
    this.logger.warn(
      `Clamping paper order ${order._id} amount from ${order.amount} to ${maxAmount} to fit available funds at trigger`,
    );
    order.amount = maxAmount;
    return true;
  }

  /**
   * Returns the taker fill price when the order should fill synchronously
   * at creation time (market orders, marketable limits, already-triggered
   * stops), or null when it must stay open.
   */
  private getImmediateFillPrice(
    order: PaperOrderDocument,
    account: PaperAccountDocument,
    currentPrice: number,
  ): number | null {
    if (order.type === PaperOrderType.MARKET) {
      return this.applySlippage(currentPrice, order.side, account.slippageBps);
    }

    const isBuy = order.side === PaperOrderSide.BUY;
    if (order.type === PaperOrderType.LIMIT) {
      const marketable = isBuy
        ? order.limitPrice >= currentPrice
        : order.limitPrice <= currentPrice;
      return marketable
        ? this.applySlippage(currentPrice, order.side, account.slippageBps)
        : null;
    }

    // stop_loss / take_profit already triggered at creation -> execute now
    let triggered = false;
    if (order.type === PaperOrderType.STOP_LOSS) {
      triggered = isBuy
        ? currentPrice >= order.stopPrice
        : currentPrice <= order.stopPrice;
    } else if (order.type === PaperOrderType.TAKE_PROFIT) {
      triggered = isBuy
        ? currentPrice <= order.stopPrice
        : currentPrice >= order.stopPrice;
    }
    return triggered
      ? this.applySlippage(currentPrice, order.side, account.slippageBps)
      : null;
  }

  private getReferencePrice(
    dto: CreatePaperOrderDto,
    account: PaperAccountDocument,
    currentPrice: number,
  ): number {
    switch (dto.type) {
      case PaperOrderType.LIMIT:
        return dto.limitPrice;
      case PaperOrderType.STOP_LOSS:
      case PaperOrderType.TAKE_PROFIT:
        return dto.stopPrice;
      default:
        return this.applySlippage(currentPrice, dto.side, account.slippageBps);
    }
  }

  private validateOrderInput(dto: CreatePaperOrderDto): void {
    const hasAmount = dto.amount !== undefined && dto.amount !== null;
    const hasQuoteAmount =
      dto.quoteAmount !== undefined && dto.quoteAmount !== null;
    if (hasAmount === hasQuoteAmount) {
      throw new BadRequestException(
        'Exactly one of amount or quoteAmount must be provided',
      );
    }
    if (dto.type === PaperOrderType.LIMIT && !dto.limitPrice) {
      throw new BadRequestException('limitPrice is required for limit orders');
    }
    if (
      (dto.type === PaperOrderType.STOP_LOSS ||
        dto.type === PaperOrderType.TAKE_PROFIT) &&
      !dto.stopPrice
    ) {
      throw new BadRequestException(
        'stopPrice is required for stop_loss/take_profit orders',
      );
    }
  }

  parseSymbol(symbol: string): { base: string; quote: string } {
    const parts = (symbol || '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new BadRequestException(
        `Invalid symbol '${symbol}': expected BASE/QUOTE format (e.g. BTC/USDT)`,
      );
    }
    const [base, quote] = parts;
    if (quote !== QUOTE_ASSET) {
      throw new BadRequestException(
        `Only ${QUOTE_ASSET}-quoted pairs are supported (got '${symbol}')`,
      );
    }
    if (base === QUOTE_ASSET) {
      throw new BadRequestException(`Invalid symbol '${symbol}'`);
    }
    return { base, quote };
  }

  async getCurrentPrice(baseAsset: string): Promise<number | null> {
    try {
      const pricesMap = await this.pricesService.getPricesMap([baseAsset]);
      const price = pricesMap[baseAsset];
      return price && price > 0 ? price : null;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch price for ${baseAsset}: ${error.message}`,
      );
      return null;
    }
  }

  private async getPricesForAccount(
    account: PaperAccountDocument,
  ): Promise<Record<string, number>> {
    const assets = Object.keys(account.balances || {}).filter(
      (asset) => asset !== QUOTE_ASSET,
    );
    return assets.length > 0
      ? await this.pricesService.getPricesMap(assets)
      : {};
  }

  private downsampleEquityCurve(
    points: { timestamp: Date; equity: number }[],
  ): { timestamp: Date; equity: number }[] {
    if (points.length <= EQUITY_CURVE_MAX_POINTS) {
      return points;
    }
    const step = points.length / EQUITY_CURVE_MAX_POINTS;
    const sampled: { timestamp: Date; equity: number }[] = [];
    for (let i = 0; i < EQUITY_CURVE_MAX_POINTS; i++) {
      sampled.push(points[Math.floor(i * step)]);
    }
    // Always keep the most recent point
    sampled[sampled.length - 1] = points[points.length - 1];
    return sampled;
  }

  private async getAccountDoc(
    userId: string,
    accountId: string,
  ): Promise<PaperAccountDocument> {
    if (!Types.ObjectId.isValid(accountId)) {
      throw new NotFoundException(`Paper account ${accountId} not found`);
    }
    const account = await this.accountModel
      .findOne({
        _id: new Types.ObjectId(accountId),
        userId: new Types.ObjectId(userId),
      })
      .exec();
    if (!account) {
      throw new NotFoundException(`Paper account ${accountId} not found`);
    }
    return account;
  }

  private async getOrderDoc(
    userId: string,
    orderId: string,
  ): Promise<PaperOrderDocument> {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new NotFoundException(`Paper order ${orderId} not found`);
    }
    const order = await this.orderModel
      .findOne({
        _id: new Types.ObjectId(orderId),
        userId: new Types.ObjectId(userId),
      })
      .exec();
    if (!order) {
      throw new NotFoundException(`Paper order ${orderId} not found`);
    }
    return order;
  }

  private toAccountResponse(
    account: PaperAccountDocument,
    pricesMap: Record<string, number>,
  ): PaperAccountResponseDto {
    const equity = this.computeEquity(account, pricesMap);
    return {
      id: account._id.toString(),
      name: account.name,
      initialBalance: account.initialBalance,
      feeRate: account.feeRate,
      slippageBps: account.slippageBps,
      balances: account.balances,
      equity,
      totalPnl: equity - account.initialBalance,
      totalPnlPct:
        ((equity - account.initialBalance) / account.initialBalance) * 100,
      createdAt: (account as any).createdAt,
    };
  }

  private toOrderResponse(order: PaperOrderDocument): PaperOrderResponseDto {
    return {
      id: order._id.toString(),
      accountId: order.accountId.toString(),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: order.status,
      amount: order.amount,
      quoteAmount: order.quoteAmount,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      requestedPrice: order.requestedPrice,
      filledPrice: order.filledPrice,
      filledAt: order.filledAt,
      fee: order.fee,
      feeAsset: order.feeAsset,
      note: order.note,
      rejectReason: order.rejectReason,
      realizedPnl: order.realizedPnl,
      ocoPartnerId: order.ocoPartnerId?.toString(),
      createdAt: (order as any).createdAt,
    };
  }
}
