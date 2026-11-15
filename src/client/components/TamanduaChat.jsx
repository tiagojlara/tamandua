import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CopilotChat, CopilotKitProvider, useAgent, useRenderTool } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import { useTamandua } from '../tamanduaState.jsx';
import { stamp } from '../api.js';
import { historyToMessages, readToolResult } from '../tamanduaMessages.mjs';
import { TAMANDUA_CODES } from '../tamanduaCodes.mjs';

// The CopilotKit half of the assistant, and the only module in the client that imports the library.
//
// Everything about the answer — which tools ran, what the model was told, whether the disclosure was
// accepted — is decided server-side (`src/assistant/copilotAgents.js` → `agent.js`). This file renders
// the transcript the AG-UI stream produces and routes the typed failure codes back to the right surface
// (Settings, the disclosure, or a plain message).
//
// Loaded lazily, by tamanduaState.jsx, on the first press of the launcher or a visit to /assistant. Measured
// with `npm run build`: this module's import graph is a 258 kB gzipped chunk that nothing else needs, and
// the entry bundle is unchanged at 96 kB. A holdings table has no business waiting on either.

const AGENT_ID = 'tamandua';

// The library's composer strings. The welcome text is kept as a fallback, but the empty conversation is
// drawn by `EmptyState` below because the library suppresses its own welcome screen once a thread id is
// supplied. `chatDisclaimerText` carries the keyboard hint under the input.
const LABELS = {
  chatInputPlaceholder: 'Ask about your records…',
  welcomeMessageText: 'Read-only answers, from your own records.',
  chatDisclaimerText: 'Enter to send · Shift + Enter for a new line',
};

// The library disables its own welcome screen whenever a thread id is supplied (ours always is), which
// left a new conversation as a large blank card. This is the replacement: it sits behind the transcript,
// disappears as soon as the first message exists, and never intercepts a click meant for the composer.
function EmptyState() {
  return <div className="tamandua-chat-empty">
    <span className="tamandua-chat-empty-mark" aria-hidden="true">✦</span>
    <b>Ask about your own numbers</b>
    <p>Loan payoffs, cash buffers, or where last month went — answered from the records stored here.</p>
    <ul>
      <li>Can I pay off the car loan?</li>
      <li>What did I spend last month?</li>
      <li>How is my net worth split?</li>
    </ul>
    <small>Read-only answers · sources shown for every reply</small>
  </div>;
}

// Past conversations, inside the floating panel.
//
// `/assistant` has a permanent conversation sidebar, but the panel had no way back into an older chat:
// closing it removed the only route to the list. This is the same server data (`tamandua.conversations`)
// in a compact picker. Empty threads are hidden — they are an artefact of opening the panel and would
// only push the conversations someone actually wants off screen.
function HistoryPanel({ conversations, currentId, loading, onSelect, onClose }) {
  const visible = conversations
    .filter((conversation) => conversation.messageCount > 0)
    .sort((left, right) => String(right.lastMessageAt || right.updatedAt).localeCompare(String(left.lastMessageAt || left.updatedAt)));
  return <section className="tamandua-history" id="tamandua-history" aria-label="Past conversations">
    <div className="tamandua-history-head">
      <div className="tamandua-history-title">
        <b>Past conversations</b>
        <span>Saved on this device</span>
      </div>
      <button type="button" className="tamandua-close" onClick={onClose} aria-label="Close past conversations" autoFocus>×</button>
    </div>
    <div className="tamandua-history-body">
      {loading && !visible.length
        ? <p className="tamandua-history-note">Loading conversations…</p>
        : visible.length
          ? <ul className="tamandua-history-list">
            {visible.map((conversation) => {
              const current = String(conversation.id) === currentId;
              return <li key={conversation.id}>
                <button type="button" className={`tamandua-history-row${current ? ' selected' : ''}`} onClick={() => onSelect(conversation.id)} aria-current={current ? 'true' : undefined}>
                  <span className="tamandua-history-row-main">
                    <span className="tamandua-history-row-title">{conversation.title || 'Untitled conversation'}</span>
                    <span className="tamandua-history-row-meta">{conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'} · {stamp(conversation.lastMessageAt || conversation.updatedAt, { time: false })}</span>
                  </span>
                  {current ? <span className="tamandua-history-current">Current</span> : <span className="tamandua-history-open" aria-hidden="true">›</span>}
                </button>
              </li>;
            })}
          </ul>
          : <div className="tamandua-history-empty">
            <span className="tamandua-history-empty-mark" aria-hidden="true">↺</span>
            <b>No past conversations yet.</b>
            <p>Start a chat and it will be saved here.</p>
          </div>}
    </div>
    <p className="tamandua-history-foot">History is stored on this device only.</p>
  </section>;
}

const STATUS_LABELS = { ok: 'read', error: 'failed', refused: 'refused' };

// FR-8: "users can see which tools ran and whether they read or wrote data".
//
// Registering a renderer is not cosmetic. In 1.85.0 a tool call with no matching renderer paints *nothing*
// (the lookup returns null and the view skips it) — so without this, a run that consulted four tools would
// show an answer with no evidence behind it, and the redacted `{status, ms, reason}` payload the bridge
// sends would be invisible. `group: true` lets the chat fold consecutive calls into one block.
function ToolChip({ name, args, status, result }) {
  const info = readToolResult(result);
  const settled = String(status).toLowerCase() === 'complete';
  const label = STATUS_LABELS[info.status] || (settled ? 'read' : 'reading');
  const shown = STATUS_LABELS[info.status] ? info.status : settled ? 'ok' : 'pending';
  let argText = '';
  try { argText = args && Object.keys(args).length ? JSON.stringify(args) : ''; } catch { argText = ''; }
  return <div className={`tamandua-tool tool-${shown}`}>
    <code>{name}</code>
    <span className={`tag ${shown === 'ok' ? '' : shown === 'refused' ? 'tag-warn' : 'tag-bad'}`}>{label}</span>
    {info.ms ? <span className="tool-ms">{info.ms} ms</span> : null}
    {info.reason ? <span className="tool-ms">{info.reason}</span> : null}
    {argText ? <code className="tool-args">{argText}</code> : null}
  </div>;
}

export default function TamanduaChat() {
  return <CopilotKitProvider
    runtimeUrl="/api/copilotkit"
    agentId={AGENT_ID}
    // Both default to on, and both reach for infrastructure this app does not have: the inspector is a
    // developer panel, and the intelligence indicator opens a websocket to the runtime's channel server.
    // `activateChannels: false` on the server side is the other half of the same decision.
    enableInspector={false}
    showIntelligenceIndicator={false}
  >
    <TamanduaPanel/>
  </CopilotKitProvider>;
}

function TamanduaPanel() {
  const tamandua = useTamandua();
  const { threadId, rows, historyToken, settings, chatError, conversations, open, page, slot } = tamandua;
  const panelRef = useRef(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const expanded = page === 'assistant';
  // The same agent instance CopilotChat runs against — `useAgent` reads the registry, not a copy, so
  // `setMessages` here is what the transcript renders from (the view draws `agent.messages` verbatim).
  const { agent, isReady } = useAgent({ agentId: AGENT_ID });

  useRenderTool({ name: '*', group: true, render: ToolChip }, []);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    panelRef.current?.focus();
  }, []);

  const showHistory = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try { await tamandua.loadConversations(); } finally { setHistoryLoading(false); }
  }, [tamandua]);

  const recoverConversation = useCallback(async (id) => {
    setHistoryOpen(false);
    await tamandua.openConversation(id);
    panelRef.current?.focus();
  }, [tamandua]);

  const startNewChat = useCallback(() => {
    setHistoryOpen(false);
    tamandua.startNewChat();
  }, [tamandua]);

  const closePanel = useCallback(() => {
    setHistoryOpen(false);
    tamandua.closePanel();
  }, [tamandua]);

  // The history picker belongs to the floating panel. Once /assistant takes over, its sidebar is the
  // history surface and an overlay would just duplicate it.
  useEffect(() => { if (expanded) setHistoryOpen(false); }, [expanded]);

  // The bundle is here; anything the page was showing as "Loading Tamandua…" can stop. Mounted once and
  // kept mounted while the app runs, which is also what keeps the transcript alive across page changes.
  useEffect(() => {
    tamandua.setChatReady(true);
    return () => tamandua.setChatReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore a conversation from SQLite.
  //
  // The chat's own store only holds the turn it watched, so without this an old conversation would reopen
  // with answers whose tool calls have vanished (FR-8 applies to history, not only to live output).
  //
  // Keyed on `historyToken`, not `rows`: the token is bumped exactly when the transcript should be
  // *replaced* server→screen. `rows` is read but not a dependency on purpose — appending a message during
  // a run also changes its identity, and re-applying history then would take the streaming answer back.
  //
  // This is also why the thread is not switched with the `threadId` prop alone: a change there clears the
  // list and posts `agent/connect` (measured: answered here with an empty 200 stream, so nothing re-clears
  // afterwards — the ordering that survives is "library clears, we fill").
  useEffect(() => {
    if (!isReady || !agent) return;
    agent.setMessages(historyToMessages(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, agent, historyToken, threadId]);

  useEffect(() => {
    if (open && !expanded) panelRef.current?.focus();
  }, [open, expanded]);

  // Escape closes the history picker first, then the floating panel. On /assistant there is nothing to close.
  useEffect(() => {
    if (!open || expanded) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (historyOpen) { closeHistory(); return; }
      tamandua.closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, expanded, historyOpen, closeHistory, tamandua]);

  // The typed codes the server yields (`src/assistant/errors.js`), not a regex over the message: FR-9 wants
  // a failure to say what to do, and "open Settings" is a different action from "read the disclosure".
  //
  // Two measured shapes, because the two gates fail differently:
  //   - a yielded `RUN_ERROR` arrives as `{error, code: 'agent_run_error_event', context: {runtimeErrorCode:
  //     our code, event}}`, with the code also on `error.code`;
  //   - the policy gate's HTTP 428 never becomes an event. AG-UI's `runHttpRequest` reads a non-2xx JSON
  //     body into `error.payload` (and `error.status`), and the core re-emits it as `agent_run_failed`, so
  //     `payload.code` is where our code is — and `payload.disclosure` is the text to show, already here.
  // All three are read, in that order, because which one survives the wrapper is the library's business.
  const handleError = useCallback((event) => {
    const payload = event?.error?.payload;
    const code = event?.context?.runtimeErrorCode || payload?.code || event?.error?.code || '';
    if (code === TAMANDUA_CODES.runStopped) {
      // Not a failure: the person pressed Stop. The partial answer is already on screen and already
      // persisted server-side, so there is nothing to report and nothing to retry.
      return;
    }
    if (code === TAMANDUA_CODES.disclosureRequired) { tamandua.ensureDisclosure(payload?.disclosure); return; }
    if (code === TAMANDUA_CODES.modelNotConfigured) { tamandua.loadSettings(); tamandua.setChatError(event?.error?.message || 'No model endpoint is configured yet.'); return; }
    if (code === TAMANDUA_CODES.threadRequired || code === TAMANDUA_CODES.threadUnknown) {
      // The conversation this tab is writing to no longer exists — deleted from the other surface, or a
      // thread id the library invented before ours landed. Make a real one and say so plainly.
      tamandua.ensureThread().catch(() => {});
      tamandua.setChatError('This conversation was removed. Send again to start a new one.');
      return;
    }
    // `payload.error` first: for an HTTP refusal the message AG-UI builds is `HTTP 428: {"error":…}` —
    // the sentence the server wrote is the one to show, not the wire dump around it.
    tamandua.setChatError(payload?.error || event?.error?.message || 'Tamanduá could not answer.');
  }, [tamandua]);

  if (!open && !expanded) return null;

  const ready = Boolean(settings?.ready);
  // `useAgent` re-renders on message changes, so this stays honest while a run streams: the empty state
  // vanishes the moment the question is accepted, rather than waiting for the persisted rows to come back.
  const hasMessages = Boolean(agent?.messages?.length);
  const body = <>
    {!expanded && <div className="tamandua-panel-head">
      <div className="tamandua-panel-title">
        <span className="tamandua-panel-mark" aria-hidden="true">✦</span>
        <span className="tamandua-panel-copy">
          <b>Ask Tamanduá</b>
          <span>Grounded in your records</span>
        </span>
      </div>
      <div className="tamandua-panel-actions">
        <button type="button" className="tamandua-history-toggle" onClick={() => (historyOpen ? closeHistory() : showHistory())}
          aria-expanded={historyOpen} aria-controls="tamandua-history" title="Past conversations" aria-label="Past conversations">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 4.3v3.8l2.2 1.35" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12.9 8A4.9 4.9 0 1 1 9.6 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <span className="tamandua-history-label">History</span>
        </button>
        <button type="button" className="tamandua-new-chat" onClick={startNewChat} title="Start a new conversation" aria-label="New chat">
          <span aria-hidden="true">＋</span><span className="tamandua-new-chat-label">New chat</span>
        </button>
        <button type="button" className="tamandua-close" onClick={closePanel} aria-label="Close Ask Tamanduá">×</button>
      </div>
    </div>}
    {!ready && settings && <p className="tamandua-gate">
      No model endpoint is configured, so Tamanduá answers nothing — a guessed number is worse than none.
      {tamandua.navigate && <button type="button" className="text-action" onClick={() => tamandua.navigate('settings')}>Open settings</button>}
    </p>}
    {chatError && <p className="form-error chat-error" role="alert">{chatError}</p>}
    <div className="tamandua-chat">
      {historyOpen && <HistoryPanel conversations={conversations} currentId={threadId ? String(threadId) : ''}
        loading={historyLoading} onSelect={recoverConversation} onClose={closeHistory}/>}
      {!hasMessages && <EmptyState/>}
      <CopilotChat
        agentId={AGENT_ID}
        // `threadId === String(conversation.id)` (§B). Never null: the provider creates the conversation
        // when the surface opens, and an invented library id would be refused server-side as
        // `tamandua_thread_unknown` rather than silently writing somewhere we do not own.
        threadId={threadId || undefined}
        labels={LABELS}
        onError={handleError}
        inspectorTools={false}
        // No `attachments`: a file picker would open a second path for records to leave the machine, and
        // the §9 disclosure above does not describe one.
      />
    </div>
  </>;

  // One chat instance, two placements: the full page hands us a node to render into, and navigating back
  // to it moves the same conversation rather than remounting it.
  if (expanded) {
    return slot ? createPortal(<div className="tamandua-panel tamandua-inpage">{body}</div>, slot)
      : <div className="chat-empty"><b>Loading Tamanduá…</b></div>;
  }
  return <div className="tamandua-panel tamandua-floating" role="dialog" aria-label="Ask Tamanduá" ref={panelRef} tabIndex={-1}>{body}</div>;
}
