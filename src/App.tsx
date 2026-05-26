import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import SettingsView from './components/SettingsView';
import HistoryView from './components/HistoryView';
import { Activity, Settings, Clock, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { api } from './api';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history' | 'settings'>('dashboard');
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Expose error handler to components
  const handleError = (err: Error) => {
    setGlobalError(err.message);
    setTimeout(() => setGlobalError(null), 8000);
  };

  return (
    <div className="min-h-screen bg-[#050507] text-[#e0e0e0] font-sans selection:bg-amber-500/30 relative overflow-hidden">
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-amber-500/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600/10 rounded-full blur-[120px]"></div>
      </div>

      <div className="max-w-md mx-auto min-h-screen flex flex-col relative z-10 shadow-[0_0_40px_rgba(0,0,0,0.5)] overflow-hidden">
        
        {/* Header */}
        <header className="h-16 px-4 border-b border-white/10 bg-white/5 backdrop-blur-md sticky top-0 z-20 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-amber-500 rounded-lg flex items-center justify-center font-bold text-black border border-amber-400/50 shadow-[0_0_15px_rgba(245,158,11,0.3)]">X</div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight">SMC <span className="text-amber-500 underline decoration-2 underline-offset-4">XAUUSD</span></h1>
              <p className="text-[10px] opacity-50 font-mono tracking-widest uppercase">Auto-Scanner</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></span>
            </span>
          </div>
        </header>

        {/* Global Error Banner */}
        <AnimatePresence>
          {globalError && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="m-4 p-3 bg-rose-500/10 border border-rose-500/30 backdrop-blur-md rounded-xl flex items-start gap-3 shadow-[0_0_15px_rgba(244,63,94,0.15)] z-30"
            >
              <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-xs font-bold text-rose-400 uppercase tracking-wider">System Error</h3>
                <p className="text-[11px] font-mono text-rose-200/80 mt-1 break-words leading-relaxed">{globalError}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-4 scroller relative z-10 pb-24">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.15 }}
            >
              {activeTab === 'dashboard' && <Dashboard onError={handleError} />}
              {activeTab === 'history' && <HistoryView onError={handleError} />}
              {activeTab === 'settings' && <SettingsView onError={handleError} />}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Bottom Navigation */}
        <nav className="fixed bottom-0 w-full max-w-md bg-black/50 backdrop-blur-xl border-t border-white/10 flex justify-around p-2 z-20 pb-safe">
          <NavItem 
            isActive={activeTab === 'dashboard'} 
            onClick={() => setActiveTab('dashboard')} 
            icon={<Activity className="w-5 h-5" />} 
            label="Scanner" 
          />
          <NavItem 
            isActive={activeTab === 'history'} 
            onClick={() => setActiveTab('history')} 
            icon={<Clock className="w-5 h-5" />} 
            label="History" 
          />
          <NavItem 
            isActive={activeTab === 'settings'} 
            onClick={() => setActiveTab('settings')} 
            icon={<Settings className="w-5 h-5" />} 
            label="Settings" 
          />
        </nav>
      </div>
    </div>
  );
}

function NavItem({ isActive, onClick, icon, label }: { isActive: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center p-2 rounded-xl transition-all ${isActive ? 'text-amber-400' : 'text-slate-500 hover:text-slate-300'}`}
    >
      <div className={`p-1.5 rounded-lg ${isActive ? 'bg-amber-400/10' : 'bg-transparent'}`}>
        {icon}
      </div>
      <span className="text-[10px] font-medium mt-1">{label}</span>
    </button>
  );
}
