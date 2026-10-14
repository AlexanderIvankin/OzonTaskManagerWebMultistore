# Project Structure

_Auto-generated: 2026-10-14 09:55:42 UTC_

**Root:** `OzonTaskManagerWebMultistore`  
**Files shown:** 182  
**Directories shown:** 38

## Tree

```
OzonTaskManagerWebMultistore/
├── .vscode/
│   └── settings.json
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── database.js
│   │   │   ├── envLoader.js
│   │   │   ├── index.js
│   │   │   ├── notificationsDatabase.js
│   │   │   ├── s3.js
│   │   │   ├── schema.js
│   │   │   ├── staffRoles.js
│   │   │   └── stores.js
│   │   ├── controllers/
│   │   │   ├── adminController.js
│   │   │   ├── authController.js
│   │   │   ├── modelsController.js
│   │   │   └── userController.js
│   │   ├── middlewares/
│   │   │   ├── auth.js
│   │   │   ├── cooldown.js
│   │   │   ├── rateLimiters.js
│   │   │   └── storeResolver.js
│   │   ├── models/
│   │   │   ├── Assignment.js
│   │   │   ├── Earnings.js
│   │   │   ├── EmailVerification.js
│   │   │   ├── index.js
│   │   │   ├── Notification.js
│   │   │   ├── OfferModel.js
│   │   │   ├── PasswordReset.js
│   │   │   ├── ProductStat.js
│   │   │   ├── User.js
│   │   │   ├── UserStats.js
│   │   │   ├── UserStore.js
│   │   │   └── Warehouse.js
│   │   ├── routes/
│   │   │   ├── admin.js
│   │   │   ├── auth.js
│   │   │   ├── models.js
│   │   │   ├── notifications.js
│   │   │   └── user.js
│   │   ├── services/
│   │   │   ├── AuthService.js
│   │   │   ├── BackupService.js
│   │   │   ├── CooldownService.js
│   │   │   ├── EarningsService.js
│   │   │   ├── EmailService.js
│   │   │   ├── MaterialsService.js
│   │   │   ├── ModelService.js
│   │   │   ├── NotificationService.js
│   │   │   ├── OrderService.js
│   │   │   ├── OzonService.js
│   │   │   ├── ProductStatsService.js
│   │   │   ├── PushService.js
│   │   │   ├── StorageService.js
│   │   │   └── SyncService.js
│   │   ├── debugMode.js
│   │   ├── scheduler.js
│   │   ├── socket.js
│   │   ├── state.js
│   │   └── utils.js
│   ├── tests/
│   │   ├── helpers/
│   │   │   └── setupTestEnv.js
│   │   ├── smoke-all-labels.js
│   │   ├── smoke-auth-error-logging.js
│   │   ├── smoke-cooldowns.js
│   │   ├── smoke-deliver-reminder.js
│   │   ├── smoke-earnings-revocation.js
│   │   ├── smoke-email-verification.js
│   │   ├── smoke-export-no-users.js
│   │   ├── smoke-guest-cleanup.js
│   │   ├── smoke-models.js
│   │   ├── smoke-notifications.js
│   │   ├── smoke-order-status-sync.js
│   │   ├── smoke-package-label.js
│   │   ├── smoke-password-reset.js
│   │   ├── smoke-push-no-module.js
│   │   ├── smoke-push.js
│   │   ├── smoke-rate-limit.js
│   │   ├── smoke-sync-employees.js
│   │   ├── smoke-sync-validation.js
│   │   ├── smoke-users-cohorts.js
│   │   └── smoke-vacuum-snapshot.js
│   ├── .env
│   ├── .env.example
│   ├── .env.store1
│   ├── .env.store1.example
│   ├── materials-prices-1.json
│   ├── nodemon.json
│   ├── package.json
│   ├── seed.js
│   └── server.js
├── frontend/
│   ├── public/
│   │   └── sw.js
│   ├── src/
│   │   ├── api/
│   │   │   ├── admin.ts
│   │   │   ├── index.ts
│   │   │   ├── notifications.ts
│   │   │   ├── orders.ts
│   │   │   └── user.ts
│   │   ├── components/
│   │   │   ├── Layout/
│   │   │   │   └── Layout.tsx
│   │   │   ├── ui/
│   │   │   │   ├── alert.tsx
│   │   │   │   ├── badge.tsx
│   │   │   │   ├── button.tsx
│   │   │   │   ├── card.tsx
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── input.tsx
│   │   │   │   ├── label.tsx
│   │   │   │   ├── select.tsx
│   │   │   │   ├── separator.tsx
│   │   │   │   ├── switch.tsx
│   │   │   │   └── table.tsx
│   │   │   ├── CompletedOrderCard.tsx
│   │   │   ├── FillStatsDialog.tsx
│   │   │   ├── OrderCard.tsx
│   │   │   ├── OrderProductsList.tsx
│   │   │   ├── OrderTotalAmount.tsx
│   │   │   ├── PhoneInput.tsx
│   │   │   ├── ProductImages.tsx
│   │   │   ├── ProductStatsBlock.tsx
│   │   │   ├── ProtectedRoute.tsx
│   │   │   ├── RoleBadge.tsx
│   │   │   └── StoreCard.tsx
│   │   ├── hooks/
│   │   │   └── usePushSubscription.ts
│   │   ├── lib/
│   │   │   ├── notify.ts
│   │   │   ├── socket.ts
│   │   │   ├── theme.ts
│   │   │   ├── urls.ts
│   │   │   └── utils.ts
│   │   ├── pages/
│   │   │   ├── Admin/
│   │   │   │   ├── ActiveOrders.tsx
│   │   │   │   ├── AdminPanel.tsx
│   │   │   │   ├── CompletedOrders.tsx
│   │   │   │   ├── EarningsManagement.tsx
│   │   │   │   ├── ExportData.tsx
│   │   │   │   ├── Materials.tsx
│   │   │   │   ├── Models.tsx
│   │   │   │   ├── OrdersManagement.tsx
│   │   │   │   ├── StaffStats.tsx
│   │   │   │   ├── Users.tsx
│   │   │   │   └── Warehouses.tsx
│   │   │   ├── Login/
│   │   │   │   └── Login.tsx
│   │   │   ├── MyStores/
│   │   │   │   └── MyStores.tsx
│   │   │   ├── Notifications/
│   │   │   │   └── Notifications.tsx
│   │   │   ├── Orders/
│   │   │   │   └── Orders.tsx
│   │   │   ├── Profile/
│   │   │   │   ├── GlobalProfile.tsx
│   │   │   │   ├── Profile.tsx
│   │   │   │   └── StoreProfile.tsx
│   │   │   ├── Register/
│   │   │   │   └── Register.tsx
│   │   │   ├── ResetPassword/
│   │   │   │   └── ResetPassword.tsx
│   │   │   └── VerifyEmail/
│   │   │       └── VerifyEmail.tsx
│   │   ├── store/
│   │   │   ├── authSlice.ts
│   │   │   └── index.ts
│   │   ├── types/
│   │   │   └── index.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── vite-env.d.ts
│   ├── .env.development
│   ├── .env.production
│   ├── components.json
│   ├── package.json
│   ├── README.md
│   ├── tsconfig.app.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── vite.config.d.ts
│   └── vite.config.ts
├── migration/
│   ├── lib/
│   │   ├── db.js
│   │   ├── helpers.js
│   │   ├── identity.js
│   │   ├── logger.js
│   │   ├── schema-bot.js
│   │   ├── schema-merge.js
│   │   ├── schema.js
│   │   ├── tg-overrides.js
│   │   └── tg-overrides.local.js
│   ├── .env
│   ├── .env.example
│   ├── bot-to-web.js
│   ├── merge.js
│   ├── notifications-merge-live.js
│   ├── package.json
│   ├── split.js
│   ├── verify-roundtrip.js
│   └── web-to-bot.js
├── tests/
│   ├── http/
│   │   ├── fixtures/
│   │   │   └── materials-prices-1.json
│   │   ├── .env
│   │   ├── admin.http
│   │   ├── auth.http
│   │   ├── notifications.http
│   │   └── user.http
│   └── scripts/
│       └── http-login.js
├── createAccount.js
└── generate-project-structure.js
```

## Empty directories

- `migration/input/`
- `migration/output/`
- `migration/output-merged/`
- `migration/web-bot_output/`

## Excluded directories

_Пропущены намеренно (сборка, кэш, секреты, тяжёлые данные):_

- `.cache/`
- `.git/`
- `.hg/`
- `.next/`
- `.nuxt/`
- `.svn/`
- `ServerFiles/`
- `backups/`
- `build/`
- `coverage/`
- `dist/`
- `logs/`
- `models-cache/`
- `node_modules/`
- `outputs/`
- `temp/`
- `tmp/`
- `uploads/`

## Included file extensions

`.cjs`, `.http`, `.js`, `.json`, `.jsx`, `.md`, `.mjs`, `.ps1`, `.sh`, `.sql`, `.ts`, `.tsx`, `.yaml`, `.yml`, а также любые `.env*` файлы
