// Типы API «Хранилище возвратов» (см. backend/src/controllers/storedReturnsController.js
// и backend/src/controllers/adminController.js → uploadReturnsPdf/syncReturnsReport).

export interface ReturnsStorageSettings {
  enabled: boolean;
}

export type StoredReturnStatus = "stored" | "used" | "removed";
export type StoredReturnResolution = "pending" | "resolved" | "unresolved";

export interface StoredReturn {
  id: number;
  user_id: number;
  box_number: string;
  lozon_id: string;
  offer_id: string | null;
  sku: string | null;
  product_name: string | null;
  quantity: number;
  status: StoredReturnStatus;
  resolution_status: StoredReturnResolution;
  resolution_attempts?: number;
  resolution_method?: "api" | "manual" | null;
  resolution_error?: string | null;
  source_store_id: string | null;
  source_order_id: string | null;
  source?: "lozon_id" | "barcode" | "offer_id";
  barcode?: string | null;
  created_at: number;
  updated_at: number;
  // Заполняется только в /admin/stored-returns
  user_name?: string;
  user_username?: string;
}

export interface ReturnOwner {
  stored_return_id: number;
  user_id: number;
  user_name: string;
  user_username: string;
  box_number: string;
  quantity: number;
  lozon_id: string;
  source?: "lozon_id" | "barcode" | "offer_id";
}

export interface AddStoredReturnResult {
  ok: boolean;
  id: number;
  created: boolean;
  quantity: number;
  offer_id: string | null;
  sku: string | null;
  barcode: string | null;
  cargo_box_id: string;
  source: "lozon_id" | "barcode" | "offer_id";
}

export interface ImportStoredReturnsResult {
  ok: boolean;
  total: number;
  valid: number;
  inserted: number;
  updated: number;
  rejected: number;
  errors: Array<{
    row: number;
    lozon_id?: string | null;
    box?: string;
    error: string;
  }>;
}

// --- Админка ---

export interface ReturnsPdfUploadItem {
  fileName: string;
  ok: boolean;
  error?: string;
  pairs: number;
  updated: number;
  notFound: number;
  alreadySet: number;
  conflicts: number;
  warnings: string[];
  isLikelyScanned: boolean;
  numPages?: number;
  durationMs: number;
}

export interface ReturnsPdfUploadResult {
  message: string;
  total: number;
  okCount: number;
  failCount: number;
  totalPairs: number;
  totalUpdated: number;
  totalNotFound: number;
  durationMs: number;
  items: ReturnsPdfUploadItem[];
}

export interface ReturnsSyncResult {
  message: string;

  // Идентификация прогона
  storeId: string;
  code: string; // REPORT_...
  dateFrom: string;
  dateTo: string;
  statusAlias: string[];

  // Статистика парсинга CSV
  totalRows: number; // всего строк данных в файле
  canceledRows: number; // со статусом cancelled
  skippedEmptyBarcode: number; // строк без barcode
  skippedNotCanceled: number; // не-cancelled
  skippedMultipleInCell: number; // несколько значений в ячейке P/Q
  skippedNoOffer: number; // нет offer_id/sku — ушли в skip
  uniqueRows: number; // после дедупликации по composite id
  multiProductBarcodes: number; // barcode с >1 уникальным offer_id
  ready: number; // resolution_status='ready'
  skip: number; // resolution_status='skip'

  // Состояние upsert в returns-N.db
  inserted: number;
  updated: number;

  // Диагностика
  headerWarnings: string[];
  durationMs: number;
}

export interface ReturnsCacheItem {
  id: string;
  barcode: string | null;
  cargo_box_id: string | null;
  offer_id: string | null;
  sku: string | null;
  product_name: string | null;
  quantity: number;
  order_id: string | null;
  order_number: string | null;
  posting_number: string | null;
  schema: string | null;
  return_schema: string | null;
  return_date: string | null;
  status_name: string | null;
  status_sys_name: string | null;
  place_name: string | null;
  resolution_status: "pending" | "ready" | "skip";
  resolution_reason?: string | null; // NEW: 'multiple_products' | 'no_offer_id' | null
  created_at: number;
  updated_at: number;
}
