import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useDispatch } from "react-redux";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resendCode, verifyEmail } from "../../store/authSlice";
import { AppDispatch } from "../../store";

const verifySchema = z.object({
  email: z.string().email("Некорректный email"),
  code: z.string().regex(/^\d{6}$/, "Код состоит из 6 цифр"),
});

type VerifyFormValues = z.infer<typeof verifySchema>;

const RESEND_COOLDOWN_SECONDS = 60;

const getServerMessage = (err: any, fallback: string) =>
  err?.response?.data?.error || err?.message || fallback;

export const VerifyEmail = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  // Email приходит из query (?email=...) после регистрации или попытки входа
  const [searchParams] = useSearchParams();
  const initialEmail = searchParams.get("email") || "";
  // ?resent=1 — вернулись с повторной регистрации: предыдущая неподтверждённая
  // регистрация тем же логином/email заменена, код отправлен заново
  const resentFromRegistration = searchParams.get("resent") === "1";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  const [resendLoading, setResendLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<VerifyFormValues>({
    resolver: zodResolver(verifySchema),
    defaultValues: { email: initialEmail, code: "" },
  });

  // Таймер кулдауна повторной отправки
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const onSubmit = async (data: VerifyFormValues) => {
    setLoading(true);
    setError(null);
    try {
      await dispatch(verifyEmail({ code: data.code })).unwrap();
      setVerified(true);
    } catch (err: any) {
      setError(getServerMessage(err, "Ошибка подтверждения"));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    const email = getValues("email")?.trim();
    setResendLoading(true);
    setResendError(null);
    setResendMessage(null);
    try {
      const res = await dispatch(resendCode({ email })).unwrap();
      // Кулдаун диктует сервер (RESEND_CODE_COOLDOWN_SEC): кнопка блокируется
      // на retryAfterSec секунд. sent === false — письмо НЕ отправлено
      // (кулдаун ещё идёт, аккаунта нет или email уже подтверждён)
      const wait = res.retryAfterSec ?? RESEND_COOLDOWN_SECONDS;
      setCooldown(wait);
      setResendMessage(
        res.sent === false
          ? `Письмо уже отправлено — повторно можно через ${wait} с.`
          : res.message,
      );
    } catch (err: any) {
      setResendError(getServerMessage(err, "Ошибка отправки"));
    } finally {
      setResendLoading(false);
    }
  };

  if (verified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">✅ Email подтверждён!</CardTitle>
            <CardDescription>
              Вашему аккаунту присвоена роль «Пользователь»
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            <p>Теперь вы можете войти в систему со своим логином и паролем.</p>
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={() => navigate("/login")}>
              Войти
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Подтверждение email</CardTitle>
          <CardDescription>
            Мы отправили 6-значный код на вашу почту. Введите его, чтобы
            завершить регистрацию и получить роль «Пользователь». Код
            действителен 15 минут.
          </CardDescription>
          {resentFromRegistration && (
            <p className="text-sm pt-2 mb-[8px] text-green-700">
              Код отправлен повторно — предыдущая неподтверждённая регистрация
              заменена.
            </p>
          )}
        </CardHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Ваш email"
                {...register("email")}
              />
              {errors.email && (
                <p className="text-sm text-red-500">{errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2 mb-[16px]">
              <Label htmlFor="code">Код из письма</Label>
              <Input
                id="code"
                placeholder="000000"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                className="text-center text-lg tracking-[0.5em]"
                {...register("code")}
                onChange={(event) => {
                  const raw = event.target.value;
                  // Браузер может автозаполнить поле сохранённым email —
                  // оставляем только чистый ввод (до 6 цифр)
                  event.target.value = /^\d*$/.test(raw) ? raw.slice(0, 6) : "";
                  register("code").onChange(event);
                }}
              />
              {errors.code && (
                <p className="text-sm text-red-500">{errors.code.message}</p>
              )}
            </div>
            {error && (
              <p className="text-sm mb-[8px] text-red-500">{error}</p>
            )}
            {resendMessage && (
              <p className="text-sm mb-[8px] text-green-700">{resendMessage}</p>
            )}
            {resendError && (
              <p className="text-sm mb-[8px] text-red-500">{resendError}</p>
            )}
          </CardContent>
          <CardFooter className="flex flex-col space-y-2">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Проверяем код..." : "Подтвердить email"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={resendLoading || cooldown > 0}
              onClick={handleResend}
            >
              {cooldown > 0
                ? `Отправить код повторно (${cooldown} с)`
                : resendLoading
                  ? "Отправляем..."
                  : "Отправить код повторно"}
            </Button>
            <p className="text-sm text-muted-foreground">
              Уже подтвердили?{" "}
              <Link to="/login" className="text-blue-600 hover:underline">
                Войти
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
};