import api from "./index";

export interface ChatThreadDTO {
  id: number;
  userId: number;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string | null;
  lastMessageAuthor: "user" | "staff" | null;
  unreadForUser: number;
  unreadForStaff: number;
  userLastReadMessageId: number;
  staffLastReadMessageId: number;
  status: "open" | "closed";
}

export interface StaffThreadDTO extends ChatThreadDTO {
  user: { id: number; username: string; displayName: string };
}

export interface ChatAttachmentDTO {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  url: string;
  previewUrl: string | null;
}

export interface ReplyToDTO {
  id: number;
  authorId: number;
  authorRole: string;
  authorName: string;
  body: string;
  quotedText: string | null;
  deleted: boolean;
}

export interface ChatMessageDTO {
  id: number;
  threadId: number;
  authorId: number;
  authorRole: "user" | "moderator" | "admin" | "god";
  author: { username: string | null; displayName: string };
  body: string;
  storeId: string | null;
  replyToId: number | null;
  replyTo: ReplyToDTO | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  attachments: ChatAttachmentDTO[];
}

export interface MyThreadResponse {
  thread: ChatThreadDTO;
  unreadForUser: number;
  isStaff: boolean;
}

export interface ListThreadsResponse {
  items: StaffThreadDTO[];
  total: number;
  hasMore: boolean;
}

export interface ThreadMessagesResponse {
  thread: ChatThreadDTO;
  messages: ChatMessageDTO[];
}

export interface SendMessageResponse {
  message: ChatMessageDTO;
  threadId: number;
}

export interface UnreadCountsResponse {
  isStaff: boolean;
  total: number;
  threads: number;
}

export const chatApi = {
  async getMyThread(): Promise<MyThreadResponse> {
    const { data } = await api.get<MyThreadResponse>("/chat/thread");
    return data;
  },
  async listThreads(
    params: { limit?: number; offset?: number; unread?: boolean } = {},
  ): Promise<ListThreadsResponse> {
    const { data } = await api.get<ListThreadsResponse>("/chat/threads", {
      params: {
        limit: params.limit,
        offset: params.offset,
        unread: params.unread ? 1 : undefined,
      },
    });
    return data;
  },
  async getMessages(
    threadId: number,
    params: { beforeId?: number; limit?: number } = {},
  ): Promise<ThreadMessagesResponse> {
    const { data } = await api.get<ThreadMessagesResponse>(
      `/chat/threads/${threadId}/messages`,
      {
        params: { before: params.beforeId, limit: params.limit },
      },
    );
    return data;
  },
  async sendMessage(payload: {
    threadId?: number;
    body: string;
    replyToId?: number;
    quotedText?: string;
    attachmentIds?: number[];
  }): Promise<SendMessageResponse> {
    const { data } = await api.post<SendMessageResponse>(
      "/chat/messages",
      payload,
    );
    return data;
  },
  // Загрузка
  async uploadAttachment(
    threadId: number,
    file: File,
  ): Promise<ChatAttachmentDTO> {
    const form = new FormData();
    form.append("file", file);
    form.append("threadId", String(threadId));
    const { data } = await api.post<ChatAttachmentDTO>(
      "/chat/attachments",
      form,
      { headers: { "Content-Type": "multipart/form-data" } },
    );
    return data;
  },
  async markRead(
    threadId?: number,
  ): Promise<{ ok: boolean; scope: string; threadId?: number }> {
    const { data } = await api.post("/chat/read", { threadId });
    return data;
  },
  async unreadCount(): Promise<UnreadCountsResponse> {
    const { data } = await api.get<UnreadCountsResponse>("/chat/unread-count");
    return data;
  },
  async deleteThread(
    threadId: number,
  ): Promise<{ ok: boolean; deletedMessages: number }> {
    const { data } = await api.delete("/chat/thread", { data: { threadId } });
    return data;
  },
};
