import type { ProductStats } from "../api/orders";

interface ProductStatsBlockProps {
  stats?: ProductStats | null;
  /**
   * Классы выравнивания. Должны включать и text-*, и justify-*,
   * т.к. это flex-контейнер с собственными дефолтами.
   */
  alignClassName?: string;
}

/**
 * Материал, цвет и вес товара (product_stats) — как в карточке заказа
 * Telegram-бота (bot.js: «Материал: …, Цвет: …»). Если статистика не
 * заполнена (stats = null), блок не рендерится.
 */
export const ProductStatsBlock = ({
  stats,
  alignClassName = "text-center justify-center lg:text-start lg:justify-start",
}: ProductStatsBlockProps) => {
  if (!stats) return null;
  return (
    <div
      className={`flex flex-wrap text-sm text-muted-foreground ${alignClassName}`}
    >
      Материал:&nbsp;<b>{stats.material}</b>, Цвет:&nbsp;<b>{stats.color}</b>,
      Вес:&nbsp;<b>{stats.weight_grams} г</b>
    </div>
  );
};
