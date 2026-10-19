// src/components/Chat/ChatWindow.tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RoleBadge } from "@/components/RoleBadge";
import type { ChatMessageDTO, ChatThreadDTO, StaffThreadDTO } from "@/api/chat";

interface ChatWindowProps {
  thread: ChatThreadDTO | StaffThreadDTO | null;
  messages: ChatMessageDTO[];
  currentUserId: number;
  isStaffViewer: boolean;
  onSend: (body: string) => Promise<void> | void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  sending?: boolean;
  onBack?: () => void; // для мобильного staff
  emptyText?: string;
}

const formatTime = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatDayLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, today)) return "Сегодня";
  if (same(d, yest)) return "Вчера";
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

export const ChatWindow = ({
  thread,
  messages,
  currentUserId,
  isStaffViewer,
  onSend,
  onLoadMore,
  hasMore,
  loading,
  sending,
  onBack,
  emptyText,
}: ChatWindowProps) => {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  // Автоскролл: вниз при новых сообщениях. При загрузке предыдущих — сохраняем
  // позицию (см. отдельный useEffect ниже).
  useEffect(() => {
    if (messages.length > prevCount.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    prevCount.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    // Первичная загрузка — сразу к низу
    if (messages.length && prevCount.current === 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
    prevCount.current = messages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = input.trim();
    if (!body || sending) return;
    try {
      await onSend(body);
      setInput("");
    } catch {
      // input сохраняется — пользователь может повторить
    }
  };

  // Заголовок: для staff — данные user'а; для user — «Поддержка»
  const headerTitle = isStaffViewer
    ? (thread as StaffThreadDTO | null)?.user?.displayName || "Пользователь"
    : "Поддержка";
  const headerSubtitle = isStaffViewer
    ? thread
      ? `Тред #${thread.id} · пользователь #${thread.userId}`
      : ""
    : "Ответим как можно скорее";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b flex items-center gap-2 bg-card">
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={onBack}
            title="К списку"
          >
            ←
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{headerTitle}</div>
          <div className="text-xs text-muted-foreground truncate">
            {headerSubtitle}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-3">
        {loading && (
          <div className="text-center text-muted-foreground py-6">
            Загрузка сообщений...
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="text-center text-muted-foreground py-10 px-4">
            {emptyText || "Сообщений пока нет."}
          </div>
        )}

        {hasMore && !loading && (
          <div className="text-center mb-3">
            <Button variant="outline" size="sm" onClick={onLoadMore}>
              ↑ Загрузить раньше
            </Button>
          </div>
        )}

        {messages.map((m, idx) => {
          const isOwn = m.authorId === currentUserId;
          const prev = messages[idx - 1];
          const showDay =
            !prev ||
            new Date(prev.createdAt).toDateString() !==
              new Date(m.createdAt).toDateString();
          const showAuthor = !isOwn && (!prev || prev.authorId !== m.authorId);

          return (
            <div key={m.id}>
              {showDay && (
                <div className="text-center text-xs text-muted-foreground my-3">
                  {formatDayLabel(m.createdAt)}
                </div>
              )}
              <div
                className={`flex mb-2 ${isOwn ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] sm:max-w-[75%] min-w-0 flex flex-col ${
                    isOwn ? "items-end" : "items-start"
                  }`}
                >
                  {showAuthor && (
                    <div className="flex items-center gap-1 mb-2 text-xs">
                      <span className="font-medium truncate">
                        {m.author.displayName}
                      </span>
                      <RoleBadge role={m.authorRole} />
                    </div>
                  )}
                  <div
                    className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${
                      isOwn
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
                    }`}
                  >
                    {m.body}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <span>{formatTime(m.createdAt)}</span>
                    {m.storeId && (
                      <span title="Контекст магазина">· 🏬 {m.storeId}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={submit}
        className="shrink-0 p-2 border-t flex items-end gap-2 bg-card"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Напишите сообщение..."
          maxLength={4000}
          disabled={sending}
          className="flex-1"
        />
        <Button
          type="submit"
          disabled={sending || !input.trim()}
          title="Отправить"
        >
          {sending ? "…" : "➤"}
        </Button>
      </form>
    </div>
  );
};
