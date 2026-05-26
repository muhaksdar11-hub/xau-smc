import { useState, useEffect } from 'react';
import { api } from '../api';
import { Save, Server, ShieldCheck, Database, MessagesSquare, CheckCircle2, XCircle } from 'lucide-react';

export default function SettingsView({ onError }: { onError: (err: Error) => void }) {
  const [settings, setSettings] = useState({
    enabled: true,
    risk_factor_min: 0.5,
    risk_factor_max: 1.5,
    tp1_rr: 2.5,
    tp2_rr: 4.0,
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
  });
  
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connStatus, setConnStatus] = useState<any>(null);

  useEffect(() => {
    api.get('/api/settings').then(res => setSettings(s => ({...s, ...res.data}))).catch(onError);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/api/settings', settings);
      alert('Settings saved successfully!');
    } catch (err: any) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await api.get('/api/test-connections');
      setConnStatus(res.data);
    } catch (err: any) {
      onError(err);
    } finally {
      setTesting(false);
    }
  };

  const handleUpdate = (field: string, value: any) => setSettings(s => ({...s, [field]: value}));

  return (
    <div className="space-y-6 pb-20">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold tracking-tight">System Settings</h2>
        <button 
            onClick={handleTest}
            disabled={testing}
            className="bg-black/50 hover:bg-white/10 border border-white/20 text-white font-mono text-[10px] uppercase px-3 py-1.5 rounded-lg flex items-center gap-2 transition-all disabled:opacity-50"
          >
            <Server className="w-3 h-3" />
            {testing ? 'TESTING...' : 'TEST CONNECTIONS'}
        </button>
      </div>

      {connStatus && (
        <div className="bg-black/40 border border-white/10 backdrop-blur-md rounded-xl p-4 grid grid-cols-2 gap-3 mb-6">
          <StatusIndicator label="TwelveData" isOk={connStatus.twelvedata} />
          <StatusIndicator label="YFinance" isOk={connStatus.yfinance} />
          <StatusIndicator label="Gemini AI" isOk={connStatus.gemini} />
          <StatusIndicator label="Telegram" isOk={connStatus.telegram} />
        </div>
      )}

      <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-2xl p-5 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-[13px] font-bold">Trading Engine</label>
            <p className="text-[11px] font-mono opacity-50 mt-1">Master killswitch for scanner</p>
          </div>
          <button 
            onClick={() => handleUpdate('enabled', !settings.enabled)}
            className={`w-12 h-6 rounded-full transition-colors relative border ${settings.enabled ? 'bg-amber-500 border-amber-400/50 shadow-[0_0_10px_rgba(245,158,11,0.3)]' : 'bg-black/50 border-white/10'}`}
          >
            <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform ${settings.enabled ? 'translate-x-7' : 'translate-x-1 shadow-[0_0_5px_rgba(255,255,255,0.2)]'}`}></div>
          </button>
        </div>

        <hr className="border-white/5" />

        <div className="space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-emerald-400 flex items-center gap-2"><ShieldCheck className="w-4 h-4"/> API Keys</h3>
          <InputField label="TwelveData API Key" field="twelveDataApiKey" type="password" val={settings.twelveDataApiKey} update={handleUpdate} placeholder="Enter TwelveData API Key..." />
          <InputField label="Gemini AI API Key" field="geminiApiKey" type="password" val={settings.geminiApiKey} update={handleUpdate} placeholder="Enter Gemini Pro API Key..." />
        </div>

        <hr className="border-white/5" />

        <div className="space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-sky-400 flex items-center gap-2"><MessagesSquare className="w-4 h-4"/> Telegram Alerts</h3>
          <InputField label="Bot Token" field="telegramBotToken" type="password" val={settings.telegramBotToken} update={handleUpdate} placeholder="71829...:AA..." />
          <InputField label="Chat ID" field="telegramChatId" type="text" val={settings.telegramChatId} update={handleUpdate} placeholder="-100..." />
        </div>

        <hr className="border-white/5" />

        <div className="space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-amber-500 flex items-center gap-2"><Database className="w-4 h-4"/> Firebase Config</h3>
          <div className="grid grid-cols-2 gap-3">
             <InputField label="Project ID" field="firebaseProjectId" type="text" val={settings.firebaseProjectId} update={handleUpdate} />
             <InputField label="App ID" field="firebaseAppId" type="text" val={settings.firebaseAppId} update={handleUpdate} />
          </div>
          <InputField label="Auth Domain" field="firebaseAuthDomain" type="text" val={settings.firebaseAuthDomain} update={handleUpdate} />
          <InputField label="Client Email" field="firebaseClientEmail" type="text" val={settings.firebaseClientEmail} update={handleUpdate} />
          <InputField label="Msg Sender ID" field="firebaseMessagingSenderId" type="text" val={settings.firebaseMessagingSenderId} update={handleUpdate} />
          <InputField label="Storage Bucket" field="firebaseStorageBucket" type="text" val={settings.firebaseStorageBucket} update={handleUpdate} />
          <InputField label="Private Key" field="firebasePrivateKey" type="password" val={settings.firebasePrivateKey} update={handleUpdate} />
        </div>

        <hr className="border-white/5" />

        <div>
          <label className="text-[13px] font-bold block mb-3">ATR Risk Multiplier</label>
          <div className="flex gap-4">
            <div className="w-1/2 relative">
               <span className="absolute left-3 top-2.5 text-[10px] font-mono opacity-40">MIN</span>
               <input type="number" step="0.1" value={settings.risk_factor_min} onChange={e => handleUpdate('risk_factor_min', parseFloat(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg pl-10 pr-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500/50" />
            </div>
            <div className="w-1/2 relative">
               <span className="absolute left-3 top-2.5 text-[10px] font-mono opacity-40">MAX</span>
               <input type="number" step="0.1" value={settings.risk_factor_max} onChange={e => handleUpdate('risk_factor_max', parseFloat(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg pl-10 pr-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500/50" />
            </div>
          </div>
        </div>

        <hr className="border-white/5" />

        <div>
           <label className="text-[13px] font-bold block mb-3">Take Profit Multipliers</label>
          <div className="flex gap-4">
            <div className="w-1/2 relative">
               <span className="absolute left-3 top-2.5 text-[10px] font-mono opacity-40">TP1 RR</span>
               <input type="number" step="0.1" value={settings.tp1_rr} onChange={e => handleUpdate('tp1_rr', parseFloat(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg pl-14 pr-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500/50" />
            </div>
            <div className="w-1/2 relative">
                <span className="absolute left-3 top-2.5 text-[10px] font-mono opacity-40">TP2 RR</span>
               <input type="number" step="0.1" value={settings.tp2_rr} onChange={e => handleUpdate('tp2_rr', parseFloat(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg pl-14 pr-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500/50" />
            </div>
          </div>
        </div>

        <button 
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-amber-500 hover:bg-amber-400 text-black font-bold py-3 px-4 rounded-xl flex justify-center items-center gap-2 mt-6 transition-all text-sm shadow-[0_0_20px_rgba(245,158,11,0.2)] disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Syncing...' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}

function InputField({ label, field, val, type, update, placeholder }: any) {
  return (
    <div className="grid gap-1.5">
      <label className="text-[10px] uppercase font-mono opacity-60 tracking-wider">
        {label}
      </label>
      <input 
        type={type} 
        value={val} 
        onChange={e => update(field, e.target.value)} 
        placeholder={placeholder}
        className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-white/90 focus:outline-none focus:border-amber-500/50 focus:bg-white/5 transition-colors placeholder:text-white/20"
      />
    </div>
  );
}

function StatusIndicator({ label, isOk }: { label: string, isOk: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {isOk ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <XCircle className="w-4 h-4 text-rose-500" />}
      <span className="text-xs font-mono opacity-80">{label}</span>
    </div>
  );
}
