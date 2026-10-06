import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { adminApi, User } from "../../api/admin";
import { RootState } from "../../store";
import { RoleBadge, ROLE_LABELS } from "@/components/RoleBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isValidPhone, PHONE_FORMAT_HINT, EMAIL_FORMAT_RE } from "@/lib/utils";
import { PhoneInput } from "@/components/PhoneInput";

// Роли, доступные при создании аккаунта (god выдаётся только синхронизацией).
// Подписи ролей берутся из RoleBadge/ROLE_LABELS — единый источник.
const CREATE_ROLES = ["employee", "user", "moderator", "admin"] as const;
type CreateRole = (typeof CREATE_ROLES)[number];

const emptyCreateForm = {
  username: "",
  email: "",
  password: "",
  name: "",
  phone: "",
  capacity: "",
  role: "employee" as CreateRole,
};

// === Коэффициент заработка: поддерживаем оба разделителя "1.5" и "1,5" ===
// Приводим запятую к точке — Number() понимает только точку
const normalizeFactorSeparator = (value: string): string =>
  value.replace(",", ".");

// Живая маска при вводе: цифры, один разделитель, максимум 2 знака после него.
// Разрешает промежуточные состояния вида "123." / "123," — чтобы точка не
// «съедалась», как было с type="number" + parseFloat.
const FACTOR_LIVE_RE = /^\d+(\.\d{0,2})?$/;

// Строгая проверка на момент сохранения: положительное число > 0,
// до 2 знаков после запятой, пусто не принимается.
const parseFactorValue = (
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "Укажите коэффициент" };
  }
  const normalized = normalizeFactorSeparator(trimmed);
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return {
      ok: false,
      error: "Положительное число, максимум 2 знака после запятой: 1.5 или 1,5",
    };
  }
  const n = Number(normalized);
  if (!(n > 0)) {
    return { ok: false, error: "Коэффициент должен быть больше 0" };
  }
  return { ok: true, value: n };
};

// === Количество принтеров: целое положительное число ===
// Живая маска при вводе: только цифры
const CAPACITY_LIVE_RE = /^\d+$/;

// Строгая проверка на момент сохранения: целое положительное, пусто не принимается
const parseCapacityValue = (
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "Укажите количество принтеров" };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "Целое положительное число принтеров" };
  }
  const n = Number(trimmed);
  if (n < 1) {
    return { ok: false, error: "Количество принтеров должно быть ≥ 1" };
  }
  return { ok: true, value: n };
};

export const Users = () => {
  // Текущий пользователь: определяет, может ли он редактировать Создателя
  const viewer = useSelector((state: RootState) => state.auth.user);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  // Текстовое состояние коэффициента: инпут переведён на type="text" и
  // управляется строкой, чтобы ввод вида "123." / "123," не «затирался»,
  // как было с type="number" + parseFloat
  const [factorInput, setFactorInput] = useState("");
  const [factorError, setFactorError] = useState("");
  // Текстовое состояние количества принтеров (type="text") — чтобы ввод не
  // «затирался», как с type="number" + parseInt
  const [capacityInput, setCapacityInput] = useState("");
  const [capacityError, setCapacityError] = useState("");
  const [showFired, setShowFired] = useState(false);
  // Вид таблицы: «staff» — сотрудники и уволенные ex-сотрудники (прежняя
  // таблица), «users» — зарегистрировавшиеся, но ещё НИКОГДА не бывшие
  // сотрудниками (разделены через was_employee на сервере)
  const [view, setView] = useState<"staff" | "users">("staff");

  // === Создание аккаунта администратором (без email-подтверждения) ===
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});

  // === Синхронизация из серверного team-info.xlsx (кнопка «Обновить») ===
  const [syncing, setSyncing] = useState(false);

  // === Синхронизация из загруженного файла team-info (карточка под таблицей) ===
  // Жёсткая проверка имени файла: принимается только актуальный версионированный
  // team-info[-<версия>].xlsx — как на странице «Материалы»
  const [teamFile, setTeamFile] = useState<File | null>(null);
  const [uploadingTeamFile, setUploadingTeamFile] = useState(false);
  // Актуальное имя файла сотрудников (приходит с сервера, зависит от BOT_VERSION)
  const [expectedTeamFileName, setExpectedTeamFileName] = useState("");

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getUsers({
        // Вкладка «Пользователи»: зарегистрированные, ещё НИКОГДА не бывшие
        // сотрудниками (cohort='users') + гости (неподтверждённые
        // регистрации — админ видит попытки, гость удалится сам через 24 ч).
        // «Показывать уволенных» имеет смысл только для вкладки
        // «Сотрудники» (cohort='staff')
        includeFired: view === "staff" ? showFired : false,
        includeAll: true,
        cohort: view,
      });
      setUsers(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить пользователей");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [view, showFired]);

  // Кнопка «Обновить»: сначала синхронизация из серверного team-info.xlsx
  // (подтягивает данные сотрудников из Excel и выдаёт роль 👻 Создателя по
  // GOD_EMAIL/GOD_ID из .env), затем перезагрузка списка
  const handleRefresh = async () => {
    setSyncing(true);
    try {
      const result = await adminApi.syncFromServerFile();
      toast.success(
        `Синхронизация выполнена: обновлено ${result.updated}, создано ${result.created}, пропущено ${result.skipped}${result.fired ? `, уволено ${result.fired}` : ""}`,
      );
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err?.message || "Ошибка синхронизации",
      );
    } finally {
      setSyncing(false);
      loadUsers();
    }
  };

  // Актуальное (версионированное) имя файла сотрудников: как в «Материалах»,
  // сервер сообщает его сам, клиент сверяет с ним имя выбранного файла
  useEffect(() => {
    adminApi
      .getExpectedTeamInfoFileName()
      .then((res) => setExpectedTeamFileName(res.fileName || ""))
      .catch(() => {
        // Не критично: при загрузке сработает запасная проверка
        // team-info[-<версия>].xlsx, как у старого бэкенда в «Материалах»
      });
  }, []);

  // === Загрузка файла сотрудников с последующей синхронизацией ===
  const handleTeamFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setTeamFile(e.target.files[0]);
    }
  };

  // Строгое совпадение имени с актуальным версионированным файлом
  const teamFileNameMismatch =
    teamFile !== null &&
    expectedTeamFileName !== "" &&
    teamFile.name !== expectedTeamFileName;

  const handleSyncFromFile = async () => {
    if (!teamFile) {
      toast.error("Выберите файл");
      return;
    }
    // Жёсткая проверка имени: только актуальный версионированный файл
    if (teamFileNameMismatch) {
      toast.error(
        `Неверное имя файла: "${teamFile.name}". Ожидается "${expectedTeamFileName}"`,
      );
      return;
    }
    // Запасная проверка, если сервер не сообщил имя (старый бэкенд)
    if (
      !expectedTeamFileName &&
      !/^team-info(-\d+)?\.xlsx$/.test(teamFile.name)
    ) {
      toast.error(
        "Неверное имя файла: ожидается team-info.xlsx или team-info-<версия>.xlsx",
      );
      return;
    }
    setUploadingTeamFile(true);
    try {
      // Тот же syncBy=email, что и у кнопки «Обновить» — файл сначала
      // сохраняется на сервере, затем идёт синхронизация из него
      const result = await adminApi.syncEmployeesFile(teamFile);
      toast.success(
        `Синхронизация выполнена: обновлено ${result.updated}, создано ${result.created}, пропущено ${result.skipped}${result.fired ? `, уволено ${result.fired}` : ""}`,
      );
      setTeamFile(null);
      // Сбросить input
      const input = document.getElementById(
        "team-file-upload",
      ) as HTMLInputElement | null;
      if (input) input.value = "";
      loadUsers(); // перезагрузить список
    } catch (err: any) {
      // Ошибки бэкенда: 400 (неверное имя/файл) и прочие ошибки синхронизации
      toast.error(
        err?.response?.data?.error || err?.message || "Ошибка синхронизации",
      );
    } finally {
      setUploadingTeamFile(false);
    }
  };

  // Коэффициент: живая обработка ввода. Оставляем только цифры и разделители,
  // по мере набора показываем ошибку, если структура невалидна
  const handleFactorChange = (raw: string) => {
    // Очистка: убираем всё, кроме цифр, точки и запятой
    const sanitized = raw.replace(/[^\d.,]/g, "");
    setFactorInput(sanitized);

    if (sanitized === "") {
      setFactorError("");
      return;
    }
    if (FACTOR_LIVE_RE.test(normalizeFactorSeparator(sanitized))) {
      setFactorError("");
      const parsed = Number(normalizeFactorSeparator(sanitized));
      if (Number.isFinite(parsed)) {
        // Поддерживаем editingUser в актуальном состоянии при валидном вводе
        setEditingUser((prev) =>
          prev ? { ...prev, earnings_factor: parsed } : prev,
        );
      }
    } else {
      setFactorError(
        "Положительное число, максимум 2 знака после запятой: 1.5 или 1,5",
      );
    }
  };

  // Принтеры: живая обработка ввода. Только цифры, по мере набора проверяем валидность
  const handleCapacityChange = (raw: string) => {
    const sanitized = raw.replace(/\D/g, "");
    setCapacityInput(sanitized);

    if (sanitized === "") {
      setCapacityError("");
      return;
    }
    if (CAPACITY_LIVE_RE.test(sanitized)) {
      setCapacityError("");
      const parsed = Number(sanitized);
      if (Number.isInteger(parsed)) {
        setEditingUser((prev) => (prev ? { ...prev, capacity: parsed } : prev));
      }
    } else {
      setCapacityError("Целое положительное число принтеров");
    }
  };

  const handleUpdateUser = async (user: User) => {
    // Валидация количества принтеров: целое положительное
    const capacity = parseCapacityValue(capacityInput);
    if (!capacity.ok) {
      setCapacityError(capacity.error);
      toast.error(capacity.error);
      return;
    }
    // Валидация коэффициента: формат "1.5" / "1,5", положительное,
    // максимум 2 знака после запятой
    const factor = parseFactorValue(factorInput);
    if (!factor.ok) {
      setFactorError(factor.error);
      toast.error(factor.error);
      return;
    }
    // Валидация телефона: если указан — ровно 11 цифр
    if (user.phone && user.phone.trim() !== "" && !isValidPhone(user.phone)) {
      toast.error(
        "Телефон должен содержать ровно 11 цифр в формате +7 (999) 999-99-99",
      );
      return;
    }
    try {
      // Роль Создателя управляется только синхронизацией из Excel —
      // не отправляем её на сервер при редактировании
      const payload = {
        ...user,
        capacity: capacity.value,
        earnings_factor: factor.value, // берём из текстового ввода (был провалидирован выше)
      };
      if (payload.role === "god") delete (payload as Partial<User>).role;
      await adminApi.updateUser(user.id, payload);
      toast.success(`Пользователь ${user.name} обновлён`);
      loadUsers();
      setEditingUser(null);
    } catch (err: any) {
      toast.error(err.message || "Ошибка обновления");
    }
  };

  const handleFireUser = async (id: number) => {
    if (!confirm("Уволить пользователя?")) return;
    try {
      await adminApi.deleteUser(id);
      toast.success("Пользователь уволен");
      loadUsers();
    } catch (err: any) {
      toast.error(err.message || "Ошибка увольнения");
    }
  };

  const handleRestoreUser = async (user: User) => {
    if (!confirm(`Восстановить пользователя ${user.name}?`)) return;
    try {
      await adminApi.updateUser(user.id, {
        is_fired: false,
        taking_orders: true,
        role: "employee",
      });
      toast.success(`Пользователь ${user.name} восстановлен`);
      loadUsers();
    } catch (err: any) {
      toast.error(err.message || "Ошибка восстановления");
    }
  };

  // Принять «обычного пользователя» (вкладка «Пользователи») в сотрудники —
  // ручное подтверждение: роль employee + активность, как при восстановлении.
  // На сервере это выставляет was_employee = 1 — пользователь переходит
  // из вкладки «Пользователи» во вкладку «Сотрудники»
  const handlePromoteUser = async (user: User) => {
    if (!confirm(`Принять ${user.name} в сотрудники?`)) return;
    try {
      await adminApi.updateUser(user.id, {
        role: "employee",
        is_fired: false,
        taking_orders: true,
      });
      toast.success(`${user.name} принят(а) в сотрудники`);
      loadUsers();
    } catch (err: any) {
      toast.error(err.message || "Ошибка принятия в сотрудники");
    }
  };

  const handleCreateUser = async () => {
    // Клиентская валидация (мягкие правила админ-регистрации):
    // логин/пароль от 1 символа, email — формат, capacity — целое >= 1
    const errors: Record<string, string> = {};
    if (!createForm.username.trim()) errors.username = "Укажите логин";
    if (!EMAIL_FORMAT_RE.test(createForm.email.trim()))
      errors.email =
        "Некорректный email (только латиница, цифры и символы ._%+-)";
    if (!createForm.password) errors.password = "Укажите пароль";
    if (createForm.capacity.trim() !== "") {
      const n = Number(createForm.capacity);
      if (!Number.isInteger(n) || n < 1)
        errors.capacity = "Целое положительное число (пусто — 1)";
    }
    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setCreating(true);
    try {
      const result = await adminApi.createUser({
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        password: createForm.password,
        name: createForm.name.trim() || undefined,
        phone: createForm.phone.trim() || undefined,
        capacity:
          createForm.capacity.trim() !== ""
            ? Number(createForm.capacity)
            : undefined,
        role: createForm.role,
      });
      toast.success(result.message || `Аккаунт ${createForm.username} создан`);
      loadUsers();
      setShowCreate(false);
      setCreateForm({ ...emptyCreateForm });
      setCreateErrors({});
    } catch (err: any) {
      // Ошибки бэкенда: 400 (валидация) / 409 (занят логин или email)
      setCreateErrors({
        _server:
          err?.response?.data?.error ||
          err?.message ||
          "Ошибка создания аккаунта",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Верхний ряд: заголовок + остальные кнопки */}
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold">
          {" "}
          <span className="inline-block align-middle -translate-y-[5px]">
            👥
          </span>{" "}
          Пользователи
        </h1>

        <div className="flex flex-col items-center gap-2 sm:flex-row">
          {view === "staff" && (
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={showFired}
                onChange={(e) => setShowFired(e.target.checked)}
              />
              Показывать уволенных
            </label>
          )}
          <Button
            size="sm"
            onClick={() => {
              setCreateErrors({});
              setShowCreate(true);
            }}
          >
            ➕ Создать аккаунт
          </Button>
          <Button onClick={handleRefresh} disabled={loading || syncing}>
            {syncing ? "🔄 Синхронизация..." : "🔄 Обновить"}
          </Button>
        </div>
      </div>

      {/* Переключатель вида таблицы — отдельным блоком ниже, по центру */}
      <div className="flex justify-center mt-3 px-2">
        <div
          className="
      flex flex-col sm:flex-row
      items-stretch sm:items-center
      gap-1
      rounded-lg border p-1
      w-full max-w-[10rem] sm:w-auto sm:max-w-none
    "
        >
          <Button
            size="sm"
            variant={view === "staff" ? "default" : "ghost"}
            onClick={() => setView("staff")}
            className="justify-center"
            title="Сотрудники"
          >
            <span aria-hidden="true">👷</span>
            <span className="hidden sm:inline ml-1">Сотрудники</span>
          </Button>
          <Button
            size="sm"
            variant={view === "users" ? "default" : "ghost"}
            onClick={() => setView("users")}
            className="justify-center"
            title="Пользователи"
          >
            <span
              className="inline-block align-middle -translate-y-[1px]"
              aria-hidden="true"
            >
              👥
            </span>
            <span className="hidden sm:inline ml-1">Пользователи</span>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Два вида таблицы (переключатель в шапке): «Сотрудники» — прежняя
              таблица (уволенные по галочке); «Пользователи» — зарегистриро-
              вавшиеся, ещё не ставшие сотрудниками. Адаптив (скрытые колонки
              на маленьких экранах) сохранён в обеих */}
          {view === "staff" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center hidden md:table-cell">
                    ID
                  </TableHead>
                  <TableHead className="text-center">Имя</TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    Логин
                  </TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    Email
                  </TableHead>
                  <TableHead className="text-center">Роль</TableHead>
                  <TableHead className="text-center">Принтеры</TableHead>
                  <TableHead className="text-center">Коэф.</TableHead>
                  <TableHead className="text-center">Статус</TableHead>
                  <TableHead className="text-center">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center">
                      Загрузка...
                    </TableCell>
                  </TableRow>
                ) : users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center">
                      Нет сотрудников
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
                    <TableRow
                      key={user.id}
                      className={user.is_fired ? "opacity-50" : ""}
                    >
                      <TableCell className="text-center hidden md:table-cell">
                        <code>{user.id}</code>
                      </TableCell>
                      <TableCell className="text-center">
                        <b>{user.name}</b>
                      </TableCell>
                      <TableCell className="text-center hidden md:table-cell">
                        {user.username}
                      </TableCell>
                      <TableCell className="text-center hidden md:table-cell">
                        {user.email}
                      </TableCell>
                      <TableCell className="text-center">
                        {/* Стили ролей — единый RoleBadge; персоналу добавляем жирность */}
                        <RoleBadge
                          role={user.role}
                          className={`font-normal ${
                            ["admin", "moderator", "god"].includes(user.role)
                              ? "font-bold"
                              : ""
                          }`}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        {user.capacity}
                      </TableCell>
                      <TableCell className="text-center">
                        {user.earnings_factor}
                      </TableCell>
                      <TableCell className="text-center">
                        {user.is_fired ? (
                          <Badge variant="destructive">Уволен</Badge>
                        ) : user.taking_orders ? (
                          <Badge variant="default">Принимает</Badge>
                        ) : (
                          <Badge variant="secondary">Не принимает</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center space-x-1">
                        {/* Создателя может редактировать только Создатель:
                          остальным ролям кнопки не показываются */}
                        {user.role !== "god" || viewer?.role === "god" ? (
                          <>
                            <Dialog
                              open={editingUser?.id === user.id}
                              onOpenChange={(open) => {
                                if (!open) {
                                  setFactorError("");
                                  setCapacityError("");
                                  setEditingUser(null);
                                }
                              }}
                            >
                              <DialogTrigger
                                render={
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      setFactorInput(
                                        String(user.earnings_factor),
                                      );
                                      setFactorError("");
                                      setCapacityInput(
                                        user.capacity == null
                                          ? ""
                                          : String(user.capacity),
                                      );
                                      setCapacityError("");
                                      setEditingUser(user);
                                    }}
                                  />
                                }
                              >
                                ✏️
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>
                                    Редактировать пользователя
                                  </DialogTitle>
                                </DialogHeader>
                                {editingUser && (
                                  <div className="space-y-4 py-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                      <div className="space-y-2">
                                        <Label>Имя</Label>
                                        <Input
                                          value={editingUser.name}
                                          onChange={(e) =>
                                            setEditingUser({
                                              ...editingUser,
                                              name: e.target.value,
                                            })
                                          }
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <Label>Телефон</Label>
                                        <PhoneInput
                                          placeholder="+7 (999) 999-99-99"
                                          value={editingUser.phone || ""}
                                          onValueChange={(formatted) =>
                                            setEditingUser({
                                              ...editingUser,
                                              phone: formatted,
                                            })
                                          }
                                        />
                                        <p className="text-xs text-muted-foreground">
                                          {PHONE_FORMAT_HINT}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                      <div className="space-y-2">
                                        <Label>Принтеры</Label>
                                        <Input
                                          type="text"
                                          inputMode="numeric"
                                          placeholder="Например: 2"
                                          value={capacityInput}
                                          onChange={(e) =>
                                            handleCapacityChange(e.target.value)
                                          }
                                        />
                                        {capacityError ? (
                                          <p className="text-sm text-red-500">
                                            {capacityError}
                                          </p>
                                        ) : (
                                          <p className="text-xs text-muted-foreground">
                                            Целое положительное число принтеров
                                          </p>
                                        )}
                                      </div>
                                      <div className="space-y-2">
                                        <Label>Коэффициент</Label>
                                        <Input
                                          type="text"
                                          inputMode="decimal"
                                          placeholder="Например: 1.5 или 1,5"
                                          value={factorInput}
                                          onChange={(e) =>
                                            handleFactorChange(e.target.value)
                                          }
                                        />
                                        {factorError ? (
                                          <p className="text-sm text-red-500">
                                            {factorError}
                                          </p>
                                        ) : (
                                          <p className="text-xs text-muted-foreground">
                                            Положительное число, до 2 знаков
                                            после запятой: 1.5 или 1,5
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                      <div className="space-y-2">
                                        <Label>Роль</Label>
                                        {/* Роль Создателя нельзя изменить вручную —
                                      только синхронизацией из Excel */}
                                        {editingUser.role === "god" ? (
                                          <Input
                                            value="👻 Создатель (изменение недоступно)"
                                            disabled
                                          />
                                        ) : (
                                          <Select
                                            value={editingUser.role}
                                            onValueChange={(val) => {
                                              const role = val as User["role"];
                                              setEditingUser((prev) => {
                                                if (!prev) return prev;
                                                // Роль «Пользователь» = вывод из активного состава:
                                                // автоматически помечаем уволенным и выключаем
                                                // приём заказов (аналог кнопки «🗑️ Уволить»)
                                                if (role === "user") {
                                                  return {
                                                    ...prev,
                                                    role,
                                                    is_fired: true,
                                                    taking_orders: false,
                                                  };
                                                }
                                                // Обратно: сотрудник/модератор/админ —
                                                // автоматически восстанавливаем, если был уволен
                                                return {
                                                  ...prev,
                                                  role,
                                                  is_fired: false,
                                                  taking_orders: true,
                                                };
                                              });
                                            }}
                                          >
                                            <SelectTrigger>
                                              <SelectValue>
                                                {(val) =>
                                                  ROLE_LABELS[String(val)] ??
                                                  String(val)
                                                }
                                              </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="user">
                                                Пользователь
                                              </SelectItem>
                                              <SelectItem value="employee">
                                                Сотрудник
                                              </SelectItem>
                                              <SelectItem value="moderator">
                                                Модератор
                                              </SelectItem>
                                              <SelectItem value="admin">
                                                Администратор
                                              </SelectItem>
                                            </SelectContent>
                                          </Select>
                                        )}
                                        {/* Связка роли и статуса: Пользователь = уволен */}
                                        {editingUser.role === "user" ? (
                                          <p className="text-xs text-red-500">
                                            Роль «Пользователь» = сотрудник
                                            выведен из состава: статус станет
                                            «Уволен»
                                          </p>
                                        ) : (
                                          <p className="text-xs text-muted-foreground">
                                            При выборе этой роли сотрудник
                                            автоматически восстанавливается из
                                            уволенных
                                          </p>
                                        )}
                                      </div>
                                      <div className="space-y-2">
                                        <Label>Приём заказов</Label>
                                        <Select
                                          value={
                                            editingUser.taking_orders
                                              ? "true"
                                              : "false"
                                          }
                                          onValueChange={(val) =>
                                            setEditingUser({
                                              ...editingUser,
                                              taking_orders: val === "true",
                                            })
                                          }
                                        >
                                          <SelectTrigger>
                                            <SelectValue>
                                              {(val) =>
                                                String(val) === "true"
                                                  ? "Принимает"
                                                  : "Не принимает"
                                              }
                                            </SelectValue>
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="true">
                                              Принимает
                                            </SelectItem>
                                            <SelectItem value="false">
                                              Не принимает
                                            </SelectItem>
                                          </SelectContent>
                                        </Select>
                                      </div>
                                    </div>
                                    <div className="flex justify-end gap-2 pt-4">
                                      <Button
                                        variant="outline"
                                        onClick={() => setEditingUser(null)}
                                      >
                                        Отмена
                                      </Button>
                                      <Button
                                        onClick={() =>
                                          handleUpdateUser(editingUser)
                                        }
                                      >
                                        Сохранить
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </DialogContent>
                            </Dialog>
                            {user.is_fired ? (
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => handleRestoreUser(user)}
                              >
                                🔄 Восстановить
                              </Button>
                            ) : (
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => handleFireUser(user.id)}
                              >
                                🗑️
                              </Button>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-halloween-text">
                            👻 Только Создатель
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center hidden md:table-cell">
                    ID
                  </TableHead>
                  <TableHead className="text-center">Имя</TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    Логин
                  </TableHead>
                  <TableHead className="text-center">Email</TableHead>
                  <TableHead className="text-center">Роль</TableHead>
                  <TableHead className="text-center">Статус</TableHead>
                  <TableHead className="text-center hidden lg:table-cell">
                    Регистрация
                  </TableHead>
                  <TableHead className="text-center">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center">
                      Загрузка...
                    </TableCell>
                  </TableRow>
                ) : users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center">
                      Пока нет зарегистрированных пользователей
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
                    <TableRow
                      key={user.id}
                      // Гость — регистрация не завершена, запись временная
                      // (удалится сама через GUEST_TTL_HOURS): вся строка
                      // приглушена, как уволенные в таблице «Сотрудники»
                      className={user.role === "guest" ? "opacity-50" : ""}
                    >
                      <TableCell className="text-center hidden md:table-cell">
                        <code>{user.id}</code>
                      </TableCell>
                      <TableCell className="text-center">
                        <b>{user.name}</b>
                      </TableCell>
                      <TableCell className="text-center hidden md:table-cell">
                        {user.username}
                      </TableCell>
                      <TableCell className="text-center break-all">
                        {user.email}
                      </TableCell>
                      <TableCell className="text-center">
                        {/* Стили ролей — единый RoleBadge (guest → «⏳ Гость») */}
                        <RoleBadge role={user.role} className="font-normal" />
                      </TableCell>
                      <TableCell className="text-center">
                        {/* Гость — регистрация не завершена (email не подтверждён,
                            удалится автоматически через GUEST_TTL_HOURS) */}
                        {user.role === "guest" ? (
                          <Badge
                            variant="outline"
                            className="border-dashed text-muted-foreground"
                          >
                            ⏳ Регистрация не завершена
                          </Badge>
                        ) : user.email_verified ? (
                          <Badge variant="secondary">
                            ✅ Email подтверждён
                          </Badge>
                        ) : (
                          <Badge variant="outline">⏳ Не подтверждён</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center hidden lg:table-cell">
                        {new Date(user.created_at).toLocaleDateString("ru-RU")}
                      </TableCell>
                      <TableCell className="text-center space-x-1">
                        {/* Ручное подтверждение в сотрудники: сервер выставит
                            was_employee — пользователь перейдёт во вкладку
                            «Сотрудники» */}
                        <Button
                          size="sm"
                          onClick={() => handlePromoteUser(user)}
                        >
                          ✅ В сотрудники
                        </Button>
                        <Dialog
                          open={editingUser?.id === user.id}
                          onOpenChange={(open) => {
                            if (!open) {
                              setFactorError("");
                              setCapacityError("");
                              setEditingUser(null);
                            }
                          }}
                        >
                          <DialogTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setFactorInput(String(user.earnings_factor));
                                  setFactorError("");
                                  setCapacityInput(
                                    user.capacity == null
                                      ? ""
                                      : String(user.capacity),
                                  );
                                  setCapacityError("");
                                  setEditingUser(user);
                                }}
                              />
                            }
                          >
                            ✏️
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>
                                Редактировать пользователя
                              </DialogTitle>
                            </DialogHeader>
                            {editingUser && (
                              <div className="space-y-4 py-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                  <div className="space-y-2">
                                    <Label>Имя</Label>
                                    <Input
                                      value={editingUser.name}
                                      onChange={(e) =>
                                        setEditingUser({
                                          ...editingUser,
                                          name: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Телефон</Label>
                                    <PhoneInput
                                      placeholder="+7 (999) 999-99-99"
                                      value={editingUser.phone || ""}
                                      onValueChange={(formatted) =>
                                        setEditingUser({
                                          ...editingUser,
                                          phone: formatted,
                                        })
                                      }
                                    />
                                    <p className="text-xs text-muted-foreground">
                                      {PHONE_FORMAT_HINT}
                                    </p>
                                  </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                  <div className="space-y-2">
                                    <Label>Принтеры</Label>
                                    <Input
                                      type="text"
                                      inputMode="numeric"
                                      placeholder="Например: 2"
                                      value={capacityInput}
                                      onChange={(e) =>
                                        handleCapacityChange(e.target.value)
                                      }
                                    />
                                    {capacityError ? (
                                      <p className="text-sm text-red-500">
                                        {capacityError}
                                      </p>
                                    ) : (
                                      <p className="text-xs text-muted-foreground">
                                        Целое положительное число принтеров
                                      </p>
                                    )}
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Коэффициент</Label>
                                    <Input
                                      type="text"
                                      inputMode="decimal"
                                      placeholder="Например: 1.5 или 1,5"
                                      value={factorInput}
                                      onChange={(e) =>
                                        handleFactorChange(e.target.value)
                                      }
                                    />
                                    {factorError ? (
                                      <p className="text-sm text-red-500">
                                        {factorError}
                                      </p>
                                    ) : (
                                      <p className="text-xs text-muted-foreground">
                                        Положительное число, до 2 знаков после
                                        запятой: 1.5 или 1,5
                                      </p>
                                    )}
                                  </div>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  Роль меняется кнопкой «✅ В сотрудники» —
                                  пользователь станет сотрудником и появится во
                                  вкладке «Сотрудники».
                                </p>
                                <div className="flex justify-end gap-2 pt-4">
                                  <Button
                                    variant="outline"
                                    onClick={() => setEditingUser(null)}
                                  >
                                    Отмена
                                  </Button>
                                  <Button
                                    onClick={() =>
                                      handleUpdateUser(editingUser)
                                    }
                                  >
                                    Сохранить
                                  </Button>
                                </div>
                              </div>
                            )}
                          </DialogContent>
                        </Dialog>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Синхронизация из загруженного файла сотрудников (под таблицей).
          Стили формы — как на странице «Материалы», выравнивание по центру */}
      <Card>
        <CardHeader>
          <CardTitle>🔄 Синхронизация из файла сотрудников</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="mx-auto w-full max-w-2xl">
            <Label
              className="mb-[10px] block cursor-pointer text-center"
              htmlFor="team-file-upload"
            >
              Файл сотрудников (ожидается{" "}
              {expectedTeamFileName || "team-info.xlsx"})
            </Label>
            <Input
              id="team-file-upload"
              type="file"
              accept=".xlsx"
              onChange={handleTeamFileChange}
              className="m-0 p-0 items-center file:h-full file:mr-4 file:px-3 file:rounded-lg file:border-0 file:bg-primary file:text-primary-foreground file:font-semibold file:cursor-pointer file:hover:bg-primary/90 hover:border-primary/60 cursor-pointer transition-all hover:bg-input/50 active:scale-[0.98]"
            />
            {teamFile ? (
              <p className="text-sm text-muted-foreground mt-2 flex items-center justify-center gap-2">
                <span className="text-foreground font-medium">Выбран:</span>{" "}
                <div>
                  <span className="font-mono text-xs break-all">
                    {teamFile.name}
                  </span>
                </div>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground mt-2 text-center">
                Файл не выбран
              </p>
            )}
            {teamFileNameMismatch && (
              <p className="text-xs text-red-500 mt-1 text-center">
                ⚠️ Имя файла не совпадает с актуальным: {expectedTeamFileName}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Загрузите актуальный {expectedTeamFileName || "team-info.xlsx"} —
              синхронизация выполнится по email (как кнопка «Обновить»):
              обновляются состав сотрудников, список складов и приоритеты.
            </p>
          </div>
          <div className="flex justify-center">
            <Button
              onClick={handleSyncFromFile}
              disabled={!teamFile || uploadingTeamFile || teamFileNameMismatch}
              /* max-w-full не дает кнопке вылезать за пределы экрана, а w-full растягивает в пределах контейнера */
              className="md:w-auto w-full max-w-[340px] md:max-w-none"
            >
              {uploadingTeamFile ? (
                "Синхронизация..."
              ) : (
                /* Оборачиваем текст в span с классом truncate */
                <span className="truncate block w-full text-center">
                  📤 Загрузить {expectedTeamFileName || "team-info.xlsx"}
                </span>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Создание аккаунта администратором (в обход email-подтверждения) */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) setShowCreate(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Создать аккаунт</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Аккаунт создаётся сразу подтверждённым — без письма с кодом
              подтверждения. Логин и email должны быть уникальными.
            </p>
            <div className="space-y-2">
              <Label htmlFor="create-username">Логин *</Label>
              <Input
                id="create-username"
                placeholder="Минимум 1 символ"
                value={createForm.username}
                onChange={(e) =>
                  setCreateForm({ ...createForm, username: e.target.value })
                }
              />
              {createErrors.username && (
                <p className="text-sm text-red-500">{createErrors.username}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-email">Email *</Label>
              <Input
                id="create-email"
                type="email"
                placeholder="user@example.com"
                value={createForm.email}
                onChange={(e) =>
                  setCreateForm({ ...createForm, email: e.target.value })
                }
              />
              {createErrors.email && (
                <p className="text-sm text-red-500">{createErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-password">Пароль *</Label>
              <Input
                id="create-password"
                type="password"
                autoComplete="new-password"
                placeholder="Минимум 1 символ"
                value={createForm.password}
                onChange={(e) =>
                  setCreateForm({ ...createForm, password: e.target.value })
                }
              />
              {createErrors.password && (
                <p className="text-sm text-red-500">{createErrors.password}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-name">Имя</Label>
              <Input
                id="create-name"
                placeholder="По умолчанию — логин"
                value={createForm.name}
                onChange={(e) =>
                  setCreateForm({ ...createForm, name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-phone">Телефон</Label>
              <PhoneInput
                id="create-phone"
                inputMode="tel"
                placeholder="+7 (999) 999-99-99"
                value={createForm.phone}
                onValueChange={(formatted) =>
                  setCreateForm({ ...createForm, phone: formatted })
                }
              />
              <p className="text-xs text-muted-foreground">
                {PHONE_FORMAT_HINT}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-capacity">Количество принтеров</Label>
              <Input
                id="create-capacity"
                type="number"
                placeholder="1"
                value={createForm.capacity}
                onChange={(e) =>
                  setCreateForm({ ...createForm, capacity: e.target.value })
                }
              />
              {createErrors.capacity ? (
                <p className="text-sm text-red-500">{createErrors.capacity}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Целое положительное число, без ограничения сверху. По
                  умолчанию — 1.
                </p>
              )}
            </div>
            <div className="space-y-3">
              <Label>Роль</Label>
              <Select
                value={createForm.role}
                onValueChange={(val) =>
                  setCreateForm({ ...createForm, role: val as CreateRole })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Роль 👻 Создатель выдаётся только синхронизацией.
              </p>
            </div>
            {createErrors._server && (
              <p className="text-sm text-red-500">{createErrors._server}</p>
            )}
            <div className="flex flex-col-reverse justify-end gap-2 pt-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setShowCreate(false)}
                disabled={creating}
              >
                Отмена
              </Button>
              <Button onClick={handleCreateUser} disabled={creating}>
                {creating ? "Создание..." : "Создать"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
