import { useState, useEffect } from "react";
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
import { forgotPassword, resetPassword } from "../../store/authSlice";
import { AppDispatch } from "../../store";

const requestSchema = z.object({
  email: z.string().email("Некорректный email"),
});

const resetSchema = z
  .object({
    email: z.string().email("Некорректный email"),
    code: z.string().regex(/^\d{6}$/, "Код состоит из 6 цифр"),
    newPassword: z.string().min(6, "Минимум 6 символов"),
    confirmPassword: z.string().min(6, "Минимум 6 символов"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Пароли не совпадают",
    path: ["confirmPassword"],
  });

type RequestFormValues = z.infer<typeof requestSchema>;
type ResetFormValues = z.infer<typeof resetSchema>;

const RESEND_COOLDOWN_SECONDS = 60;

const getServerMessage = (err: any, fallback: string) =>
  err?.response?.data?.error || err?.message || fallback;

export const ResetPassword = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialEmail = searchParams.get("email") || "";

  const [step, setStep] = useState<1 | 2>(1);
  const [currentEmail, setCurrentEmail] = useState(initialEmail);

  const [requestLoading, setRequestLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register: registerRequest,
    handleSubmit: handleRequestSubmit,
    formState: { errors: requestErrors },
  } = useForm<RequestFormValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: { email: initialEmail },
  });

  const {
    register: registerReset,
    handleSubmit: handleResetSubmit,
    setValue: setResetValue,
    formState: { errors: resetErrors },
  } = useForm<ResetFormValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: {
      email: initialEmail,
      code: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const onRequestCode = async (data: RequestFormValues) => {
    setRequestLoading(true);
    setRequestError(null);
    try {
      const res = await dispatch(forgotPassword({ email: data.email.trim() })).unwrap();
      setCurrentEmail(data.email.trim());
      setResetValue("email", data.email.trim());
      setCooldown(res.retryAfterSec ?? RESEND_COOLDOWN_SECONDS);
      setStep(2);
    } catch (err: any) {
      setRequestError(getServerMessage(err, "Ошибка запроса кода"));
    } finally {
      setRequestLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!currentEmail || cooldown > 0) return;
    setRequestLoading(true);
    setResetError(null);
    try {
      const res = await dispatch(forgotPassword({ email: currentEmail })).unwrap();
      setCooldown(res.retryAfterSec ?? RESEND_COOLDOWN_SECONDS);
    } catch (err: any) {
      setResetError(getServerMessage(err, "Ошибка повторной отправки"));
    } finally {
      setRequestLoading(false);
    }
  };

  const onResetPassword = async (data: ResetFormValues) => {
    setResetLoading(true);
    setResetError(null);
    try {
      await dispatch(
        resetPassword({
          code: data.code.trim(),
          newPassword: data.newPassword,
        })
      ).unwrap();
      setSuccess(true);
    } catch (err: any) {
      setResetError(getServerMessage(err, "Не удалось изменить пароль"));
    } finally {
      setResetLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-600">
              ✓
            </div>
            <CardTitle className="text-2xl">Пароль успешно изменён!</CardTitle>
            <CardDescription>
              Новый пароль сохранён. Теперь вы можете войти в систему.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button className="w-full" onClick={() => navigate("/login")}>
              Перейти к входу
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
          <CardTitle className="text-2xl">Сброс пароля</CardTitle>
          <CardDescription>
            {step === 1
              ? "Введите ваш email. Мы отправим вам 6-значный код для смены пароля."
              : `Введите код, отправленный на ${currentEmail}, и новый пароль.`}
          </CardDescription>
        </CardHeader>

        {step === 1 ? (
          <form onSubmit={handleRequestSubmit(onRequestCode)}>
            <CardContent className="space-y-4">
              <div className="space-y-2 mb-[16px]">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="example@mail.ru"
                  {...registerRequest("email")}
                />
                {requestErrors.email && (
                  <p className="text-sm text-red-500">
                    {requestErrors.email.message}
                  </p>
                )}
              </div>
              {requestError && (
                <p className="text-sm text-red-500">{requestError}</p>
              )}
            </CardContent>
            <CardFooter className="flex flex-col space-y-2">
              <Button type="submit" className="w-full" disabled={requestLoading}>
                {requestLoading ? "Отправляем..." : "Получить код для сброса"}
              </Button>
              <p className="text-sm text-muted-foreground text-center">
                Вспомнили пароль?{" "}
                <Link to="/login" className="text-blue-600 hover:underline">
                  Войти
                </Link>
              </p>
            </CardFooter>
          </form>
        ) : (
          <form onSubmit={handleResetSubmit(onResetPassword)}>
            <CardContent className="space-y-4 mb-[16px]">
              <div className="space-y-2">
                <Label htmlFor="resetCode">Код из письма</Label>
                <Input
                  id="resetCode"
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  className="text-center text-lg tracking-[0.5em]"
                  {...registerReset("code")}
                  onChange={(event) => {
                    const raw = event.target.value;
                    // Браузер может автозаполнить поле сохранённым email —
                    // оставляем только чистый ввод (до 6 цифр)
                    event.target.value = /^\d*$/.test(raw) ? raw.slice(0, 6) : "";
                    registerReset("code").onChange(event);
                  }}
                />
                {resetErrors.code && (
                  <p className="text-sm text-red-500">
                    {resetErrors.code.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="newPassword">Новый пароль</Label>
                <Input
                  id="newPassword"
                  type="password"
                  placeholder="Минимум 6 символов"
                  autoComplete="new-password"
                  {...registerReset("newPassword")}
                />
                {resetErrors.newPassword && (
                  <p className="text-sm text-red-500">
                    {resetErrors.newPassword.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Повторите новый пароль</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Повторите новый пароль"
                  autoComplete="new-password"
                  {...registerReset("confirmPassword")}
                />
                {resetErrors.confirmPassword && (
                  <p className="text-sm text-red-500">
                    {resetErrors.confirmPassword.message}
                  </p>
                )}
              </div>

              {resetError && (
                <p className="text-sm text-red-500">{resetError}</p>
              )}
            </CardContent>
            <CardFooter className="flex flex-col space-y-2">
              <Button type="submit" className="w-full" disabled={resetLoading}>
                {resetLoading ? "Сохраняем..." : "Сохранить новый пароль"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={requestLoading || cooldown > 0}
                onClick={handleResendCode}
              >
                {cooldown > 0
                  ? `Отправить код повторно (${cooldown} с)`
                  : requestLoading
                  ? "Отправляем..."
                  : "Отправить код повторно"}
              </Button>
              <div className="flex justify-between w-full text-xs text-muted-foreground pt-1">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-blue-600 hover:underline"
                >
                  ← Изменить email
                </button>
                <Link to="/login" className="text-blue-600 hover:underline">
                  Вернуться ко входу
                </Link>
              </div>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  );
};
