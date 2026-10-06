import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const PHONE_FORMAT_HINT = "+7 (999) 999-99-99 (11 цифр)";

/**
 * Базовая проверка email: только латиница, цифры и символы ._%+-
 * (кириллица/пробелы ломают синхронизацию сотрудников по email —
 * бэкенд такое отклоняет, поэтому проверяем так же на клиенте).
 */
export const EMAIL_FORMAT_RE =
  /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$/;

/**
 * Живое форматирование телефона в формате +7 (999) 999-99-99.
 * Убирает лишние символы, авто-добавляет код страны 7, максимум 11 цифр.
 */
export function formatPhoneInput(raw: string): string {
  let digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";

  // Ведущая "8" — российский стиль, приводим к "7"
  if (digits[0] === "8") digits = "7" + digits.slice(1);
  // 10 цифр без кода страны → дописываем 7
  if (digits[0] !== "7" && digits.length === 10) digits = "7" + digits;
  // Пока не начался с 7 — подставляем код страны (маска растёт слева)
  if (digits[0] !== "7") digits = "7" + digits;

  digits = digits.slice(0, 11); // максимум 11 цифр

  let res = "+" + digits[0];
  if (digits.length > 1) {
    res += " (" + digits.slice(1, 4);
    if (digits.length >= 4) res += ")";
  }
  if (digits.length > 4) {
    res += " " + digits.slice(4, 7);
    if (digits.length >= 7) res += "-";
  }
  if (digits.length > 7) {
    res += digits.slice(7, 9);
    if (digits.length >= 9) res += "-";
  }
  if (digits.length > 9) {
    res += digits.slice(9, 11);
  }
  return res;
}

/**
 * Валидация телефона: ровно 11 цифр.
 */
export function isValidPhone(value: string): boolean {
  const digits = (value || "").replace(/\D/g, "");
  return digits.length === 11;
}
