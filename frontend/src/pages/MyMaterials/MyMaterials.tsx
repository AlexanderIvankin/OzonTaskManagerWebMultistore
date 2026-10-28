import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useSelector } from "react-redux";
import { RootState } from "../../store";
import { buildCrossOriginUrl, getRootOrigin } from "../../lib/urls";
import { userApi, MyMaterialsResponse } from "../../api/user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const MyMaterials = () => {
  const user = useSelector((s: RootState) => s.auth.user);
  const isGlobalContext = !user?.store_id;
  const canAccess = user?.role === "god" || user?.has_store_access === true;

  const [data, setData] = useState<MyMaterialsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Локальное состояние редактирования: material -> Set<color>
  // Изначально — из data.mine; при редактировании меняется только в памяти.
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [savingMaterial, setSavingMaterial] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await userApi.getMyMaterials();
      setData(res);
      const initial: Record<string, Set<string>> = {};
      for (const m of res.reference.materials) {
        initial[m] = new Set(res.mine[m] || []);
      }
      setDraft(initial);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err.message || "Не удалось загрузить",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // dirty по материалу: отличается ли draft от сохранённого
  const dirtyMap = useMemo(() => {
    if (!data) return {};
    const map: Record<string, boolean> = {};
    for (const m of data.reference.materials) {
      const saved = new Set(data.mine[m] || []);
      const current = draft[m] || new Set();
      if (saved.size !== current.size) {
        map[m] = true;
        continue;
      }
      let dirty = false;
      for (const c of saved)
        if (!current.has(c)) {
          dirty = true;
          break;
        }
      map[m] = dirty;
    }
    return map;
  }, [data, draft]);

  const toggleColor = (material: string, color: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      const set = new Set(next[material] || []);
      if (set.has(color)) set.delete(color);
      else set.add(color);
      next[material] = set;
      return next;
    });
  };

  const selectAll = (material: string) => {
    if (!data) return;
    setDraft((prev) => ({
      ...prev,
      [material]: new Set(data.reference.colors),
    }));
  };

  const clearMaterial = (material: string) => {
    setDraft((prev) => ({ ...prev, [material]: new Set() }));
  };

  const saveMaterial = async (material: string) => {
    if (!data) return;
    const colors = Array.from(draft[material] || []);
    setSavingMaterial(material);
    try {
      await userApi.updateMyMaterial(material, colors);
      // Обновляем "saved" в data, чтобы dirty сбросился
      setData((prev) =>
        prev ? { ...prev, mine: { ...prev.mine, [material]: colors } } : prev,
      );
      toast.success(`«${material}» сохранено`);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err.message || "Не удалось сохранить",
      );
    } finally {
      setSavingMaterial(null);
    }
  };

  // Guard-redirect: на поддомене → cross-origin на root с auth-хэшем
  // (тот же паттерн, что у ссылки «Магазины» в Layout).
  useEffect(() => {
    if (user && canAccess && !isGlobalContext) {
      window.location.href = buildCrossOriginUrl(
        `${getRootOrigin()}/my-materials`,
      );
    }
  }, [user, canAccess, isGlobalContext]);

  // Загрузку запускаем только если на root и есть доступ — иначе
  // useEffect(load) дёрнет API впустую (получит 403 на поддомене до редиректа).
  useEffect(() => {
    if (!user || !canAccess || !isGlobalContext) return;
    void load();
  }, [user, canAccess, isGlobalContext, load]);

  // ── Guards (ПОСЛЕ всех хуков!) ──
  if (!user) return null; // сессия восстанавливается
  if (!canAccess) return <Navigate to="/profile" replace />;
  if (!isGlobalContext) {
    return (
      <div className="container mx-auto py-10 max-w-4xl text-center text-muted-foreground">
        Открываем на главном домене...
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="container mx-auto py-10 max-w-4xl text-center text-muted-foreground">
        Загрузка...
      </div>
    );
  }

  const totalSelected = Object.values(draft).reduce(
    (acc, s) => acc + s.size,
    0,
  );

  return (
    <div className="container mx-auto py-6 max-w-4xl space-y-6">
      <div className="text-center md:text-start">
        <h1 className="text-2xl font-bold">🎨 Материалы</h1>
        <p className="flex flex-col text-sm text-muted-foreground mt-1">
          Отметьте, какие цвета каждого материала у вас есть. Набор общий для
          всех магазинов — заполняете один раз.
          <span className="text-xl text-center mt-4">
            {" "}
            Выбрано комбинаций: <b className="text-blue-600">{totalSelected}</b>
          </span>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-center">
            Наличие материалов
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.reference.materials.map((material) => {
            const selected = draft[material] || new Set();
            const dirty = dirtyMap[material];
            const saving = savingMaterial === material;
            return (
              <div
                key={material}
                className="border rounded-lg p-3 bg-card flex items-center flex-col md:flex-row gap-3"
              >
                {/* Левая часть: заголовок + бейджи + цвета */}
                <div className="flex-1 min-w-0 space-y-2 flex flex-col">
                  <div className="flex flex-wrap items-center gap-2 justify-center">
                    <span className="font-medium">{material}</span>
                    <Badge variant="outline">
                      {selected.size} / {data.reference.colors.length}
                    </Badge>
                    {dirty && <Badge variant="destructive">не сохранено</Badge>}
                  </div>

                  <div className="flex flex-wrap gap-1.5 justify-center">
                    {data.reference.colors.map((color) => {
                      const on = selected.has(color);
                      return (
                        <button
                          key={color}
                          type="button"
                          onClick={() => toggleColor(material, color)}
                          disabled={saving}
                          className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                            on
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background hover:bg-accent border-border"
                          }`}
                        >
                          {on ? "✓ " : ""}
                          {color}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Правая часть: кнопки */}
                <div
                  className="
      flex flex-col gap-1 shrink-0 self-center
      xl:flex-row md:flex-col sm:flex-row sm:items-center
      md:items-center md:self-auto md:justify-center
    "
                >
                  {/* Все + Ничего — всегда в ряд, но на sm упадут друг под друга,
        потому что это flex-элемент родителя-колонки */}
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => selectAll(material)}
                      disabled={saving}
                      title="Выбрать все цвета"
                    >
                      Все
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => clearMaterial(material)}
                      disabled={saving || selected.size === 0}
                      title="Снять все цвета"
                    >
                      Ничего
                    </Button>
                  </div>

                  <Button
                    size="sm"
                    onClick={() => saveMaterial(material)}
                    disabled={!dirty || saving}
                  >
                    {saving ? "…" : "💾 Сохранить"}
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Изменения по каждому материалу сохраняются отдельно кнопкой «💾
        Сохранить». Не забудьте сохранить перед уходом со страницы.
      </p>
    </div>
  );
};
