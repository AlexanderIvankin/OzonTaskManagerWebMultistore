require('dotenv').config();
const { initDB } = require('./src/config/database');
const { User, Assignment, ProductStat } = require('./src/models');
const bcrypt = require('bcrypt');

async function seed() {
  const db = await initDB();
  console.log('Начинаем заполнение тестовыми данными...');

  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  const admin = await User.create({
    username: 'admin',
    email: 'admin@example.com',
    passwordHash: adminPasswordHash,
    name: 'Администратор',
    phone: '+7 999 000-00-00',
    capacity: 10,
    earningsFactor: 1.0,
    role: 'admin', // <-- главное
  });
  console.log('Создан администратор:', admin);

  // Создаём тестового пользователя
  const passwordHash = await bcrypt.hash('password123', 10);
  const user = await User.create({
    username: 'testuser',
    email: 'test@example.com',
    passwordHash,
    name: 'Тестовый Пользователь',
    phone: '+7 999 123-45-67',
    capacity: 2,
    earningsFactor: 1.0,
    role: 'employee',
  });
  console.log('Создан пользователь:', user);

  // Добавляем статистику по товарам (для расчёта заработка)
  await ProductStat.upsert('TEST-OFFER-1', 'Pet-G', 'Черный', 150, user.id);
  await ProductStat.upsert('TEST-OFFER-2', 'ABS', 'Белый', 200, user.id);
  console.log('Добавлена статистика товаров');

  // Создаём тестовое назначение заказа (для проверки)
  await Assignment.assign('TEST-ORDER-001', user.id);
  console.log('Создано тестовое назначение заказа');

  console.log('✅ Тестовые данные добавлены');
  process.exit(0);
}

seed().catch(console.error);