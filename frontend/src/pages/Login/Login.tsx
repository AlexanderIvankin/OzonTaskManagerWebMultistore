import { useState } from "react";
import { useDispatch } from "react-redux";
import { Link, useNavigate } from "react-router-dom";
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
import { login } from "../../store/authSlice";
import { AppDispatch } from "../../store";

const loginSchema = z.object({
  usernameOrEmail: z.string().min(1, "Введите логин или email"),
  password: z.string().min(1, "Введите пароль"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export const Login = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Email аккаунта, которому нужно подтвердить почту (для ссылки на /verify-email)
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormValues) => {
    setLoading(true);
    setError(null);
    setUnverifiedEmail(null);
    try {
      const result = await dispatch(login(data)).unwrap();
      // result содержит { user, accessToken, refreshToken }
      // Модератор = Администратор, Создатель тоже попадает в админку
      if (["admin", "moderator", "god"].includes(result.user.role)) {
        navigate("/admin");
      } else if (result.user.role === "employee") {
        navigate("/orders");
      } else {
        navigate("/profile");
      }
    } catch (err: any) {
      if (err?.response?.data?.code === "EMAIL_NOT_VERIFIED") {
        setError(err?.response?.data?.error || "Email не подтверждён. Введите код из письма.");
        // Подставляем email в ссылку подтверждения, только если введён именно email
        const raw = data.usernameOrEmail?.trim() || "";
        setUnverifiedEmail(raw.includes("@") ? raw : "");
      } else {
        setError(err?.response?.data?.error || err?.message || "Ошибка входа");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Вход в систему</CardTitle>
          <CardDescription>
            Введите свои учетные данные для доступа
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="usernameOrEmail">Логин или Email</Label>
              <Input
                id="usernameOrEmail"
                placeholder="Введите логин или email"
                autoComplete="username"
                {...register("usernameOrEmail")}
              />
              {errors.usernameOrEmail && (
                <p className="text-sm mb-[15px] text-red-500">
                  {errors.usernameOrEmail.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                type="password"
                placeholder="Введите пароль"
                autoComplete="current-password"
                {...register("password")}
              />
              {errors.password && (
                <p className="text-sm mb-[15px] text-red-500">
                  {errors.password.message}
                </p>
              )}
            </div>
              <div className="flex justify-end mb-[16px]">
                <Link
                  to={`/reset-password${
                    getValues("usernameOrEmail")?.includes("@")
                      ? `?email=${encodeURIComponent(getValues("usernameOrEmail").trim())}`
                      : ""
                  }`}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Забыли пароль?
                </Link>
              </div>

            {error && <p className="text-sm mb-[15px] text-red-500">{error}</p>}
            {unverifiedEmail !== null && (
              <p className="text-sm mb-[15px]">
                <Link
                  to={`/verify-email${
                    unverifiedEmail ? `?email=${encodeURIComponent(unverifiedEmail)}` : ""
                  }`}
                  className="text-blue-600 hover:underline"
                >
                  Перейти к подтверждению email →
                </Link>
              </p>
            )}
          </CardContent>
          <CardFooter className="flex flex-col space-y-2">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Загрузка..." : "Войти"}
            </Button>
            <p className="text-sm text-muted-foreground">
              Нет аккаунта?{" "}
              <Link to="/register" className="text-blue-600 hover:underline">
                Зарегистрироваться
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
};
