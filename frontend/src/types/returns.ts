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
  resolution_status: StoredReturnResolution;
  resolution_attempts?: number;
  resolution_method?: "api" | "manual" | null;
  resolution_error?: string | null;
  source_store_id: string | null;
  source_order_id: string | null;
  status: StoredReturnStatus;
  created_at: number;
  updated_at: number;
  // Заполняется только в /admin/stored-returns
  user_name?: string;
  user_username?: string;
}

export interface AddStoredReturnResult {
  ok: boolean;
  id: number;
  created: boolean;
  quantity: number;
  offer_id: string | null;
  sku: string | null;
  cargo_box_id: string;
  barcode: string;
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
  storeId: string;
  code: string;
  dateFrom: string;
  dateTo: string;
  statusAlias: string[];
  parse: {
    totalRows: number;
    canceledRows: number;
    skippedEmptyBarcode: number;
    skippedNotCanceled: number;
    skippedNoOffer: number;
    deduplicated: number;
    collisions: number;
  };
  headerWarnings: string[];
  collisionsSample: Array<{
    barcode: string;
    kept: string | null;
    dropped: string | null;
  }>;
  inserted: number;
  updated: number;
  ready: number;
  skip: number;
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
  created_at: number;
  updated_at: number;
}
