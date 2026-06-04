import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { AgentModel } from './dto/chat.dto';

const SYSTEM_PROMPT_APPEND = `
Sos el agente de análisis financiero personal de Eugenio en Exchange Monitor.

Idioma: español rioplatense argentino (vos, dale, che, "tirar plata", etc.). Tono directo, sin chamuyo, técnico pero claro.

Tenés acceso al sistema Exchange Monitor del usuario vía el CLI \`exchange-monitor\` (instalado globalmente). El JWT del usuario ya está disponible vía la variable de entorno EXCHANGE_MONITOR_TOKEN — los comandos lo toman automáticamente.

Los skills exchange-monitor-* (portfolio, market, credentials, config, events) te dan recetas y conocimiento de dominio. Usalos antes de razonar sobre datos de mercado o portfolio.

REGLAS DURAS:
1. Siempre incluí un disclaimer breve de "esto no es asesoramiento financiero" antes de cualquier recomendación accionable.
2. Si el usuario dice que va a tomar tus respuestas "a rajatabla" o similar, hacé push back firme: explicale que actuar sobre un solo análisis sin considerar macro/regulatorio/personal es peligroso.
3. NUNCA inventes números — siempre citá los valores literales que devuelven los comandos. Si dudás, volvé a consultar el dato.
4. Considerá: concentración (>20% en un solo asset es flag), liquidez (volumen vs tu tamaño), accounting (FIFO vs lote específico para realizar P&L), fees y slippage.
5. Cuando detectes inconsistencias de datos (ej. cost basis que no cierra con balance actual), reportalas explícitamente.
6. Para acciones destructivas (\`prices swap-execute\`, \`pnl recalculate\`, \`snapshots rebuild-history\`), pedí confirmación explícita y advertí sobre el riesgo.
7. Default: usá \`--format json\` cuando vayas a parsear con jq o cuando el output va a ser largo. Para mostrar resultados breves al usuario, podés usar el formato tabla.

CONTROL DEL GRÁFICO (chart-action):
Si el usuario te pide algo que requiera cambiar lo que está viendo en el panel \`/market-analysis\` (cambiar de par, timeframe, exchange, dibujar líneas, marcar divergencias), incluí en tu respuesta un bloque code-fence con lenguaje \`chart-action\` y un JSON:

\`\`\`chart-action
{"symbol": "ETH/USDT", "timeframe": "4h", "exchange": "binance"}
\`\`\`

Campos de cambio de vista (todos opcionales):
- \`symbol\`: par de trading con slash, MAYÚSCULAS (\`BTC/USDT\`, \`ETH/USDT\`, \`NEXO/USDT\`, \`SOL/USDT\`, etc.)
- \`timeframe\`: \`15m\` | \`1h\` | \`4h\` | \`1d\`
- \`exchange\`: \`binance\` | \`kraken\`

Annotations (dibujos sobre el gráfico):
- \`annotations\`: array de annotations (ver abajo) — se suman a las existentes
- \`clearAnnotations\`: \`true\` para borrar todas antes de aplicar las nuevas

Tipos de annotation:
1. Línea horizontal (niveles de soporte/resistencia):
   \`{"type":"horizontal-line","chart":"price","value":76500,"label":"Resistencia","color":"red"}\`
2. Trendline / línea diagonal entre dos puntos:
   \`{"type":"trend-line","chart":"price","from":{"t":1776520000000,"y":74000},"to":{"t":1776720000000,"y":76500},"label":"Soporte alcista","color":"green"}\`
3. Divergencia manual (conecta dos pivots, misma forma que trend-line pero renderiza más resaltada):
   \`{"type":"divergence","chart":"rsi","variant":"bullish","from":{"t":...,"y":35},"to":{"t":...,"y":42},"label":"Div bullish confirmada"}\`
4. Marker (punto con etiqueta en una vela específica):
   \`{"type":"marker","chart":"price","t":1776620000000,"y":75800,"label":"Breakout","color":"yellow"}\`

Campos comunes:
- \`chart\`: \`price\` (sobre el candlestick) o \`rsi\` (sobre el RSI chart) — el MACD chart NO está disponible para annotations.
- \`label\`: opcional, string descriptivo (aparece como tooltip / en la leyenda)
- \`color\`: opcional, color CSS (\`red\`, \`green\`, \`yellow\`, \`#00bcd4\`, etc.). Default verde/rojo según contexto.
- \`t\`: timestamp en milisegundos (unix epoch). Usar los timestamps de las velas que ves en el OHLC.
- \`y\`: valor en el eje Y (precio USD para chart \`price\`, valor 0–100 para chart \`rsi\`).

Ejemplo completo (marcar divergencia bullish + nivel de soporte + borrar las previas):
\`\`\`chart-action
{
  "clearAnnotations": true,
  "annotations": [
    {"type":"horizontal-line","chart":"price","value":74500,"label":"Soporte clave","color":"#0ecb81"},
    {"type":"divergence","chart":"rsi","variant":"bullish","from":{"t":1776300000000,"y":28},"to":{"t":1776600000000,"y":35},"label":"Div bullish"},
    {"type":"divergence","chart":"price","variant":"bullish","from":{"t":1776300000000,"y":71200},"to":{"t":1776600000000,"y":70800},"label":"Precio LL"}
  ]
}
\`\`\`

Reglas (CRÍTICAS — el bloque es lo que efectivamente dibuja):
- **OBLIGATORIO**: si decís "marqué", "dibujé", "agregué", "puse una línea/divergencia/nivel/marker" en el gráfico, DEBÉS incluir el bloque \`chart-action\` en esa misma respuesta. Sin el bloque, NADA se dibuja — solo estarías alucinando la acción.
- **NUNCA afirmes que dibujaste/marcaste algo si no emitiste el bloque**. Si no podés emitirlo por cualquier razón, decí que no pudiste y explicá por qué.
- Emití COMO MÁXIMO un bloque \`chart-action\` por respuesta.
- El bloque se oculta del texto visible y se aplica al gráfico inmediatamente.
- Los timestamps DEBEN ser reales — usá los valores de \`candles[i].timestamp\` del output de \`exchange-monitor market ohlc SYMBOL --exchange X --timeframe Y --limit N --format json\`. No inventes fechas.
- Para niveles horizontales (soporte/resistencia) NO necesitás timestamps, solo \`value\`.
- Después de cambiar el símbolo/timeframe, el contexto del próximo análisis es el nuevo símbolo — usá ese par para los siguientes \`market indicators\` / \`market ohlc\`.
- Workflow recomendado para "marcá los niveles clave":
  1. Corré \`exchange-monitor market indicators SYMBOL --exchange X --timeframe Y --format json\` → sacá Bollinger upper/lower, SMA, EMA.
  2. Identificá los niveles importantes.
  3. Emití el bloque con horizontal-line por cada nivel.
  4. Describí en texto natural qué marcaste y por qué.

REGLAS DE FORMATO (obligatorias — la respuesta se renderiza en un chat mobile):
- Usá **pipe tables markdown** siempre. Ejemplo:
  | Asset | % | Valor |
  |---|---:|---:|
  | BTC | 49.9% | $75,953 |
  NUNCA uses espacios o tabs para alinear columnas — no se renderizan.
- Headers en markdown: \`##\` para secciones principales, \`###\` para subsecciones. No uses \`####\` salvo casos especiales.
- Separadores: \`---\` en una línea sola, no \`---\` al final de un párrafo.
- Listas: usá \`- \` (guion + espacio) o \`1. \` para numeradas.
- Negrita con \`**texto**\`, código inline con \`\\\`código\\\`\`.
- **Sé conciso por defecto** (mobile first). Tablas cortas, no dumps. Si el análisis es largo, ofrecé expandir al final ("¿querés que profundice en X?").
- Montos USD con símbolo \`$\` y comas de miles (\`$75,953\`, \`$1,250.50\`).
- Porcentajes con un decimal (\`49.9%\`) y signo explícito en cambios (\`+2.5%\` / \`-1.3%\`).
- Tickers en MAYÚSCULAS (\`BTC\`, no \`btc\`).
- Fechas en formato \`DD mmm YYYY\` (\`21 abr 2026\`).

Output: respondé siempre en markdown válido siguiendo las reglas de arriba.
`.trim();

const ALLOWED_TOOLS = [
  // Domain CLI
  'Bash(exchange-monitor *)',
  // Data wrangling
  'Bash(jq *)',
  'Bash(awk *)',
  'Bash(sed *)',
  'Bash(grep *)',
  'Bash(sort *)',
  'Bash(uniq *)',
  'Bash(wc *)',
  'Bash(cut *)',
  'Bash(tr *)',
  'Bash(paste *)',
  // Read-only file ops
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(ls *)',
  'Bash(find *)',
  'Bash(file *)',
  'Bash(stat *)',
  // Write-friendly file ops (the agent runs in scoped allowed-dirs anyway)
  'Bash(echo *)',
  'Bash(printf *)',
  'Bash(mkdir *)',
  'Bash(touch *)',
  'Bash(cp *)',
  'Bash(mv *)',
  // Scripting languages for ad-hoc analysis
  'Bash(python3 *)',
  'Bash(python *)',
  'Bash(node *)',
  'Bash(npx *)',
  // Date / utility
  'Bash(date *)',
  'Bash(env)',
  'Bash(pwd)',
  // Network probes (read-only)
  'Bash(curl *)',
  // Native Claude Code tools
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Skill',
];

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd?: number }
  | { type: 'done'; result?: string; sessionId?: string }
  | { type: 'error'; message: string };

interface RunOptions {
  message: string;
  sessionId?: string;
  model?: AgentModel;
  jwt: string;
  signal?: AbortSignal;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(private readonly configService: ConfigService) {}

  async *run(opts: RunOptions): AsyncIterable<AgentEvent> {
    const claudeBin = this.configService.get<string>('CLAUDE_BIN') ?? 'claude';
    const apiUrl = this.configService.get<string>('agent.apiUrl') ?? 'http://localhost:3050';
    // Allow the agent to read/write inside the whole Exchange-Monitor
    // workspace + /tmp (typical scratch dir for jq pipelines, intermediate
    // analysis files, etc.). Override via env AGENT_ALLOWED_DIRS (space-sep).
    const extraDirsRaw =
      this.configService.get<string>('AGENT_ALLOWED_DIRS') ??
      '/Users/eugeniovaleiras/workspace/Exchange-Monitor /tmp';
    const extraDirs = extraDirsRaw.split(/\s+/).filter(Boolean);

    const args: string[] = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--append-system-prompt', SYSTEM_PROMPT_APPEND,
      '--allowed-tools', ALLOWED_TOOLS.join(' '),
      '--permission-mode', 'acceptEdits',
      ...(extraDirs.length ? ['--add-dir', ...extraDirs] : []),
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    args.push(opts.message);

    this.logger.log(
      `Spawning claude (model=${opts.model ?? 'default'}, resume=${opts.sessionId ?? 'new'})`,
    );

    // Ensure the nvm node bin (where exchange-monitor is npm-linked) is at
    // the front of PATH. When claude spawns zsh -c for Bash tool commands it
    // uses a non-login shell, so .zshrc isn't loaded and PATH can be missing
    // the nvm directory even when the API's own PATH has it (npm prepends
    // node_modules/.bin which can push nvm lower, or production envs can
    // strip it entirely).
    const currentNodeBin = path.dirname(process.execPath);
    const injectedPath = [
      currentNodeBin,
      process.env.PATH ?? '',
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ]
      .filter(Boolean)
      .join(':');

    let proc: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      proc = spawn(claudeBin, args, {
        env: {
          ...process.env,
          PATH: injectedPath,
          EXCHANGE_MONITOR_TOKEN: opts.jwt,
          EXCHANGE_MONITOR_API_URL: apiUrl,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      yield { type: 'error', message: `Failed to spawn claude: ${(err as Error).message}` };
      return;
    }

    const onAbort = () => {
      this.logger.warn('Client aborted, killing claude subprocess');
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 2000);
    };
    opts.signal?.addEventListener('abort', onAbort);

    proc.stdin.end();

    const stderrChunks: string[] = [];
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    const rl = readline.createInterface({ input: proc.stdout });

    let finalSessionId: string | undefined;
    let finalResult: string | undefined;
    const lastUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch (err) {
          this.logger.warn(`Skipping non-JSON line: ${line.slice(0, 200)}`);
          continue;
        }

        const translated = this.translateEvent(event, lastUsage, (sid) => {
          finalSessionId = sid;
        }, (result) => {
          finalResult = result;
        });
        for (const out of translated) {
          yield out;
        }
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode: number = await new Promise((resolve) => {
      if (proc.exitCode !== null) resolve(proc.exitCode);
      else proc.on('close', resolve);
    });

    if (exitCode !== 0) {
      yield {
        type: 'error',
        message: `claude exited with code ${exitCode}: ${stderrChunks.join('').slice(0, 500)}`,
      };
      return;
    }

    if (lastUsage.inputTokens || lastUsage.outputTokens) {
      yield {
        type: 'usage',
        inputTokens: lastUsage.inputTokens,
        outputTokens: lastUsage.outputTokens,
        cachedTokens: lastUsage.cachedTokens,
        costUsd: lastUsage.costUsd,
      };
    }

    yield { type: 'done', result: finalResult, sessionId: finalSessionId };
  }

  private translateEvent(
    event: any,
    usageRef: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number },
    setSessionId: (id: string) => void,
    setResult: (result: string) => void,
  ): AgentEvent[] {
    const out: AgentEvent[] = [];

    if (event.type === 'system' && event.subtype === 'init') {
      if (event.session_id) {
        setSessionId(event.session_id);
        out.push({ type: 'session', sessionId: event.session_id });
      }
      return out;
    }

    if (event.type === 'stream_event' && event.event) {
      const inner = event.event;
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        out.push({ type: 'text', text: inner.delta.text });
      } else if (
        inner.type === 'content_block_start' &&
        inner.content_block?.type === 'tool_use'
      ) {
        out.push({
          type: 'tool_use',
          id: inner.content_block.id,
          name: inner.content_block.name,
          input: inner.content_block.input ?? {},
        });
      }
      return out;
    }

    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c: any) => (typeof c === 'string' ? c : c.text ?? ''))
                    .join('')
                : JSON.stringify(block.content);
          out.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            content: content.slice(0, 10_000),
            isError: !!block.is_error,
          });
        }
      }
      return out;
    }

    if (event.type === 'assistant' && event.message?.usage) {
      usageRef.inputTokens = event.message.usage.input_tokens ?? usageRef.inputTokens;
      usageRef.outputTokens = event.message.usage.output_tokens ?? usageRef.outputTokens;
      usageRef.cachedTokens =
        event.message.usage.cache_read_input_tokens ?? usageRef.cachedTokens;
      return out;
    }

    if (event.type === 'result') {
      if (event.session_id) setSessionId(event.session_id);
      if (typeof event.result === 'string') setResult(event.result);
      if (typeof event.total_cost_usd === 'number') usageRef.costUsd = event.total_cost_usd;
      if (event.usage) {
        usageRef.inputTokens = event.usage.input_tokens ?? usageRef.inputTokens;
        usageRef.outputTokens = event.usage.output_tokens ?? usageRef.outputTokens;
        usageRef.cachedTokens =
          event.usage.cache_read_input_tokens ?? usageRef.cachedTokens;
      }
      return out;
    }

    return out;
  }
}
