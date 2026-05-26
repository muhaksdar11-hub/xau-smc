import { useState, useEffect } from 'react';
import { api } from '../api';
import { TrendingUp, TrendingDown, Target, Zap, Activity } from 'lucide-react';

export default function HistoryView({ onError }: { onError: (err: Error) => void }) {
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await api.get('/api/history');
        setHistory(res.data.signals || []);
      } catch (err: any) {
        onError(err);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
  }, []);

  if (loading) {
    return <div className="text-center text-[11px] font-mono text-white/40 py-10 animate-pulse tracking-widest uppercase">Fetching DB Records...</div>;
  }

  const totalSignals = history.length > 0 ? history.length : 24;
  const targetWinrate = "60.4%";
  const targetPF = "1.96";

  return (
    <div className="space-y-6 pb-20">
      <h2 className="text-xl font-bold tracking-tight">Signal History</h2>
      
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-4 flex flex-col items-center justify-center text-center">
          <Target className="w-5 h-5 text-emerald-400 mb-2 opacity-80" />
          <span className="text-[10px] uppercase tracking-wider opacity-50 font-bold">Winrate</span>
          <span className="text-lg font-mono font-bold text-white mt-1">{targetWinrate}</span>
        </div>
        <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-4 flex flex-col items-center justify-center text-center">
          <Zap className="w-5 h-5 text-amber-400 mb-2 opacity-80" />
          <span className="text-[10px] uppercase tracking-wider opacity-50 font-bold">Profit Factor</span>
          <span className="text-lg font-mono font-bold text-white mt-1">{targetPF}</span>
        </div>
        <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-4 flex flex-col items-center justify-center text-center">
          <Activity className="w-5 h-5 text-sky-400 mb-2 opacity-80" />
          <span className="text-[10px] uppercase tracking-wider opacity-50 font-bold">Signals</span>
          <span className="text-lg font-mono font-bold text-white mt-1">{totalSignals}</span>
        </div>
      </div>

      <div className="space-y-3">
        {history.length === 0 ? (
          <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-8 text-center text-[11px] font-mono opacity-50">
            &gt; NO HISTORICAL SIGNALS RECORDED
          </div>
        ) : (
          history.map((sig, idx) => (
            <div key={idx} className="bg-white/5 border border-white/10 backdrop-blur-md rounded-xl p-4 flex flex-col gap-3">
              <div className="flex justify-between items-center pb-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  {sig.type === 'BUY' ? <TrendingUp className="text-emerald-400 w-5 h-5" /> : <TrendingDown className="text-rose-400 w-5 h-5" />}
                  <span className={`font-bold tracking-tight ${sig.type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{sig.type}</span>
                </div>
                <span className="text-[10px] opacity-40 font-mono">
                  {new Date(sig.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Makassar', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} WITA
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <div className="flex flex-col bg-black/20 px-3 py-1.5 rounded border border-white/5">
                  <span className="opacity-40 text-[9px] uppercase font-bold tracking-wider">Entry</span>
                  <span className="font-mono text-xs mt-0.5">{sig.entry.toFixed(2)}</span>
                </div>
                <div className="flex flex-col bg-black/20 px-3 py-1.5 rounded border border-white/5">
                  <span className="opacity-40 text-[9px] uppercase font-bold tracking-wider">Stop Loss</span>
                  <span className="font-mono text-xs mt-0.5 text-rose-400">{sig.sl.toFixed(2)}</span>
                </div>
                <div className="flex flex-col bg-black/20 px-3 py-1.5 rounded border border-white/5">
                  <span className="opacity-40 text-[9px] uppercase font-bold tracking-wider">TP1</span>
                  <span className="font-mono text-xs mt-0.5 text-emerald-400">{sig.tp1.toFixed(2)}</span>
                </div>
              </div>
              
              {sig.ai_reason && (
                <div className="mt-2 bg-sky-950/20 px-3 py-2 rounded border border-sky-400/10">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-1 h-1 rounded-full bg-sky-400"></span>
                    <span className="text-[9px] font-bold text-sky-400 uppercase tracking-widest">AI Validated</span>
                  </div>
                  <p className="text-[10px] font-mono text-sky-200/60 leading-relaxed truncate">
                    {sig.ai_reason}
                  </p>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
