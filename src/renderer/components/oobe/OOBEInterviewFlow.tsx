import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MarkdownBlock } from '@/components/content/MarkdownBlock';
import type { ProviderConfig, AgentConfig } from './OOBEWizard';
import { parseAgentJson, AgentConfigPreview } from './oobe-utils';
import { useOobeStreamStore, ensureOobeStreamListener, runOobeGenerate } from './useOobeStreamStore';

function buildInterviewSystemPrompt(userName: string) {
  return `You are the onboarding interviewer for Eaves, a multi-agent desktop application. The user's name is ${userName}. Your job is to have a warm, conversational interview to learn about them and then design their perfect first AI agent.

Conduct the interview in two phases, asking questions ONE AT A TIME (never multiple at once). Keep each message brief and natural.

**Phase 1 — Get to know ${userName}:**
Start by greeting them by name. Ask 2-3 questions to understand who they are:
- What kind of work do they do? (developer, writer, researcher, student, creative, etc.)
- What are they hoping to use Eaves for day-to-day?
- Any tools, workflows, or domains they spend the most time in?

**Phase 2 — Design the agent:**
Based on what you've learned, ask 2-3 questions to shape the agent:
- What should this agent specialize in? (coding, writing, analysis, brainstorming, etc.)
- What personality or tone feels right? (professional, casual, playful, direct, etc.)
- How verbose should it be? (concise, detailed, balanced)
- Suggest a name or ask if they have one in mind — the name should be creative and memorable.

Once you have enough to work with, generate the agent configuration. Output ONLY a JSON block in this exact format — no text before or after:

\`\`\`json
{
  "name": "The agent's name",
  "description": "A one-sentence description of the agent's purpose",
  "systemPrompt": "A detailed system prompt that defines the agent's personality, expertise, and behavior. This should be thorough — it's the agent's core identity and instructions.",
  "temperature": 0.7
}
\`\`\`

Choose a temperature between 0.3 (focused/precise) and 1.0 (creative/varied) based on the use case. The systemPrompt should be rich and specific, incorporating what you learned about ${userName}'s needs, preferred tone, and the agent's area of expertise.`;
}

interface OOBEInterviewFlowProps {
  providerConfig: ProviderConfig;
  userName: string;
  onComplete: (config: AgentConfig) => void;
  onBack: () => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function OOBEInterviewFlow({ providerConfig, userName, onComplete, onBack }: OOBEInterviewFlowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [parsedConfig, setParsedConfig] = useState<AgentConfig | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);

  const streaming = useOobeStreamStore(s => s.streaming);
  const displayedContent = useOobeStreamStore(s => s.displayedContent);
  const generatingJson = useOobeStreamStore(s => s.generatingJson);
  const completedContent = useOobeStreamStore(s => s.completedContent);
  const error = useOobeStreamStore(s => s.error);

  const handleRetry = useCallback(() => {
    // Resend the conversation so far (or the initial greeting if the very
    // first turn failed) to give the model another attempt.
    const retryMessages = messages.length > 0
      ? messages
      : [{ role: 'user' as const, content: `Hi! I'm ${userName}. I'd like to create my first agent.` }];
    runOobeGenerate({
      provider: providerConfig.provider,
      model: providerConfig.model,
      apiKey: providerConfig.apiKey,
      messages: retryMessages,
      systemPrompt: buildInterviewSystemPrompt(userName),
    });
  }, [messages, providerConfig, userName]);

  // Register the module-level listener once (no cleanup — store is module-level,
  // reset() would kill in-flight streams during strict mode re-mount)
  useEffect(() => {
    ensureOobeStreamListener();
  }, []);

  // When a stream completes, parse for JSON config or add as a message
  useEffect(() => {
    if (completedContent === null) return;
    const config = parseAgentJson(completedContent);
    if (config) {
      setParsedConfig(config);
    } else {
      // Strip any stray JSON fence so a failed parse doesn't dump a blob into the chat
      const cleaned = completedContent.replace(/```json[\s\S]*?```/g, '').trim();
      if (cleaned) setMessages(prev => [...prev, { role: 'assistant', content: cleaned }]);
    }
    useOobeStreamStore.setState({ completedContent: null });
  }, [completedContent]);

  const sendToAI = useCallback((chatMessages: ChatMessage[]) => {
    runOobeGenerate({
      provider: providerConfig.provider,
      model: providerConfig.model,
      apiKey: providerConfig.apiKey,
      messages: chatMessages,
      systemPrompt: buildInterviewSystemPrompt(userName),
    });
  }, [providerConfig, userName]);

  // Kick off the interview once
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    sendToAI([{ role: 'user', content: `Hi! I'm ${userName}. I'd like to create my first agent.` }]);
  }, [sendToAI]);

  // Auto-scroll (instant — smooth scroll queues animations per chunk and feels laggy)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, displayedContent, generatingJson]);

  const handleSend = useCallback(() => {
    if (!input.trim() || streaming) return;
    const userMessage: ChatMessage = { role: 'user', content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    sendToAI(updatedMessages);
  }, [input, streaming, messages, sendToAI]);

  if (parsedConfig) {
    return (
      <AgentConfigPreview
        config={parsedConfig}
        onConfirm={onComplete}
        onBack={() => setParsedConfig(null)}
        title="Here's the agent based on your interview"
      />
    );
  }

  return (
    <div className="flex flex-col" style={{ height: '500px' }}>
      <div className="p-4 pb-2">
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary, #fff)' }}>
          Agent Interview
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary, #666)' }}>
          The AI will ask you a few questions to design your agent
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-3">
        {messages.length === 0 && !streaming && !error && (
          <div className="flex justify-center items-center h-full">
            <div className="text-center space-y-2">
              <div className="animate-pulse text-2xl">...</div>
              <p className="text-xs" style={{ color: 'var(--text-tertiary, #666)' }}>
                Preparing your interview
              </p>
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${msg.role === 'user' ? 'whitespace-pre-wrap' : ''}`}
              style={{
                backgroundColor: msg.role === 'user'
                  ? 'var(--accent-primary, #667eea)'
                  : 'var(--bg-tertiary, #1a1a24)',
                color: msg.role === 'user' ? '#fff' : 'var(--text-primary, #ddd)',
              }}
            >
              {msg.role === 'user'
                ? msg.content
                : <MarkdownBlock content={msg.content} />}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[85%] rounded-lg px-3 py-2 text-sm"
              style={{
                backgroundColor: 'var(--bg-tertiary, #1a1a24)',
                color: 'var(--text-primary, #ddd)',
              }}
            >
              {generatingJson ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary, #aaa)' }}>
                  <span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
                  Preparing your agent config...
                </div>
              ) : displayedContent ? (
                <div className="relative">
                  <MarkdownBlock content={displayedContent} />
                  <span className="animate-pulse">|</span>
                </div>
              ) : (
                <span className="inline-flex gap-1 py-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" />
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" style={{ animationDelay: '0.15s' }} />
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" style={{ animationDelay: '0.3s' }} />
                </span>
              )}
            </div>
          </div>
        )}
        {error && !streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[85%] rounded-lg px-3 py-2 text-sm space-y-2"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid var(--status-error, #ef4444)',
                color: 'var(--text-primary, #ddd)',
              }}
            >
              <div className="text-xs" style={{ color: 'var(--status-error, #ef4444)' }}>
                {error}
              </div>
              <Button size="sm" variant="outline" onClick={handleRetry}>
                Try again
              </Button>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 pt-2 flex gap-2">
        <Button variant="ghost" onClick={onBack} size="sm"
          style={{ color: 'var(--text-secondary, #999)' }}>
          Back
        </Button>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type your answer..."
          disabled={streaming}
          className="flex-1"
          autoFocus
        />
        <Button
          onClick={handleSend}
          disabled={!input.trim() || streaming}
          size="sm"
          style={input.trim() && !streaming ? {
            backgroundColor: 'var(--accent-primary, #667eea)',
            color: '#fff',
          } : { opacity: 0.4 }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
