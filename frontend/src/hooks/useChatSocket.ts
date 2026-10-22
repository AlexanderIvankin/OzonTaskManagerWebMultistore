// src/hooks/useChatSocket.ts
import { useEffect, useRef, useState } from "react";
import {
  ChatMessageNewPayload,
  ChatReadPayload,
  ChatThreadDeletedPayload,
  ChatMessageDeletedPayload,
  isSocketConnected,
  onChatMessageNew,
  onChatRead,
  onChatThreadDeleted,
  onChatMessageDeleted,
  onSocketConnect,
} from "../lib/socket";

interface Handlers {
  onMessageNew?: (data: ChatMessageNewPayload) => void;
  onRead?: (data: ChatReadPayload) => void;
  onThreadDeleted?: (data: ChatThreadDeletedPayload) => void;
  onMessageDeleted?: (data: ChatMessageDeletedPayload) => void;
}

/**
 * Подписка на чат-события. Хендлеры хранятся в ref — можно передавать
 * инлайн-стрелки без риска ре-подписки на каждый рендер.
 */
export function useChatSocket(handlers: Handlers): { connected: boolean } {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState<boolean>(() =>
    isSocketConnected(),
  );

  useEffect(() => {
    const offMsg = onChatMessageNew((d) => ref.current.onMessageNew?.(d));
    const offRead = onChatRead((d) => ref.current.onRead?.(d));
    const offThreadDel = onChatThreadDeleted((d) =>
      ref.current.onThreadDeleted?.(d),
    );
    const offMsgDel = onChatMessageDeleted((d) =>
      ref.current.onMessageDeleted?.(d),
    );
    const offConn = onSocketConnect(() => setConnected(true));

    // На случай, если сокет уже был подключён до монтирования
    setConnected(isSocketConnected());

    return () => {
      offMsg();
      offRead();
      offThreadDel();
      offMsgDel();
      offConn();
    };
  }, []);

  return { connected };
}
