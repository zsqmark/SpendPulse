import React, { useState, useRef, useEffect } from 'react';
import { apiUrl } from '../lib/apiBase.ts';
import {
  Sparkles,
  Send,
  Loader2,
  Bot,
  User,
  TrendingUp,
  FileText,
  DollarSign,
  ArrowRight,
  Lightbulb,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  suggestedActions?: string[];
  referencedProducts?: string[];
}

interface AIChatCopilotProps {
  onNavigateToProduct?: (productName: string) => void;
}

export const AIChatCopilot: React.FC<AIChatCopilotProps> = ({ onNavigateToProduct }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Hello! I am your AI Procurement & Cost Intelligence Copilot.

I have direct access to your extracted invoices, standardized master products, vendor price fluctuations, and purchase history.

As soon as you ingest invoices or connect a folder, you can ask me:
- **"Which suppliers have increased prices the most?"**
- **"Forecast our expected costs for key inventory items over the next 60 days."**
- **"Compare pricing differences across different vendors for identical products."**
- **"List any price spikes that should be disputed or negotiated."**`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      suggestedActions: [
        'How does SpendPulse detect price fluctuations?',
        'How do I map vendor product variations?',
        'Forecast upcoming costs once invoices are loaded',
      ],
    },
  ]);

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || input.trim();
    if (!text || isLoading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch(apiUrl('/api/chat/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) throw new Error('Failed to get analysis from AI');
      const data = await res.json();

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.reply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        suggestedActions: data.suggestedActions,
        referencedProducts: data.referencedProducts,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      console.error('Chat error:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: 'I encountered an issue analyzing the database. Please ensure your query is specific or check your internet connection.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[740px] bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden">
      {/* Copilot Header */}
      <div className="p-4 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
              <span>Procurement & Trend Intelligence Copilot</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                DeepSeek Vision
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Grounded in your real-time invoice database, vendor price history, and fluctuation alerts
            </p>
          </div>
        </div>
      </div>

      {/* Messages Container */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {messages.map((m) => {
          const isUser = m.role === 'user';
          return (
            <div
              key={m.id}
              className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              {!isUser && (
                <div className="w-7 h-7 rounded-lg bg-blue-950 border border-blue-800 flex items-center justify-center text-blue-400 shrink-0 mt-0.5">
                  <Bot className="w-4 h-4" />
                </div>
              )}

              <div
                className={`max-w-[85%] sm:max-w-[75%] rounded-xl p-4 text-xs leading-relaxed ${
                  isUser
                    ? 'bg-blue-600 text-white rounded-br-none shadow-md'
                    : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none shadow-sm'
                }`}
              >
                {/* Content formatted */}
                <div className="whitespace-pre-wrap space-y-1.5 font-sans">
                  {m.content}
                </div>

                {/* Referenced Products Badges */}
                {m.referencedProducts && m.referencedProducts.length > 0 && (
                  <div className="mt-3 pt-2.5 border-t border-slate-800 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-mono text-slate-400">Products Mentioned:</span>
                    {m.referencedProducts.map((pName, i) => (
                      <button
                        key={i}
                        onClick={() => onNavigateToProduct?.(pName)}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800 hover:bg-blue-900 transition-colors flex items-center gap-1"
                      >
                        <span>{pName}</span>
                        <ArrowRight className="w-2.5 h-2.5" />
                      </button>
                    ))}
                  </div>
                )}

                <div
                  className={`mt-2 text-[10px] font-mono ${
                    isUser ? 'text-blue-200' : 'text-slate-500'
                  }`}
                >
                  {m.timestamp}
                </div>
              </div>

              {isUser && (
                <div className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                  <User className="w-4 h-4" />
                </div>
              )}
            </div>
          );
        })}

        {isLoading && (
          <div className="flex gap-3 justify-start">
            <div className="w-7 h-7 rounded-lg bg-blue-950 border border-blue-800 flex items-center justify-center text-blue-400 shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-400 flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
              <span>Analyzing invoices, historical trend regressions, and vendor price variances...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Follow-up Prompts */}
      {messages.length > 0 && messages[messages.length - 1].suggestedActions && (
        <div className="px-4 py-2 bg-slate-950/80 border-t border-slate-900 overflow-x-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider shrink-0 flex items-center gap-1">
            <Lightbulb className="w-3 h-3 text-amber-400" />
            <span>Suggested:</span>
          </span>
          {messages[messages.length - 1].suggestedActions?.map((act, i) => (
            <button
              key={i}
              onClick={() => handleSendMessage(act)}
              className="text-xs bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-slate-700 px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {act}
            </button>
          ))}
        </div>
      )}

      {/* Input Form */}
      <div className="p-3 bg-slate-900 border-t border-slate-800">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about vendor price spikes, future cost projections, or inflation trends..."
            disabled={isLoading}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold shrink-0"
          >
            <span>Send</span>
            <Send className="w-3 h-3" />
          </button>
        </form>
      </div>
    </div>
  );
};
