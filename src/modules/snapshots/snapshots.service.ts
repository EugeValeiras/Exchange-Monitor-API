import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DailySnapshot,
  DailySnapshotDocument,
  AssetBalance,
  ExchangeBalance,
} from './schemas/daily-snapshot.schema';
import {
  HourlySnapshot,
  HourlySnapshotDocument,
  SnapshotAssetBalance,
} from './schemas/hourly-snapshot.schema';
import { BalancesService } from '../balances/balances.service';
import { PricesService } from '../prices/prices.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionDocument } from '../transactions/schemas/transaction.schema';
import { TransactionType } from '../../common/constants/transaction-types.constant';
import {
  SnapshotResponseDto,
  SnapshotCompareDto,
  ChartDataResponseDto,
  ChartDataByAssetResponseDto,
  AssetChartDataDto,
  RebuildHistoryResponseDto,
} from './dto/snapshot-response.dto';

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    @InjectModel(DailySnapshot.name)
    private snapshotModel: Model<DailySnapshotDocument>,
    @InjectModel(HourlySnapshot.name)
    private hourlySnapshotModel: Model<HourlySnapshotDocument>,
    private readonly balancesService: BalancesService,
    private readonly pricesService: PricesService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
  ) {}

  async generateSnapshot(userId: string | Types.ObjectId): Promise<DailySnapshotDocument> {
    const userIdStr = userId.toString();
    const today = new Date().toISOString().split('T')[0];

    // Check if snapshot already exists
    const existing = await this.snapshotModel.findOne({
      userId: new Types.ObjectId(userIdStr),
      date: today,
    });

    if (existing) {
      this.logger.log(`Snapshot for ${today} already exists, updating...`);
    }

    // Get balances
    const consolidated = await this.balancesService.getConsolidatedBalances(userIdStr);

    // Get all unique assets
    const assets = new Set<string>();
    for (const balance of consolidated.byAsset) {
      assets.add(balance.asset);
    }

    // Get prices
    const { precios: pricesMap, arrastrados } = await this.reponerPreciosCaidos(
      userIdStr,
      consolidated.byAsset,
      await this.pricesService.getPricesMap(Array.from(assets)),
    );

    if (arrastrados.length > 0) {
      this.logger.warn(
        `Snapshot diario de ${userIdStr}: sin cotización para ` +
          `[${arrastrados.join(', ')}], se arrastra el último precio bueno`,
      );
    }

    // Build exchange balances with USD values
    const exchangeBalances: ExchangeBalance[] = consolidated.byExchange.map((eb) => {
      const balances: AssetBalance[] = eb.balances.map((b) => ({
        asset: b.asset,
        amount: b.total,
        priceUsd: pricesMap[b.asset] || 0,
        valueUsd: b.total * (pricesMap[b.asset] || 0),
      }));

      return {
        exchange: eb.exchange,
        credentialId: new Types.ObjectId(eb.credentialId),
        label: eb.label,
        balances,
        totalValueUsd: balances.reduce((sum, b) => sum + (b.valueUsd || 0), 0),
      };
    });

    // Build consolidated balances with USD values
    const consolidatedBalances: AssetBalance[] = consolidated.byAsset.map((b) => ({
      asset: b.asset,
      amount: b.total,
      priceUsd: pricesMap[b.asset] || 0,
      valueUsd: b.total * (pricesMap[b.asset] || 0),
    }));

    const totalValueUsd = consolidatedBalances.reduce(
      (sum, b) => sum + (b.valueUsd || 0),
      0,
    );

    const snapshotData = {
      userId: new Types.ObjectId(userIdStr),
      date: today,
      snapshotAt: new Date(),
      exchangeBalances,
      consolidatedBalances,
      totalValueUsd,
      pricesAtSnapshot: pricesMap,
    };

    if (existing) {
      Object.assign(existing, snapshotData);
      return existing.save();
    }

    const snapshot = new this.snapshotModel(snapshotData);
    return snapshot.save();
  }

  async findAllByUser(userId: string): Promise<SnapshotResponseDto[]> {
    const snapshots = await this.snapshotModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ date: -1 });

    return snapshots.map((s) => this.toResponse(s));
  }

  async findLatest(userId: string): Promise<SnapshotResponseDto | null> {
    const snapshot = await this.snapshotModel
      .findOne({ userId: new Types.ObjectId(userId) })
      .sort({ date: -1 });

    return snapshot ? this.toResponse(snapshot) : null;
  }

  async findByDate(userId: string, date: string): Promise<SnapshotResponseDto> {
    const snapshot = await this.snapshotModel.findOne({
      userId: new Types.ObjectId(userId),
      date,
    });

    if (!snapshot) {
      throw new NotFoundException(`Snapshot for ${date} not found`);
    }

    return this.toResponse(snapshot);
  }

  async compare(
    userId: string,
    fromDate: string,
    toDate: string,
  ): Promise<SnapshotCompareDto> {
    const [fromSnapshot, toSnapshot] = await Promise.all([
      this.findByDate(userId, fromDate),
      this.findByDate(userId, toDate),
    ]);

    const changeUsd = toSnapshot.totalValueUsd - fromSnapshot.totalValueUsd;
    const changePercent =
      fromSnapshot.totalValueUsd > 0
        ? (changeUsd / fromSnapshot.totalValueUsd) * 100
        : 0;

    // Build asset changes
    const fromAssets = new Map(
      fromSnapshot.consolidatedBalances.map((b) => [b.asset, b.amount]),
    );
    const toAssets = new Map(
      toSnapshot.consolidatedBalances.map((b) => [b.asset, b.amount]),
    );

    const allAssets = new Set([...fromAssets.keys(), ...toAssets.keys()]);
    const assetChanges = Array.from(allAssets).map((asset) => ({
      asset,
      fromAmount: fromAssets.get(asset) || 0,
      toAmount: toAssets.get(asset) || 0,
      change: (toAssets.get(asset) || 0) - (fromAssets.get(asset) || 0),
    }));

    return {
      fromDate,
      toDate,
      fromTotalUsd: fromSnapshot.totalValueUsd,
      toTotalUsd: toSnapshot.totalValueUsd,
      changeUsd,
      changePercent,
      assetChanges,
    };
  }

  async findUsersWithoutSnapshotForDate(date: string): Promise<string[]> {
    // This would require access to the users collection
    // For simplicity, we'll return empty array - implement as needed
    return [];
  }

  // ==================== HOURLY SNAPSHOTS ====================

  async generateHourlySnapshot(
    userId: string | Types.ObjectId,
  ): Promise<HourlySnapshotDocument> {
    const userIdStr = userId.toString();
    const now = new Date();

    // Get balances
    const consolidated = await this.balancesService.getConsolidatedBalances(userIdStr);

    // Get all unique assets
    const assets = consolidated.byAsset.map((b) => b.asset);

    // Get prices
    const { precios: pricesMap, arrastrados, perdidos } =
      await this.reponerPreciosCaidos(
        userIdStr,
        consolidated.byAsset,
        await this.pricesService.getPricesMap(assets),
      );

    if (arrastrados.length > 0) {
      this.logger.warn(
        `Snapshot horario de ${userIdStr}: sin cotización para ` +
          `[${arrastrados.join(', ')}], se arrastra el último precio bueno`,
      );
    }

    // Calculate all asset balances with USD values
    const assetBalances: SnapshotAssetBalance[] = consolidated.byAsset.map((b) => ({
      asset: b.asset,
      amount: b.total,
      priceUsd: pricesMap[b.asset] || 0,
      valueUsd: b.total * (pricesMap[b.asset] || 0),
    }));

    const totalValueUsd = assetBalances.reduce((sum, a) => sum + a.valueUsd, 0);

    // Get top 5 assets by value (for backwards compatibility)
    const topAssets = [...assetBalances]
      .sort((a, b) => b.valueUsd - a.valueUsd)
      .slice(0, 5)
      .map((a) => ({ asset: a.asset, valueUsd: a.valueUsd }));

    // Un exchange que no contesta no aborta el snapshot, pero sí lo descalifica
    // como lectura de la cartera: el 28/08 Binance no respondió y el punto quedó
    // en 61k contra 106k reales, con 0,5 BTC en vez de 1,08.
    //
    // No alcanza con "falló alguno": una credencial puede estar rota de forma
    // crónica sin aportar saldo (nexo-pro devolviendo 530), y abortar ahí
    // dejaría la serie vacía para siempre. Lo que descalifica al punto es que el
    // fallo SE NOTE en el total, así que se pide además una caída brusca contra
    // la última lectura buena.
    //
    // Un precio que no llegó y no se pudo reponer cuenta como el mismo tipo de
    // fallo: el saldo está, pero no se sabe cuánto vale.
    const failedExchanges = consolidated.failedExchanges ?? [];
    const huboFallo = failedExchanges.length > 0 || perdidos.length > 0;
    const isPartial =
      huboFallo &&
      (await this.dropsAgainstLastGoodSnapshot(userIdStr, totalValueUsd));

    if (isPartial) {
      const causa = failedExchanges.length
        ? `no contestaron [${failedExchanges.join(', ')}]`
        : `sin precio para [${perdidos.join(', ')}]`;
      this.logger.warn(
        `Snapshot horario de ${userIdStr} marcado como parcial: ${causa} ` +
          `y el total cayó a ${Math.round(totalValueUsd)}`,
      );
    }

    const snapshot = new this.hourlySnapshotModel({
      userId: new Types.ObjectId(userIdStr),
      timestamp: now,
      totalValueUsd,
      topAssets,
      assetBalances,
      isPartial,
      missingExchanges: failedExchanges.length ? failedExchanges : undefined,
      stalePriceAssets: arrastrados.length ? arrastrados : undefined,
    });

    return snapshot.save();
  }

  /** Umbral de caída horaria que, junto con un exchange caído, delata una
   *  lectura incompleta. Una cartera no pierde esto en una hora por mercado. */
  private static readonly PARTIAL_DROP_RATIO = 0.1;

  /** Hasta acá se considera vigente el último precio conocido de un activo. */
  private static readonly ARRASTRE_PRECIO_MS = 6 * 60 * 60 * 1000;

  /**
   * `getPricesMap` devuelve 0 con dos significados que el snapshot no puede
   * distinguir: "esto no cotiza" (el polvo de PIXEL, de W, de BABY) y "no pude
   * consultarlo". El 03/09/2026 a las 02:00 UTC pasó lo segundo con NEXO: el
   * saldo estaba entero —25.457,94— y el precio vino en cero, así que el punto
   * quedó en 83.839 contra 104.889 reales. Un desplome de 21 mil dólares que
   * nunca ocurrió.
   *
   * La última lectura buena sí sabe distinguirlos: si el activo tenía precio
   * hace una hora, el cero de ahora es un agujero. Se tapa con ese precio, que
   * envejece pero no miente; valuar 25 mil NEXO en cero sí.
   *
   * Lo que no se puede reponer se devuelve aparte: es la prueba de que la
   * lectura vino incompleta, el mismo papel que juega un exchange que no
   * contesta.
   */
  private async reponerPreciosCaidos(
    userId: string,
    saldos: { asset: string; total: number }[],
    precios: Record<string, number>,
  ): Promise<{
    precios: Record<string, number>;
    arrastrados: string[];
    perdidos: string[];
  }> {
    const sinPrecio = saldos.filter((b) => b.total > 0 && !(precios[b.asset] > 0));
    if (sinPrecio.length === 0) {
      return { precios, arrastrados: [], perdidos: [] };
    }

    const ultimoBueno = await this.hourlySnapshotModel
      .findOne({ userId: new Types.ObjectId(userId), isPartial: { $ne: true } })
      .sort({ timestamp: -1 })
      .select('timestamp assetBalances')
      .lean();

    // Sin lectura previa no hay con qué distinguir un agujero de un cero real.
    if (!ultimoBueno?.assetBalances?.length) {
      return { precios, arrastrados: [], perdidos: [] };
    }

    const antiguedad = Date.now() - new Date(ultimoBueno.timestamp).getTime();
    const vigente = antiguedad <= SnapshotsService.ARRASTRE_PRECIO_MS;

    const repuestos = { ...precios };
    const arrastrados: string[] = [];
    const perdidos: string[] = [];

    for (const saldo of sinPrecio) {
      const previo =
        ultimoBueno.assetBalances.find((a) => a.asset === saldo.asset)?.priceUsd ?? 0;
      if (previo <= 0) continue; // nunca cotizó: el cero es la respuesta correcta

      if (vigente) {
        repuestos[saldo.asset] = previo;
        arrastrados.push(saldo.asset);
      } else {
        perdidos.push(saldo.asset);
      }
    }

    return { precios: repuestos, arrastrados, perdidos };
  }

  /**
   * ¿El total cae bruscamente contra el último snapshot que sí fue completo?
   * Sin lectura previa no hay con qué comparar, y se asume buena.
   */
  private async dropsAgainstLastGoodSnapshot(
    userId: string,
    totalValueUsd: number,
  ): Promise<boolean> {
    const lastGood = await this.hourlySnapshotModel
      .findOne({ userId: new Types.ObjectId(userId), isPartial: { $ne: true } })
      .sort({ timestamp: -1 })
      .select('totalValueUsd')
      .lean();

    if (!lastGood?.totalValueUsd) return false;

    const drop = (lastGood.totalValueUsd - totalValueUsd) / lastGood.totalValueUsd;
    return drop > SnapshotsService.PARTIAL_DROP_RATIO;
  }

  // ==================== CHART DATA ====================

  async getChartData(
    userId: string,
    timeframe: '24h' | '7d' | '1m' | '1y',
  ): Promise<ChartDataResponseDto> {
    switch (timeframe) {
      case '24h':
        return this.get24hChartData(userId);
      case '7d':
        return this.get7dChartData(userId);
      case '1m':
        return this.get1mChartData(userId);
      case '1y':
        return this.get1yChartData(userId);
      default:
        return this.get24hChartData(userId);
    }
  }

  async get24hPnl(userId: string): Promise<{
    currentValue: number;
    value24hAgo: number;
    changeUsd: number;
    changePercent: number;
  }> {
    // Get snapshot closest to 24h ago
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const snapshot = await this.hourlySnapshotModel
      .findOne({
        userId: new Types.ObjectId(userId),
        timestamp: { $lte: since },
        isPartial: { $ne: true },
      })
      .sort({ timestamp: -1 });

    // Get current balance
    const current = await this.balancesService.getConsolidatedBalances(userId);
    const currentValue = current.totalValueUsd;
    const value24hAgo = snapshot?.totalValueUsd || currentValue;

    const changeUsd = currentValue - value24hAgo;
    const changePercent = value24hAgo > 0 ? (changeUsd / value24hAgo) * 100 : 0;

    return {
      currentValue,
      value24hAgo,
      changeUsd,
      changePercent,
    };
  }

  async getChartDataByAsset(
    userId: string,
    timeframe: '24h' | '7d',
    assets?: string[],
  ): Promise<ChartDataByAssetResponseDto> {
    const since =
      timeframe === '24h'
        ? new Date(Date.now() - 24 * 60 * 60 * 1000)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rawSnapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
        isPartial: { $ne: true },
      })
      .sort({ timestamp: 1 });

    // Collect all available assets from snapshots (before aggregation)
    const allAssets = new Set<string>();
    rawSnapshots.forEach((s) => {
      s.assetBalances?.forEach((ab) => allAssets.add(ab.asset));
    });

    const availableAssets = Array.from(allAssets).sort();
    const filteredAssets =
      assets && assets.length > 0 ? assets : availableAssets;

    // Show all hourly data points for better granularity
    const snapshots = rawSnapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: s.totalValueUsd,
      assetBalances: s.assetBalances,
    }));

    // Build data per asset
    const assetData: AssetChartDataDto[] = filteredAssets.map((asset) => ({
      asset,
      data: snapshots.map((s) => {
        const ab = s.assetBalances?.find((a) => a.asset === asset);
        return ab?.valueUsd || 0;
      }),
    }));

    // Build total data and calculate change
    const totalData = snapshots.map((s) => s.totalValueUsd);
    const labels = snapshots.map((s) => s.timestamp.toISOString());

    const firstValue = totalData[0] || 0;
    const lastValue = totalData[totalData.length - 1] || 0;
    const changeUsd = lastValue - firstValue;
    const changePercent = firstValue > 0 ? (changeUsd / firstValue) * 100 : 0;

    return {
      labels,
      totalData,
      assetData,
      changeUsd,
      changePercent,
      timeframe,
      availableAssets,
    };
  }

  private async get24hChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const snapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
        isPartial: { $ne: true },
      })
      .sort({ timestamp: 1 });

    // Map to the expected format
    const data = snapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: s.totalValueUsd,
    }));

    return this.buildChartResponse(data, '24h');
  }

  private async get7dChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Get hourly snapshots
    const snapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
        isPartial: { $ne: true },
      })
      .sort({ timestamp: 1 });

    // Show all hourly data points for better granularity
    const data = snapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: s.totalValueUsd,
    }));

    return this.buildChartResponse(data, '7d');
  }

  private async get1mChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceDate = since.toISOString().split('T')[0];

    const snapshots = await this.snapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        date: { $gte: sinceDate },
      })
      .sort({ date: 1 });

    const data = snapshots.map((s) => ({
      timestamp: new Date(s.date),
      totalValueUsd: s.totalValueUsd,
    }));

    return this.buildChartResponse(data, '1m');
  }

  private async get1yChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    const sinceDate = since.toISOString().split('T')[0];

    const snapshots = await this.snapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        date: { $gte: sinceDate },
      })
      .sort({ date: 1 });

    // Aggregate to weekly (every 7 days)
    const data = snapshots.map((s) => ({
      timestamp: new Date(s.date),
      totalValueUsd: s.totalValueUsd,
    }));

    const aggregated = this.aggregateByWeek(data);

    return this.buildChartResponse(aggregated, '1y');
  }

  private aggregateSnapshots(
    snapshots: HourlySnapshotDocument[],
    interval: number,
  ): { timestamp: Date; totalValueUsd: number }[] {
    if (snapshots.length === 0) return [];

    const result: { timestamp: Date; totalValueUsd: number }[] = [];
    for (let i = 0; i < snapshots.length; i += interval) {
      const chunk = snapshots.slice(i, i + interval);
      const avgValue =
        chunk.reduce((sum, s) => sum + s.totalValueUsd, 0) / chunk.length;
      result.push({
        timestamp: chunk[Math.floor(chunk.length / 2)].timestamp,
        totalValueUsd: avgValue,
      });
    }
    return result;
  }

  private aggregateByWeek(
    data: { timestamp: Date; totalValueUsd: number }[],
  ): { timestamp: Date; totalValueUsd: number }[] {
    if (data.length === 0) return [];

    const result: { timestamp: Date; totalValueUsd: number }[] = [];
    for (let i = 0; i < data.length; i += 7) {
      const chunk = data.slice(i, i + 7);
      const avgValue =
        chunk.reduce((sum, s) => sum + s.totalValueUsd, 0) / chunk.length;
      result.push({
        timestamp: chunk[Math.floor(chunk.length / 2)].timestamp,
        totalValueUsd: avgValue,
      });
    }
    return result;
  }

  private buildChartResponse(
    data: { timestamp: Date; totalValueUsd: number }[],
    timeframe: string,
  ): ChartDataResponseDto {
    if (data.length === 0) {
      return {
        labels: [],
        data: [],
        changeUsd: 0,
        changePercent: 0,
        timeframe,
      };
    }

    const labels = data.map((d) => d.timestamp.toISOString());
    const values = data.map((d) => d.totalValueUsd);

    const firstValue = values[0] || 0;
    const lastValue = values[values.length - 1] || 0;
    const changeUsd = lastValue - firstValue;
    const changePercent = firstValue > 0 ? (changeUsd / firstValue) * 100 : 0;

    return {
      labels,
      data: values,
      changeUsd,
      changePercent,
      timeframe,
    };
  }

  private toResponse(snapshot: DailySnapshotDocument): SnapshotResponseDto {
    return {
      id: snapshot._id.toString(),
      date: snapshot.date,
      snapshotAt: snapshot.snapshotAt,
      exchangeBalances: snapshot.exchangeBalances.map((eb) => ({
        exchange: eb.exchange,
        label: eb.label,
        credentialId: eb.credentialId?.toString() || '',
        balances: eb.balances,
        totalValueUsd: eb.totalValueUsd,
      })),
      consolidatedBalances: snapshot.consolidatedBalances,
      totalValueUsd: snapshot.totalValueUsd,
      pricesAtSnapshot: snapshot.pricesAtSnapshot,
    };
  }

  // ==================== REBUILD HISTORY ====================

  /**
   * Rebuild historical balance snapshots from transactions
   * This method recalculates the balance at each day based on transaction history
   */
  async rebuildHistory(
    userId: string,
    options?: {
      fromDate?: string;
      skipExisting?: boolean;
    },
  ): Promise<RebuildHistoryResponseDto> {
    const userIdObj = new Types.ObjectId(userId);
    this.logger.log(`[RebuildHistory] Starting for user ${userId}`);

    // Get all transactions sorted by timestamp
    const transactions = await this.transactionsService.findAllByUserSorted(userId);

    if (transactions.length === 0) {
      this.logger.log(`[RebuildHistory] No transactions found for user`);
      return {
        success: true,
        message: 'No transactions found',
        daysProcessed: 0,
        snapshotsCreated: 0,
        snapshotsUpdated: 0,
      };
    }

    // Determine date range - max 1 year back
    const firstTxDate = new Date(transactions[0].timestamp);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    let startDate: Date;
    if (options?.fromDate) {
      startDate = new Date(options.fromDate);
    } else {
      // Use the later of: first transaction date or 1 year ago
      startDate = firstTxDate > oneYearAgo ? firstTxDate : oneYearAgo;
    }
    const endDate = new Date();

    // Set to start of day
    startDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCHours(23, 59, 59, 999);

    this.logger.log(
      `[RebuildHistory] Processing from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    );

    // Get existing snapshots if we want to skip them
    const existingDates = new Set<string>();
    if (options?.skipExisting) {
      const existing = await this.snapshotModel.find({
        userId: userIdObj,
        date: {
          $gte: startDate.toISOString().split('T')[0],
          $lte: endDate.toISOString().split('T')[0],
        },
      });
      for (const snapshot of existing) {
        existingDates.add(snapshot.date);
      }
      this.logger.log(`[RebuildHistory] Found ${existingDates.size} existing snapshots to skip`);
    }

    // Build a running balance from transactions
    const balanceState = new Map<string, number>(); // asset -> amount
    let txIndex = 0;

    let daysProcessed = 0;
    let snapshotsCreated = 0;
    let snapshotsUpdated = 0;

    // Collect all unique assets for price fetching
    const allAssets = new Set<string>();
    for (const tx of transactions) {
      allAssets.add(tx.asset);
      if (tx.feeAsset) allAssets.add(tx.feeAsset);
    }

    // First, apply all transactions before the start date to get initial balance
    while (
      txIndex < transactions.length &&
      new Date(transactions[txIndex].timestamp) < startDate
    ) {
      this.applyTransaction(balanceState, transactions[txIndex]);
      txIndex++;
    }

    this.logger.log(
      `[RebuildHistory] Applied ${txIndex} transactions before start date to build initial balance`,
    );

    // Process day by day
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const dayEnd = new Date(currentDate);
      dayEnd.setUTCHours(23, 59, 59, 999);

      // Skip if we already have a snapshot and skipExisting is true
      if (options?.skipExisting && existingDates.has(dateStr)) {
        // Still need to process transactions to update balance state
        while (
          txIndex < transactions.length &&
          new Date(transactions[txIndex].timestamp) <= dayEnd
        ) {
          this.applyTransaction(balanceState, transactions[txIndex]);
          txIndex++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Process all transactions up to end of this day
      while (
        txIndex < transactions.length &&
        new Date(transactions[txIndex].timestamp) <= dayEnd
      ) {
        this.applyTransaction(balanceState, transactions[txIndex]);
        txIndex++;
      }

      // Get assets with non-zero balances
      const assetsWithBalance = Array.from(balanceState.entries())
        .filter(([_, amount]) => amount > 0.00000001)
        .map(([asset]) => asset);

      if (assetsWithBalance.length === 0) {
        currentDate.setDate(currentDate.getDate() + 1);
        daysProcessed++;
        continue;
      }

      // Get historical prices for this date
      const pricesMap = await this.pricesService.getHistoricalPricesMap(
        assetsWithBalance,
        currentDate,
      );

      // Build consolidated balances
      const consolidatedBalances: AssetBalance[] = [];
      let totalValueUsd = 0;

      for (const asset of assetsWithBalance) {
        const amount = balanceState.get(asset) || 0;
        const priceUsd = pricesMap[asset] || 0;
        const valueUsd = amount * priceUsd;

        consolidatedBalances.push({
          asset,
          amount,
          priceUsd,
          valueUsd,
        });

        totalValueUsd += valueUsd;
      }

      // Sort by value descending
      consolidatedBalances.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

      // Check if snapshot exists
      const existing = await this.snapshotModel.findOne({
        userId: userIdObj,
        date: dateStr,
      });

      const snapshotData = {
        userId: userIdObj,
        date: dateStr,
        snapshotAt: dayEnd,
        exchangeBalances: [], // We don't have per-exchange breakdown from transactions
        consolidatedBalances,
        totalValueUsd,
        pricesAtSnapshot: pricesMap,
      };

      if (existing) {
        Object.assign(existing, snapshotData);
        await existing.save();
        snapshotsUpdated++;
      } else {
        await this.snapshotModel.create(snapshotData);
        snapshotsCreated++;
      }

      daysProcessed++;

      // Log progress every 30 days
      if (daysProcessed % 30 === 0) {
        this.logger.log(
          `[RebuildHistory] Progress: ${daysProcessed} days processed, ${snapshotsCreated} created, ${snapshotsUpdated} updated`,
        );
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    this.logger.log(
      `[RebuildHistory] Completed: ${daysProcessed} days processed, ${snapshotsCreated} created, ${snapshotsUpdated} updated`,
    );

    return {
      success: true,
      message: 'History rebuilt successfully',
      daysProcessed,
      snapshotsCreated,
      snapshotsUpdated,
    };
  }

  /**
   * Apply a transaction to the balance state
   */
  private applyTransaction(
    balanceState: Map<string, number>,
    tx: TransactionDocument,
  ): void {
    const currentBalance = balanceState.get(tx.asset) || 0;

    switch (tx.type) {
      case TransactionType.DEPOSIT:
      case TransactionType.INTEREST:
        // Add to balance
        balanceState.set(tx.asset, currentBalance + tx.amount);
        break;

      case TransactionType.WITHDRAWAL:
      case TransactionType.FEE:
        // Subtract from balance
        balanceState.set(tx.asset, currentBalance - Math.abs(tx.amount));
        break;

      case TransactionType.TRADE:
        // For trades, we need to handle both sides
        // amount is typically the base asset amount
        // If side is 'buy', we receive the asset
        // If side is 'sell', we lose the asset
        if (tx.side === 'buy') {
          balanceState.set(tx.asset, currentBalance + Math.abs(tx.amount));
          // Subtract the quote asset (price * amount)
          if (tx.priceAsset && tx.price) {
            const quoteBalance = balanceState.get(tx.priceAsset) || 0;
            balanceState.set(
              tx.priceAsset,
              quoteBalance - Math.abs(tx.amount * tx.price),
            );
          }
        } else if (tx.side === 'sell') {
          balanceState.set(tx.asset, currentBalance - Math.abs(tx.amount));
          // Add the quote asset
          if (tx.priceAsset && tx.price) {
            const quoteBalance = balanceState.get(tx.priceAsset) || 0;
            balanceState.set(
              tx.priceAsset,
              quoteBalance + Math.abs(tx.amount * tx.price),
            );
          }
        }
        break;

      case TransactionType.TRANSFER:
        // Transfers might be in or out, check if amount is positive or negative
        balanceState.set(tx.asset, currentBalance + tx.amount);
        break;
    }

    // Apply fee if present
    if (tx.fee && tx.feeAsset) {
      const feeBalance = balanceState.get(tx.feeAsset) || 0;
      balanceState.set(tx.feeAsset, feeBalance - Math.abs(tx.fee));
    }
  }

  /**
   * Borra snapshots horarios del usuario en un rango de tiempo.
   *
   * Existe por un problema real y recurrente: cuando se mueven fondos entre
   * exchanges, el activo sale de uno y todavía no está acreditado en el otro.
   * El snapshot horario que cae en esa ventana registra un total que no
   * corresponde a ninguna pérdida — el 24/08/2026 una transferencia de BTC de
   * NEXO a Binance dejó dos puntos de ~61k contra ~106k reales — y el gráfico
   * de balance muestra un desplome fantasma.
   *
   * Se borra en vez de corregir el valor a propósito: para esas horas no hay
   * una lectura real, y fabricar una sería inventar un dato. Sin el punto, el
   * gráfico interpola entre las horas vecinas.
   */
  async deleteHourlySnapshots(
    userId: string,
    fromIso: string,
    toIso: string,
    dryRun = false,
  ): Promise<{
    dryRun: boolean;
    matched: number;
    deleted: number;
    snapshots: { id: string; timestamp: Date; totalValueUsd: number }[];
  }> {
    const from = new Date(fromIso);
    const to = new Date(toIso);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from y to tienen que ser fechas ISO válidas');
    }
    if (from >= to) {
      throw new BadRequestException('from tiene que ser anterior a to');
    }
    // Los snapshots horarios tienen TTL de 7 días: un rango mayor no puede ser
    // intencional y solo abre la puerta a un borrado masivo por accidente.
    const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > SIETE_DIAS_MS) {
      throw new BadRequestException(
        'el rango no puede superar los 7 días (es el TTL de los snapshots horarios)',
      );
    }

    const filtro = {
      userId: new Types.ObjectId(userId),
      timestamp: { $gte: from, $lte: to },
    };

    const encontrados = await this.hourlySnapshotModel
      .find(filtro)
      .sort({ timestamp: 1 })
      .select({ timestamp: 1, totalValueUsd: 1 })
      .lean()
      .exec();

    const snapshots = encontrados.map((d) => ({
      id: String(d._id),
      timestamp: d.timestamp,
      totalValueUsd: d.totalValueUsd,
    }));

    if (dryRun) {
      return { dryRun: true, matched: snapshots.length, deleted: 0, snapshots };
    }

    const res = await this.hourlySnapshotModel.deleteMany(filtro).exec();
    this.logger.warn(
      `Borrados ${res.deletedCount} snapshots horarios de ${userId} entre ${from.toISOString()} y ${to.toISOString()}`,
    );

    return {
      dryRun: false,
      matched: snapshots.length,
      deleted: res.deletedCount ?? 0,
      snapshots,
    };
  }

}
