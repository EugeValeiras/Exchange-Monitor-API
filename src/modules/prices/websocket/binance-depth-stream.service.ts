import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';

const WS_OPEN = 1;

/** Un libro de órdenes parcial, tal como lo manda Binance cada 100 ms. */
export interface DepthUpdate {
  exchange: 'binance';
  symbol: string;
  timestamp: Date;
  bids: [number, number][];
  asks: [number, number][];
}

/**
 * Profundidad de mercado de Binance en vivo, a demanda.
 *
 * A diferencia del stream de precios —que sigue siempre los pares
 * configurados— acá se suscribe sólo lo que algún cliente está mirando, y se
 * deja de recibir cuando el último se va: son diez mensajes por segundo por
 * par, y nadie los quiere si no hay una pantalla abierta.
 *
 * Se usa el endpoint combinado (`/stream`) porque envuelve cada mensaje con el
 * nombre del stream; el payload de profundidad no trae el símbolo, y sin esa
 * envoltura no se sabría de qué par es.
 */
@Injectable()
export class BinanceDepthStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceDepthStreamService.name);
  private readonly streamHost: string;

  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private nextRequestId = 1;

  /** Cuántos clientes miran cada par. Cuando llega a cero, se desuscribe. */
  private readonly viewers = new Map<string, number>();
  private readonly streamToSymbol = new Map<string, string>();
  private callback: ((book: DepthUpdate) => void) | null = null;

  /** Binance sólo ofrece libros parciales de 5, 10 o 20 niveles. */
  static readonly LEVELS = 20;

  constructor(private readonly configService: ConfigService) {
    this.streamHost = this.configService.get<string>('BINANCE_STREAM_HOST') || 'stream.binance.com';
  }

  onUpdate(callback: (book: DepthUpdate) => void): void {
    this.callback = callback;
  }

  subscribe(symbol: string): void {
    const count = (this.viewers.get(symbol) ?? 0) + 1;
    this.viewers.set(symbol, count);
    if (count > 1) return; // ya estaba llegando

    const stream = this.streamName(symbol);
    this.streamToSymbol.set(stream, symbol);
    this.ensureConnected()
      .then(() => this.send('SUBSCRIBE', [stream]))
      .catch((err) => this.logger.error(`No pude suscribir ${symbol}: ${err.message}`));
  }

  unsubscribe(symbol: string): void {
    const count = (this.viewers.get(symbol) ?? 0) - 1;
    if (count > 0) {
      this.viewers.set(symbol, count);
      return;
    }
    this.viewers.delete(symbol);
    const stream = this.streamName(symbol);
    this.streamToSymbol.delete(stream);
    if (this.viewers.size === 0) {
      this.disconnect();
      return;
    }
    this.send('UNSUBSCRIBE', [stream]);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  private streamName(symbol: string): string {
    return `${symbol.toLowerCase().replace('/', '')}@depth${BinanceDepthStreamService.LEVELS}@100ms`;
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
    if (!this.isConnected()) return;
    this.ws!.send(JSON.stringify({ method, params, id: this.nextRequestId++ }));
  }

  private ensureConnected(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.connecting) return this.connecting;

    // El endpoint combinado exige al menos un stream en la URL: van todos los
    // que haya, así una reconexión repone las suscripciones sola.
    const streams = Array.from(this.streamToSymbol.keys());
    const url = `wss://${this.streamHost}:9443/stream?streams=${streams.join('/')}`;

    this.connecting = new Promise<void>((resolve, reject) => {
      this.logger.log(`Conectando profundidad de Binance: ${streams.length} stream(s)`);
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
        this.logger.error(`Profundidad de Binance: ${error.message}`);
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
      if (!parsed.stream || !parsed.data) return; // respuestas a SUBSCRIBE, etc.
      const symbol = this.streamToSymbol.get(parsed.stream);
      if (!symbol) return;

      const toLevels = (rows: [string, string][]): [number, number][] =>
        (rows ?? []).map(([p, q]) => [parseFloat(p), parseFloat(q)]);

      this.callback?.({
        exchange: 'binance',
        symbol,
        timestamp: new Date(),
        bids: toLevels(parsed.data.bids),
        asks: toLevels(parsed.data.asks),
      });
    } catch (error) {
      this.logger.error(`Mensaje de profundidad ilegible: ${error.message}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= 10) {
      this.logger.error('Profundidad de Binance: demasiados reintentos, me rindo');
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
