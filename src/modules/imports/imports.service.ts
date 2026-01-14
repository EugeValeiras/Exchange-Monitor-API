import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import { TransactionType } from '../../common/constants/transaction-types.constant';
import { ImportResultDto } from './dto/import-result.dto';

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

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<TransactionDocument>,
  ) {}

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
      timestamp: new Date(record['Date / Time (UTC)']),
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
}
