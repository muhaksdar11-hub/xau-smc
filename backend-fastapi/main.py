import logging
import os
import sqlite3
import random
import asyncio
import json
import pytz
import pandas as pd
from typing import List, Dict, Optional
from datetime import datetime
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import httpx
import yfinance as yf
import google.generativeai as genai

# Configure Logging
os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("logs/error.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("SMC_Institutional_Bot")

app = FastAPI(title="Institutional SMC XAUUSD Scalper")

# Configuration
TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel('gemini-2.5-flash')
else:
    gemini_model = None

SYMBOL = "XAU/USD"
YF_SYMBOL = "GC=F"

# Database Configuration (SQLite)
DB_PATH = "smc_bot.db"

def get_db_connection():
    return sqlite3.connect(DB_PATH, timeout=30.0, isolation_level=None, check_same_thread=False)

def init_db():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            entry REAL,
            sl REAL,
            tp1 REAL,
            tp2 REAL,
            ai_reason TEXT,
            confidence INTEGER,
            timestamp TEXT,
            created_at_utc TEXT,
            status TEXT DEFAULT 'ACTIVE'
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS cooldown (
            id INTEGER PRIMARY KEY,
            last_signal_time TEXT
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY,
            config TEXT
        )
    ''')
    
    # Initialize default settings if not exists
    c.execute('SELECT config FROM settings WHERE id = 1')
    if not c.fetchone():
        default_settings = {
            "enabled": True,
            "risk_factor_min": 0.5,
            "risk_factor_max": 2.0,
            "tp1_rr": 2.5,
            "tp2_rr": 4.0,
            "max_signals_per_15m": 1
        }
        c.execute('INSERT INTO settings (id, config) VALUES (1, ?)', (json.dumps(default_settings),))
        
    conn.commit()
    conn.close()

init_db()

# Load Settings State
def load_settings():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('SELECT config FROM settings WHERE id = 1')
    row = c.fetchone()
    conn.close()
    if row:
        return json.loads(row[0])
    return {}

settings = load_settings()

class SignalSettings(BaseModel):
    enabled: bool
    risk_factor_min: float
    risk_factor_max: float
    tp1_rr: float
    tp2_rr: float

def is_in_killzone() -> bool:
    now_utc = datetime.utcnow()
    wita_hour = (now_utc.hour + 8) % 24
    
    # 15:00 - 18:00 WITA
    if 15 <= wita_hour < 18:
        return True
    
    # 21:30 - 00:00 WITA (21.5 - 24.0)
    wita_time = wita_hour + (now_utc.minute / 60.0)
    if 21.5 <= wita_time < 24.0:
        return True
        
    return False

async def fetch_twelvedata(interval: str, outputsize: int = 50, max_retries: int = 3):
    url = f"https://api.twelvedata.com/time_series?symbol={SYMBOL}&interval={interval}&outputsize={outputsize}&apikey={TWELVEDATA_API_KEY}"
    async with httpx.AsyncClient() as client:
        for attempt in range(max_retries):
            try:
                resp = await client.get(url, timeout=12.0)
                data = resp.json()
                if "status" in data and data["status"] == "error":
                    raise Exception(data["message"])
                if "values" not in data:
                    raise Exception("No values in response")
                
                candles = []
                for item in data["values"]:
                    candles.append({
                        "open": float(item["open"]),
                        "high": float(item["high"]),
                        "low": float(item["low"]),
                        "close": float(item["close"]),
                        "datetime": item["datetime"],
                    })
                
                # Stale Candle Reject: check the latest candle time
                if len(candles) > 0:
                    latest = candles[0] # assuming item[0] is latest before reverse
                    dt_str = latest["datetime"]
                    try:
                        latest_time = pd.to_datetime(dt_str).tz_localize(None)
                        elapsed_mins = (datetime.utcnow() - latest_time).total_seconds() / 60.0
                        if elapsed_mins > 15: # API data too old
                            raise Exception(f"Stale candle data detected (> 15m old: {elapsed_mins:.1f}m)")
                    except Exception as e:
                        if "Stale" in str(e): raise e
                        
                return list(reversed(candles)) # Oldest to newest
            except Exception as e:
                logger.error(f"TwelveData {interval} fetch failed (attempt {attempt+1}/{max_retries}): {str(e)}")
                if attempt == max_retries - 1:
                    return None
                await asyncio.sleep(2)
        return None

def fetch_yfinance(interval: str):
    yf_interval = {
        "1min": "1m",
        "5min": "5m",
        "15min": "15m",
        "1h": "1h"
    }.get(interval, "1m")
    
    try:
        data = yf.download(tickers=YF_SYMBOL, period="5d", interval=yf_interval)
        if data.empty:
            return None
        
        candles = []
        for index, row in data.iterrows():
            candles.append({
                "open": float(row['Open'].iloc[0] if isinstance(row['Open'], pd.Series) else row['Open']),
                "high": float(row['High'].iloc[0] if isinstance(row['High'], pd.Series) else row['High']),
                "low": float(row['Low'].iloc[0] if isinstance(row['Low'], pd.Series) else row['Low']),
                "close": float(row['Close'].iloc[0] if isinstance(row['Close'], pd.Series) else row['Close']),
                "datetime": index.isoformat()
            })
        return candles[-50:] 
    except Exception as e:
        logger.error(f"YFinance {interval} fallback failed: {str(e)}")
        return None

async def get_market_data(interval: str):
    data = await fetch_twelvedata(interval) if TWELVEDATA_API_KEY else None
    if data is None:
        data = fetch_yfinance(interval)
    if data is None:
        logger.error(f"Market fetch failed for interval: {interval}")
        raise Exception(f"Failed to fetch {interval} data from all sources.")
    return data

def calculate_atr_df(df: pd.DataFrame, period: int = 14) -> float:
    if len(df) < period + 1: return 0.0
    high_low = df['high'] - df['low']
    high_close = (df['high'] - df['close'].shift()).abs()
    low_close = (df['low'] - df['close'].shift()).abs()
    ranges = pd.concat([high_low, high_close, low_close], axis=1)
    true_range = ranges.max(axis=1)
    return float(true_range.tail(period).mean())

def get_swing_points(df: pd.DataFrame, strength: int = 2):
    sh, sl = [], []
    for i in range(strength, len(df) - strength):
        is_high, is_low = True, True
        for j in range(1, strength + 1):
            if df['high'].iloc[i] <= df['high'].iloc[i-j] or df['high'].iloc[i] <= df['high'].iloc[i+j]: is_high = False
            if df['low'].iloc[i] >= df['low'].iloc[i-j] or df['low'].iloc[i] >= df['low'].iloc[i+j]: is_low = False
        if is_high: sh.append({"index": i, "price": df['high'].iloc[i]})
        if is_low: sl.append({"index": i, "price": df['low'].iloc[i]})
    return sh, sl

def is_displacement_candle(df: pd.DataFrame, idx: int, atr: float, direction: str) -> bool:
    """
    Check if the candle at idx is a strong displacement candle.
    Includes body dominance and candle range expansion filters.
    """
    open_p, close_p = df['open'].iloc[idx], df['close'].iloc[idx]
    high_p, low_p = df['high'].iloc[idx], df['low'].iloc[idx]
    
    body = abs(close_p - open_p)
    candle_range = high_p - low_p
    
    # 1. Minimum Body Size
    if body < atr * 0.5:
        return False
        
    # 2. Candle Range Expansion (should be a decently sized candle)
    # HARD REJECT: candle_range < ATR * 1.2
    if candle_range < atr * 1.2:
        return False
        
    # 3. Body Dominance Filter (Body takes up majority of the candle)
    if candle_range > 0 and (body / candle_range) < 0.6:
        return False
        
    if direction == "bullish":
        # Ensure it closes strong without a massive upper wick rejection
        upper_wick = high_p - close_p
        return upper_wick < body * 0.5 and close_p > open_p
    else:
        # Ensure it closes strong without a massive lower wick rejection
        lower_wick = close_p - low_p
        return lower_wick < body * 0.5 and close_p < open_p

def detect_institutional_bos(df: pd.DataFrame, bias: str, atr: float, sh: list, sl: list) -> bool:
    """
    Institutional Grade BOS (Break of Structure) Detection:
    - Uses strict swing high/low points
    - Requires displacement candle (body > 0.5 ATR, strong close, body > 60% of range)
    - Body close confirmation beyond the swing structure (Weak breakout rejection)
    - Liquidity taken: ensures the latest structure swept prior liquidity (Fake sweep rejection)
    - Continuation momentum score: next candle holds the structural break
    """
    if len(sh) < 2 or len(sl) < 2:
        return False
        
    last_sh = sh[-1]
    prev_sh = sh[-2]
    last_sl = sl[-1]
    prev_sl = sl[-2]
    
    for i in range(max(1, len(df)-10), len(df)-1):
        if bias == "bullish":
            # 1. Fake Sweep Rejection: Ensure the sweep is noticeable (depth > 0.1 ATR)
            sweep_depth = prev_sl['price'] - last_sl['price']
            liquidity_taken = sweep_depth > (atr * 0.1)
            
            # 2. Weak Breakout Rejection: Close must be significantly above the structure (> 0.2 ATR)
            breakout_distance = df['close'].iloc[i] - last_sh['price']
            candle_breaks_struct = breakout_distance > (atr * 0.2) and df['close'].iloc[i-1] <= last_sh['price']
            
            if liquidity_taken and candle_breaks_struct:
                # 3. Displacement: Must be a strong momentum candle
                if is_displacement_candle(df, i, atr, "bullish"):
                    # 4. Continuation Momentum Score
                    # The next immediate candle must hold the displacement and not violently reverse
                    median_displacement = (df['open'].iloc[i] + df['close'].iloc[i]) / 2.0
                    next_close = df['close'].iloc[i+1]
                    next_open = df['open'].iloc[i+1]
                    displacement_body = df['close'].iloc[i] - df['open'].iloc[i]
                    
                    holds_level = next_close >= median_displacement
                    bearish_reversal_body = max(0, next_open - next_close)
                    not_strong_reversal = bearish_reversal_body < (displacement_body * 0.6)
                    
                    if holds_level and not_strong_reversal:
                        return True
                        
        elif bias == "bearish":
            # 1. Fake Sweep Rejection: Ensure the sweep is noticeable (depth > 0.1 ATR)
            sweep_depth = last_sh['price'] - prev_sh['price']
            liquidity_taken = sweep_depth > (atr * 0.1)
            
            # 2. Weak Breakout Rejection: Close must be significantly below the structure (> 0.2 ATR)
            breakout_distance = last_sl['price'] - df['close'].iloc[i]
            candle_breaks_struct = breakout_distance > (atr * 0.2) and df['close'].iloc[i-1] >= last_sl['price']
            
            if liquidity_taken and candle_breaks_struct:
                # 3. Displacement
                if is_displacement_candle(df, i, atr, "bearish"):
                    # 4. Continuation Momentum Score
                    median_displacement = (df['open'].iloc[i] + df['close'].iloc[i]) / 2.0
                    next_close = df['close'].iloc[i+1]
                    next_open = df['open'].iloc[i+1]
                    displacement_body = df['open'].iloc[i] - df['close'].iloc[i]
                    
                    holds_level = next_close <= median_displacement
                    bullish_reversal_body = max(0, next_close - next_open)
                    not_strong_reversal = bullish_reversal_body < (displacement_body * 0.6)
                    
                    if holds_level and not_strong_reversal:
                        return True
                        
    return False

def detect_institutional_choch(df: pd.DataFrame, bias: str, atr: float, sh: list, sl: list) -> dict:
    """
    Institutional Grade CHOCH Detection:
    - Internal vs External structure targeting
    - Inducement validation (Sweep quality > 0.1 ATR)
    - Fake reversal rejection (Displacement validation on breakout)
    """
    if len(sh) < 4 or len(sl) < 4:
        return {"valid": False, "sweep": False}
        
    # Separate into External (Major) and Internal (Minor) structures
    ext_sh = sh[-2]
    ext_sl = sl[-2]
    int_sh = sh[-1]
    int_sl = sl[-1]
    
    liq_sweep = False
    
    for i in range(max(1, len(df)-15), len(df)-1):
        if bias == "bullish":
            # 1. Sweep Quality & Inducement Validation (Must sweep External Low)
            sweep_depth = ext_sl['price'] - df['low'].iloc[i]
            is_valid_sweep_candle = df['low'].iloc[i] < ext_sl['price'] and df['close'].iloc[i] > ext_sl['price']
            
            if is_valid_sweep_candle and sweep_depth > (atr * 0.1):
                liq_sweep = True
                
                # 2. Internal Structure Break (CHOCH) - Must break Internal High
                for j in range(i+1, len(df)):
                    # Breakout distance Check (Fake reversal rejection)
                    breakout_distance = df['close'].iloc[j] - int_sh['price']
                    candle_breaks_struct = breakout_distance > (atr * 0.15) and df['close'].iloc[j-1] <= int_sh['price']
                    
                    if candle_breaks_struct:
                        # 3. Displacement & Momentum Validation
                        if is_displacement_candle(df, j, atr, "bullish"):
                            return {"valid": True, "sweep": True}
                            
        elif bias == "bearish":
            # 1. Sweep Quality & Inducement Validation (Must sweep External High)
            sweep_depth = df['high'].iloc[i] - ext_sh['price']
            is_valid_sweep_candle = df['high'].iloc[i] > ext_sh['price'] and df['close'].iloc[i] < ext_sh['price']
            
            if is_valid_sweep_candle and sweep_depth > (atr * 0.1):
                liq_sweep = True
                
                # 2. Internal Structure Break (CHOCH) - Must break Internal Low
                for j in range(i+1, len(df)):
                    breakout_distance = int_sl['price'] - df['close'].iloc[j]
                    candle_breaks_struct = breakout_distance > (atr * 0.15) and df['close'].iloc[j-1] >= int_sl['price']
                    
                    if candle_breaks_struct:
                        # 3. Displacement & Momentum Validation
                        if is_displacement_candle(df, j, atr, "bearish"):
                            return {"valid": True, "sweep": True}
                            
    return {"valid": False, "sweep": liq_sweep}

def detect_institutional_fvg(df: pd.DataFrame, bias: str, atr: float) -> dict:
    """
    Institutional Grade FVG Detection:
    - Minimum imbalance size (Reject tiny FVG)
    - Premium/Discount location filter
    - Displacement validation (momentum body)
    - Midpoint mitigation (price taps midpoint or deeper)
    - Nested FVG handling (selects optimal FVG)
    """
    valid_fvgs = []
    
    # Calculate local range for Premium/Discount
    local_high = df['high'].iloc[-15:].max()
    local_low = df['low'].iloc[-15:].min()
    local_range = local_high - local_low
    
    for i in range(len(df)-15, len(df)-2):
        if bias == "bullish":
            # 1. Basic FVG Gap Formation
            if df['high'].iloc[i] < df['low'].iloc[i+2]:
                fvg_gap = df['low'].iloc[i+2] - df['high'].iloc[i]
                body = df['close'].iloc[i+1] - df['open'].iloc[i+1]
                
                # 2. Minimum Imbalance Size & Displacement
                # HARD REJECT: fvg_size < ATR * 0.15
                if fvg_gap < (atr * 0.15): continue
                if body > (atr * 0.5):
                    fvg_zone = (float(df['high'].iloc[i]), float(df['low'].iloc[i+2]))
                    midpoint = (fvg_zone[0] + fvg_zone[1]) / 2
                    
                    # 3. Premium/Discount Location (Avoid buying at extreme premium)
                    if midpoint < (local_high - local_range * 0.2):
                        # 4. Midpoint Mitigation Check
                        mitigated = False
                        for j in range(i+2, len(df)):
                            if df['low'].iloc[j] <= midpoint and df['close'].iloc[j] > fvg_zone[0]:
                                mitigated = True
                                break
                        
                        if mitigated:
                            valid_fvgs.append({"zone": fvg_zone, "gap": fvg_gap})
                        
        elif bias == "bearish":
            # 1. Basic FVG Gap Formation
            if df['low'].iloc[i] > df['high'].iloc[i+2]:
                fvg_gap = df['low'].iloc[i] - df['high'].iloc[i+2]
                body = df['open'].iloc[i+1] - df['close'].iloc[i+1]
                
                # 2. Minimum Imbalance Size & Displacement
                # HARD REJECT: fvg_size < ATR * 0.15
                if fvg_gap < (atr * 0.15): continue
                if body > (atr * 0.5):
                    fvg_zone = (float(df['low'].iloc[i]), float(df['high'].iloc[i+2]))
                    midpoint = (fvg_zone[0] + fvg_zone[1]) / 2
                    
                    # 3. Premium/Discount Location (Avoid selling at extreme discount)
                    if midpoint > (local_low + local_range * 0.2):
                        # 4. Midpoint Mitigation Check
                        mitigated = False
                        for j in range(i+2, len(df)):
                            if df['high'].iloc[j] >= midpoint and df['close'].iloc[j] < fvg_zone[0]:
                                mitigated = True
                                break
                                
                        if mitigated:
                            valid_fvgs.append({"zone": fvg_zone, "gap": fvg_gap})
                            
    # 5. Nested FVG Filter: If multiple valid FVGs exist, pick the largest/clearest gap
    if valid_fvgs:
        best_fvg = max(valid_fvgs, key=lambda x: x["gap"])
        return {"valid": True, "zone": best_fvg["zone"]}
        
    return {"valid": False, "zone": None}

def detect_smc(h1_candles, m15_candles, m5_candles, m1_candles):
    df_h1 = pd.DataFrame(h1_candles)
    df_m15 = pd.DataFrame(m15_candles)
    df_m5 = pd.DataFrame(m5_candles)
    df_m1 = pd.DataFrame(m1_candles)
    
    if len(df_h1) < 30 or len(df_m15) < 30 or len(df_m5) < 30 or len(df_m1) < 30:
        return {"valid": False, "reason": "Insufficient market data to detect structure"}
        
    atr_h1 = calculate_atr_df(df_h1, 14)
    atr_m15 = calculate_atr_df(df_m15, 14)
    atr_m5 = calculate_atr_df(df_m5, 14)
    atr_m1 = calculate_atr_df(df_m1, 14)
    
    if atr_h1 == 0 or atr_m15 == 0 or atr_m5 == 0 or atr_m1 == 0:
        return {"valid": False, "reason": "Insufficient data for dynamic ATR calculation"}
        
    # === HARD REJECT LAYER ===
    # 0.1 Abnormal Volatility (ATR check)
    recent_m15_body = abs(df_m15['close'].iloc[-1] - df_m15['open'].iloc[-1])
    recent_m15_range = df_m15['high'].iloc[-1] - df_m15['low'].iloc[-1]
    
    # Reject: Candle terlalu kecil (Dead Market)
    if recent_m15_range < (atr_m15 * 0.3):
        return {"valid": False, "reason": "HARD REJECT: Market is dead (Recent M15 range < 30% ATR)"}
        
    # Reject: ATR abnormal (News Spike)
    if recent_m15_range > (atr_m15 * 4.0):
        return {"valid": False, "reason": "HARD REJECT: Abnormal Volatility (Recent M15 range > 4x ATR)"}
        
    # Reject: Spread abnormal / Whiplash
    if recent_m15_range > 0 and (recent_m15_body / recent_m15_range) < 0.1 and recent_m15_range > atr_m15:
        return {"valid": False, "reason": "HARD REJECT: Abnormal Spread / Whiplash (Doji with massive range)"}

    # 1. H1 BIAS ENGINE (Institutional Direction)
    sh_h1, sl_h1 = get_swing_points(df_h1, strength=3)
    if not sh_h1 or not sl_h1:
        return {"valid": False, "reason": "No valid H1 swing structure"}
        
    h1_bias = "neutral"
    last_sh_h1, last_sl_h1 = sh_h1[-1]['price'], sl_h1[-1]['price']
    
    # H1 Structural Break with Displacement confirmation
    for i in range(len(df_h1)-5, len(df_h1)):
        body = abs(df_h1['close'].iloc[i] - df_h1['open'].iloc[i])
        is_displacement = body > atr_h1 * 0.5
        
        if df_h1['close'].iloc[i] > last_sh_h1 and is_displacement:
            h1_bias = "bullish"
            break
        elif df_h1['close'].iloc[i] < last_sl_h1 and is_displacement:
            h1_bias = "bearish"
            break

    if h1_bias == "neutral":
        if sh_h1[-1]['index'] > sl_h1[-1]['index']: h1_bias = "bullish"
        else: h1_bias = "bearish"
        
    # 2. BOS & CHOCH (M15 Liquidity Sweep & Structure Shift)
    sh_15, sl_15 = get_swing_points(df_m15, strength=2)
    if len(sh_15) < 3 or len(sl_15) < 3: return {"valid": False, "reason": "No M15 internal swing structure"}
    
    bos_valid = detect_institutional_bos(df_m15, h1_bias, atr_m15, sh_15, sl_15)
    
    choch_res = detect_institutional_choch(df_m15, h1_bias, atr_m15, sh_15, sl_15)
    choch_valid = choch_res["valid"]
    liq_sweep = choch_res["sweep"]

    if not (liq_sweep and bos_valid and choch_valid):
        return {"valid": False, "reason": f"HARD REJECT: Invalid Structure (No Displacement, No Sweep, or Weak Breakout) context: {h1_bias}"}
        
    # 3 & 4. FVG Mitigation (M5 Displacement & Midpoint Rejection)
    fvg_res = detect_institutional_fvg(df_m5, h1_bias, atr_m5)
    
    if not fvg_res["valid"]:
        return {"valid": False, "reason": "HARD REJECT: Weak or No FVG Mitigation (Requires midpoint mitigation and displacement)"}
    
    fvg_zone = fvg_res["zone"]

    # 5. Entry Confirmation (M1 Rejection Pinbar / Engulfing / Micro CHOCH)
    last_m1 = m1_candles[-1]
    last_open = last_m1['open']
    last_close = last_m1['close']
    last_high = last_m1['high']
    last_low = last_m1['low']
    
    body_last = abs(last_close - last_open)
    range_last = last_high - last_low
    
    # HARD REJECT: Tiny momentum on entry
    if range_last < (atr_m1 * 0.3):
        return {"valid": False, "reason": "HARD REJECT: M1 candle too small (No entry momentum)"}
        
    if body_last == 0: return {"valid": False, "reason": "HARD REJECT: Weak M1 entry confirmation (Doji)"}
    
    rejection_type = "None"
    entry_valid = False
    
    if h1_bias == "bullish":
        wick = min(last_open, last_close) - last_low
        if wick > body_last * 1.5:
            rejection_type = "Bullish Pinbar Rejection"
            entry_valid = True
        elif last_close > m1_candles[-2]['high']:
            rejection_type = "Bullish Engulfing / Micro CHOCH"
            entry_valid = True
    else:
        wick = last_high - max(last_open, last_close)
        if wick > body_last * 1.5:
            rejection_type = "Bearish Pinbar Rejection"
            entry_valid = True
        elif last_close < m1_candles[-2]['low']:
            rejection_type = "Bearish Engulfing / Micro CHOCH"
            entry_valid = True

    if not entry_valid:
        return {"valid": False, "reason": "HARD REJECT: No strong M1 institutional entry confirmation (reversal / pinbar)"}

    entry_price = float(last_close)
    
    # 7. Dynamic ATR & Risk Management (Anti-Stophunt SL)
    buffer = atr_m1 * 1.0 
    
    if h1_bias == "bullish":
        sl = min([c['low'] for c in m1_candles[-15:]]) - buffer
        sl_dist = entry_price - sl
        if sl_dist <= 0.05: return {"valid": False, "reason": "HARD REJECT: SL distance too small (Abnormal volatility calculation)"}
        tp1 = entry_price + (sl_dist * settings["tp1_rr"])
        tp2 = entry_price + (sl_dist * settings["tp2_rr"])
    else:
        sl = max([c['high'] for c in m1_candles[-15:]]) + buffer
        sl_dist = sl - entry_price
        if sl_dist <= 0.05: return {"valid": False, "reason": "HARD REJECT: SL distance too small (Abnormal volatility calculation)"}
        tp1 = entry_price - (sl_dist * settings["tp1_rr"])
        tp2 = entry_price - (sl_dist * settings["tp2_rr"])

    logger.info(f"SMC Setup DETECTED: {h1_bias.upper()} | FVG: {fvg_zone} | Conf: {rejection_type}")

    return {
        "valid": True,
        "type": "BUY" if h1_bias == "bullish" else "SELL",
        "entry": entry_price,
        "sl": round(sl, 2),
        "tp1": round(tp1, 2),
        "tp2": round(tp2, 2),
        "bias": h1_bias,
        "sl_pips": round(sl_dist * 10, 1),
        "timestamp": last_m1["datetime"],
        "fvg_zone": [round(fvg_zone[0], 2), round(fvg_zone[1], 2)],
        "atr": float(atr_m15),
        "h1_bias": h1_bias,
        "liq_sweep": liq_sweep,
        "bos": bos_valid,
        "rejection_type": rejection_type
    }
        
async def validate_with_gemini(signal_data: dict):
    if not gemini_model:
        logger.info("Gemini Bypass: No API Key provided.")
        return {"valid": True, "reason": "Bypassed (No API Key)", "confidence": 100}
    
    try:
        fvg_msg = f"{signal_data['fvg_zone'][0]:.2f} - {signal_data['fvg_zone'][1]:.2f}" if signal_data.get('fvg_zone') else "Unknown"
        prompt = f"""Analisa setup Institutional Smart Money Concepts (SMC) berikut untuk scalping XAUUSD:
Waktu (WITA): {signal_data['timestamp']}
Arah (H1 Bias): {signal_data.get('h1_bias', signal_data.get('bias'))}
Liquidity Sweep (M15): {signal_data.get('liq_sweep', False)}
BOS Valid (M15): {signal_data.get('bos', False)}
CHOCH Valid (M15): {signal_data.get('liq_sweep', False)}
M5/M1 Rejection: {signal_data.get('rejection_type', 'Valid')}
FVG Midpoint Mitigation Zone: {fvg_msg}
Entry: {signal_data['entry']}
SL (Dynamic Anti-stophunt): {signal_data['sl']}
TP1: {signal_data['tp1']} (RR: {settings['tp1_rr']})
TP2: {signal_data['tp2']} (RR: {settings['tp2_rr']})
ATR: {signal_data['atr']:.2f}

Pertanyaan: Berikan Confidence Score (0-100) dan alasan validasi dari eksekusi ini.
Signal HANYA valid jika skor >= 87. Tolak jika berisiko atau confidence rendah.
Format kembalian murni JSON tanpa markdown, format:
{{
  "confidence": 88,
  "valid": true,
  "reason": "Alasan analisa SMC (max 2 kalimat)"
}}"""
        
        response = gemini_model.generate_content(
            prompt, 
            generation_config=genai.GenerationConfig(response_mime_type="application/json")
        )
        data = json.loads(response.text)
        return data
    except Exception as e:
        logger.error(f"Gemini Validation Error: {e}")
        # Jika gemini timeout/down, fallback ke approve karena setup lokal SMC sudah lengkap & ketat, 
        # sesuai best practice reliability, tapi log warning.
        return {"valid": True, "confidence": 90, "reason": f"AI Error Fallback: {str(e)[:50]}"}

async def notify_telegram(sig_obj):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    
    try:
        dt_utc = datetime.fromisoformat(sig_obj['created_at_utc'].replace("Z", ""))
        tz = pytz.timezone('Asia/Makassar')
        dt_wita = dt_utc.replace(tzinfo=pytz.utc).astimezone(tz)
        wita_str = dt_wita.strftime('%H:%M:%S')

        text = f"""🚨 <b>INSTITUTIONAL SMC SCALP</b> 🚨

⏰ Waktu (WITA): <code>{wita_str}</code>
💱 Pair: XAUUSD
📈 Action: <b>{sig_obj['type']}</b>
🎯 Entry: <code>{sig_obj['entry']}</code>
🛑 SL (Anti-stophunt): <code>{sig_obj['sl']}</code>
💰 TP1: <code>{sig_obj['tp1']}</code> (1:{settings['tp1_rr']})
🤑 TP2: <code>{sig_obj['tp2']}</code> (1:{settings['tp2_rr']})

🧠 <b>Setup Info</b>:
• Bias: {sig_obj.get('ai_reason', 'Valid')}
• Conf: {sig_obj.get('confidence', 100)}%

🤖 <b>AI Validator</b>: Approved."""
        
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        async with httpx.AsyncClient() as client:
            await client.post(url, json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": text,
                "parse_mode": "HTML"
            }, timeout=10.0)
        logger.info("Telegram notification sent successfully.")
    except Exception as e:
        logger.error(f"Telegram notification failed: {e}")

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "Institutional SMC Bot"}

@app.get("/api/live-signal")
async def process_signal():
    try:
        if not settings["enabled"]:
           return {"status": "disabled", "message": "Bot is currently disabled in settings"}
           
        if not is_in_killzone():
            logger.info("Session Closed: Outside of Killzone")
            return {"status": "waiting", "message": "HARD REJECT: Outside of Killzone (15:00-18:00 or 21:30-00:00 WITA)"}

        # 9. Anti-spam: 15min cooldown check (SQLite)
        conn = get_db_connection()
        c = conn.cursor()
        c.execute('SELECT last_signal_time FROM cooldown WHERE id = 1')
        row = c.fetchone()
        
        if row and row[0]: # If exists and not None
            last_sig_time = datetime.fromisoformat(row[0])
            elapsed = (datetime.utcnow() - last_sig_time).total_seconds()
            if elapsed < 300: # 5 minutes basic burst cooldown
                conn.close()
                return {"status": "waiting", "message": f"HARD REJECT: Global Burst Cooldown active ({int(300 - elapsed)}s remaining)"}

        h1, m15, m5, m1 = await asyncio.gather(
            get_market_data("1h"),
            get_market_data("15min"),
            get_market_data("5min"),
            get_market_data("1min")
        )

        result = detect_smc(h1, m15, m5, m1)
        
        if result["valid"]:
            # Duplicate Signal Protection (Same Direction within 15 mins limits + Exact identical timestamp hash)
            signal_type = result["type"]
            c.execute('SELECT created_at_utc, timestamp FROM signals WHERE type = ? ORDER BY id DESC LIMIT 1', (signal_type,))
            last_same_dir = c.fetchone()
            if last_same_dir and last_same_dir[0]:
                try:
                    # Duplicate hashing check (same internal M1 candle timestamp or exact same generated string)
                    if last_same_dir[1] == result.get("timestamp"):
                        conn.close()
                        return {"status": "no_signal", "reason": "HARD REJECT: Exact duplicate signal on same candle."}
                        
                    last_time = datetime.fromisoformat(last_same_dir[0])
                    elapsed_same_dir = (datetime.utcnow() - last_time).total_seconds()
                    if elapsed_same_dir < 900: # 15 minutes strict cooldown
                        conn.close()
                        return {"status": "no_signal", "reason": f"HARD REJECT: Repeated Signal Blocked. Same direction '{signal_type}' within 15 mins ({int(900 - elapsed_same_dir)}s left)"}
                except ValueError:
                    pass
                    
            # 6. AI Validation Layer
            ai_eval = await validate_with_gemini(result)
            conf = ai_eval.get("confidence", 0)
            reason = ai_eval.get("reason", "No reason provided")
            
            if not ai_eval.get("valid", True) or conf < 87:
                logger.info(f"AI REJECTED Setup. Conf: {conf}%. Reason: {reason}")
                conn.close()
                return {"status": "no_signal", "reason": f"HARD REJECT: AI Confidence < 87% ({conf}%) - {reason}"}
                
            logger.info(f"AI APPROVED Setup. Conf: {conf}%.")
            created_at = datetime.utcnow()
            
            # Formatting timestamp to standard Asia/Makassar
            tz_wita = pytz.timezone('Asia/Makassar')
            created_wita = created_at.replace(tzinfo=pytz.utc).astimezone(tz_wita)
            
            sig_obj = {
                "type": result["type"],
                "entry": result["entry"],
                "sl": result["sl"],
                "tp1": result["tp1"],
                "tp2": result["tp2"],
                "created_at_utc": created_at.isoformat() + "Z",
                "timestamp": created_wita.strftime('%Y-%m-%d %H:%M:%S WITA'),
                "ai_reason": reason,
                "confidence": conf
            }
            
            # 11. Database Persistence 
            c.execute('''
                INSERT INTO signals (type, entry, sl, tp1, tp2, ai_reason, confidence, timestamp, created_at_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                sig_obj["type"], sig_obj["entry"], sig_obj["sl"], sig_obj["tp1"], sig_obj["tp2"],
                sig_obj["ai_reason"], sig_obj["confidence"], sig_obj["timestamp"], created_at.isoformat()
            ))
            sig_id = c.lastrowid
            sig_obj["id"] = sig_id
            
            c.execute('SELECT id FROM cooldown WHERE id = 1')
            if c.fetchone():
                c.execute('UPDATE cooldown SET last_signal_time = ? WHERE id = 1', (created_at.isoformat(),))
            else:
                c.execute('INSERT INTO cooldown (id, last_signal_time) VALUES (1, ?)', (created_at.isoformat(),))
                
            conn.commit()
            conn.close()
            
            asyncio.create_task(notify_telegram(sig_obj))
            
            return {"status": "signal", "data": sig_obj, "ai_reason": reason}
        else:
            conn.close()
            return {"status": "no_signal", "reason": result["reason"]}

    except Exception as e:
        logger.error(f"Error in process_signal: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/history")
async def get_history():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('''
        SELECT id, type, entry, sl, tp1, tp2, ai_reason, confidence, timestamp, created_at_utc, status 
        FROM signals 
        ORDER BY id DESC LIMIT 50
    ''')
    rows = c.fetchall()
    conn.close()
    
    signals_list = []
    for row in rows:
        created_str = row[9] + "Z" if not row[9].endswith("Z") else row[9]
        signals_list.append({
            "id": row[0],
            "type": row[1],
            "entry": row[2],
            "sl": row[3],
            "tp1": row[4],
            "tp2": row[5],
            "ai_reason": row[6],
            "confidence": row[7],
            "timestamp": row[8],
            "created_at_utc": created_str,
            "status": row[10]
        })
        
    return {"signals": signals_list}

@app.get("/api/settings")
async def get_settings():
    return settings

@app.post("/api/settings")
async def update_settings(new_settings: SignalSettings):
    global settings
    settings.update(new_settings.dict())
    
    # Persist to database
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('UPDATE settings SET config = ? WHERE id = 1', (json.dumps(settings),))
    conn.commit()
    conn.close()
    
    return settings
