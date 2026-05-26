import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import yahooFinance from "yahoo-finance2";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

// Polyfill for Node <= 18
const currentDir = process.cwd();

const app = express();
const PORT = 3000;
app.use(express.json());
app.use(cors());

// Configure Logging (simulated via console for AI Studio)
const logger = {
  info: (msg: string) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`)
};

const TWELVEDATA_API_KEY = settings.twelveDataApiKey || process.env.TWELVEDATA_API_KEY || "";
const TELEGRAM_BOT_TOKEN = settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = settings.telegramChatId || process.env.TELEGRAM_CHAT_ID || "";
const SYMBOL = "XAU/USD";
const YF_SYMBOL = "GC=F";

function getAiClient() {
  const key = settings.geminiApiKey || process.env.GEMINI_API_KEY || "";
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}

let settings = {
  enabled: true,
  risk_factor_min: 0.5,
  risk_factor_max: 1.5,
  tp1_rr: 2.5,
  tp2_rr: 4.0,
  max_signals_per_15m: 1,
  twelveDataApiKey: "",
  geminiApiKey: "",
  telegramBotToken: "",
  telegramChatId: "",
  firebaseAppId: "",
  firebaseAuthDomain: "",
  firebaseClientEmail: "",
  firebaseMessagingSenderId: "",
  firebasePrivateKey: "",
  firebaseProjectId: "",
  firebaseStorageBucket: ""
};

interface Signal {
  id: number;
  type: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  created_at_utc: Date;
  timestamp: string;
  ai_reason?: string;
}

const signals: Signal[] = [];

async function validateWithGemini(signalData: any, fvgZone: number[], atr: number): Promise<{valid: boolean, reason: string}> {
  try {
    const ai = getAiClient();
    if (!ai) {
      logger.info("No Gemini API Key, skipping AI validation");
      return { valid: true, reason: "Bypassed (No API Key)" };
    }
    const prompt = `Analisa setup Smart Money Concepts (SMC) berikut untuk scalping XAUUSD:
Waktu (WITA): ${signalData.timestamp}
Arah: ${signalData.type}
Entry: ${signalData.entry}
SL: ${signalData.sl}
TP1: ${signalData.tp1}
TP2: ${signalData.tp2}
ATR: ${atr.toFixed(2)}
FVG Zone: ${fvgZone[0]?.toFixed(2)} - ${fvgZone[1]?.toFixed(2)}
RR Ratio TP1: ${settings.tp1_rr}
RR Ratio TP2: ${settings.tp2_rr}

Pertanyaan: Apakah setup SMC ini berkualitas tinggi dan layak dieksekusi berdasarkan struktur market dan risk reward?
Panduan:
Jawab dengan JSON berformat:
{
  "valid": true / false,
  "reason": "Alasan singkat (max 2 kalimat)"
}
Hanya kirimkan raw JSON, tanpa markdown formatting.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });
    
    if (response.text) {
      const result = JSON.parse(response.text);
      return {
        valid: result.valid,
        reason: result.reason || "Analysis complete"
      };
    }
    return { valid: true, reason: "Failed to parse AI response, proceeding as valid." };
  } catch (err: any) {
    logger.error("Gemini Error: " + err.message);
    return { valid: true, reason: "AI Validation failed, reverting to standard rules" };
  }
}

async function notifyTelegram(sig: any, aiReason: string) {
  const token = settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = settings.telegramChatId || process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const witaTime = new Date(sig.timestamp).toLocaleTimeString("en-US", {timeZone:"Asia/Makassar"});

  const text = `
🚨 <b>SMC SCALP SIGNAL</b> 🚨

⏰ Waktu (WITA): <code>${witaTime}</code>
💱 Pair: XAUUSD
📈 Action: <b>${sig.type}</b>
🎯 Entry: <code>${sig.entry}</code>
🛑 SL (Anti-stophunt): <code>${sig.sl}</code>
💰 TP1: <code>${sig.tp1}</code>
🤑 TP2: <code>${sig.tp2}</code>

🤖 <b>AI Validation:</b>
<i>${aiReason}</i>
  `.trim();
  
  try {
    axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    }).catch((err: any) => logger.error("Telegram error: " + err.message));
  } catch(e) {}
}

function isInKillzone(): boolean {
  const nowUtc = new Date();
  const witaHour = (nowUtc.getUTCHours() + 8) % 24;
  const witaTime = witaHour + (nowUtc.getUTCMinutes() / 60.0);
  
  if (witaHour >= 15 && witaHour < 18) return true;
  if (witaTime >= 21.5 && witaTime < 24.0) return true;
  return false;
}

async function fetchTwelvedata(interval: string, outputsize = 50) {
  const key = settings.twelveDataApiKey || process.env.TWELVEDATA_API_KEY || "";
  if (!key) throw new Error("API Key required");
  const url = `https://api.twelvedata.com/time_series?symbol=${SYMBOL}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`;
  try {
    const resp = await axios.get(url, { timeout: 10000 });
    const data = resp.data;
    if (data.status === "error") throw new Error(data.message);
    if (!data.values) throw new Error("No values in response");
    
    return data.values.map((item: any) => ({
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
      datetime: item.datetime
    })).reverse();
  } catch (e: any) {
    logger.error(`TwelveData ${interval} error: ${e.message}`);
    return null;
  }
}

async function fetchYfinance(interval: string) {
  const intervalMap: Record<string, "1m"|"5m"|"15m"> = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m"
  };
  const yfInterval = intervalMap[interval] || "1m";
  
  try {
    const data = await yahooFinance.chart(YF_SYMBOL, {
      period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      interval: yfInterval
    }) as any;
    
    if (!data || !data.quotes || data.quotes.length === 0) return null;
    
    return data.quotes
      .filter((q) => q.open !== null && q.high !== null && q.low !== null && q.close !== null)
      .map((q) => ({
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        datetime: q.date.toISOString()
      }))
      .slice(-50);
  } catch (e: any) {
    logger.error(`YFinance ${interval} fallback error: ${e.message}`);
    return null;
  }
}

async function getMarketData(interval: string) {
  let data = null;
  if (settings.twelveDataApiKey || process.env.TWELVEDATA_API_KEY) {
    data = await fetchTwelvedata(interval);
  }
  if (!data) {
    data = await fetchYfinance(interval);
  }
  if (!data) {
    throw new Error(`Failed to fetch ${interval} data from all sources (Timeouts/Limits)`);
  }
  return data;
}

function calculateAtr(candles: any[], period = 14) {
  if (candles.length < period * 2) return 0;
  let trList = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i-1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trList.push(tr);
  }
  return trList.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function detectSmc(m15C: any[], m5C: any[], m1C: any[]) {
  if (m15C.length < 20 || m5C.length < 20 || m1C.length < 20) {
    return { valid: false, reason: "Insufficient chart data" };
  }
  
  const lastM15 = m15C[m15C.length - 1];
  const lastM1 = m1C[m1C.length - 1];
  
  // Bias M15
  const recentHighs = m15C.slice(-10, -1).map(c => c.high);
  const recentLows = m15C.slice(-10, -1).map(c => c.low);
  const hh = Math.max(...recentHighs);
  const ll = Math.min(...recentLows);
  
  let bias = "neutral";
  if (lastM15.close > hh) bias = "bullish";
  else if (lastM15.close < ll) bias = "bearish";
  
  if (bias === "neutral") return { valid: false, reason: "No clear M15 BOS", step: "M15_BOS" };
  
  // FVG Mitigation
  let fvgFound = false;
  let fvgZone = [0, 0];
  for (let i = m5C.length - 5; i < m5C.length - 2; i++) {
    if (bias === "bullish" && m5C[i].high < m5C[i+2].low) {
      fvgFound = true;
      fvgZone = [m5C[i].high, m5C[i+2].low];
    }
    else if (bias === "bearish" && m5C[i].low > m5C[i+2].high) {
      fvgFound = true;
      fvgZone = [m5C[i].low, m5C[i+2].high];
    }
  }
  
  if (!fvgFound) return { valid: false, reason: "No M5 FVG mitigated", step: "FVG_WAIT", bias };
  
  // CHOCH M1
  let chochFound = false;
  const m1RecentHighs = m1C.slice(-5, -1).map(c => c.high);
  const m1RecentLows = m1C.slice(-5, -1).map(c => c.low);
  
  if (bias === "bullish" && lastM1.close > Math.max(...m1RecentHighs)) chochFound = true;
  else if (bias === "bearish" && lastM1.close < Math.min(...m1RecentLows)) chochFound = true;
  
  if (!chochFound) return { valid: false, reason: "No M1 CHOCH", step: "CHOCH_WAIT", bias, fvgZone };
  
  // Risk Mgmt
  let atr = calculateAtr(m5C, 14);
  if (atr === 0) atr = 2.0;

  const multMin = settings.risk_factor_min;
  const multMax = settings.risk_factor_max;
  const riskMultiplier = Math.random() * (multMax - multMin) + multMin;
  
  const slDist = atr * riskMultiplier;
  const entryPrice = lastM1.close;
  
  let sl, tp1, tp2;
  if (bias === "bullish") {
    sl = entryPrice - slDist;
    tp1 = entryPrice + (slDist * settings.tp1_rr);
    tp2 = entryPrice + (slDist * settings.tp2_rr);
  } else {
    sl = entryPrice + slDist;
    tp1 = entryPrice - (slDist * settings.tp1_rr);
    tp2 = entryPrice - (slDist * settings.tp2_rr);
  }
  
  return {
    valid: true,
    type: bias === "bullish" ? "BUY" : "SELL",
    entry: Number(entryPrice.toFixed(2)),
    sl: Number(sl.toFixed(2)),
    tp1: Number(tp1.toFixed(2)),
    tp2: Number(tp2.toFixed(2)),
    timestamp: new Date().toISOString(),
    fvgZone,
    atr
  };
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "SMC Bot Scanner (Node Env)" });
});

app.get("/api/test-connections", async (req, res) => {
  const status = {
    twelvedata: false,
    yfinance: false,
    gemini: false,
    telegram: false
  };
  
  try {
    const tdData = await fetchTwelvedata("1min", 1);
    status.twelvedata = !!tdData;
  } catch(e) {}
  
  try {
    const yfData = await fetchYfinance("1min");
    status.yfinance = !!yfData;
  } catch(e) {}

  try {
    const ai = getAiClient();
    if (ai) {
      const resp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: "test" });
      status.gemini = !!resp.text;
    }
  } catch(e) {}

  try {
    const token = settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      const resp = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
      status.telegram = resp.data.ok;
    }
  } catch(e) {}

  res.json(status);
});

app.get("/api/live-signal", async (req, res) => {
  try {
    if (!settings.enabled) {
      return res.json({ status: "disabled", message: "Bot is currently disabled in settings" });
    }
    
    if (!isInKillzone()) {
      return res.json({ status: "waiting", message: "Outside of Killzone (15:00-18:00 or 21:30-00:00 WITA)", step: "WAITING_KILLZONE" });
    }
    
    if (signals.length > 0) {
      const lastSig = signals[signals.length - 1];
      const elapsed = (Date.now() - lastSig.created_at_utc.getTime()) / 1000;
      if (elapsed < 900) {
        return res.json({ status: "waiting", message: `Waiting for next scan window (${Math.floor(900 - elapsed)}s)`, step: "COOLDOWN" });
      }
    }
    
    const [m15, m5, m1] = await Promise.all([
      getMarketData("15min"),
      getMarketData("5min"),
      getMarketData("1min")
    ]);
    
    const result = detectSmc(m15, m5, m1);
    
    if (result.valid) {
      // AI Validation
      const aiEval = await validateWithGemini(result, result.fvgZone, result.atr);
      
      if (!aiEval.valid) {
        return res.json({ status: "no_signal", reason: `AI Rejected: ${aiEval.reason}`, step: "SIGNAL_CANCELLED" });
      }

      const sigObj: Signal = {
        id: signals.length + 1,
        type: result.type as "BUY" | "SELL",
        entry: result.entry,
        sl: result.sl,
        tp1: result.tp1,
        tp2: result.tp2,
        created_at_utc: new Date(),
        timestamp: new Date().toISOString(),
        ai_reason: aiEval.reason
      };
      signals.push(sigObj);

      // Async Telegram Notification
      notifyTelegram(sigObj, aiEval.reason).catch(e => console.error(e));

      res.json({ status: "signal", data: sigObj, step: "SIGNAL_SENT" });
    } else {
      res.json({ status: "no_signal", reason: result.reason, step: result.step, bias: result.bias });
    }
  } catch (err: any) {
    logger.error(`process_signal error: ${err.message}`);
    res.status(500).json({ error: err.message, status: "error" });
  }
});

app.get("/api/history", (req, res) => {
  res.json({ signals: [...signals].reverse() });
});

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  settings = { ...settings, ...req.body };
  res.json(settings);
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(currentDir, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(currentDir, 'dist/index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
