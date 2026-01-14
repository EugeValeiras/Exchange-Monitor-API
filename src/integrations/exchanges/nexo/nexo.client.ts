import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface NexoConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
}

// Response interfaces based on OpenAPI spec
export interface NexoBalance {
  assetName: string;
  totalBalance: string;
  availableBalance: string;
  lockedBalance: string;
  debt?: string;
  interest?: string;
  lastUpdated?: string;
}

export interface AccountSummaryResponse {
  balances: NexoBalance[];
}

export interface DepositWithdrawalDeal {
  timestamp: number;
  asset: string;
  amount: string;
  side: 'DEPOSIT' | 'WITHDRAWAL';
}

export interface DepositWithdrawalsResponse {
  totalPages: number;
  pageSize: number;
  deals: DepositWithdrawalDeal[];
}

export interface NexoTrade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  tradeAmount: string;
  executedPrice: string;
  timestamp: number;
  orderId: string;
}

export interface TradesResponse {
  trades: NexoTrade[];
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalElements: number;
}

export class NexoClient {
  private readonly client: AxiosInstance;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(config: NexoConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;

    this.client = axios.create({
      baseURL: config.baseUrl || 'https://pro-api.nexo.io',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private generateSignature(nonce: number): string {
    // According to Nexo Pro API docs, signature must be Base64 encoded
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(nonce.toString())
      .digest('base64');
  }

  private getAuthHeaders(): Record<string, string> {
    const nonce = Date.now();
    const signature = this.generateSignature(nonce);

    return {
      'X-API-KEY': this.apiKey,
      'X-NONCE': nonce.toString(),
      'X-SIGNATURE': signature,
    };
  }

  async getAccountSummary(): Promise<AccountSummaryResponse> {
    const response = await this.client.get<AccountSummaryResponse>(
      '/api/v1/accountSummary',
      {
        headers: this.getAuthHeaders(),
      },
    );
    return response.data;
  }

  async getDepositsAndWithdrawals(params?: {
    from?: number;
    to?: number;
    pageSize?: number;
    pageNumber?: number;
    type?: 'deposit' | 'withdrawal';
    asset?: string[];
  }): Promise<DepositWithdrawalsResponse> {
    const response = await this.client.get<DepositWithdrawalsResponse>(
      '/api/v1/history/deposit-and-withdrawals',
      {
        headers: this.getAuthHeaders(),
        params,
      },
    );
    return response.data;
  }

  async getTrades(params?: {
    pairs?: string[];
    startDate?: number;
    endDate?: number;
    pageSize?: number;
    pageNum?: number;
  }): Promise<TradesResponse> {
    const response = await this.client.get<TradesResponse>('/api/v1/trades', {
      headers: this.getAuthHeaders(),
      params,
    });
    return response.data;
  }

  async getPairs(): Promise<Record<string, unknown>> {
    const response = await this.client.get('/api/v1/pairs', {
      headers: this.getAuthHeaders(),
    });
    return response.data;
  }
}
