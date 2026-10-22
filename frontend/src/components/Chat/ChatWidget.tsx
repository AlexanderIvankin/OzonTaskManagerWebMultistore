// src/components/Chat/ChatWidget.tsx
import { useCallback, useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { Link, useLocation } from "react-router-dom";
import { RootState } from "../../store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { chatApi } from "../../api/chat";
import { onChatMessageNew, onSocketConnect } from "../../lib/socket";
import { useChatPanel } from "../../hooks/useChatPanel";
import { ChatWindow } from "./ChatWindow";

export const ChatWidget = () => {
  const user = useSelector((s: RootState) => s.auth.user);
  const location = useLocation();

  // Скрываем: гость (email не подтверждён), staff (у них есть вкладка
  // «Поддержка» с бейджем), страница /support (там уже открыто).
  const isGuest = user?.role === "guest";
  const isStaffRole = ["employee", "moderator", "admin", "god"].includes(
    user?.role || "",
  );
  const isOnSupportPage = location.pathname === "/support";

  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const refreshUnread = useCallback(async () => {
    try {
      const data = await chatApi.unreadCount();
      setUnread(data.total);
    } catch {
      /* счётчик некритичен */
    }
  }, []);

  useEffect(() => {
    if (!user || isGuest || isStaffRole) return;
    refreshUnread();
    const off = onChatMessageNew(() => refreshUnread());
    const offConnect = onSocketConnect(refreshUnread);
    return () => {
      off();
      offConnect();
    };
  }, [user, isGuest, isStaffRole, refreshUnread]);

  if (!user || isGuest || isStaffRole || isOnSupportPage) return null;

  return (
    <>
      {/* FAB */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 size-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity grid place-items-center"
        title="Поддержка"
        aria-label="Открыть чат поддержки"
      >
        <span aria-hidden="true" className="text-2xl">
          💬
        </span>
        {unread > 0 && (
          <Badge
            className="absolute -top-1 -right-1 h-5 min-w-5 px-1 text-[10px] leading-none"
            variant="destructive"
          >
            {unread > 99 ? "99+" : unread}
          </Badge>
        )}
      </button>

      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (!isOpen) void refreshUnread();
        }}
      >
        {/* p-0, gap-0 — убираем дефолтные отступы shadcn.
            [&>button]:hidden — скрываем встроенный ✕ shadcn (он перекрывает
            наш header в ChatWindow).
            absolute inset-0 внутри — вырывает WidgetPanel из grid-раскладки
            DialogContent, поэтому h-full честно тянется до высоты модалки
            и внутренний скролл у ChatWindow работает. */}
        <DialogContent
          className="p-0 gap-0 overflow-hidden
                     w-full max-w-[calc(100vw-1rem)]
                     sm:max-w-[560px] md:max-w-[640px]
                     h-[85vh] max-h-[700px]
                     [&>button]:hidden"
        >
          <DialogTitle className="sr-only">Поддержка</DialogTitle>
          <div className="absolute inset-0">
            {open && <WidgetPanel onClose={() => setOpen(false)} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

const WidgetPanel = ({ onClose }: { onClose: () => void }) => {
  const chat = useChatPanel();

  // ── Loading ──
  if (chat.isStaff === null) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 px-3 py-2 border-b flex items-center justify-between bg-card">
          <span className="font-medium">Поддержка</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onClose}
            title="Закрыть"
          >
            ✕
          </Button>
        </div>
        <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
          Загрузка...
        </div>
      </div>
    );
  }

  // ── Staff (теоретически недостижимо — widget не рендерится для staff,
  //          но на всякий случай — понятный fallback) ──
  if (chat.isStaff) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 px-3 py-2 border-b flex items-center justify-between bg-card">
          <span className="font-medium">Поддержка</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onClose}
            title="Закрыть"
          >
            ✕
          </Button>
        </div>
        <div className="flex-1 grid place-items-center p-6 text-center text-muted-foreground text-sm">
          <div>
            <p className="mb-3">
              Для работы с обращениями откройте полную страницу.
            </p>
            <Link
              to="/support"
              onClick={onClose}
              className="text-primary hover:underline"
            >
              Перейти в Поддержку →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── User (обычный случай) ──
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0">
        <ChatWindow
          thread={chat.thread}
          messages={chat.messages}
          currentUserId={chat.currentUserId}
          isStaffViewer={false}
          onSend={chat.handleSend}
          onLoadMore={chat.handleLoadMoreMessages}
          hasMore={chat.messagesHasMore}
          loading={chat.messagesLoading}
          sending={chat.sending}
          typingName={chat.typingName}
          onTyping={chat.emitTyping}
          onDeleteMessage={chat.handleDeleteMessage}
          pendingAttachments={chat.pendingAttachments}
          onUploadFile={chat.handleUploadFile}
          onRemovePendingAttachment={chat.handleRemoveAttachment}
          uploading={chat.uploading}
          onClose={onClose}
          emptyText="👋 Напишите первое сообщение — поддержка ответит как можно скорее."
        />
      </div>
      <div className="shrink-0 border-t p-2 text-center bg-card">
        <Link
          to="/support"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Открыть полную страницу →
        </Link>
      </div>
    </div>
  );
};
