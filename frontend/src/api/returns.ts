// frontend/src/api/returns.ts
import api from ".";
import type {
  ReturnsStorageSettings,
  StoredReturn,
  AddStoredReturnResult,
  ImportStoredReturnsResult,
} from "../types/returns";

/**
 * API личного хранилища возвратов (сотрудник).
 * Работает и на глобальном домене, и на поддомене магазина.
 * На магазинном домене бэкенд использует req.storeId как source_store_id.
 */
export const returnsStorageApi = {
  getSettings: () =>
    api
      .get<ReturnsStorageSettings>("/user/returns-storage/settings")
      .then((r) => r.data),

  setEnabled: (enabled: boolean) =>
    api
      .patch<ReturnsStorageSettings>("/user/returns-storage/settings", {
        enabled,
      })
      .then((r) => r.data),

  list: (params?: { includeAll?: boolean; status?: string }) =>
    api
      .get<{ items: StoredReturn[] }>("/user/stored-returns", { params })
      .then((r) => r.data),

  addManual: (data: {
    boxNumber: string;
    offerId?: string;
    input?: string;
    quantity?: number;
  }) =>
    api
      .post<AddStoredReturnResult>("/user/stored-returns", data)
      .then((r) => r.data),

  importExcel: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api
      .post<ImportStoredReturnsResult>("/user/stored-returns/import", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },

  remove: (id: number) =>
    api
      .delete<{ ok: boolean }>(`/user/stored-returns/${id}`)
      .then((r) => r.data),
};
