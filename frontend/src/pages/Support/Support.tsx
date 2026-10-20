// src/pages/Support/Support.tsx
import { useCallback, useEffect, useState, useRef } from "react";
import { useSelector } from "react-redux";
import { RootState } from "../../store";
import { toast } from "sonner";
import {
  chatApi,
  ChatMessageDTO,
  ChatThreadDTO,
  StaffThreadDTO,
  ChatAttachmentDTO,
} from "../../api/chat";
import { ChatWindow } from "../../components/Chat/ChatWindow";
import { ThreadList } from "../../components/Chat/ThreadList";
import { useChatSocket } from "../../hooks/useChatSocket";
import {
  isSocketConnected,
  emitChatTyping,
  onChatTyping,
} from "../../lib/socket";

const PAGE_SIZE = 50;
const THREADS_PAGE = 30;

export const Support = () => {
  const user = useSelector((s: RootState) => s.auth.user);
  const currentUserId = user?.id ?? 0;

  const [isStaff, setIsStaff] = useState<boolean | null>(null); // null = loading

  const [thread, setThread] = useState<ChatThreadDTO | StaffThreadDTO | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesHasMore, setMessagesHasMore] = useState(false);

  const [threads, setThreads] = useState<StaffThreadDTO[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsHasMore, setThreadsHasMore] = useState(false);
  const [threadsTotal, setThreadsTotal] = useState(0);

  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);

  const [typingName, setTypingName] = useState<string | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const [pendingAttachments, setPendingAttachments] = useState<
    ChatAttachmentDTO[]
  >([]);
  const [uploading, setUploading] = useState(false);

  // ---------- Загрузка списка тредов (staff) ----------
  const loadThreads = useCallback(async (offset = 0) => {
    setThreadsLoading(true);
    try {
      const data = await chatApi.listThreads({
        limit: THREADS_PAGE,
        offset,
      });
      setThreads((prev) =>
        offset === 0 ? data.items : [...prev, ...data.items],
      );
      setThreadsTotal(data.total);
      setThreadsHasMore(data.hasMore);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ||
          err.message ||
          "Не удалось загрузить диалоги",
      );
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  // ---------- Загрузка сообщений ----------
  const loadMessages = useCallback(
    async (threadId: number, beforeId?: number) => {
      if (!beforeId) setMessagesLoading(true);
      try {
        const data = await chatApi.getMessages(threadId, {
          beforeId,
          limit: PAGE_SIZE,
        });
        setThread(data.thread);
        if (beforeId) {
          setMessages((prev) => [...data.messages, ...prev]);
        } else {
          setMessages(data.messages);
        }
        setMessagesHasMore(data.messages.length === PAGE_SIZE);
        // Mark read
        if (!beforeId) {
          await chatApi.markRead(threadId).catch(() => {});
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId ? { ...t, unreadForStaff: 0 } : t,
            ),
          );
        }
      } catch (err: any) {
        toast.error(
          err?.response?.data?.error ||
            err.message ||
            "Не удалось загрузить сообщения",
        );
      } finally {
        if (!beforeId) setMessagesLoading(false);
      }
    },
    [],
  );

  // ---------- Bootstrap ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await chatApi.getMyThread();
        if (cancelled) return;
        setIsStaff(data.isStaff);
        if (!data.isStaff) {
          setThread(data.thread);
          setActiveThreadId(data.thread.id);
        } else {
          await loadThreads();
        }
      } catch (err: any) {
        if (cancelled) return;
        setIsStaff(false);
        toast.error(
          err?.response?.data?.error ||
            err.message ||
            "Не удалось загрузить чат",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Смена активного треда ----------
  useEffect(() => {
    if (!activeThreadId) return;
    void loadMessages(activeThreadId);
  }, [activeThreadId, loadMessages]);

  // ---------- Смена состояния печати ----------
  useEffect(() => {
    const off = onChatTyping((data) => {
      // Показываем только в активном треде и только если печатает НЕ данный пользователь
      if (data.threadId !== activeThreadId) return;
      if (data.authorId === currentUserId) return;

      const label = data.isStaff && !isStaff ? "Поддержка" : data.authorName;
      setTypingName(label);

      if (typingTimeoutRef.current)
        window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = window.setTimeout(() => {
        setTypingName(null);
        typingTimeoutRef.current = null;
      }, 4000);
    });
    return () => {
      off();
      if (typingTimeoutRef.current)
        window.clearTimeout(typingTimeoutRef.current);
    };
  }, [activeThreadId, currentUserId, isStaff]);

  // ---------- Сброс печати при смене thread ----------
  useEffect(() => {
    setTypingName(null);
    setPendingAttachments([]);
  }, [activeThreadId]);

  // ---------- Socket ----------
  useChatSocket({
    onMessageNew: (msg) => {
      // staff: обновить список
      if (isStaff) {
        setThreads((prev) => {
          const idx = prev.findIndex((t) => t.id === msg.threadId);
          if (idx === -1) {
            // Новый тред — перезагружаем список целиком
            void loadThreads();
            return prev;
          }
          const updated = { ...prev[idx] };
          updated.lastMessagePreview = msg.preview;
          updated.lastMessageAuthor =
            msg.authorRole === "user" ? "user" : "staff";
          updated.updatedAt = msg.createdAt;
          if (msg.authorRole === "user") {
            updated.unreadForStaff =
              msg.threadId === activeThreadId
                ? 0
                : (updated.unreadForStaff || 0) + 1;
          }
          const next = [...prev];
          next.splice(idx, 1);
          next.unshift(updated);
          return next;
        });
      }
      // Активный тред — добавляем сообщение
      if (msg.threadId === activeThreadId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.messageId)) return prev;
          return [
            ...prev,
            {
              id: msg.messageId,
              threadId: msg.threadId,
              authorId: msg.authorId,
              authorRole: msg.authorRole as ChatMessageDTO["authorRole"],
              author: { username: null, displayName: msg.authorName },
              body: msg.body,
              storeId: null,
              replyToId: null,
              createdAt: msg.createdAt,
              editedAt: null,
              deletedAt: null,
              attachments: [],
            },
          ];
        });
        // Пометить прочитанным, если это не моё сообщение
        if (msg.threadId === activeThreadId && msg.authorId !== currentUserId) {
          void chatApi.markRead(msg.threadId).catch(() => {});
        }
      }
    },

    onRead: (data) => {
      if (!data.threadId) return;
      setThread((prev) =>
        prev && prev.id === data.threadId
          ? {
              ...prev,
              userLastReadMessageId:
                data.by === "user"
                  ? Math.max(
                      prev.userLastReadMessageId,
                      data.lastReadMessageId || 0,
                    )
                  : prev.userLastReadMessageId,
              staffLastReadMessageId:
                data.by === "staff"
                  ? Math.max(
                      prev.staffLastReadMessageId,
                      data.lastReadMessageId || 0,
                    )
                  : prev.staffLastReadMessageId,
            }
          : prev,
      );
      // в списке staff — тоже обновим (для бейджей не критично, но пусть)
      setThreads((prev) =>
        prev.map((t) =>
          t.id === data.threadId
            ? {
                ...t,
                userLastReadMessageId:
                  data.by === "user"
                    ? Math.max(
                        t.userLastReadMessageId,
                        data.lastReadMessageId || 0,
                      )
                    : t.userLastReadMessageId,
                staffLastReadMessageId:
                  data.by === "staff"
                    ? Math.max(
                        t.staffLastReadMessageId,
                        data.lastReadMessageId || 0,
                      )
                    : t.staffLastReadMessageId,
              }
            : t,
        ),
      );
    },

    onThreadDeleted: (data) => {
      if (data.threadId === activeThreadId) {
        setActiveThreadId(null);
        setMessages([]);
        setThread(null);
      }
      setThreads((prev) => prev.filter((t) => t.id !== data.threadId));
    },
  });

  // ---------- Отправка ----------
  const handleSend = async (body: string) => {
    if (!activeThreadId) return;
    if (!body.trim() && pendingAttachments.length === 0) return;
    setSending(true);
    try {
      const res = await chatApi.sendMessage({
        threadId: activeThreadId,
        body: body.trim(),
        attachmentIds: pendingAttachments.map((a) => a.id),
      });
      setPendingAttachments([]); // очищаем draft

      // Fallback: если socket не подключён — своё сообщение по событию не придёт,
      // добавляем вручную (с dedup на случай гонки).
      if (!isSocketConnected()) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.message.id)) return prev;
          return [...prev, res.message];
        });
        if (isStaff) {
          setThreads((prev) => {
            const idx = prev.findIndex((t) => t.id === res.threadId);
            if (idx === -1) return prev;
            const updated = {
              ...prev[idx],
              lastMessagePreview: body.slice(0, 100),
              lastMessageAuthor: "staff" as const,
              updatedAt: res.message.createdAt,
              unreadForStaff: 0,
            };
            const next = [...prev];
            next.splice(idx, 1);
            next.unshift(updated);
            return next;
          });
        }
      }
      // Если socket подключён — сообщение придёт через chat_message_new,
      // никаких ручных setMessages.
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err.message || "Не удалось отправить",
      );
      throw err; // ChatWindow сохранит input, чтобы не потерять текст
    } finally {
      setSending(false);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (!activeThreadId) return;
    if (pendingAttachments.length >= 3) {
      toast.error("Максимум 3 вложения на сообщение");
      return;
    }
    setUploading(true);
    try {
      const att = await chatApi.uploadAttachment(activeThreadId, file);
      setPendingAttachments((prev) => [...prev, att]);
    } catch (err: any) {
      const msg =
        err?.response?.status === 413
          ? "Файл слишком большой"
          : err?.response?.status === 415
            ? "Недопустимый тип файла"
            : err?.response?.data?.error ||
              err.message ||
              "Не удалось загрузить";
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAttachment = (id: number) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // ---------- Загрузить ещё (staff) ----------
  const handleLoadMoreThreads = () => {
    if (threadsLoading) return;
    void loadThreads(threads.length);
  };

  // ---------- Загрузить раньше (messages) ----------
  const handleLoadMoreMessages = () => {
    if (!activeThreadId || !messages.length) return;
    void loadMessages(activeThreadId, messages[0].id);
  };

  // ---------- Loading ----------
  if (isStaff === null) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        Загрузка чата...
      </div>
    );
  }

  // ---------- User ----------
  if (!isStaff) {
    return (
      <div className="flex flex-col h-[calc(100dvh-1.5rem)] md:h-[calc(100dvh-3rem)]">
        <div className="shrink-0 mb-3">
          <h1 className="text-xl md:text-2xl font-bold">💬 Поддержка</h1>
          <p className="text-xs text-muted-foreground">
            Один диалог для всех магазинов. Отвечаем как можно скорее.
          </p>
        </div>
        <div className="flex-1 min-h-0 border rounded-lg bg-card overflow-hidden">
          <ChatWindow
            thread={thread}
            messages={messages}
            currentUserId={currentUserId}
            isStaffViewer={false}
            onSend={handleSend}
            onLoadMore={handleLoadMoreMessages}
            hasMore={messagesHasMore}
            loading={messagesLoading}
            sending={sending}
            typingName={typingName}
            onTyping={() => {
              if (activeThreadId) emitChatTyping(activeThreadId);
            }}
            pendingAttachments={pendingAttachments}
            onUploadFile={handleUploadFile}
            onRemovePendingAttachment={handleRemoveAttachment}
            uploading={uploading}
            emptyText="👋 Напишите первое сообщение — поддержка ответит как можно скорее."
          />
        </div>
      </div>
    );
  }

  // ---------- Staff ----------
  return (
    <div className="flex flex-col h-[calc(100dvh-1.5rem)] md:h-[calc(100dvh-3rem)]">
      <div className="shrink-0 mb-3 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">💬 Поддержка</h1>
          <p className="text-xs text-muted-foreground">
            Диалогов: {threadsTotal}
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0 border rounded-lg bg-card overflow-hidden flex">
        {/* Thread list: скрыт на мобильном, если открыт тред */}
        <aside
          className={`w-full md:w-80 border-r flex-col min-h-0 ${
            activeThreadId ? "hidden md:flex" : "flex"
          }`}
        >
          <ThreadList
            threads={threads}
            activeId={activeThreadId}
            onSelect={setActiveThreadId}
            loading={threadsLoading}
            hasMore={threadsHasMore}
            onLoadMore={handleLoadMoreThreads}
            emptyText="Пока никто не написал в поддержку."
          />
        </aside>

        {/* Chat window: скрыт на мобильном, если тред не открыт */}
        <div
          className={`flex-1 min-w-0 min-h-0 flex-col ${
            activeThreadId ? "flex" : "hidden md:flex"
          }`}
        >
          {activeThreadId ? (
            <ChatWindow
              thread={thread}
              messages={messages}
              currentUserId={currentUserId}
              isStaffViewer
              onSend={handleSend}
              onLoadMore={handleLoadMoreMessages}
              hasMore={messagesHasMore}
              loading={messagesLoading}
              sending={sending}
              typingName={typingName}
              onTyping={() => {
                if (activeThreadId) emitChatTyping(activeThreadId);
              }}
              pendingAttachments={pendingAttachments}
              onUploadFile={handleUploadFile}
              onRemovePendingAttachment={handleRemoveAttachment}
              uploading={uploading}
              onBack={() => setActiveThreadId(null)}
              emptyText="Начните диалог — напишите первое сообщение пользователю."
            />
          ) : (
            <div className="flex-1 grid place-items-center text-center text-muted-foreground p-6">
              <div>
                <div className="text-3xl mb-2">💬</div>
                <p>Выберите диалог слева</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
