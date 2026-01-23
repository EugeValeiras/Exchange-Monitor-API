import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as ExcelJS from 'exceljs';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import { TransactionType } from '../../common/constants/transaction-types.constant';
import { ImportResultDto } from './dto/import-result.dto';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';

interface NexoCsvRow {
  Transaction: string;
  Type: string;
  'Input Currency': string;
  'Input Amount': string;
  'Output Currency': string;
  'Output Amount': string;
  'USD Equivalent': string;
  Fee?: string;
  'Fee Currency'?: string;
  Details: string;
  'Date / Time (UTC)': string;
}

interface BinanceTransactionRow {
  userId: string;
  time: string;
  account: string;
  operation: string;
  coin: string;
  change: number;
  remark: string;
}

interface BinanceDepositRow {
  time: string;
  coin: string;
  network: string;
  amount: number;
  address: string;
  txid: string;
  status: string;
}

interface BinanceWithdrawRow {
  time: string;
  coin: string;
  network: string;
  amount: number;
  fee: number;
  address: string;
  txid: string;
  status: string;
}

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<TransactionDocument>,
    private readonly credentialsService: ExchangeCredentialsService,
  ) {}

  /**
   * Get the exchange name from a credential, or throw if not found
   */
  private async getCredentialExchange(credentialId: string, userId: string): Promise<string> {
    const credential = await this.credentialsService.findById(credentialId, userId);
    if (!credential) {
      throw new NotFoundException(`Credential ${credentialId} not found`);
    }
    return credential.exchange;
  }

  async importNexoCsv(
    fileBuffer: Buffer,
    credentialId: string,
    userId: string,
  ): Promise<ImportResultDto> {
    const content = fileBuffer.toString('utf-8');
    const records = this.parseCsv(content);

    if (records.length === 0) {
      throw new BadRequestException('No valid records found in CSV file');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const record of records) {
      try {
        const transaction = this.mapNexoCsvToTransaction(
          record,
          credentialId,
          userId,
        );

        // Check if transaction already exists
        const existing = await this.transactionModel.findOne({
          externalId: transaction.externalId,
          exchange: transaction.exchange,
        });

        if (existing) {
          skipped++;
        } else {
          await this.transactionModel.create(transaction);
          imported++;
        }
      } catch (error) {
        this.logger.warn(`Failed to import row: ${error.message}`);
        errors++;
      }
    }

    this.logger.log(
      `Import completed: ${imported} imported, ${skipped} skipped, ${errors} errors`,
    );

    return { imported, skipped, errors };
  }

  private parseCsv(content: string): NexoCsvRow[] {
    const lines = content.split('\n').filter((line) => line.trim());
    if (lines.length < 2) return [];

    const headers = this.parseCSVLine(lines[0]);
    const records: NexoCsvRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (values.length !== headers.length) continue;

      const record: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = values[j];
      }

      if (record['Transaction'] && record['Type']) {
        records.push(record as unknown as NexoCsvRow);
      }
    }

    return records;
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  }

  private mapNexoCsvToTransaction(
    record: NexoCsvRow,
    credentialId: string,
    userId: string,
  ): Partial<Transaction> {
    const type = this.mapNexoType(record.Type);
    const inputAmount = this.parseAmount(record['Input Amount']);
    const outputAmount = this.parseAmount(record['Output Amount']);
    const fee = this.parseAmount(record.Fee);

    // Determine the primary asset and amount based on transaction type
    let asset: string;
    let amount: number;

    if (type === TransactionType.WITHDRAWAL) {
      asset = record['Input Currency'] || record['Output Currency'];
      amount = Math.abs(inputAmount || outputAmount);
    } else {
      asset = record['Output Currency'] || record['Input Currency'];
      amount = Math.abs(outputAmount || inputAmount);
    }

    const transaction: Partial<Transaction> = {
      userId: new Types.ObjectId(userId),
      credentialId: new Types.ObjectId(credentialId),
      exchange: 'nexo-manual',
      externalId: record.Transaction,
      type,
      asset,
      amount,
      fee: fee || undefined,
      feeAsset:
        record['Fee Currency'] && record['Fee Currency'] !== '-'
          ? record['Fee Currency']
          : undefined,
      timestamp: this.parseNexoDate(record['Date / Time (UTC)']),
      rawData: {
        ...record,
        inputCurrency: record['Input Currency'],
        inputAmount: inputAmount,
        outputCurrency: record['Output Currency'],
        outputAmount: outputAmount,
      } as unknown as Record<string, unknown>,
    };

    // Add trade-specific fields for exchange/trade transactions
    if (type === TransactionType.TRADE && inputAmount && outputAmount) {
      const inputCurrency = record['Input Currency'];
      const outputCurrency = record['Output Currency'];

      if (inputCurrency && outputCurrency) {
        // pair format: OUTPUT/INPUT (e.g., NEXO/USDT - bought NEXO with USDT)
        transaction.pair = `${outputCurrency}/${inputCurrency}`;
        transaction.priceAsset = inputCurrency;
        // price = how much inputCurrency per 1 outputCurrency
        transaction.price = Math.abs(inputAmount) / Math.abs(outputAmount);
        transaction.side = 'buy'; // We're receiving the output asset
      }
    }

    return transaction;
  }

  private parseAmount(value: string | undefined): number {
    if (!value || value === '-' || value === '') return 0;
    const parsed = parseFloat(value.replace(/,/g, ''));
    return isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Parse Nexo date string as UTC
   * Nexo format: "2024-01-15 14:30:00" (already in UTC)
   */
  private parseNexoDate(dateStr: string): Date {
    if (!dateStr) return new Date();

    // If the date string doesn't have timezone info, append 'Z' to treat it as UTC
    const trimmed = dateStr.trim();

    // Check if it already has timezone indicator
    if (trimmed.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
      return new Date(trimmed);
    }

    // Replace space with 'T' and append 'Z' for proper ISO 8601 UTC format
    // "2024-01-15 14:30:00" -> "2024-01-15T14:30:00Z"
    const isoString = trimmed.replace(' ', 'T') + 'Z';
    const parsed = new Date(isoString);

    // Fallback if parsing fails
    if (isNaN(parsed.getTime())) {
      this.logger.warn(`Failed to parse Nexo date as UTC: ${dateStr}`);
      return new Date(dateStr);
    }

    return parsed;
  }

  private mapNexoType(type: string): TransactionType {
    const normalizedType = type.toLowerCase().trim();

    if (
      normalizedType === 'interest' ||
      normalizedType === 'exchange cashback' ||
      normalizedType === 'fixed term interest' ||
      normalizedType === 'nexo booster' ||
      normalizedType === 'referral bonus' ||
      normalizedType === 'cashback'
    ) {
      return TransactionType.INTEREST;
    }

    if (
      normalizedType === 'top up crypto' ||
      normalizedType === 'deposit' ||
      normalizedType === 'deposit to exchange'
    ) {
      return TransactionType.DEPOSIT;
    }

    if (
      normalizedType === 'withdrawal' ||
      normalizedType === 'withdraw' ||
      normalizedType === 'withdraw exchanged crypto' ||
      normalizedType === 'withdraw from exchange'
    ) {
      return TransactionType.WITHDRAWAL;
    }

    if (normalizedType === 'exchange' || normalizedType === 'trade') {
      return TransactionType.TRADE;
    }

    if (
      normalizedType === 'transfer in' ||
      normalizedType === 'transfer out' ||
      normalizedType === 'transfer'
    ) {
      return TransactionType.TRANSFER;
    }

    // Default to transfer for unknown types
    this.logger.warn(`Unknown Nexo transaction type: ${type}`);
    return TransactionType.TRANSFER;
  }

  // ==================== BINANCE EXCEL IMPORTS ====================

  /**
   * Import Binance deposits from Excel file
   */
  async importBinanceDeposits(
    fileBuffer: Buffer,
    credentialId: string,
    userId: string,
  ): Promise<ImportResultDto> {
    // Get the exchange from the credential
    const exchange = await this.getCredentialExchange(credentialId, userId);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);

    const sheet = workbook.worksheets[0];
    const records = this.parseBinanceDepositRows(sheet);

    if (records.length === 0) {
      throw new BadRequestException('No valid deposit records found in Excel file');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const record of records) {
      try {
        const externalId = `binance-deposit-${record.txid || record.time}`;
        const timestamp = this.parseBinanceDate(record.time);

        // Check for duplicates by externalId OR by matching fields
        const existing = await this.transactionModel.findOne({
          credentialId: new Types.ObjectId(credentialId),
          $or: [
            { externalId },
            {
              type: TransactionType.DEPOSIT,
              asset: record.coin,
              amount: { $gte: record.amount - 0.00000001, $lte: record.amount + 0.00000001 },
              timestamp: {
                $gte: new Date(timestamp.getTime() - 60000),
                $lte: new Date(timestamp.getTime() + 60000),
              },
            },
          ],
        });

        if (existing) {
          skipped++;
        } else {
          await this.transactionModel.create({
            userId: new Types.ObjectId(userId),
            credentialId: new Types.ObjectId(credentialId),
            exchange,
            externalId,
            type: TransactionType.DEPOSIT,
            asset: record.coin,
            amount: record.amount,
            timestamp,
            rawData: record as unknown as Record<string, unknown>,
          });
          imported++;
        }
      } catch (error) {
        this.logger.warn(`Failed to import deposit: ${error.message}`);
        errors++;
      }
    }

    this.logger.log(
      `Binance deposits import: ${imported} imported, ${skipped} skipped, ${errors} errors`,
    );

    return { imported, skipped, errors };
  }

  /**
   * Import Binance withdrawals from Excel file
   */
  async importBinanceWithdrawals(
    fileBuffer: Buffer,
    credentialId: string,
    userId: string,
  ): Promise<ImportResultDto> {
    // Get the exchange from the credential
    const exchange = await this.getCredentialExchange(credentialId, userId);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);

    const sheet = workbook.worksheets[0];
    const records = this.parseBinanceWithdrawRows(sheet);

    if (records.length === 0) {
      throw new BadRequestException('No valid withdrawal records found in Excel file');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const record of records) {
      try {
        const externalId = `binance-withdraw-${record.txid || record.time}`;
        const timestamp = this.parseBinanceDate(record.time);

        // Check for duplicates by externalId OR by matching fields
        const existing = await this.transactionModel.findOne({
          credentialId: new Types.ObjectId(credentialId),
          $or: [
            { externalId },
            {
              type: TransactionType.WITHDRAWAL,
              asset: record.coin,
              amount: { $gte: record.amount - 0.00000001, $lte: record.amount + 0.00000001 },
              timestamp: {
                $gte: new Date(timestamp.getTime() - 60000),
                $lte: new Date(timestamp.getTime() + 60000),
              },
            },
          ],
        });

        if (existing) {
          skipped++;
        } else {
          await this.transactionModel.create({
            userId: new Types.ObjectId(userId),
            credentialId: new Types.ObjectId(credentialId),
            exchange,
            externalId,
            type: TransactionType.WITHDRAWAL,
            asset: record.coin,
            amount: record.amount,
            fee: record.fee || undefined,
            feeAsset: record.fee ? record.coin : undefined,
            timestamp,
            rawData: record as unknown as Record<string, unknown>,
          });
          imported++;
        }
      } catch (error) {
        this.logger.warn(`Failed to import withdrawal: ${error.message}`);
        errors++;
      }
    }

    this.logger.log(
      `Binance withdrawals import: ${imported} imported, ${skipped} skipped, ${errors} errors`,
    );

    return { imported, skipped, errors };
  }

  /**
   * Import Binance transaction history from Excel file
   * This includes: interest, cashback, trades, card spending, etc.
   */
  async importBinanceTransactions(
    fileBuffer: Buffer,
    credentialId: string,
    userId: string,
  ): Promise<ImportResultDto> {
    // Get the exchange from the credential
    const exchange = await this.getCredentialExchange(credentialId, userId);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);

    const sheet = workbook.worksheets[0];
    const records = this.parseBinanceTransactionRows(sheet);

    if (records.length === 0) {
      throw new BadRequestException('No valid transaction records found in Excel file');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    // Group records by timestamp to match trade pairs
    const recordsByTime = new Map<string, BinanceTransactionRow[]>();
    for (const record of records) {
      const existing = recordsByTime.get(record.time) || [];
      existing.push(record);
      recordsByTime.set(record.time, existing);
    }

    // Process grouped records
    for (const [time, groupedRecords] of recordsByTime) {
      // Separate trade records from non-trade records
      const tradeRecords = groupedRecords.filter(r => this.isBinanceTradeOperation(r.operation));
      const nonTradeRecords = groupedRecords.filter(r => !this.isBinanceTradeOperation(r.operation));

      // Process trades as pairs
      if (tradeRecords.length >= 2) {
        try {
          const result = await this.processBinanceTradePair(
            tradeRecords,
            exchange,
            credentialId,
            userId,
          );
          imported += result.imported;
          skipped += result.skipped;
        } catch (error) {
          this.logger.warn(`Failed to import trade pair at ${time}: ${error.message}`);
          errors++;
        }
      } else if (tradeRecords.length === 1) {
        // Single trade record without pair - import as simple trade
        const record = tradeRecords[0];
        try {
          const result = await this.importSimpleBinanceTransaction(
            record,
            exchange,
            credentialId,
            userId,
          );
          if (result === 'imported') imported++;
          else if (result === 'skipped') skipped++;
        } catch (error) {
          this.logger.warn(`Failed to import single trade: ${error.message}`);
          errors++;
        }
      }

      // Process non-trade records individually
      for (const record of nonTradeRecords) {
        try {
          const result = await this.importSimpleBinanceTransaction(
            record,
            exchange,
            credentialId,
            userId,
          );
          if (result === 'imported') imported++;
          else if (result === 'skipped') skipped++;
        } catch (error) {
          this.logger.warn(`Failed to import transaction: ${error.message}`);
          errors++;
        }
      }
    }

    this.logger.log(
      `Binance transactions import: ${imported} imported, ${skipped} skipped, ${errors} errors`,
    );

    return { imported, skipped, errors };
  }

  /**
   * Check if an operation is a trade operation
   */
  private isBinanceTradeOperation(operation: string): boolean {
    const op = operation.toLowerCase();
    return (
      op === 'transaction buy' ||
      op === 'transaction sold' ||
      op === 'transaction spend' ||
      op === 'transaction revenue' ||
      op === 'binance convert' ||
      op === 'small assets exchange bnb'
    );
  }

  /**
   * Process a pair of trade records (buy + sell) into a single trade transaction
   */
  private async processBinanceTradePair(
    tradeRecords: BinanceTransactionRow[],
    exchange: string,
    credentialId: string,
    userId: string,
  ): Promise<{ imported: number; skipped: number }> {
    // Find the buy side (positive change) and sell side (negative change)
    const buyRecord = tradeRecords.find(r => r.change > 0);
    const sellRecord = tradeRecords.find(r => r.change < 0);

    if (!buyRecord || !sellRecord) {
      // Can't determine pair, import individually
      let imported = 0;
      let skipped = 0;
      for (const record of tradeRecords) {
        const result = await this.importSimpleBinanceTransaction(record, exchange, credentialId, userId);
        if (result === 'imported') imported++;
        else if (result === 'skipped') skipped++;
      }
      return { imported, skipped };
    }

    // Create trade with full details
    // The "asset" is what we bought (positive change)
    // The "priceAsset" is what we paid with (negative change)
    const asset = buyRecord.coin;
    const amount = Math.abs(buyRecord.change);
    const priceAsset = sellRecord.coin;
    const priceAmount = Math.abs(sellRecord.change);
    const price = priceAmount / amount; // How much priceAsset per 1 asset
    const pair = `${asset}/${priceAsset}`;
    const timestamp = this.parseBinanceDate(buyRecord.time);

    const externalId = `binance-trade-${buyRecord.time}-${asset}-${priceAsset}-${amount}`;

    // Check for duplicates by externalId OR by matching fields
    const existing = await this.transactionModel.findOne({
      credentialId: new Types.ObjectId(credentialId),
      $or: [
        { externalId },
        {
          type: TransactionType.TRADE,
          asset,
          amount: { $gte: amount - 0.00000001, $lte: amount + 0.00000001 },
          pair,
          timestamp: {
            $gte: new Date(timestamp.getTime() - 60000), // 1 minute tolerance
            $lte: new Date(timestamp.getTime() + 60000),
          },
        },
      ],
    });

    if (existing) {
      return { imported: 0, skipped: 1 };
    }

    await this.transactionModel.create({
      userId: new Types.ObjectId(userId),
      credentialId: new Types.ObjectId(credentialId),
      exchange,
      externalId,
      type: TransactionType.TRADE,
      asset,
      amount,
      price,
      priceAsset,
      pair,
      side: 'buy',
      timestamp,
      rawData: {
        buyRecord,
        sellRecord,
      } as unknown as Record<string, unknown>,
    });

    return { imported: 1, skipped: 0 };
  }

  /**
   * Import a simple (non-paired) Binance transaction
   */
  private async importSimpleBinanceTransaction(
    record: BinanceTransactionRow,
    exchange: string,
    credentialId: string,
    userId: string,
  ): Promise<'imported' | 'skipped' | 'error'> {
    // Skip internal transfers
    if (this.isInternalBinanceTransfer(record.operation)) {
      return 'skipped';
    }

    const mappedType = this.mapBinanceOperationType(record.operation, record.change);

    // Skip if we can't determine the type
    if (!mappedType) {
      return 'skipped';
    }

    const externalId = `binance-tx-${record.time}-${record.coin}-${record.operation}-${record.change}`;
    const timestamp = this.parseBinanceDate(record.time);
    const amount = Math.abs(record.change);

    // Check for duplicates by externalId OR by matching fields
    const existing = await this.transactionModel.findOne({
      credentialId: new Types.ObjectId(credentialId),
      $or: [
        { externalId },
        {
          type: mappedType,
          asset: record.coin,
          amount: { $gte: amount - 0.00000001, $lte: amount + 0.00000001 },
          timestamp: {
            $gte: new Date(timestamp.getTime() - 60000), // 1 minute tolerance
            $lte: new Date(timestamp.getTime() + 60000),
          },
        },
      ],
    });

    if (existing) {
      return 'skipped';
    }

    await this.transactionModel.create({
      userId: new Types.ObjectId(userId),
      credentialId: new Types.ObjectId(credentialId),
      exchange,
      externalId,
      type: mappedType,
      asset: record.coin,
      amount,
      timestamp,
      rawData: record as unknown as Record<string, unknown>,
    });

    return 'imported';
  }

  // ==================== BINANCE PARSING HELPERS ====================

  private parseBinanceDepositRows(sheet: ExcelJS.Worksheet): BinanceDepositRow[] {
    const records: BinanceDepositRow[] = [];

    // Data starts at row 11, headers at row 10
    // Col 3: Time, Col 4: Coin, Col 6: Network, Col 8: Amount, Col 10: Address, Col 11: TXID, Col 12: Status
    for (let i = 11; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const time = row.getCell(3).value?.toString();
      const coin = row.getCell(4).value?.toString();
      const network = row.getCell(6).value?.toString();
      const amount = this.parseAmount(row.getCell(8).value?.toString());
      const address = row.getCell(10).value?.toString();
      const txid = row.getCell(11).value?.toString();
      const status = row.getCell(12).value?.toString();

      if (time && coin && amount > 0 && status?.toLowerCase() === 'completed') {
        records.push({
          time,
          coin,
          network: network || '',
          amount,
          address: address || '',
          txid: txid || '',
          status: status || '',
        });
      }
    }

    return records;
  }

  private parseBinanceWithdrawRows(sheet: ExcelJS.Worksheet): BinanceWithdrawRow[] {
    const records: BinanceWithdrawRow[] = [];

    // Data starts at row 11, headers at row 10
    // Col 3: Time, Col 4: Coin, Col 5: Network, Col 6: Amount, Col 8: Fee, Col 10: Address, Col 11: TXID, Col 12: Status
    for (let i = 11; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const time = row.getCell(3).value?.toString();
      const coin = row.getCell(4).value?.toString();
      const network = row.getCell(5).value?.toString();
      const amount = this.parseAmount(row.getCell(6).value?.toString());
      const fee = this.parseAmount(row.getCell(8).value?.toString());
      const address = row.getCell(10).value?.toString();
      const txid = row.getCell(11).value?.toString();
      const status = row.getCell(12).value?.toString();

      if (time && coin && amount > 0 && status?.toLowerCase() === 'completed') {
        records.push({
          time,
          coin,
          network: network || '',
          amount,
          fee: fee || 0,
          address: address || '',
          txid: txid || '',
          status: status || '',
        });
      }
    }

    return records;
  }

  private parseBinanceTransactionRows(sheet: ExcelJS.Worksheet): BinanceTransactionRow[] {
    const records: BinanceTransactionRow[] = [];

    // Data starts at row 11, headers at row 10
    // Columns: 3=UserID, 4=Time, 6=Account, 7=Operation, 9=Coin, 10=Change, 12=Remark
    for (let i = 11; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const userId = row.getCell(3).value?.toString();
      const time = row.getCell(4).value?.toString();
      const account = row.getCell(6).value?.toString();
      const operation = row.getCell(7).value?.toString();
      const coin = row.getCell(9).value?.toString();
      const change = this.parseAmount(row.getCell(10).value?.toString());
      const remark = row.getCell(12).value?.toString();

      if (time && operation && coin) {
        records.push({
          userId: userId || '',
          time,
          account: account || '',
          operation,
          coin,
          change,
          remark: remark || '',
        });
      }
    }

    return records;
  }

  private parseBinanceDate(dateStr: string): Date {
    // Binance format: "23-01-10 19:55:11" (YY-MM-DD HH:mm:ss)
    // or "26-01-06 15:30:22"
    const match = dateStr.match(/(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, yy, mm, dd, hh, min, ss] = match;
      const year = parseInt(yy) + 2000;
      return new Date(year, parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(min), parseInt(ss));
    }
    // Try standard parse as fallback
    return new Date(dateStr);
  }

  private isInternalBinanceTransfer(operation: string): boolean {
    const internalOps = [
      'simple earn flexible subscription',
      'simple earn flexible redemption',
      'transfer between main and funding wallet',
      'asset - transfer',
      'withdrawal - initiate freeze',
    ];
    return internalOps.includes(operation.toLowerCase());
  }

  private mapBinanceOperationType(operation: string, change: number): TransactionType | null {
    const op = operation.toLowerCase();

    // Interest/Rewards
    if (
      op === 'simple earn flexible interest' ||
      op === 'simple earn flexible airdrop' ||
      op === 'binance card cashback' ||
      op === 'airdrop assets' ||
      op === 'crypto box' ||
      op === 'mission reward distribution' ||
      op === 'asset recovery'
    ) {
      return TransactionType.INTEREST;
    }

    // External Deposits (not from transaction history, but just in case)
    if (op === 'deposit' || op === 'fiat deposit') {
      return TransactionType.DEPOSIT;
    }

    // External Withdrawals
    if (
      op === 'withdraw' ||
      op === 'fiat withdrawal' ||
      op === 'send'
    ) {
      return TransactionType.WITHDRAWAL;
    }

    // Card spending (negative = withdrawal)
    if (op === 'binance card spending' || op === 'pre auth - capture') {
      return TransactionType.WITHDRAWAL;
    }

    // Merchant acquiring (receiving payment)
    if (op === 'merchant acquiring') {
      return TransactionType.DEPOSIT;
    }

    // Trades are handled separately by processBinanceTradePair
    // This handles single trade records that weren't paired
    if (
      op === 'transaction buy' ||
      op === 'transaction sold' ||
      op === 'transaction spend' ||
      op === 'transaction revenue' ||
      op === 'binance convert' ||
      op === 'small assets exchange bnb'
    ) {
      return TransactionType.TRADE;
    }

    // Fees
    if (op === 'transaction fee') {
      return TransactionType.FEE;
    }

    // Unknown - log and skip
    this.logger.debug(`Unknown Binance operation: ${operation}`);
    return null;
  }
}
