import api from ".";

export interface ProductStat {
  offer_id: string;
  material: string;
  color: string;
  weight_grams: number;
  user_id?: number;
}

export const statsApi = {
  // Получить статистику для offer_id
  getStats: (offerId: string) =>
    api.get<ProductStat>(`/api/user/stats/${offerId}`).then((res) => res.data),

  // Сохранить статистику
  saveStats: (data: {
    offerId: string;
    material: string;
    color: string;
    weight: number;
  }) => api.post("/api/user/fill-stats", data).then((res) => res.data),

  // Получить список offer_id без статистики для текущего пользователя
  getMissingStats: () =>
    api.get<string[]>("/api/user/missing-stats").then((res) => res.data),
};
