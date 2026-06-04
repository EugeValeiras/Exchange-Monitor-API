import json, sys
from datetime import datetime, timezone

data = json.load(sys.stdin)

candles = data['candles']
rsi_raw = data.get('rsi', [])

rsi_map = {r['timestamp']: r['value'] for r in rsi_raw}

aligned = []
for c in candles:
    ts = c['timestamp']
    rsi_val = rsi_map.get(ts)
    if rsi_val is not None:
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%d %b %Y %H:%M')
        aligned.append({
            'ts': ts, 'dt': dt,
            'close': c['close'], 'high': c['high'], 'low': c['low'],
            'rsi': round(rsi_val, 2)
        })

# Last 30 candles for display
last30 = aligned[-30:]
print("=== LAST 30 CANDLES (4h) WITH RSI ===")
print(f"{'Date (UTC)':<20} {'Close':>10} {'High':>10} {'Low':>10} {'RSI':>7}")
for c in last30:
    print(f"{c['dt']:<20} {c['close']:>10.2f} {c['high']:>10.2f} {c['low']:>10.2f} {c['rsi']:>7.2f}")

# --- DIVERGENCE DETECTION ---
# Find local pivots (swing highs and lows) in the last 60 candles
data60 = aligned[-60:]

def find_swing_highs(data, window=3):
    pivots = []
    for i in range(window, len(data) - window):
        is_high = all(data[i]['high'] >= data[j]['high'] for j in range(i - window, i + window + 1) if j != i)
        if is_high:
            pivots.append(i)
    return pivots

def find_swing_lows(data, window=3):
    pivots = []
    for i in range(window, len(data) - window):
        is_low = all(data[i]['low'] <= data[j]['low'] for j in range(i - window, i + window + 1) if j != i)
        if is_low:
            pivots.append(i)
    return pivots

swing_highs = find_swing_highs(data60, window=3)
swing_lows = find_swing_lows(data60, window=3)

print("\n=== DIVERGENCE ANALYSIS ===")

bearish_divs = []
for i in range(1, len(swing_highs)):
    a = swing_highs[i - 1]
    b = swing_highs[i]
    if b - a < 3:
        continue
    price_a = data60[a]['high']
    price_b = data60[b]['high']
    rsi_a = data60[a]['rsi']
    rsi_b = data60[b]['rsi']
    if price_b > price_a and rsi_b < rsi_a:
        bearish_divs.append({
            'type': 'BEARISH (regular)',
            'p1_dt': data60[a]['dt'], 'p1_price': price_a, 'p1_rsi': rsi_a,
            'p2_dt': data60[b]['dt'], 'p2_price': price_b, 'p2_rsi': rsi_b,
            'idx_b': b
        })

bullish_divs = []
for i in range(1, len(swing_lows)):
    a = swing_lows[i - 1]
    b = swing_lows[i]
    if b - a < 3:
        continue
    price_a = data60[a]['low']
    price_b = data60[b]['low']
    rsi_a = data60[a]['rsi']
    rsi_b = data60[b]['rsi']
    if price_b < price_a and rsi_b > rsi_a:
        bullish_divs.append({
            'type': 'BULLISH (regular)',
            'p1_dt': data60[a]['dt'], 'p1_price': price_a, 'p1_rsi': rsi_a,
            'p2_dt': data60[b]['dt'], 'p2_price': price_b, 'p2_rsi': rsi_b,
            'idx_b': b
        })

# Hidden bearish: price lower high, RSI higher high (trend continuation bajista)
hidden_bearish = []
for i in range(1, len(swing_highs)):
    a = swing_highs[i - 1]
    b = swing_highs[i]
    if b - a < 3:
        continue
    price_a = data60[a]['high']
    price_b = data60[b]['high']
    rsi_a = data60[a]['rsi']
    rsi_b = data60[b]['rsi']
    if price_b < price_a and rsi_b > rsi_a:
        hidden_bearish.append({
            'type': 'HIDDEN BEARISH',
            'p1_dt': data60[a]['dt'], 'p1_price': price_a, 'p1_rsi': rsi_a,
            'p2_dt': data60[b]['dt'], 'p2_price': price_b, 'p2_rsi': rsi_b,
            'idx_b': b
        })

# Hidden bullish: price higher low, RSI lower low (trend continuation alcista)
hidden_bullish = []
for i in range(1, len(swing_lows)):
    a = swing_lows[i - 1]
    b = swing_lows[i]
    if b - a < 3:
        continue
    price_a = data60[a]['low']
    price_b = data60[b]['low']
    rsi_a = data60[a]['rsi']
    rsi_b = data60[b]['rsi']
    if price_b > price_a and rsi_b < rsi_a:
        hidden_bullish.append({
            'type': 'HIDDEN BULLISH',
            'p1_dt': data60[a]['dt'], 'p1_price': price_a, 'p1_rsi': rsi_a,
            'p2_dt': data60[b]['dt'], 'p2_price': price_b, 'p2_rsi': rsi_b,
            'idx_b': b
        })

all_divs = bearish_divs + bullish_divs + hidden_bearish + hidden_bullish
all_divs.sort(key=lambda x: x['idx_b'])

if all_divs:
    for d in all_divs:
        print(f"\n[{d['type']}]")
        print(f"  Punto 1: {d['p1_dt']} | Precio={d['p1_price']:.2f} | RSI={d['p1_rsi']:.2f}")
        print(f"  Punto 2: {d['p2_dt']} | Precio={d['p2_price']:.2f} | RSI={d['p2_rsi']:.2f}")
else:
    print("No se detectaron divergencias claras en los últimos 60 candles (4h).")

last = aligned[-1]
print(f"\n=== ESTADO ACTUAL ===")
print(f"Precio: {last['close']:.2f}")
print(f"RSI(14): {last['rsi']:.2f}")
if last['rsi'] >= 70:
    print("Zona: SOBRECOMPRADO")
elif last['rsi'] <= 30:
    print("Zona: SOBREVENDIDO")
else:
    print(f"Zona: NEUTRAL ({'alcista' if last['rsi'] > 50 else 'bajista'})")
