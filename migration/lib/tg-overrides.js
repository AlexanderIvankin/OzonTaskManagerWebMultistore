// migration/lib/tg-overrides.js
//
// БАЗОВЫЙ файл override'ов tg_user_id — всегда пустой, всегда в git.
//
// Реальные правила кладём рядом, в `tg-overrides.local.js` (он в .gitignore
// и хранит конкретные исторические правки только для текущей машины).
//
// split.js мержит их: { ...base.overrides, ...local.overrides },
// при этом local переопределяет base.
//
// Формат:
//   overrides: {
//     'email@example.com': '12345678',   // установить tg
//     'email@example.com': null,         // снять tg
//   }
//
// Подробности и пример — в комментарии к loader'у в split.js.

module.exports = {
  overrides: {
    // Оставляй пустым. Реальные правила — в tg-overrides.local.js.
  },
};