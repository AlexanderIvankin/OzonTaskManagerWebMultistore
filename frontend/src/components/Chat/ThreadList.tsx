// src/components/Chat/ThreadList.tsx
import { Badge } from "@/components/ui/badge";
import type { StaffThreadDTO } from "@/api/chat";

interface ThreadListProps {
  threads: StaffThreadDTO[];
  activeId: number | null;
  onSelect: (id: number) => void;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  emptyText?: string;
  typingByThreadId?: Record<number, string>;
}

const relativeTime = (ts: number) => {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
  });
};

export const ThreadList = ({
  threads,
  activeId,
  onSelect,
  loading,
  hasMore,
  onLoadMore,
  emptyText,
  typingByThreadId,
}: ThreadListProps) => {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 py-2 border-b bg-card font-medium">
        💬 Диалоги
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto p-1
             [scrollbar-width:none] [-ms-overflow-style:none]
             [&::-webkit-scrollbar]:hidden"
      >
        {loading && (
          <div className="text-center text-muted-foreground py-6 text-sm">
            Загрузка...
          </div>
        )}
        {!loading && threads.length === 0 && (
          <div className="text-center text-muted-foreground py-10 text-sm px-3">
            {emptyText || "Пока никто не написал в поддержку."}
          </div>
        )}
        {threads.map((t) => {
          const isActive = t.id === activeId;
          const unread = t.unreadForStaff > 0;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              className={`w-full text-left p-2.5 rounded-md transition-colors mb-1 ${
                isActive ? "bg-primary/10" : "hover:bg-accent"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-0.5">
                <span
                  className={`truncate ${unread ? "font-semibold" : "font-medium"}`}
                >
                  {t.user.displayName}
                </span>
                {unread && (
                  <Badge className="shrink-0 h-5 min-w-5 px-1.5 text-xs">
                    {t.unreadForStaff > 99 ? "99+" : t.unreadForStaff}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {typingByThreadId?.[t.id] ? (
                  <span className="italic text-primary">
                    {typingByThreadId[t.id]} печатает…
                  </span>
                ) : (
                  <>
                    {t.lastMessageAuthor === "staff" && "📤 Вы: "}
                    {t.lastMessagePreview || "Нет сообщений"}
                  </>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {relativeTime(t.updatedAt)}
              </div>
            </button>
          );
        })}
        {hasMore && !loading && (
          <div className="text-center mt-2 mb-1">
            <button
              type="button"
              onClick={onLoadMore}
              className="text-xs text-muted-foreground hover:underline"
            >
              Показать ещё
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
