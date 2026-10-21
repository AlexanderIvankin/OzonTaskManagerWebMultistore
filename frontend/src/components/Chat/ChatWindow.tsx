import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RoleBadge } from "@/components/RoleBadge";
import type { ChatMessageDTO, ChatThreadDTO, StaffThreadDTO } from "@/api/chat";

const withToken = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  const token = localStorage.getItem("accessToken");
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
};

interface ChatWindowProps {
  thread: ChatThreadDTO | StaffThreadDTO | null;
  messages: ChatMessageDTO[];
  currentUserId: number;
  isStaffViewer: boolean;
  onSend: (
    body: string,
    replyToId?: number,
    quotedText?: string,
  ) => Promise<void> | void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  sending?: boolean;
  onBack?: () => void;
  emptyText?: string;
  typingName?: string | null;
  onTyping?: () => void;

  pendingAttachments?: PendingAttachment[];
  onUploadFile?: (file: File) => Promise<void>;
  onRemovePendingAttachment?: (id: number) => void;
  uploading?: boolean;
}

interface PendingAttachment {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploading?: boolean;
  previewUrl?: string | null;
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

const TYPING_THROTTLE_MS = 2000;

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
  typingName,
  onTyping,
  pendingAttachments,
  onUploadFile,
  onRemovePendingAttachment,
  uploading,
}: ChatWindowProps) => {
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState<{
    id: number;
    authorName: string;
    body: string; // полный текст цитируемого (для fallback)
    quotedText?: string; // фрагмент, если пользователь выбрал часть
  } | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    text: string;
    messageId: number;
    authorName: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const lastTypingEmit = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null); // ← FIX #1

  // Автоскролл вниз при новых сообщениях
  useEffect(() => {
    if (messages.length > prevCount.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    prevCount.current = messages.length;
  }, [messages.length]);

  // При смене треда — к низу
  useEffect(() => {
    if (messages.length && prevCount.current === 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
    prevCount.current = messages.length;
    setReplyTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  // Кнопка «Цитировать» + закрытие по клику снаружи
  useEffect(() => {
    if (!selectionMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-quote-btn]")) return;
      setSelectionMenu(null);
    };
    const onScroll = () => setSelectionMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [selectionMenu]);

  const handleInput = (val: string) => {
    setInput(val);
    if (!val.trim()) return;
    if (!onTyping) return;
    const now = Date.now();
    if (now - lastTypingEmit.current < TYPING_THROTTLE_MS) return;
    lastTypingEmit.current = now;
    onTyping();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = input.trim();
    const hasAtt = (pendingAttachments?.length || 0) > 0;
    if ((!body && !hasAtt) || sending) return;
    try {
      await onSend(body, replyTo?.id, replyTo?.quotedText);
      setInput("");
      setReplyTo(null);
    } catch {
      /* input и replyTo сохраняются */
    }
  };

  const headerTitle = isStaffViewer
    ? (thread as StaffThreadDTO | null)?.user?.displayName || "Пользователь"
    : "Поддержка";
  const headerSubtitle = isStaffViewer
    ? thread
      ? `Тред #${thread.id} · пользователь #${thread.userId}`
      : ""
    : "Ответим как можно скорее";

  // Какое «последнее прочитанное» сравнивать для ✓✓ на моих сообщениях.
  // null = не показываем галочки (staff в своём треде).
  const otherLastRead: number | null = thread
    ? isStaffViewer
      ? (thread as StaffThreadDTO).userId === currentUserId
        ? null
        : thread.userLastReadMessageId
      : thread.staffLastReadMessageId
    : 0;

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

      {/* Messages (drag-n-drop контейнер — единственный скроллящийся) */}
      <div
        className={`flex-1 min-h-0 overflow-auto px-3 py-3 relative transition-colors ${
          isDragging ? "bg-primary/5 ring-2 ring-inset ring-primary/40" : ""
        }`}
        onDragOver={(e) => {
          if (!onUploadFile) return;
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (!onUploadFile) return;
          const files = Array.from(e.dataTransfer.files || []);
          for (const f of files) {
            void onUploadFile(f);
          }
        }}
      >
        {/* ← FIX #3: без внутреннего дублирующего div */}

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
          const isRead =
            isOwn &&
            otherLastRead !== null &&
            otherLastRead > 0 &&
            m.id <= otherLastRead;

          return (
            <div key={m.id} className="group">
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
                    <div className="flex items-center gap-2 mb-2 text-xs">
                      <span className="font-medium truncate">
                        {m.author.displayName}
                      </span>
                      <RoleBadge role={m.authorRole} />
                    </div>
                  )}

                  {/* Цитата в сообщении — FIX #6: поддержка quotedText */}
                  {m.replyTo && (
                    <div
                      className={`mb-1 rounded px-2 py-1 text-xs border-l-2 ${
                        isOwn
                          ? "border-primary-foreground/40 bg-primary-foreground/10"
                          : "border-primary/40 bg-muted/40"
                      } max-w-full`}
                      title={
                        m.replyTo.deleted
                          ? "Цитируемое сообщение удалено"
                          : m.replyTo.quotedText || m.replyTo.body
                      }
                    >
                      <div className="font-medium opacity-80 truncate">
                        {m.replyTo.authorName}
                      </div>
                      <div className="truncate opacity-70">
                        {m.replyTo.deleted
                          ? "(сообщение удалено)"
                          : m.replyTo.quotedText
                            ? `«${m.replyTo.quotedText}»`
                            : m.replyTo.body || "📎 Вложение"}
                      </div>
                    </div>
                  )}

                  {/* Бабл + детектор выделения — FIX #4: один div */}
                  <div
                    className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${
                      isOwn
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
                    }`}
                    onMouseUp={(e) => {
                      const bubble = e.currentTarget; // ← захватываем СЕЙЧАС
                      // setTimeout — ждём, пока браузер зафиксирует selection
                      setTimeout(() => {
                        const sel = window.getSelection();
                        if (!sel || sel.isCollapsed) return;
                        const text = sel.toString().trim();
                        if (!text) return;

                        // Проверяем, что выделение внутри этого бабла
                        const range = sel.getRangeAt(0);
                        if (!bubble.contains(range.commonAncestorContainer))
                          return; // ← используем bubble

                        const rect = range.getBoundingClientRect();
                        setSelectionMenu({
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                          text,
                          messageId: m.id,
                          authorName: m.author.displayName,
                        });
                      }, 10);
                    }}
                  >
                    {m.body}
                    {m.attachments && m.attachments.length > 0 && (
                      <div
                        className={`mt-1 flex flex-wrap gap-1 ${isOwn ? "justify-end" : "justify-start"}`}
                      >
                        {m.attachments.map((a) => {
                          const isImg =
                            a.mimeType.startsWith("image/") && a.previewUrl;
                          return isImg ? (
                            <a
                              key={a.id}
                              href={withToken(a.url)}
                              target="_blank"
                              rel="noreferrer"
                              className="block rounded overflow-hidden border"
                            >
                              <img
                                src={withToken(a.previewUrl) ?? ""}
                                alt={a.fileName}
                                className="max-h-48 max-w-[200px] object-cover"
                              />
                            </a>
                          ) : (
                            <a
                              key={a.id}
                              href={withToken(a.url)}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-xs px-2 py-1 rounded border bg-background hover:bg-accent max-w-[240px]"
                              download={a.fileName}
                            >
                              <span>📄</span>
                              <span className="truncate min-w-0">
                                {a.fileName}
                              </span>
                              <span className="text-muted-foreground shrink-0">
                                ({Math.round(a.fileSize / 1024)} КБ)
                              </span>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <span>{formatTime(m.createdAt)}</span>
                    {m.storeId && (
                      <span title="Контекст магазина">· 🏬 {m.storeId}</span>
                    )}
                    {isOwn && (
                      <span
                        title={isRead ? "Прочитано" : "Отправлено"}
                        className="ml-0.5 select-none"
                      >
                        {otherLastRead === null ? "" : isRead ? "✓✓" : "✓"}
                      </span>
                    )}
                    {/* Кнопка «ответить на всё сообщение» */}
                    <button
                      type="button"
                      onClick={() =>
                        setReplyTo({
                          id: m.id,
                          authorName: m.author.displayName,
                          body:
                            m.body ||
                            (m.attachments?.length ? "📎 Вложение" : ""),
                        })
                      }
                      className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground select-none"
                      title="Ответить"
                    >
                      ↪️
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {typingName && (
          <div className="text-xs text-muted-foreground italic px-1 py-1 animate-pulse">
            {typingName} печатает…
          </div>
        )}

        <div ref={endRef} />

        {/* Оверлей-подсказка — sibling контента, внутри relative-родителя */}
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="bg-background border-2 border-dashed border-primary rounded-lg px-6 py-4 text-sm text-muted-foreground shadow-lg">
              📎 Отпустите файл, чтобы прикрепить
            </div>
          </div>
        )}
      </div>

      {/* Attachments preview над input'ом */}
      {pendingAttachments && pendingAttachments.length > 0 && (
        <div className="shrink-0 px-2 py-1.5 border-t flex flex-wrap gap-2 bg-card">
          {pendingAttachments.map((a) => (
            <div
              key={a.id}
              className="relative border rounded-md p-1 bg-muted/50 flex items-center gap-2 text-xs max-w-[220px]"
            >
              {a.mimeType.startsWith("image/") && a.previewUrl ? (
                <img
                  src={withToken(a.previewUrl) ?? ""}
                  alt={a.fileName}
                  className="h-10 w-10 object-cover rounded"
                />
              ) : (
                <span className="text-lg">📄</span>
              )}
              <span className="truncate min-w-0">{a.fileName}</span>
              <button
                type="button"
                onClick={() => onRemovePendingAttachment?.(a.id)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title="Убрать"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Reply preview — FIX #5: поддержка quotedText */}
      {replyTo && (
        <div className="shrink-0 px-3 py-1.5 border-t bg-muted/40 flex items-center gap-2">
          <div className="flex-1 min-w-0 text-xs">
            <div className="text-muted-foreground truncate">
              Ответ на <span className="font-medium">{replyTo.authorName}</span>
            </div>
            <div className="truncate opacity-80 italic">
              {replyTo.quotedText
                ? `«${replyTo.quotedText}»`
                : replyTo.body || "📎 Вложение"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            title="Отменить ответ"
          >
            ✕
          </button>
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={submit}
        className="shrink-0 p-2 border-t flex items-end gap-2 bg-card"
      >
        {onUploadFile && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,application/pdf,text/plain,.zip"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) await onUploadFile(f);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading || sending}
              onClick={() => fileInputRef.current?.click()}
              title="Прикрепить файл"
            >
              {uploading ? "…" : "📎"}
            </Button>
          </>
        )}

        <Input
          ref={inputRef} /* ← FIX #2 */
          value={input}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="Напишите сообщение..."
          maxLength={4000}
          disabled={sending}
          className="flex-1"
        />
        <Button
          type="submit"
          disabled={sending || (!input.trim() && !pendingAttachments?.length)}
          title="Отправить"
        >
          {sending ? "…" : "➤"}
        </Button>
      </form>

      {/* Кнопка «Цитировать» — поверх, в конце root-контейнера */}
      {selectionMenu && (
        <button
          data-quote-btn
          type="button"
          style={{
            position: "fixed",
            left: selectionMenu.x,
            top: Math.max(8, selectionMenu.y - 44),
            transform: "translateX(-50%)",
          }}
          onMouseDown={(e) => e.preventDefault()} // не терять selection
          onClick={(e) => {
            e.preventDefault();
            const msg = messages.find((x) => x.id === selectionMenu.messageId);
            setReplyTo({
              id: selectionMenu.messageId,
              authorName: selectionMenu.authorName,
              body: msg?.body || "",
              quotedText: selectionMenu.text,
            });
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
            inputRef.current?.focus();
          }}
          className="z-50 px-2 py-1 rounded-md bg-primary text-primary-foreground text-xs shadow-lg hover:opacity-90"
        >
          ↪️ Цитировать
        </button>
      )}
    </div>
  );
};
