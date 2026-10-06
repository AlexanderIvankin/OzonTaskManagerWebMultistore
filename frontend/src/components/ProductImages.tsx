import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ProductImage {
  url: string;
  name: string;
}

interface ProductImagesProps {
  productName: string;
  images: ProductImage[];
}

// Максимум фото на 1 товар (сетка 3x2), иначе карточка будет слишком огромной
const MAX_VISIBLE = 6;

/**
 * Сетка фотографий одного товара (3x2, максимум 6), с увеличением фото по клику (лайтбокс).
 * Битые ссылки прячем автоматически.
 */
export const ProductImages = ({ productName, images }: ProductImagesProps) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [broken, setBroken] = useState<Set<string>>(new Set());

  const markBroken = (url: string) => {
    if (!broken.has(url)) {
      setBroken((prev) => new Set(prev).add(url));
    }
  };

  const visible = (images || [])
    .slice(0, MAX_VISIBLE)
    .filter((img) => !broken.has(img.url));

  if (!visible.length) return null;

  return (
    <div className="mt-2">
      <div className="grid grid-cols-3 gap-2">
        {visible.map((img, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => setPreview(img.url)}
            className="overflow-hidden rounded border p-0 cursor-zoom-in"
            title="Увеличить фото"
          >
            <img
              src={img.url}
              alt={img.name}
              loading="lazy"
              className="w-full h-40 object-cover"
              onError={() => markBroken(img.url)}
            />
          </button>
        ))}
      </div>
      {images && images.length > MAX_VISIBLE && (
        <div className="mt-1 text-xs text-muted-foreground">
          + ещё {images.length - MAX_VISIBLE} фото
        </div>
      )}

      {/* Лайтбокс (увеличение фото по клику) */}
      <Dialog
        open={!!preview}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPreview(null);
        }}
      >
        <DialogContent className="w-auto max-w-[calc(100%-1rem)] sm:max-w-[85vw]">
          <DialogHeader className="pt-10">
            <DialogTitle>{productName}</DialogTitle>
            <DialogDescription>
              Нажмите крестик или Esc, чтобы закрыть.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <img
              src={preview}
              alt={productName}
              className="mx-auto max-h-[80vh] max-w-full w-auto rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};