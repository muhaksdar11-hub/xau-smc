import { useState, useEffect } from 'react';
import { api } from '../api';
import { RefreshCcw, TrendingUp, TrendingDown, Crosshair, MapPin, StopCircle } from 'lucide-react';
import { format } from 'date-fns';

export default function Dashboard({ onError }: { onError: (err: Error) => void }) {
  const [signal, setSignal] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'scanning' | 'signal' | 'waiting'>('idle');
  const [message, setMessage] = useState<string>('');
  const [stepData, setStepData] = useState({ step: '', bias: '' });
  
  const scanMarket = async () => {
    setStatus('scanning');
    setMessage('Analyzing M15, M5, M1...');
    try {
      const res = await api.get('/api/live-signal');
      if (res.data.status === 'signal') {
        setSignal(res.data.data);
        setStatus('signal');
        setMessage('Signal Detected & Broadcasted!');
        setStepData({ step: res.data.step, bias: res.data.bias || ''});
      } else {
        setStatus('waiting');
        setMessage(res.data.message || res.data.reason || 'No valid SMC setup found.');
        setStepData({ step: res.data.step, bias: res.data.bias || ''});
      }
    } catch (err: any) {
      setStatus('idle');
      setMessage(err.message || 'Error occurred');
      onError(err);
    }
  };

  useEffect(() => {
    // auto scan disabled as per user request to prevent AI Studio runtime crash
    // scanMarket();
  }, []);

  const getStepStatus = (stepName: string) => {
    const steps = ['M15_BOS', 'FVG_WAIT', 'CHOCH_WAIT', 'AI_VALIDATION', 'SIGNAL_SENT', 'SIGNAL_CANCELLED'];
    if (stepData.step === 'SIGNAL_CANCELLED' && stepName === 'AI_VALIDATION') return 'failed';
    
    // In our backend step represents what FAILED or is CURRENT.
    // If step is "FVG_WAIT", it means M15_BOS succeeded, but FVG is missing.
    if (!stepData.step) return 'pending';
    if (stepData.step === 'SIGNAL_SENT') return 'success';

    const currIdx = steps.indexOf(stepData.step);
    const targetIdx = steps.indexOf(stepName);

    if (currIdx > targetIdx) return 'success';
    if (currIdx === targetIdx) return 'active';
    return 'pending';
  };

  return (
    <div className="space-y-6">
      <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-5 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
          <Crosshair className="w-32 h-32 text-white" />
        </div>
        
        <div className="flex justify-between items-end mb-6">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Live Scanner</h2>
            <p className="text-[11px] font-mono opacity-60 mt-1 flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${status === 'scanning' ? 'bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.6)]' : 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.6)]'}`}></span>
              {status === 'scanning' ? 'SCANNING STRUCTURE...' : 'MONITORING'}
            </p>
          </div>
          <button 
            onClick={scanMarket}
            disabled={status === 'scanning'}
            className="bg-amber-500 hover:bg-amber-400 text-black px-4 py-2 rounded-lg font-semibold text-xs flex items-center gap-2 transition-all disabled:opacity-50 tracking-wider shadow-[0_0_15px_rgba(245,158,11,0.2)]"
          >
            <RefreshCcw className={`w-3.5 h-3.5 ${status === 'scanning' ? 'animate-spin' : ''}`} />
            FORCE SCAN
          </button>
        </div>

        {status === 'waiting' && (
          <div className="bg-black/40 rounded-xl p-4 border border-white/5 backdrop-blur-sm">
            <p className="text-xs font-mono opacity-60 text-center leading-relaxed">{message}</p>
          </div>
        )}
        {(status === 'idle' && message) && (
          <div className="bg-rose-500/10 rounded-xl p-4 border border-rose-500/20 backdrop-blur-sm">
            <p className="text-xs font-mono text-rose-300 text-center leading-relaxed">{message}</p>
          </div>
        )}

        {signal && status === 'signal' && (
          <div className={`rounded-xl p-5 border backdrop-blur-md ${signal.type === 'BUY' ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center gap-2">
                {signal.type === 'BUY' ? <TrendingUp className="text-emerald-400" /> : <TrendingDown className="text-rose-400" />}
                <span className={`font-bold text-lg tracking-tight ${signal.type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {signal.type} XAUUSD
                </span>
              </div>
              <span className="text-[10px] opacity-50 font-mono border border-white/10 px-2 py-0.5 rounded-full bg-black/20">
                {new Date(signal.timestamp).toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit', second: '2-digit' })} WITA
              </span>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-black/40 p-3 rounded-lg border border-white/5">
                <span className="text-[9px] opacity-40 uppercase font-bold tracking-wider mb-1 flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> Entry
                </span>
                <span className="font-mono text-lg">{signal.entry.toFixed(2)}</span>
              </div>
              <div className="bg-black/40 p-3 rounded-lg border border-white/5">
                <span className="text-[9px] opacity-40 uppercase font-bold tracking-wider mb-1 flex items-center gap-1">
                  <StopCircle className="w-3 h-3" /> Stop Loss
                </span>
                <span className="font-mono text-lg text-rose-400">{signal.sl.toFixed(2)}</span>
              </div>
              <div className="bg-black/40 p-3 rounded-lg border border-white/5">
                <span className="text-[9px] opacity-40 uppercase font-bold tracking-wider mb-1 flex items-center gap-1">
                  <Crosshair className="w-3 h-3" /> TP 1 (RR 2.5)
                </span>
                <span className="font-mono text-lg text-emerald-400">{signal.tp1.toFixed(2)}</span>
              </div>
              <div className="bg-black/40 p-3 rounded-lg border border-white/5">
                <span className="text-[9px] opacity-40 uppercase font-bold tracking-wider mb-1 flex items-center gap-1">
                  <Crosshair className="w-3 h-3" /> TP 2 (RR 4.0)
                </span>
                <span className="font-mono text-lg text-emerald-400">{signal.tp2.toFixed(2)}</span>
              </div>
            </div>

            {signal.ai_reason && (
              <div className="mt-4 bg-sky-950/30 border border-sky-400/20 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"></span>
                  <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Gemini AI Engine</span>
                </div>
                <p className="text-[11px] font-mono text-sky-200/80 leading-relaxed">
                  {signal.ai_reason}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-5">
        <h3 className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-4 font-bold">Strategy Execution Pipeline</h3>
        <ul className="space-y-3 font-mono text-[11px] opacity-80">
          <PipelineItem label="M15 Market Structure" status={getStepStatus('M15_BOS')} meta={stepData.bias ? stepData.bias.toUpperCase() : ''} />
          <PipelineItem label="M5 Retracement (FVG)" status={getStepStatus('FVG_WAIT')} />
          <PipelineItem label="M1 Order Flow (CHOCH)" status={getStepStatus('CHOCH_WAIT')} />
          <PipelineItem label="AI Validation Assessment" status={getStepStatus('AI_VALIDATION')} failedMsg="AI Rejected" />
          <PipelineItem label="Signal Telegram Broadcast" status={getStepStatus('SIGNAL_SENT')} />
        </ul>
      </div>
    </div>
  );
}

function PipelineItem({ label, status, meta, failedMsg }: any) {
  let stateNode = <span className="text-white/40">PENDING</span>;
  if (status === 'success') stateNode = <span className="text-emerald-400">PASSED</span>;
  if (status === 'active') stateNode = <span className="text-amber-400 animate-pulse">SCANNING...</span>;
  if (status === 'failed') stateNode = <span className="text-rose-400">{failedMsg || 'FAILED'}</span>;
  return (
    <li className={`flex justify-between items-center px-3 py-2.5 rounded-lg border ${status === 'active' ? 'bg-amber-500/10 border-amber-500/20' : 'bg-black/20 border-white/5'}`}>
      <span className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${status === 'success' ? 'bg-emerald-500' : status === 'active' ? 'bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.5)]' : status === 'failed' ? 'bg-rose-500' : 'bg-white/20'}`}></span>
        {label}
        {meta && status !== 'pending' && <span className="text-[9px] bg-white/10 px-1.5 py-0.5 rounded opacity-60 ml-2">{meta}</span>}
      </span>
      {stateNode}
    </li>
  );
}
