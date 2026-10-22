// Единый источник состояния чата. Используется и /support, и ChatWidget.
// Всё, что касается загрузки, отправки, socket-подписок — здесь.
// Компоненты рендерят UI поверх результата.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { RootState } from "../store";
import { toast } from "sonner";
import {
  chatApi,
  ChatAttachmentDTO,
  ChatMessageDTO,
  ChatThreadDTO,
  StaffThreadDTO,
} from "../api/chat";
import { useChatSocket } from "./useChatSocket";
import { isSocketConnected, emitChatTyping, onChatTyping } from "../lib/socket";

const PAGE_SIZE = 50;
const THREADS_PAGE = 30;
const TYPING_TIMEOUT_MS = 4000;

export interface ChatPanelState {
  currentUserId: number;
  isStaff: boolean | null;

  thread: ChatThreadDTO | StaffThreadDTO | null;
  activeThreadId: number | null;
  messages: ChatMessageDTO[];
  messagesLoading: boolean;
  messagesHasMore: boolean;

  threads: StaffThreadDTO[];
  threadsLoading: boolean;
  threadsHasMore: boolean;
  threadsTotal: number;
  typingByThreadId: Record<number, string>;

  typingName: string | null;

  sending: boolean;
  pendingAttachments: ChatAttachmentDTO[];
  uploading: boolean;

  setActiveThreadId: (id: number | null) => void;
  handleSend: (
    body: string,
    replyToId?: number,
    quotedText?: string,
  ) => Promise<void>;
  handleUploadFile: (file: File) => Promise<void>;
  handleRemoveAttachment: (id: number) => void;
  handleLoadMoreThreads: () => void;
  handleLoadMoreMessages: () => void;
  handleClearThread: () => Promise<void>;
  handleDeleteMessage: (messageId: number) => Promise<void>;
  emitTyping: () => void;
}

export function useChatPanel(): ChatPanelState {
  const user = useSelector((s: RootState) => s.auth.user);
  const currentUserId = user?.id ?? 0;

  const [isStaff, setIsStaff] = useState<boolean | null>(null);
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
  const [typingByThreadId, setTypingByThreadId] = useState<
    Record<number, string>
  >({});
  const typingTimeoutRef = useRef<number | null>(null);
  const threadTypingTimersRef = useRef<Map<number, number>>(new Map());

  const [pendingAttachments, setPendingAttachments] = useState<
    ChatAttachmentDTO[]
  >([]);
  const [uploading, setUploading] = useState(false);

  // ---------- Загрузка ----------
  const loadThreads = useCallback(async (offset = 0) => {
    setThreadsLoading(true);
    try {
      const data = await chatApi.listThreads({ limit: THREADS_PAGE, offset });
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

  // ---------- Сброс при смене треда ----------
  useEffect(() => {
    setTypingName(null);
    setPendingAttachments([]);
  }, [activeThreadId]);

  // ---------- Typing (индикатор + список) ----------
  useEffect(() => {
    const off = onChatTyping((data) => {
      if (data.authorId === currentUserId) return;

      // Если тред — активный, показываем «печатает…» в окне чата.
      if (data.threadId === activeThreadId) {
        const label = data.isStaff && !isStaff ? "Поддержка" : data.authorName;
        setTypingName(label);
        if (typingTimeoutRef.current)
          window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = window.setTimeout(() => {
          setTypingName(null);
          typingTimeoutRef.current = null;
        }, TYPING_TIMEOUT_MS);
        return;
      }

      // Иначе — обновляем список тредов (только для staff).
      if (!isStaff) return;
      setTypingByThreadId((prev) => ({
        ...prev,
        [data.threadId]: data.authorName,
      }));
      const existing = threadTypingTimersRef.current.get(data.threadId);
      if (existing) window.clearTimeout(existing);
      const t = window.setTimeout(() => {
        setTypingByThreadId((prev) => {
          const copy = { ...prev };
          delete copy[data.threadId];
          return copy;
        });
        threadTypingTimersRef.current.delete(data.threadId);
      }, TYPING_TIMEOUT_MS);
      threadTypingTimersRef.current.set(data.threadId, t);
    });

    return () => {
      off();
      if (typingTimeoutRef.current)
        window.clearTimeout(typingTimeoutRef.current);
    };
  }, [activeThreadId, currentUserId, isStaff]);

  // Clear per-thread timers on unmount
  useEffect(() => {
    const timers = threadTypingTimersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, []);

  // ---------- Socket ----------
  useChatSocket({
    onMessageNew: (msg) => {
      if (isStaff) {
        setThreads((prev) => {
          const idx = prev.findIndex((t) => t.id === msg.threadId);
          if (idx === -1) {
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
              storeId: msg.storeId ?? null,
              storeName: msg.storeName ?? null,
              replyToId: msg.replyTo?.id ?? null,
              replyTo: msg.replyTo
                ? { ...msg.replyTo, quotedText: msg.replyTo.quotedText ?? null }
                : null,
              createdAt: msg.createdAt,
              editedAt: null,
              deletedAt: null,
              attachments: msg.attachments ?? [],
            },
          ];
        });
        if (msg.authorId !== currentUserId) {
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

    onMessageDeleted: (data) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === data.messageId
            ? { ...m, deletedAt: Date.now(), body: "", attachments: [] }
            : m,
        ),
      );
    },
  });

  // ---------- Отправка ----------
  const handleSend = useCallback(
    async (body: string, replyToId?: number, quotedText?: string) => {
      if (!activeThreadId) return;
      if (!body.trim() && pendingAttachments.length === 0) return;
      setSending(true);
      try {
        const res = await chatApi.sendMessage({
          threadId: activeThreadId,
          body: body.trim(),
          replyToId,
          quotedText,
          attachmentIds: pendingAttachments.map((a) => a.id),
        });
        setPendingAttachments([]);

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
      } catch (err: any) {
        toast.error(
          err?.response?.data?.error || err.message || "Не удалось отправить",
        );
        throw err;
      } finally {
        setSending(false);
      }
    },
    [activeThreadId, isStaff, pendingAttachments],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      if (!activeThreadId) return;
      if (pendingAttachments.length >= 3) {
        toast.error("Максимум 3 вложения на сообщение");
        return;
      }
      // Клиентский лимит — не грузим зря, если файл точно больше серверного.
      const MAX_MB = 10;
      if (file.size > MAX_MB * 1024 * 1024) {
        toast.error(`Файл больше ${MAX_MB} МБ`);
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
    },
    [activeThreadId, pendingAttachments.length],
  );

  const handleRemoveAttachment = useCallback((id: number) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /**
   * Полностью удалить текущий тред и сразу получить новый пустой.
   * Используется кнопкой «Очистить» на странице /support (только owner).
   * После удаления getMyThread создаст свежий тред через ensureForUser.
   */
  const handleClearThread = useCallback(async () => {
    if (!activeThreadId) return;
    await chatApi.deleteThread(activeThreadId);
    setMessages([]);
    setThread(null);
    setActiveThreadId(null);
    setPendingAttachments([]);
    setTypingName(null);
    try {
      const data = await chatApi.getMyThread();
      setThread(data.thread);
      setActiveThreadId(data.thread.id);
    } catch {
      /* следующая загрузка страницы подтянет */
    }
  }, [activeThreadId]);

  const handleDeleteMessage = useCallback(async (messageId: number) => {
    try {
      await chatApi.deleteMessage(messageId);
      // Оптимистичное обновление: socket-эмит придёт с теми же данными —
      // повторно ничего не сломает (idempotent).
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, deletedAt: Date.now(), body: "", attachments: [] }
            : m,
        ),
      );
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err.message || "Не удалось удалить",
      );
      throw err;
    }
  }, []);

  const handleLoadMoreThreads = useCallback(() => {
    if (threadsLoading) return;
    void loadThreads(threads.length);
  }, [threadsLoading, threads.length, loadThreads]);

  const handleLoadMoreMessages = useCallback(() => {
    if (!activeThreadId || !messages.length) return;
    void loadMessages(activeThreadId, messages[0].id);
  }, [activeThreadId, messages, loadMessages]);

  const emitTyping = useCallback(() => {
    if (activeThreadId) emitChatTyping(activeThreadId);
  }, [activeThreadId]);

  return {
    currentUserId,
    isStaff,
    thread,
    activeThreadId,
    messages,
    messagesLoading,
    messagesHasMore,
    threads,
    threadsLoading,
    threadsHasMore,
    threadsTotal,
    typingByThreadId,
    typingName,
    sending,
    pendingAttachments,
    uploading,
    setActiveThreadId,
    handleSend,
    handleUploadFile,
    handleRemoveAttachment,
    handleLoadMoreThreads,
    handleLoadMoreMessages,
    handleClearThread,
    handleDeleteMessage,
    emitTyping,
  };
}
