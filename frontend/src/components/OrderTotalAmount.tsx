import { ProductPrice } from "../api/orders";

interface OrderTotalAmountProps {
  products: Array<{
    price?: ProductPrice;
    quantity?: number;
    currency_code?: string;
  }>;
}

/**
 * Сумма числовых цен по позициям. Цена в данных Ozon бывает строкой,
 * числом или объектом { amount, currency } — приводим всё к числу.
 */
const toPriceNumber = (price: unknown): number => {
  if (price == null) return 0;
  if (typeof price === "object") {
    const amount = (price as { amount?: string | number }).amount;
    return Number.parseFloat(String(amount ?? "")) || 0;
  }
  return Number.parseFloat(String(price)) || 0;
};

/**
 * «Общая сумма заказа: …» — внизу состава, как в карточке бота
 * (bot.js: `Общая сумма заказа: <b>…</b> RUB`). Если ни у одной позиции
 * нет цены, показывается «—». Валюта берётся у первой позиции,
 * где она указана (иначе RUB).
 */
export const OrderTotalAmount = ({ products }: OrderTotalAmountProps) => {
  if (!products || products.length === 0) return null;

  let total = 0;
  let currency = "RUB";
  let hasPrice = false;
  for (const p of products) {
    const value = toPriceNumber(p.price);
    if (value > 0) {
      total += value * (p.quantity || 1);
      hasPrice = true;
    }
    const itemCurrency =
      typeof p.price === "object"
        ? (p.price as { currency?: string }).currency
        : p.currency_code;
    if (itemCurrency && currency === "RUB") currency = itemCurrency;
  }

  return (
    <div className="flex justify-center text-center mt-4 text-sm font-semibold lg:justify-start lg:text-start">
      Общая сумма заказа:&nbsp;
      {hasPrice ? (
        <b>
          {total.toFixed(2)} {currency}
        </b>
      ) : (
        "—"
      )}
    </div>
  );
};
