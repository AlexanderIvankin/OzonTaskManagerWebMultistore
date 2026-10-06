import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatPhoneInput } from "@/lib/utils";

// Позиции цифр в отформатированной строке маски («+7 (999) 999-99-99»)
function digitPositions(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] >= "0" && text[i] <= "9") out.push(i);
  }
  return out;
}

// Позиция каретки «после digitsBefore-й цифры» в отформатированном тексте
function caretByDigitCount(text: string, digitsBefore: number): number {
  const pos = digitPositions(text);
  if (digitsBefore <= 0) return 0;
  if (digitsBefore >= pos.length) return text.length;
  return pos[digitsBefore - 1] + 1;
}

// Индекс цифры, стоящей слева от позиции fromIdx (0-based среди всех цифр)
function digitIndexBefore(text: string, fromIdx: number): number | null {
  let count = 0;
  for (let i = 0; i < fromIdx && i < text.length; i++) {
    if (text[i] >= "0" && text[i] <= "9") count++;
  }
  return count - 1 >= 0 ? count - 1 : null;
}

// Индекс первой цифры, стоящей справа от позиции fromIdx
function digitIndexAfter(text: string, fromIdx: number): number | null {
  let before = 0;
  for (let i = 0; i <= fromIdx && i < text.length; i++) {
    if (text[i] >= "0" && text[i] <= "9") before++;
  }
  for (let i = fromIdx + 1; i < text.length; i++) {
    if (text[i] >= "0" && text[i] <= "9") return before;
  }
  return null;
}

function countDigits(text: string): number {
  let n = 0;
  for (const ch of text) if (ch >= "0" && ch <= "9") n++;
  return n;
}

export type PhoneInputProps = Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "children"
> & {
  value?: string;
  /** Вызывается с отформатированным номером вида «+7 (999) 999-99-99» */
  onValueChange: (formatted: string) => void;
};

/**
 * Маскированный телефонный инпут в формате +7 (999) 999-99-99.
 * В отличие от formatPhoneInput не «затирает» ввод: сохраняет позицию
 * каретки, а при Backspace/Delete на разделителе маски удаляет соседнюю
 * цифру (иначе символ бы «возвращался» и цифры за ним не стирались).
 */
export function PhoneInput({ value, onValueChange, ...rest }: PhoneInputProps) {
  const [text, setText] = useState(() => formatPhoneInput(value ?? ""));

  // Синхронизация при внешнем изменении значения (например, после загрузки)
  useEffect(() => {
    const desired = formatPhoneInput(value ?? "");
    setText((prev) => (prev === desired ? prev : desired));
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const raw = el.value;
    const selStart = el.selectionStart ?? raw.length;

    const oldText = text;
    const oldDigits = (oldText.match(/\d/g) ?? []).join("");
    const rawDigits = (raw.match(/\d/g) ?? []).join("");

    const inputType = (e.nativeEvent as InputEvent)?.inputType || "";
    const isDelete =
      inputType === "deleteContentBackward" ||
      inputType === "deleteContentForward";

    let digits = rawDigits;
    let forceIndex: number | null = null;

    // Удалили только разделитель (скобку/дефис/пробел) — заменяем действие
    // на удаление соседней цифры, чтобы маска не «возвращала» символ.
    if (
      isDelete &&
      rawDigits.length === oldDigits.length &&
      raw.length < oldText.length
    ) {
      // удалённый символ в старом тексте находился на индексе selStart
      const target =
        inputType === "deleteContentBackward"
          ? digitIndexBefore(oldText, selStart)
          : digitIndexAfter(oldText, selStart);
      if (target !== null) {
        forceIndex = target;
        digits = oldDigits.slice(0, target) + oldDigits.slice(target + 1);
      }
    }

    const display = formatPhoneInput(digits);

    let caret =
      forceIndex !== null
        ? caretByDigitCount(display, forceIndex + 1)
        : caretByDigitCount(display, countDigits(raw.slice(0, selStart)));

    setText(display);
    onValueChange?.(display);

    // Возвращаем каретку на правильную позицию после перерисовки
    requestAnimationFrame(() => {
      try {
        const clamped = Math.max(0, Math.min(caret, el.value.length));
        el.setSelectionRange(clamped, clamped);
      } catch {
        // диапазон недоступен — просто оставляем каретку как есть
      }
    });
  };

  return <Input value={text} onChange={handleChange} {...rest} />;
}