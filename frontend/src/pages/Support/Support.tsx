import { useState } from "react";
import { useChatPanel } from "../../hooks/useChatPanel";
import { ChatWindow } from "../../components/Chat/ChatWindow";
import { ThreadList } from "../../components/Chat/ThreadList";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

export const Support = () => {
  const chat = useChatPanel();

  const [showConfirm, setShowConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await chat.handleClearThread();
      setShowConfirm(false);
      toast.success("История переписки очищена");
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err.message || "Не удалось очистить",
      );
    } finally {
      setClearing(false);
    }
  };

  if (chat.isStaff === null) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        Загрузка чата...
      </div>
    );
  }

  // ---------- User ----------
  if (!chat.isStaff) {
    return (
      <div className="flex flex-col h-[calc(100dvh-1.5rem)] xl:h-[calc(100dvh-3rem)]">
        <div className="shrink-0 mb-3 flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl xl:text-2xl font-bold">💬 Поддержка</h1>
            <p className="text-xs text-muted-foreground">
              Один диалог для всех магазинов. Отвечаем как можно скорее.
            </p>
          </div>
          {chat.activeThreadId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowConfirm(true)}
              title="Очистить историю переписки"
            >
              🗑️ Очистить
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 border rounded-lg bg-card overflow-hidden">
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
            emptyText="👋 Напишите первое сообщение — поддержка ответит как можно скорее."
          />
        </div>

        <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Очистить переписку?</DialogTitle>
              <DialogDescription>
                История и все вложения будут удалены <b>навсегда</b> — ни вы, ни
                поддержка не сможете их восстановить. Отменить это действие
                нельзя. Если снова напишете — начнётся новый диалог.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                disabled={clearing}
              >
                Отмена
              </Button>
              <Button
                variant="destructive"
                onClick={handleClear}
                disabled={clearing}
              >
                {clearing ? "Очищаем…" : "🗑️ Удалить навсегда"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ---------- Staff ----------
  return (
    <div className="flex flex-col h-[calc(100dvh-1.5rem)] xl:h-[calc(100dvh-3rem)]">
      <div className="shrink-0 mb-3 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl xl:text-2xl font-bold">💬 Поддержка</h1>
          <p className="text-xs text-muted-foreground">
            Диалогов: {chat.threadsTotal}
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0 border rounded-lg bg-card overflow-hidden flex">
        <aside
          className={`w-full xl:w-80 border-r flex-col min-h-0 ${
            chat.activeThreadId ? "hidden xl:flex" : "flex"
          }`}
        >
          <ThreadList
            threads={chat.threads}
            activeId={chat.activeThreadId}
            onSelect={chat.setActiveThreadId}
            loading={chat.threadsLoading}
            hasMore={chat.threadsHasMore}
            onLoadMore={chat.handleLoadMoreThreads}
            typingByThreadId={chat.typingByThreadId}
            emptyText="Пока никто не написал в поддержку."
          />
        </aside>

        <div
          className={`flex-1 min-w-0 min-h-0 flex-col ${
            chat.activeThreadId ? "flex" : "hidden xl:flex"
          }`}
        >
          {chat.activeThreadId ? (
            <ChatWindow
              thread={chat.thread}
              messages={chat.messages}
              currentUserId={chat.currentUserId}
              isStaffViewer
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
              onBack={() => chat.setActiveThreadId(null)}
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
