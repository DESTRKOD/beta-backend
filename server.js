// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== КОНФИГУРАЦИЯ =====
const BILEE_API_URL = 'https://paymentgate.bilee.ru/api';
const BILEE_SHOP_ID = process.env.BILEE_SHOP_ID;
const BILEE_PASSWORD = process.env.BILEE_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const NOTIFICATION_IP = '147.45.247.34';
const SERVER_URL = process.env.SERVER_URL || `https://ваш-сервер.onrender.com`;

// ===== ИНИЦИАЛИЗАЦИЯ =====
app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Telegram бот
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ===== УТИЛИТЫ =====
// Генерация подписи для Bilee Pay
async function generateSignature(data, password) {
  const tokenData = {
    ...data,
    password,
  };

  const excludedKeys = ["metadata", "signature"];
  const sortedTokenData = Object.keys(tokenData)
    .filter((key) => !excludedKeys.includes(key))
    .sort()
    .map((key) => tokenData[key])
    .join("");

  const hash = crypto.createHash('sha256');
  hash.update(sortedTokenData, 'utf8');
  return hash.digest('hex');
}

// Валидация подписи от Bilee
async function validateSignature(body, password) {
  const validSignature = await generateSignature(body, password);
  return validSignature === body.signature;
}

// Генерация случайного 6-значного кода
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Форматирование суммы
function formatRub(n) {
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}

// ===== БАЗА ДАННЫХ =====
async function initDB() {
  try {
    // Таблица заказов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(50) UNIQUE NOT NULL,
        items JSONB NOT NULL,
        total INTEGER NOT NULL,
        email VARCHAR(100),
        code VARCHAR(6),
        code_requested BOOLEAN DEFAULT FALSE,
        wrong_code_attempts INTEGER DEFAULT 0,
        payment_id INTEGER,
        payment_status VARCHAR(20) DEFAULT 'pending',
        status VARCHAR(20) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица товаров
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(20) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        is_gift BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Создаем индекс для быстрого поиска
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

    console.log('База данных инициализирована');
  } catch (error) {
    console.error('Ошибка инициализации БД:', error);
  }
}

// ===== УЛУЧШЕННАЯ KEEP-ALIVE СИСТЕМА ДЛЯ RENDER =====

// 1. Health check эндпоинт
app.get('/health', (req, res) => {
  const stats = {
    status: 'healthy',
    service: 'duck-shop-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    config: {
      shop_id: BILEE_SHOP_ID ? '✅ Настроен' : '❌ Нет',
      bot_token: TELEGRAM_BOT_TOKEN ? '✅ Есть' : '❌ Нет',
      admin_id: ADMIN_ID ? '✅ ' + ADMIN_ID : '❌ Нет',
      database: '✅ PostgreSQL'
    }
  };
  
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] Health check from ${req.ip}`);
  res.json(stats);
});

// 2. Wakeup эндпоинт
app.get('/wakeup', (req, res) => {
  console.log(`🔔 [${new Date().toLocaleTimeString('ru-RU')}] Сервер разбужен внешним пингом от ${req.ip}`);
  res.json({ 
    status: 'awake', 
    time: new Date().toISOString(),
    uptime: process.uptime(),
    message: 'Сервер активен и готов к работе'
  });
});

// 3. Ping эндпоинт (для самопинга)
app.get('/ping', (req, res) => {
  console.log(`🏓 [${new Date().toLocaleTimeString('ru-RU')}] Ping received from ${req.ip}`);
  res.send('pong');
});

// 4. Status эндпоинт
app.get('/status', (req, res) => {
  res.json({
    alive: true,
    timestamp: Date.now(),
    serverTime: new Date().toISOString(),
    renderKeepAlive: "active"
  });
});

// 5. Мониторинг эндпоинт
app.get('/monitor', (req, res) => {
  res.json({
    status: 'ok',
    lastPing: new Date().toISOString(),
    intervals: {
      keepAlive: '4-6 минут',
      monitoring: '1 час'
    },
    endpoints: {
      health: `${SERVER_URL}/health`,
      ping: `${SERVER_URL}/ping`,
      wakeup: `${SERVER_URL}/wakeup`,
      status: `${SERVER_URL}/status`
    }
  });
});

// 6. Keep-alive механизм
let keepAliveInterval;

async function pingSelf() {
  try {
    const https = require('https');
    
    const options = {
      hostname: new URL(SERVER_URL).hostname,
      port: 443,
      path: '/ping',
      method: 'GET',
      headers: {
        'User-Agent': 'Render-KeepAlive/1.0',
        'X-Internal-Ping': 'true'
      },
      timeout: 8000
    };
    
    const req = https.request(options, (res) => {
      const now = new Date().toLocaleTimeString('ru-RU');
      console.log(`✅ [${now}] Self-ping successful (${res.statusCode})`);
    });
    
    req.on('error', (err) => {
      const now = new Date().toLocaleTimeString('ru-RU');
      console.log(`⚠️ [${now}] Self-ping error: ${err.message}`);
    });
    
    req.on('timeout', () => {
      const now = new Date().toLocaleTimeString('ru-RU');
      console.log(`⏰ [${now}] Self-ping timeout`);
      req.destroy();
    });
    
    req.end();
    
  } catch (error) {
    const now = new Date().toLocaleTimeString('ru-RU');
    console.log(`❌ [${now}] Self-ping exception: ${error.message}`);
  }
}

function startKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  
  // Пингуем каждые 4-6 минут (рандомизация для надежности)
  const interval = 4 * 60 * 1000 + Math.floor(Math.random() * 2 * 60 * 1000);
  
  keepAliveInterval = setInterval(pingSelf, interval);
  
  // Пингуем сразу при старте
  setTimeout(pingSelf, 3000);
  
  console.log(`🔄 Keep-alive system started (every ${Math.round(interval/60000)} minutes)`);
  
  return interval;
}

// 7. Внешний мониторинг
let externalMonitorInterval;

async function checkExternalServices() {
  const services = [
    'https://httpstat.us/200',
    'https://google.com',
    'https://github.com'
  ];
  
  for (const service of services) {
    try {
      const https = require('https');
      
      const url = new URL(service);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname || '/',
        method: 'HEAD',
        timeout: 5000
      };
      
      const req = https.request(options, (res) => {
        const now = new Date().toLocaleTimeString('ru-RU');
        console.log(`🌐 [${now}] External service ${url.hostname} is reachable`);
      });
      
      req.on('error', () => {
        // Игнорируем ошибки внешних сервисов
      });
      
      req.end();
      
    } catch (error) {
      // Игнорируем ошибки
    }
  }
}

function startExternalMonitoring() {
  if (externalMonitorInterval) {
    clearInterval(externalMonitorInterval);
  }
  
  // Проверяем внешние сервисы раз в час
  externalMonitorInterval = setInterval(checkExternalServices, 60 * 60 * 1000);
  
  // Первая проверка через 30 секунд
  setTimeout(checkExternalServices, 30000);
  
  console.log('📡 External monitoring started (every hour)');
}

// 8. Graceful shutdown
function gracefulShutdown() {
  console.log('🛑 Остановка keep-alive системы...');
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (externalMonitorInterval) {
    clearInterval(externalMonitorInterval);
    externalMonitorInterval = null;
  }
  console.log('✅ Keep-alive система остановлена');
}

process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, завершаем работу...');
  gracefulShutdown();
  setTimeout(() => {
    console.log('👋 Завершение работы сервера');
    process.exit(0);
  }, 1000);
});

process.on('SIGINT', () => {
  console.log('🛑 Получен SIGINT, завершаем работу...');
  gracefulShutdown();
  setTimeout(() => {
    console.log('👋 Завершение работы сервера');
    process.exit(0);
  }, 1000);
});

// ===== TELEGRAM БОТ =====
// Проверка, что сообщение от админа
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

// Команда /add_product
const productWizards = {}; // Храним состояния пользователей

bot.onText(/\/add_product/, async (msg) => {
  if (!isAdmin(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Команда только для администратора');
    return;
  }

  const chatId = msg.chat.id;
  
  // Инициализируем визард
  productWizards[chatId] = {
    step: 1,
    product: {}
  };

  bot.sendMessage(chatId, '🛍️ *Добавление нового товара*\n\nВведите название товара:', {
    parse_mode: 'HTML'
  });
});

// Обработка ответов
bot.on('message', async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  const wizard = productWizards[chatId];
  
  if (!wizard || msg.text?.startsWith('/')) return;

  try {
    switch (wizard.step) {
      case 1: // Название
        wizard.product.name = msg.text;
        wizard.step = 2;
        bot.sendMessage(chatId, '💰 *Введите цену в рублях* (только цифры):', {
          parse_mode: 'HTML'
        });
        break;

      case 2: // Цена
        const price = parseInt(msg.text);
        if (isNaN(price) || price <= 0) {
          bot.sendMessage(chatId, '❌ Неверная цена. Введите число больше 0:');
          return;
        }
        wizard.product.price = price;
        wizard.step = 3;
        bot.sendMessage(chatId, '📸 *Отправьте ссылку на изображение*\n\nПример: https://i.imgur.com/xxx.png', {
          parse_mode: 'HTML'
        });
        break;

      case 3: // Фото
        // Проверяем, что это URL
        if (!msg.text.startsWith('http')) {
          bot.sendMessage(chatId, '❌ Это не ссылка. Отправьте полный URL:');
          return;
        }
        wizard.product.image_url = msg.text;
        wizard.step = 4;
        
        const keyboard = {
          inline_keyboard: [
            [
              { text: '🎁 Подарок', callback_data: 'gift_true' },
              { text: '📦 Обычный', callback_data: 'gift_false' }
            ]
          ]
        };
        
        bot.sendMessage(chatId, '🎁 *Это подарочный товар?*', {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        break;
    }
  } catch (error) {
    console.error('Ошибка в визарде:', error);
    bot.sendMessage(chatId, '❌ Ошибка. Начните заново: /add_product');
    delete productWizards[chatId];
  }
});

// Обработка кнопок подарка
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  
  if (!isAdmin(callbackQuery)) {
    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Доступ запрещен' });
    return;
  }

  const chatId = msg.chat.id;
  const wizard = productWizards[chatId];

  if (!wizard || wizard.step !== 4) {
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  try {
    // Определяем ID товара
    const productId = 'prod_' + Date.now() + Math.random().toString(36).substr(2, 5);
    
    // Сохраняем тип товара
    wizard.product.is_gift = data === 'gift_true';
    wizard.product.id = productId;

    // Сохраняем в базу данных
    await pool.query(
      `INSERT INTO products (id, name, price, image_url, is_gift) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (id) DO UPDATE SET 
         name = EXCLUDED.name,
         price = EXCLUDED.price,
         image_url = EXCLUDED.image_url,
         is_gift = EXCLUDED.is_gift`,
      [
        wizard.product.id,
        wizard.product.name,
        wizard.product.price,
        wizard.product.image_url,
        wizard.product.is_gift
      ]
    );

    // Формируем ответ
    const productText = `
✅ *Товар успешно добавлен!*

*ID:* ${wizard.product.id}
*Название:* ${wizard.product.name}
*Цена:* ${wizard.product.price} ₽
*Тип:* ${wizard.product.is_gift ? '🎁 Подарок' : '📦 Обычный'}
*Изображение:* ${wizard.product.image_url}

Товар появится на сайте после обновления страницы.
    `;

    // Удаляем клавиатуру и отправляем результат
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: msg.message_id }
    );

    bot.sendMessage(chatId, productText, { parse_mode: 'HTML' });

    // Очищаем визард
    delete productWizards[chatId];

    bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Товар сохранен' });

  } catch (error) {
    console.error('Ошибка сохранения товара:', error);
    bot.sendMessage(chatId, '❌ Ошибка сохранения товара в базу данных');
    bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка' });
    delete productWizards[chatId];
  }
});

// Команда /delete_product
bot.onText(/\/delete_product/, async (msg) => {
  if (!isAdmin(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Команда только для администратора');
    return;
  }

  try {
    const result = await pool.query('SELECT id, name, price FROM products ORDER BY name');
    
    if (result.rows.length === 0) {
      bot.sendMessage(msg.chat.id, '📭 В базе нет товаров для удаления');
      return;
    }

    // Создаем клавиатуру с товарами
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        {
          text: `${product.name} (${product.price} ₽)`,
          callback_data: `delete_product:${product.id}`
        }
      ])
    };

    bot.sendMessage(msg.chat.id, '🗑️ *Выберите товар для удаления:*', {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });

  } catch (error) {
    console.error('Ошибка получения товаров для удаления:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
});

// Команда /products
bot.onText(/\/products/, async (msg) => {
  if (!isAdmin(msg)) return;

  try {
    const result = await pool.query('SELECT * FROM products ORDER BY price');
    
    if (result.rows.length === 0) {
      bot.sendMessage(msg.chat.id, '📭 В базе нет товаров');
      return;
    }

    let productsText = '🛍️ *Список товаров:*\n\n';
    
    result.rows.forEach((product, index) => {
      productsText += `${index + 1}. *${product.name}*\n`;
      productsText += `   ID: ${product.id}\n`;
      productsText += `   Цена: ${product.price} ₽\n`;
      productsText += `   Тип: ${product.is_gift ? '🎁 Подарок' : '📦 Обычный'}\n`;
      productsText += `   Изображение: ${product.image_url}\n\n`;
    });

    // Разбиваем на части если сообщение слишком длинное
    const maxLength = 4000;
    if (productsText.length > maxLength) {
      const parts = productsText.match(new RegExp(`.{1,${maxLength}}`, 'g'));
      for (const part of parts) {
        await bot.sendMessage(msg.chat.id, part, { parse_mode: 'HTML' });
      }
    } else {
      bot.sendMessage(msg.chat.id, productsText, { parse_mode: 'HTML' });
    }

  } catch (error) {
    console.error('Ошибка получения товаров:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
});

// Команда /start
bot.onText(/\/start/, async (msg) => {
  if (!isAdmin(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Доступ запрещен');
    return;
  }
  
  const welcomeText = `👋 Привет, администратор!\n\nДоступные команды:\n/orders - просмотреть заказы\n/stats - статистика\n/products - список товаров\n/add_product - добавить товар\n/delete_product - удалить товар`;
  bot.sendMessage(msg.chat.id, welcomeText);
});

// Команда /orders
bot.onText(/\/orders/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT order_id, total, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10'
    );
    
    if (result.rows.length === 0) {
      bot.sendMessage(msg.chat.id, '📭 Нет заказов');
      return;
    }
    
    // Создаем клавиатуру с заказами
    const keyboard = {
      inline_keyboard: result.rows.map(order => [
        {
          text: `#${order.order_id} - ${formatRub(order.total)} - ${getStatusText(order.status)}`,
          callback_data: `order_detail:${order.order_id}`
        }
      ])
    };
    
    let ordersText = '📋 Последние заказы:\n\n';
    result.rows.forEach((order, index) => {
      ordersText += `${index + 1}. Заказ #${order.order_id}\n`;
      ordersText += `   Сумма: ${formatRub(order.total)}\n`;
      ordersText += `   Статус: ${getStatusText(order.status)}\n`;
      ordersText += `   Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n`;
    });
    
    bot.sendMessage(msg.chat.id, ordersText, {
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Ошибка получения заказов:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении заказов');
  }
});

// Команда /stats
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const totalResult = await pool.query('SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE payment_status = $1', ['confirmed']);
    const todayResult = await pool.query(
      "SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURRENT_DATE AND payment_status = $1",
      ['confirmed']
    );
    
    const statsText = `📊 Статистика магазина:\n\n` +
      `Всего заказов: ${totalResult.rows[0].count || 0}\n` +
      `Общая выручка: ${formatRub(totalResult.rows[0].revenue || 0)}\n` +
      `Заказов сегодня: ${todayResult.rows[0].count || 0}`;
    
    bot.sendMessage(msg.chat.id, statsText);
  } catch (error) {
    console.error('Ошибка получения статистики:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении статистики');
  }
});

// Обработчик callback-кнопок для заказов
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  
  if (!isAdmin(callbackQuery)) {
    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Доступ запрещен' });
    return;
  }
  
  try {
    // Обработка удаления товара
    if (data.startsWith('delete_product:')) {
      const productId = data.split(':')[1];
      
      const productResult = await pool.query(
        'SELECT name FROM products WHERE id = $1',
        [productId]
      );
      
      if (productResult.rows.length === 0) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Товар не найден' });
        return;
      }
      
      const productName = productResult.rows[0].name;
      
      // Удаляем товар
      await pool.query('DELETE FROM products WHERE id = $1', [productId]);
      
      // Обновляем сообщение
      await bot.editMessageText(`✅ Товар "${productName}" удален`, {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      
      bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Товар удален' });
      return;
    }
    
    // Обработка деталей заказа
    if (data.startsWith('order_detail:')) {
      const orderId = data.split(':')[1];
      await showOrderDetails(msg.chat.id, msg.message_id, orderId);
      bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    // Обработка кнопок в деталях заказа
    const [action, orderId] = data.split(':');
    
    switch(action) {
      case 'request_code':
        await handleRequestCode(orderId, msg);
        break;
      case 'order_ready':
        await handleOrderReady(orderId, msg);
        break;
      case 'wrong_code':
        await handleWrongCode(orderId, msg);
        break;
      case 'mark_completed':
        await handleMarkCompleted(orderId, msg);
        break;
      case 'back_to_orders':
        await handleBackToOrders(msg);
        break;
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Ошибка обработки callback:', error);
    bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка' });
  }
});

// Показать детали заказа
async function showOrderDetails(chatId, messageId, orderId) {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      await bot.editMessageText('❌ Заказ не найден', {
        chat_id: chatId,
        message_id: messageId
      });
      return;
    }
    
    const order = result.rows[0];
    const items = order.items || {};
    
    let itemsText = '';
    let totalItems = 0;
    
    // Получаем названия товаров из базы
    for (const [id, qty] of Object.entries(items)) {
      const productResult = await pool.query(
        'SELECT name FROM products WHERE id = $1',
        [id]
      );
      
      const productName = productResult.rows[0]?.name || `Товар ${id}`;
      itemsText += `• ${productName}: ${qty} шт.\n`;
      totalItems += parseInt(qty);
    }
    
    const orderText = `📋 *Детали заказа #${order.order_id}*\n\n` +
      `💰 Сумма: ${formatRub(order.total)}\n` +
      `📧 Почта: ${order.email || 'не указана'}\n` +
      `🔢 Код: ${order.code || 'не введен'}\n` +
      `📦 Товаров: ${totalItems} шт.\n` +
      `📊 Статус: ${getStatusText(order.status)}\n` +
      `💳 Оплата: ${order.payment_status === 'confirmed' ? '✅ Оплачен' : '❌ Не оплачен'}\n` +
      `📅 Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n` +
      `🛒 *Состав заказа:*\n${itemsText}`;
    
    // Создаем клавиатуру в зависимости от статуса
    let keyboardRows = [];
    
    // Кнопка "Сделать готовым" показывается только если:
    // 1. Заказ оплачен (payment_status = 'confirmed') ИЛИ
    // 2. Уже есть email (статус email_entered или waiting_code_request) ИЛИ
    // 3. Статус waiting (ожидание выполнения)
    if ((order.payment_status === 'confirmed' || order.email) && order.status !== 'completed') {
      keyboardRows.push([
        { text: '✅ Сделать готовым', callback_data: `mark_completed:${orderId}` }
      ]);
    }
    
    // Кнопка "Запросить код" показывается если:
    // 1. Есть email
    // 2. Код еще не запрошен (code_requested = false)
    // 3. Заказ не завершен
    if (order.email && !order.code_requested && order.status !== 'completed') {
      keyboardRows.push([
        { text: '📝 Запросить код', callback_data: `request_code:${orderId}` }
      ]);
    }
    
    if (order.code && order.status === 'waiting') {
      keyboardRows.push([
        { text: '✅ Подтвердить код', callback_data: `order_ready:${orderId}` },
        { text: '❌ Неверный код', callback_data: `wrong_code:${orderId}` }
      ]);
    }
    
    // Всегда добавляем кнопку возврата
    keyboardRows.push([
      { text: '⬅️ Назад к заказам', callback_data: `back_to_orders:${orderId}` }
    ]);
    
    const keyboard = {
      inline_keyboard: keyboardRows
    };
    
    await bot.editMessageText(orderText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
  } catch (error) {
    console.error('Ошибка показа деталей заказа:', error);
    await bot.editMessageText('❌ Ошибка при получении деталей заказа', {
      chat_id: chatId,
      message_id: messageId
    });
  }
}

// Вернуться к списку заказов
async function handleBackToOrders(msg) {
  try {
    const result = await pool.query(
      'SELECT order_id, total, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10'
    );
    
    if (result.rows.length === 0) {
      await bot.editMessageText('📭 Нет заказов', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      return;
    }
    
    // Создаем клавиатуру с заказами
    const keyboard = {
      inline_keyboard: result.rows.map(order => [
        {
          text: `#${order.order_id} - ${formatRub(order.total)} - ${getStatusText(order.status)}`,
          callback_data: `order_detail:${order.order_id}`
        }
      ])
    };
    
    let ordersText = '📋 Последние заказы:\n\n';
    result.rows.forEach((order, index) => {
      ordersText += `${index + 1}. Заказ #${order.order_id}\n`;
      ordersText += `   Сумма: ${formatRub(order.total)}\n`;
      ordersText += `   Статус: ${getStatusText(order.status)}\n`;
      ordersText += `   Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n`;
    });
    
    await bot.editMessageText(ordersText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
    
  } catch (error) {
    console.error('Ошибка возврата к заказам:', error);
  }
}

// Запросить код от администратора
async function handleRequestCode(orderId, msg) {
  try {
    // Помечаем, что код запрошен
    await pool.query(
      "UPDATE orders SET code_requested = TRUE, status = 'waiting_code_request' WHERE order_id = $1",
      [orderId]
    );
    
    await bot.editMessageText(`📝 Код запрошен для заказа #${orderId}\n\nПользователю отправлен запрос на ввод кода.`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  } catch (error) {
    console.error('Ошибка запроса кода:', error);
  }
}

// Отметить заказ как готовый (из бота)
async function handleMarkCompleted(orderId, msg) {
  try {
    // Обновляем статус заказа
    await pool.query(
      "UPDATE orders SET status = 'completed' WHERE order_id = $1",
      [orderId]
    );
    
    await bot.editMessageText(`✅ Заказ #${orderId} отмечен как готовый\n\nПользователь будет уведомлен о готовности заказа.`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
  } catch (error) {
    console.error('Ошибка отметки заказа как готового:', error);
    await bot.editMessageText('❌ Ошибка при обновлении статуса заказа', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }
}

// Отправка уведомления о новом заказе
async function sendNewOrderNotification(orderId, total, email) {
  try {
    const result = await pool.query(
      'SELECT items FROM orders WHERE order_id = $1',
      [orderId]
    );
    const items = result.rows[0]?.items || {};
    
    let itemsText = '';
    let totalItems = 0;
    
    // Получаем названия товаров из базы
    for (const [id, qty] of Object.entries(items)) {
      const productResult = await pool.query(
        'SELECT name FROM products WHERE id = $1',
        [id]
      );
      
      const productName = productResult.rows[0]?.name || `Товар ${id}`;
      itemsText += `• ${productName}: ${qty} шт.\n`;
      totalItems += parseInt(qty);
    }
    
    const text = `🛒 *Новый заказ #${orderId}*\n\n` +
      `💰 Сумма: ${formatRub(total)}\n` +
      `📦 Товаров: ${totalItems} шт.\n` +
      `📧 Почта: ${email || 'не указана'}\n\n` +
      `📋 *Состав заказа:*\n${itemsText}`;
    
    const keyboard = {
      inline_keyboard: [[
        { text: '📝 Управление заказом', callback_data: `order_detail:${orderId}` }
      ]]
    };
    
    await bot.sendMessage(ADMIN_ID, text, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
  } catch (error) {
    console.error('Ошибка отправки уведомления:', error);
  }
}

// Отправка уведомления о сохранении email и кода
async function sendCodeNotification(orderId, total, email, code) {
  try {
    const result = await pool.query('SELECT items FROM orders WHERE order_id = $1', [orderId]);
    const items = result.rows[0]?.items || {};
    
    let itemsText = '';
    let totalItems = 0;
    
    for (const [id, qty] of Object.entries(items)) {
      const productResult = await pool.query(
        'SELECT name FROM products WHERE id = $1',
        [id]
      );
      
      const productName = productResult.rows[0]?.name || `Товар ${id}`;
      itemsText += `• ${productName}: ${qty} шт.\n`;
      totalItems += parseInt(qty);
    }
    
    const text = `📧 *Новая информация по заказу #${orderId}*\n\n` +
      `💰 Сумма: ${formatRub(total)}\n` +
      `📧 Почта: ${email}\n` +
      `🔢 Код: ${code}\n` +
      `📦 Товаров: ${totalItems} шт.\n\n` +
      `📋 *Состав заказа:*\n${itemsText}`;
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Заказ готов', callback_data: `order_ready:${orderId}` },
          { text: '❌ Неверный код', callback_data: `wrong_code:${orderId}` }
        ],
        [
          { text: '📋 Управление заказом', callback_data: `order_detail:${orderId}` }
        ]
      ]
    };
    
    await bot.sendMessage(ADMIN_ID, text, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
  } catch (error) {
    console.error('Ошибка отправки уведомления о коде:', error);
  }
}

// Обработка готовности заказа
async function handleOrderReady(orderId, msg) {
  try {
    await pool.query(
      "UPDATE orders SET status = 'completed' WHERE order_id = $1",
      [orderId]
    );
    
    await bot.editMessageText(`✅ Заказ #${orderId} отмечен как готовый`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  } catch (error) {
    console.error('Ошибка обработка готовности заказа:', error);
  }
}

// Обработка неверного кода
async function handleWrongCode(orderId, msg) {
  try {
    // Увеличиваем счетчик неверных попыток
    await pool.query(
      "UPDATE orders SET wrong_code_attempts = wrong_code_attempts + 1, code = NULL, status = 'waiting' WHERE order_id = $1",
      [orderId]
    );
    
    // Получаем количество попыток
    const result = await pool.query(
      'SELECT wrong_code_attempts FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    const attempts = result.rows[0]?.wrong_code_attempts || 0;
    
    let message = `❌ Код для заказа #${orderId} отмечен как неверный\n\n`;
    message += `Неверных попыток: ${attempts}\n`;
    message += `Пользователю отправлен запрос на повторный ввод кода.`;
    
    if (attempts >= 2) {
      message += `\n\n⚠️ Пользователь будет перенаправлен в поддержку.`;
    }
    
    await bot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  } catch (error) {
    console.error('Ошибка обработки неверного кода:', error);
  }
}

function getStatusText(status) {
  const statusMap = {
    'new': '🆕 Новый',
    'pending': '⏳ Ожидает оплаты',
    'confirmed': '✅ Оплачен',
    'waiting_code_request': '⏳ Ожидает запроса кода',
    'waiting': '⏳ Ожидает выполнения',
    'completed': '🎉 Завершен',
    'canceled': '❌ Отменен'
  };
  return statusMap[status] || status;
}

// ===== API РОУТЫ =====

// 1. Создание заказа и платежа
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total } = req.body;
    
    // Генерация уникального ID заказа
    const orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    
    // Сохранение заказа в БД
    await pool.query(
      'INSERT INTO orders (order_id, items, total, status) VALUES ($1, $2, $3, $4)',
      [orderId, items, total, 'new']
    );
    
    // Создание платежа в Bilee Pay
    const paymentData = {
      order_id: orderId,
      method_slug: 'card', // или другой метод
      amount: total,
      description: `Заказ #${orderId}`,
      shop_id: parseInt(BILEE_SHOP_ID),
      notify_url: `${SERVER_URL}/api/bilee-webhook`,
      success_url: `${req.headers.origin || 'https://DESTRKOD.github.io'}/duck2/beta-duck.html?payment=success&order=${orderId}`,
      fail_url: `${req.headers.origin || 'https://DESTRKOD.github.io'}/duck2/beta-duck.html?payment=fail&order=${orderId}`,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 часа
    };
    
    // Генерация подписи
    paymentData.signature = await generateSignature(paymentData, BILEE_PASSWORD);
    
    // Отправка запроса к Bilee Pay
    const bileeResponse = await axios.post(
      `${BILEE_API_URL}/payment/init`,
      paymentData
    );
    
    if (bileeResponse.data.success) {
      // Сохраняем ID платежа
      await pool.query(
        'UPDATE orders SET payment_id = $1 WHERE order_id = $2',
        [bileeResponse.data.payment.id, orderId]
      );
      
      res.json({
        success: true,
        orderId: orderId,
        paymentUrl: bileeResponse.data.url
      });
    } else {
      throw new Error('Bilee Pay error');
    }
  } catch (error) {
    console.error('Ошибка создания заказа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 2. Сохранение email
app.post('/api/save-email', async (req, res) => {
  try {
    const { orderId, email } = req.body;
    
    await pool.query(
      'UPDATE orders SET email = $1, status = $2 WHERE order_id = $3',
      [email, 'waiting_code_request', orderId]
    );
    
    // Отправляем уведомление админу
    const orderResult = await pool.query(
      'SELECT total FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length > 0) {
      await sendNewOrderNotification(orderId, orderResult.rows[0].total, email);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка сохранения email:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 3. Проверка запроса кода от админа
app.get('/api/check-code-request/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT code_requested, status FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = result.rows[0];
    
    res.json({
      success: true,
      codeRequested: order.code_requested || false,
      status: order.status
    });
  } catch (error) {
    console.error('Ошибка проверки запроса кода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 4. Проверка кода
app.post('/api/verify-code', async (req, res) => {
  try {
    const { orderId, code } = req.body;
    
    const orderResult = await pool.query(
      'SELECT email, total, wrong_code_attempts FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const wrongAttempts = orderResult.rows[0].wrong_code_attempts || 0;
    
    // Проверяем, если было 2 или более неверных попыток
    if (wrongAttempts >= 2) {
      return res.json({ 
        success: false, 
        status: 'support_needed',
        message: 'Превышено количество попыток ввода кода'
      });
    }
    
    // Проверяем код в базе данных
    const codeResult = await pool.query(
      'SELECT code FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    const savedCode = codeResult.rows[0]?.code;
    
    if (savedCode && savedCode === code) {
      // Код верный - помечаем заказ как выполненный
      await pool.query(
        "UPDATE orders SET status = 'completed' WHERE order_id = $1",
        [orderId]
      );
      
      res.json({ 
        success: true, 
        status: 'completed'
      });
    } else {
      // Код неверный - сохраняем и увеличиваем счетчик попыток
      await pool.query(
        'UPDATE orders SET code = $1, wrong_code_attempts = wrong_code_attempts + 1, status = $2 WHERE order_id = $3',
        [code, 'waiting', orderId]
      );
      
      // Отправляем уведомление админу
      await sendCodeNotification(
        orderId,
        orderResult.rows[0].total,
        orderResult.rows[0].email,
        code
      );
      
      res.json({ 
        success: true, 
        status: 'waiting'
      });
    }
    
  } catch (error) {
    console.error('Ошибка проверки кода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 5. Вебхук от Bilee Pay
app.post('/api/bilee-webhook', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    // Проверка подписи
    const isValid = await validateSignature(req.body, BILEE_PASSWORD);
    if (!isValid) {
      console.error('Неверная подпись от Bilee Pay');
      return res.status(400).send('Invalid signature');
    }
    
    const { order_id, status, id: paymentId } = req.body;
    
    // Обновляем статус платежа в БД
    if (status === 'confirmed') {
      await pool.query(
        'UPDATE orders SET payment_status = $1, status = $2 WHERE order_id = $3',
        ['confirmed', 'confirmed', order_id]
      );
      
      // Можно отправить дополнительное уведомление админу
      const orderResult = await pool.query(
        'SELECT total, email FROM orders WHERE order_id = $1',
        [order_id]
      );
      
      if (orderResult.rows.length > 0) {
        const text = `💰 Получена оплата за заказ #${order_id}\n` +
          `Сумма: ${formatRub(orderResult.rows[0].total)}\n` +
          `Почта: ${orderResult.rows[0].email || 'не указана'}\n` +
          `ID платежа: ${paymentId}`;
        
        await bot.sendMessage(ADMIN_ID, text);
      }
    }
    
    // Всегда возвращаем 200 OK
    res.status(200).send('OK');
  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
    res.status(500).send('Internal server error');
  }
});

// 6. Проверка статуса заказа
app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT status, payment_status, code, wrong_code_attempts FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = result.rows[0];
    
    // Проверяем количество неверных попыток
    if (order.wrong_code_attempts >= 2) {
      return res.json({
        success: true,
        status: 'support_needed',
        paymentStatus: order.payment_status,
        hasCode: !!order.code,
        wrongAttempts: order.wrong_code_attempts
      });
    }
    
    res.json({
      success: true,
      status: order.status,
      paymentStatus: order.payment_status,
      hasCode: !!order.code,
      wrongAttempts: order.wrong_code_attempts
    });
  } catch (error) {
    console.error('Ошибка проверки статуса:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 7. Получение списка товаров
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY price');
    res.json({ success: true, products: result.rows });
  } catch (error) {
    console.error('Ошибка получения товаров:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Эндпоинт проверки структуры БД
app.get('/check-db-structure', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        table_name,
        column_name,
        data_type,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_name IN ('products', 'orders')
      ORDER BY table_name, ordinal_position
    `);
    
    res.json({
      success: true,
      tables: result.rows,
      message: 'Проверь что products.id имеет character_maximum_length: 100'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Добавление товара (для админки через бота)
app.post('/api/products', async (req, res) => {
  try {
    const { id, name, price, image_url, is_gift } = req.body;
    
    await pool.query(
      `INSERT INTO products (id, name, price, image_url, is_gift) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (id) DO UPDATE SET 
         name = EXCLUDED.name,
         price = EXCLUDED.price,
         image_url = EXCLUDED.image_url,
         is_gift = EXCLUDED.is_gift`,
      [id, name, price, image_url, is_gift || false]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка добавления товара:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== ЗАГРУЗКА ТЕСТОВЫХ ТОВАРОВ =====
async function loadSampleProducts() {
  try {
    const sampleProducts = [
      { id: "c30", name: "30 кристаллов", price: 200, image_url: "https://i.imgur.com/s4K0WIP.png", is_gift: false },
      { id: "c80", name: "80 кристаллов", price: 550, image_url: "https://i.imgur.com/XbnZKDb.png", is_gift: false },
      { id: "c170", name: "170 кристаллов", price: 950, image_url: "https://i.imgur.com/X0JCmMQ.png", is_gift: false },
      { id: "c360", name: "360 кристаллов", price: 1900, image_url: "https://i.imgur.com/7z8z9Rw.png", is_gift: false },
      { id: "c950", name: "950 кристаллов", price: 4600, image_url: "https://i.imgur.com/zzBuIxF.png", is_gift: false },
      { id: "c2000", name: "2000 кристаллов", price: 9000, image_url: "https://i.imgur.com/FTVnycE.png", is_gift: false },
      { id: "bp", name: "Brawl Pass", price: 900, image_url: "https://i.imgur.com/FaFAL6l.png", is_gift: false },
      { id: "bpplus", name: "Brawl Pass Plus", price: 1200, image_url: "https://i.imgur.com/21InnIc.png", is_gift: false },
      { id: "up", name: "Улучшение до БП+", price: 550, image_url: "https://i.imgur.com/yhaR5Ho.png", is_gift: false },
      { id: "bp_g", name: "Brawl Pass", price: 950, image_url: "https://i.imgur.com/FaFAL6l.png", is_gift: true },
      { id: "bpp_g", name: "Brawl Pass Plus", price: 1250, image_url: "https://i.imgur.com/21InnIc.png", is_gift: true },
      { id: "pro", name: "Pro Pass", price: 2200, image_url: "https://i.imgur.com/6808Xnp.png", is_gift: false }
    ];
    
    for (const product of sampleProducts) {
      await pool.query(
        `INSERT INTO products (id, name, price, image_url, is_gift) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (id) DO UPDATE SET 
           name = EXCLUDED.name,
           price = EXCLUDED.price,
           image_url = EXCLUDED.image_url,
           is_gift = EXCLUDED.is_gift`,
        [product.id, product.name, product.price, product.image_url, product.is_gift]
      );
    }
    
    console.log('Тестовые товары загружены');
  } catch (error) {
    console.error('Ошибка загрузки тестовых товаров:', error);
  }
}

// ===== ЗАПУСК СЕРВЕРА =====
async function startServer() {
  try {
    // Инициализация БД
    await initDB();
    
    // Загрузка тестовых товаров
    await loadSampleProducts();
    
    // Запуск сервера
    app.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
      console.log(`📞 API доступен по адресу: ${SERVER_URL}`);
      console.log(`🤖 Telegram бот запущен`);
      console.log(`👑 Админ ID: ${ADMIN_ID}`);
      console.log(`⏰ Keep-alive система: АКТИВНА`);
      
      // Запуск keep-alive системы
      startKeepAlive();
      startExternalMonitoring();
    });
  } catch (error) {
    console.error('Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

startServer();
