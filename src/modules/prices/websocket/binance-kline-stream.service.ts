import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';

const WS_OPEN = 1;

/** Una vela tal como la va actualizando Binance mientras transcurre. */
export interface KlineUpdate {
  exchange: 'binance';
  symbol: string;
  timeframe: string;
  /** Apertura del período, que es la clave de la vela. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** El período terminó: esta vela ya no cambia y empieza otra. */
  closed: boolean;
}

/**
 * Velas de Binance en vivo, a demanda.
 *
 * Hasta ahora las velas se repedían por REST —cada 60 s en la web, una sola vez
 * en la app—, así que la última siempre estaba vieja. Binance emite cada vela
 * en curso un par de veces por segundo; esto la relaya y el gráfico deja de
 * mentir sobre el presente.
 *
 * Mismo trato que la profundidad: se suscribe lo que alguien está mirando y se
 * suelta cuando se va el último. Un par abierto en cinco intervalos son cinco
 * streams, y nadie los quiere sin pantalla.
 */
@Injectable()
export class BinanceKlineStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceKlineStreamService.name);
  private readonly streamHost: string;

  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private nextRequestId = 1;

  /** Cuántos clientes miran cada (par, intervalo). */
  private readonly viewers = new Map<string, number>();
  private readonly streamToKey = new Map<string, { symbol: string; timeframe: string }>();
  private callback: ((k: KlineUpdate) => void) | null = null;

  /** Los intervalos que la app y la web ofrecen. Nada más se suscribe. */
  private static readonly INTERVALOS = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1w']);

  constructor(private readonly configService: ConfigService) {
    this.streamHost =
      this.configService.get<string>('BINANCE_STREAM_HOST') || 'stream.binance.com';
  }

  onUpdate(callback: (k: KlineUpdate) => void): void {
    this.callback = callback;
  }

  soporta(timeframe: string): boolean {
    return BinanceKlineStreamService.INTERVALOS.has(timeframe);
  }

  subscribe(symbol: string, timeframe: string): void {
    if (!this.soporta(timeframe)) return;
    const key = this.claveDe(symbol, timeframe);
    const count = (this.viewers.get(key) ?? 0) + 1;
    this.viewers.set(key, count);
    if (count > 1) return;

    const stream = this.streamName(symbol, timeframe);
    this.streamToKey.set(stream, { symbol, timeframe });
    this.ensureConnected()
      .then(() => this.send('SUBSCRIBE', [stream]))
      .catch((err) =>
        this.logger.error(`No pude suscribir velas de ${key}: ${err.message}`),
      );
  }

  unsubscribe(symbol: string, timeframe: string): void {
    const key = this.claveDe(symbol, timeframe);
    const count = (this.viewers.get(key) ?? 0) - 1;
    if (count > 0) {
      this.viewers.set(key, count);
      return;
    }
    this.viewers.delete(key);
    const stream = this.streamName(symbol, timeframe);
    this.streamToKey.delete(stream);
    if (this.viewers.size === 0) {
      this.disconnect();
      return;
    }
    this.send('UNSUBSCRIBE', [stream]);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  private claveDe(symbol: string, timeframe: string): string {
    return `${symbol.toUpperCase()}@${timeframe}`;
  }

  private streamName(symbol: string, timeframe: string): string {
    return `${symbol.toLowerCase().replace('/', '')}@kline_${timeframe}`;
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
    if (!this.isConnected()) return;
    this.ws!.send(JSON.stringify({ method, params, id: this.nextRequestId++ }));
  }

  private ensureConnected(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.connecting) return this.connecting;

    const streams = Array.from(this.streamToKey.keys());
    const url = `wss://${this.streamHost}:9443/stream?streams=${streams.join('/')}`;

    this.connecting = new Promise<void>((resolve, reject) => {
      this.logger.log(`Conectando velas de Binance: ${streams.length} stream(s)`);
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.startPing();
        resolve();
      });
      ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));
      ws.on('close', () => {
        this.clearTimers();
        if (this.viewers.size > 0) this.scheduleReconnect();
      });
      ws.on('error', (error) => {
        this.logger.error(`Velas de Binance: ${error.message}`);
        reject(error);
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(data.toString());
      if (!parsed.stream || !parsed.data?.k) return;
      const key = this.streamToKey.get(parsed.stream);
      if (!key) return;

      const k = parsed.data.k;
      this.callback?.({
        exchange: 'binance',
        symbol: key.symbol,
        timeframe: key.timeframe,
        timestamp: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        closed: k.x === true,
      });
    } catch (error) {
      this.logger.error(`Vela ilegible: ${error.message}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= 10) {
      this.logger.error('Velas de Binance: demasiados reintentos, me rindo');
      return;
    }
    this.reconnectAttempts++;
    const wait = Math.min(5000 * this.reconnectAttempts, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.ensureConnected().catch(() => undefined);
    }, wait);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.isConnected()) this.ws!.ping();
    }, 30000);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private disconnect(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  onModuleDestroy(): void {
    this.viewers.clear();
    this.disconnect();
  }
}
