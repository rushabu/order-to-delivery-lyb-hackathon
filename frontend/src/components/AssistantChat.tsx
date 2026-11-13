import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ChatCircleDots, PaperPlaneRight, X } from "@phosphor-icons/react";
import { useAskAssistant, useAssistantStatus } from "../api/queries";
import type { ChatTurn, Role } from "../api/contract";
import { Button } from "./ui";

/*
  Order-tracking assistant: a chat menu in the top bar, for every role (bonus item, DESIGN.md 2.3).
  Answers come from a language model (Groq) that is given only the shipments this user may see,
  so the panel always says that it is AI and that the screen is the record.
*/
const SUGGESTIONS: Record<Role, string[]> = {
  COORDINATOR: ["Which shipments are at risk of being late?", "Why is SHP-1001 delayed?", "What is on the road right now?"],
  DRIVER: ["What is my ETA?", "Am I running late?", "How far do I have left?"],
  CUSTOMER: ["Where is my order?", "When will it arrive?", "Is my delivery delayed, and why?"],
};
const MAX_QUESTION = 500;
const HISTORY_TURNS = 10; // the API accepts at most 10 earlier turns

export function AssistantChat({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const status = useAssistantStatus(open);
  const ask = useAskAssistant();
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns, ask.isPending, open]);

  const unconfigured = status.data?.configured === false;
  const busy = ask.isPending;
  const addAnswer = (r: { answer: string }) => setTurns((t) => [...t, { role: "assistant", content: r.answer }]);

  function send(text: string) {
    const question = text.trim().slice(0, MAX_QUESTION);
    if (!question || busy || unconfigured) return;
    const history = turns.slice(-HISTORY_TURNS);
    setTurns((t) => [...t, { role: "user", content: question }]);
    setDraft("");
    ask.mutate({ question, history }, { onSuccess: addAnswer });
  }

  /** After a failure the question stays in the list; this sends it again without adding it twice. */
  function retry() {
    const last = turns.at(-1);
    if (!last || last.role !== "user" || busy) return;
    ask.mutate({ question: last.content, history: turns.slice(0, -1).slice(-HISTORY_TURNS) }, { onSuccess: addAnswer });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(draft);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Ask the assistant"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-2 hover:bg-sunken"
      >
        <ChatCircleDots size={20} weight="bold" aria-hidden />
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Assistant"
          className="fixed inset-x-4 top-16 z-[900] flex max-h-[min(580px,calc(100dvh-88px))] flex-col overflow-hidden rounded-lg border border-line-strong bg-surface text-ink shadow-[0_18px_40px_-18px_rgb(27_34_48/0.45)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[420px]"
        >
          <header className="flex items-start justify-between gap-2 border-b-4 border-accent bg-road px-4 py-3 text-rail-ink">
            <div>
              <h2 className="text-body font-semibold text-[#f4f6f9]">Ask about your shipments</h2>
              <p className="text-meta">AI answers from the shipments you can see. Check the screen before acting.</p>
            </div>
            <button type="button" aria-label="Close assistant" onClick={() => setOpen(false)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#f4f6f9] hover:bg-white/10">
              <X size={16} weight="bold" aria-hidden />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3" aria-live="polite">
            {unconfigured ? (
              <p className="text-body text-muted">The assistant is switched off. Set GROQ_API_KEY on the API server and restart it.</p>
            ) : turns.length === 0 ? (
              <div className="space-y-2">
                <p className="text-meta text-muted">Try one of these, or type your own question.</p>
                <ul className="divide-y divide-line border-y border-line">
                  {SUGGESTIONS[role].map((q) => (
                    <li key={q}>
                      <button type="button" onClick={() => send(q)} className="ct-go flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left text-body text-ink transition-colors duration-150 hover:bg-raised">
                        {q}
                        <ArrowRight size={14} weight="bold" aria-hidden className="shrink-0 text-muted" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ul className="space-y-3">
                {turns.map((t, i) => (
                  <li key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`break-words text-body ${t.role === "user" ? "whitespace-pre-wrap " : ""}${t.role === "user" ? "max-w-[85%] rounded-lg rounded-br-sm bg-ink px-3 py-2 text-surface" : "max-w-[92%] border-l-[3px] border-accent py-0.5 pl-3 text-ink"}`}>
                      <span className="sr-only">{t.role === "user" ? "You: " : "Assistant: "}</span>
                      {t.role === "assistant" ? <Answer text={t.content} /> : t.content}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {busy && <p role="status" className="text-meta text-muted">Looking at your shipments…</p>}
            {ask.error && !busy && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-l-4 border-high bg-high-soft px-3 py-2 text-meta text-high">
                <span>{ask.error.message}</span>
                <Button size="sm" onClick={retry}>Try again</Button>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line px-3 py-3">
            <label htmlFor={`${panelId}-q`} className="sr-only">Your question</label>
            <textarea
              id={`${panelId}-q`}
              ref={inputRef}
              rows={1}
              value={draft}
              maxLength={MAX_QUESTION}
              disabled={unconfigured}
              placeholder="Type a question"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              className="max-h-28 min-h-10 flex-1 resize-none border-0 border-b-2 border-line-strong bg-transparent px-1 py-2 text-body text-ink outline-none placeholder:text-muted hover:border-ink-2 focus-visible:border-ink"
            />
            <Button type="submit" variant="primary" aria-label="Send question" disabled={!draft.trim() || busy || unconfigured} className="w-10 px-0">
              <PaperPlaneRight size={18} weight="bold" aria-hidden />
            </Button>
          </form>
          {status.data?.configured && <p className="border-t border-line px-4 py-2 text-meta text-muted">Answers by {status.data.provider}, model {status.data.model}</p>}
        </section>
      )}
    </div>
  );
}

/** **bold** inside a line. Nothing else inline is parsed. */
function withBold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i} className="font-semibold text-ink">{part}</strong> : part));
}

/**
  The answer as short blocks: paragraphs, "- " or "1. " lists, and a "Next:" line set apart.
  The prompt asks the model for that shape (backend/src/assistant/assistant.ts); anything else shows as plain lines.
*/
export function Answer({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => l && !/^\|?[-:| ]+\|?$/.test(l) && !/^#+\s*$/.test(l));
  const blocks: { kind: "p" | "li" | "next"; text: string }[] = lines.map((l) => {
    const item = l.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) return { kind: "li", text: item[1] };
    const next = l.match(/^\**next:?\**:?\s*(.*)$/i);
    if (next) return { kind: "next", text: next[1] };
    return { kind: "p", text: l.replace(/^#+\s*/, "").replace(/^\|(.*)\|$/, "$1").replace(/\s*\|\s*/g, ", ") };
  });
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "li") {
      const items: string[] = [];
      while (i < blocks.length && blocks[i].kind === "li") items.push(blocks[i++].text);
      i--;
      out.push(
        <ul key={i} className="space-y-1.5">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span aria-hidden className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-2" />
              <span className="min-w-0">{withBold(it)}</span>
            </li>
          ))}
        </ul>,
      );
    } else if (b.kind === "next") {
      out.push(
        <p key={i} className="rounded-md bg-accent-soft px-2.5 py-1.5 text-ink">
          <span className="font-semibold">Next: </span>
          {withBold(b.text)}
        </p>,
      );
    } else {
      out.push(<p key={i}>{withBold(b.text)}</p>);
    }
  }
  return <span className="block space-y-2">{out}</span>;
}
