// server.js - ПОЛНЫЙ ИСПРАВЛЕННЫЙ СЕРВЕР
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
const USER_BOT_TOKEN = process.env.USER_BOT_TOKEN;
const USER_BOT_USERNAME = process.env.USER_BOT_USERNAME;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const SERVER_URL = process.env.SERVER_URL || `https://duck-shop-sever.onrender.com`;
const SITE_URL = process.env.SITE_URL || 'https://DESTRKOD.github.io/duck2';

// ===== ИНИЦИАЛИЗАЦИЯ =====
app.use(cors({
  origin: ['https://destrkod.github.io', 'https://DESTRKOD.github.io', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// Подключение к PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Эндпоинт для получения конфигурации Firebase
app.get('/api/firebase-config', (req, res) => {
  res.json({
    success: true,
    config: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID
    }
  });
});

// Два Telegram бота
let adminBot;
let userBot;

try {
  if (process.env.NODE_ENV === 'production') {
    adminBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
      webHook: {
        port: PORT
      }
    });
    userBot = new TelegramBot(USER_BOT_TOKEN, { 
      webHook: {
        port: PORT
      }
    });
  } else {
    adminBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    userBot = new TelegramBot(USER_BOT_TOKEN, { polling: true });
  }
  console.log('🤖 Telegram боты инициализированы');
} catch (error) {
  console.error('❌ Ошибка инициализации ботов:', error);
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

// Хранилище временных данных для регистрации/входа
const authSessions = new Map();

// Глобальный объект для хранения состояний пользователей (для админского бота)
const userStates = {};

// ===== ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ =====
async function initDB() {
  try {
    // Таблица пользователей
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        tg_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(100) NOT NULL,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        telegram_username VARCHAR(100),
        avatar_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица заказов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(50) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        items JSONB NOT NULL,
        total INTEGER NOT NULL,
        email VARCHAR(100),
        code VARCHAR(6),
        payment_id INTEGER,
        payment_status VARCHAR(20) DEFAULT 'pending',
        status VARCHAR(20) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        code_requested BOOLEAN DEFAULT FALSE,
        wrong_code_attempts INTEGER DEFAULT 0
      )
    `);

    // Таблица товаров
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

    // Индексы
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
  }
}

// ===== KEEP-ALIVE СИСТЕМА =====
app.get('/health', (req, res) => {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] Health check`);
  res.json({
    status: 'healthy',
    service: 'duck-shop-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/wakeup', (req, res) => {
  console.log(`🔔 Сервер разбужен`);
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

// ===== БОТ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ =====
userBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const params = match[1];
    
    console.log(`🟢 /start от ${userId}`);
    
    if (params) {
      const [action, token] = params.split('_');
      
      if (action === 'reg' && authSessions.has(token)) {
        // Регистрация
        await handleRegistration(msg, chatId, userId, token);
        return;
      } 
      else if (action === 'login' && authSessions.has(token)) {
        // Вход
        await handleLogin(msg, chatId, userId, token);
        return;
      }
    }
    
    // Стандартное приветствие
    await userBot.sendMessage(chatId, 
      `👋 Привет!\n\nЯ бот для авторизации в магазине Duck Shop.\n\n` +
      `Для входа или регистрации перейдите на сайт: ${SITE_URL}`
    );
    
  } catch (error) {
    console.error('❌ Ошибка обработки /start:', error);
  }
});

async function handleRegistration(msg, chatId, userId, token) {
  try {
    const userFirstName = msg.from.first_name || '';
    const userLastName = msg.from.last_name || '';
    const userUsername = msg.from.username || '';
    
    let username = userFirstName || userUsername || `User_${userId}`;
    
    // Сохраняем пользователя
    const result = await pool.query(
      `INSERT INTO users (tg_id, username, first_name, last_name, telegram_username) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (tg_id) DO UPDATE SET 
         last_login = CURRENT_TIMESTAMP
       RETURNING id`,
      [userId, username, userFirstName, userLastName, userUsername]
    );
    
    const user = result.rows[0];
    
    // Сохраняем сессию
    authSessions.set(`auth_${token}`, {
      userId: user.id,
      tgId: userId,
      username: username,
      type: 'auth_success'
    });
    
    // Удаляем временную сессию
    authSessions.delete(token);
    
    await userBot.sendMessage(chatId, 
      `✅ Регистрация успешна!\n\n` +
      `Вы можете вернуться в магазин.`
    );
    
  } catch (error) {
    console.error('❌ Ошибка регистрации:', error);
  }
}

async function handleLogin(msg, chatId, userId, token) {
  try {
    const result = await pool.query(
      'SELECT id, username FROM users WHERE tg_id = $1',
      [userId]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      
      // Обновляем время входа
      await pool.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );
      
      // Сохраняем сессию
      authSessions.set(`auth_${token}`, {
        userId: user.id,
        tgId: userId,
        username: user.username,
        type: 'auth_success'
      });
      
      authSessions.delete(token);
      
      await userBot.sendMessage(chatId, 
        `✅ Вход выполнен!\n\n` +
        `Добро пожаловать, ${user.username}!`
      );
    } else {
      await userBot.sendMessage(chatId, '❌ Пользователь не найден. Зарегистрируйтесь сначала.');
    }
  } catch (error) {
    console.error('❌ Ошибка входа:', error);
  }
}

userBot.onText(/\/help/, async (msg) => {
  await userBot.sendMessage(msg.chat.id, 
    `🆘 Помощь:\n\n` +
    `/start - начать работу\n` +
    `/profile - ваш профиль\n` +
    `/orders - ваши заказы`
  );
});

// ===== АДМИНСКИЙ БОТ =====
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

adminBot.onText(/\/start/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  await adminBot.sendMessage(msg.chat.id,
    `👋 Привет, администратор!\n\n` +
    `📋 Команды:\n` +
    `/orders - заказы\n` +
    `/stats - статистика\n` +
    `/products - товары`
  );
});

adminBot.onText(/\/orders/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT order_id, total, status FROM orders ORDER BY created_at DESC LIMIT 10'
    );
    
    let text = '📦 Последние заказы:\n\n';
    result.rows.forEach((order, i) => {
      text += `${i+1}. #${order.order_id} - ${formatRub(order.total)} - ${order.status}\n`;
    });
    
    await adminBot.sendMessage(msg.chat.id, text);
  } catch (error) {
    console.error('❌ Ошибка получения заказов:', error);
  }
});

// ===== API ДЛЯ САЙТА =====

// 1. Получение товаров
app.get('/api/products', async (req, res) => {
  console.log('📦 Запрос товаров');
  
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY price');
    
    // Если товаров нет, возвращаем стандартные
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        products: getDefaultProducts()
      });
    }
    
    res.json({ 
      success: true, 
      products: result.rows 
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    res.json({
      success: true,
      products: getDefaultProducts()
    });
  }
});

function getDefaultProducts() {
  return [
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
}

// 2. Создание заказа
app.post('/api/create-order', async (req, res) => {
  try {
    console.log('🛒 Создание заказа:', req.body);
    
    const { items, total, userId } = req.body;
    const orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    
    // Сохраняем в БД
    await pool.query(
      'INSERT INTO orders (order_id, items, total, user_id, status) VALUES ($1, $2, $3, $4, $5)',
      [orderId, items, total, userId || null, 'new']
    );
    
    // Если настроен Bilee Pay
    if (BILEE_SHOP_ID && BILEE_PASSWORD) {
      try {
        const paymentData = {
          order_id: orderId,
          method_slug: 'card',
          amount: total,
          description: `Заказ #${orderId}`,
          shop_id: parseInt(BILEE_SHOP_ID),
          notify_url: `${SERVER_URL}/api/bilee-webhook`,
          success_url: `${SITE_URL}/success.html?order=${orderId}`,
          fail_url: `${SITE_URL}/beta-duck.html?payment=fail&order=${orderId}`,
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
          
          return res.json({
            success: true,
            orderId: orderId,
            paymentUrl: bileeResponse.data.url
          });
        }
      } catch (paymentError) {
        console.error('⚠️ Ошибка Bilee Pay:', paymentError.message);
        // Продолжаем без платежной системы
      }
    }
    
    // Возвращаем успех без платежной ссылки
    res.json({
      success: true,
      orderId: orderId,
      message: 'Заказ создан'
    });
    
  } catch (error) {
    console.error('❌ Ошибка создания заказа:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// 3. Авторизация
app.post('/api/auth/start-register', async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    
    authSessions.set(token, {
      type: 'register',
      createdAt: Date.now()
    });
    
    res.json({
      success: true,
      token: token,
      telegramLink: `https://t.me/${USER_BOT_USERNAME}?start=reg_${token}`,
      message: 'Перейдите по ссылке в Telegram'
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/auth/start-login', async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    
    authSessions.set(token, {
      type: 'login',
      createdAt: Date.now()
    });
    
    res.json({
      success: true,
      token: token,
      telegramLink: `https://t.me/${USER_BOT_USERNAME}?start=login_${token}`,
      message: 'Перейдите по ссылке в Telegram'
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/auth/check/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const authKey = `auth_${token}`;
    
    if (authSessions.has(authKey)) {
      const session = authSessions.get(authKey);
      
      if (session.type === 'auth_success') {
        const userResult = await pool.query(
          'SELECT id, tg_id, username FROM users WHERE id = $1',
          [session.userId]
        );
        
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          
          // Удаляем сессию после использования
          authSessions.delete(authKey);
          
          return res.json({
            success: true,
            authenticated: true,
            user: {
              id: user.id,
              tgId: user.tg_id,
              username: user.username
            }
          });
        }
      }
    }
    
    res.json({
      success: true,
      authenticated: false,
      pending: authSessions.has(token)
    });
    
  } catch (error) {
    console.error('Ошибка проверки авторизации:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 4. Профиль пользователя
app.get('/api/auth/profile', async (req, res) => {
  try {
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }
    
    const userResult = await pool.query(
      'SELECT id, tg_id, username, created_at FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    const ordersResult = await pool.query(
      `SELECT order_id as id, total, status, created_at as date 
       FROM orders 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );
    
    res.json({
      success: true,
      user: {
        id: user.id,
        tgId: user.tg_id,
        username: user.username,
        createdAt: user.created_at
      },
      orders: ordersResult.rows
    });
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 5. Сохранение email для заказа
app.post('/api/save-email', async (req, res) => {
  try {
    const { orderId, email } = req.body;
    
    await pool.query(
      'UPDATE orders SET email = $1 WHERE order_id = $2',
      [email, orderId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка сохранения email:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 6. Статус заказа
app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT status, payment_status, email FROM orders WHERE order_id = $1',
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
      hasEmail: !!order.email
    });
  } catch (error) {
    console.error('Ошибка проверки статуса:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 7. Проверка запроса кода
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
    
    res.json({
      success: true,
      codeRequested: result.rows[0].code_requested || false,
      status: result.rows[0].status
    });
  } catch (error) {
    console.error('Ошибка проверки запроса кода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 8. Проверка кода
app.post('/api/verify-code', async (req, res) => {
  try {
    const { orderId, code } = req.body;
    
    await pool.query(
      'UPDATE orders SET code = $1 WHERE order_id = $2',
      [code, orderId]
    );
    
    res.json({ 
      success: true, 
      status: 'waiting'
    });
  } catch (error) {
    console.error('Ошибка проверки кода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== ЗАГРУЗКА СТАНДАРТНЫХ ТОВАРОВ =====
async function loadDefaultProducts() {
  try {
    const defaultProducts = getDefaultProducts();
    
    for (const product of defaultProducts) {
      await pool.query(
        `INSERT INTO products (id, name, price, image_url, is_gift) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (id) DO NOTHING`,
        [product.id, product.name, product.price, product.image_url, product.is_gift]
      );
    }
    
    console.log('✅ Стандартные товары загружены');
  } catch (error) {
    console.error('❌ Ошибка загрузки товаров:', error);
  }
}

// ===== ЗАПУСК СЕРВЕРА =====
async function startServer() {
  try {
    // Инициализация БД
    await initDB();
    
    // Загрузка стандартных товаров
    await loadDefaultProducts();
    
    // Запуск сервера
    app.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
      console.log(`📡 API: ${SERVER_URL}`);
      console.log(`🏥 Health: ${SERVER_URL}/health`);
      console.log(`🛒 Products: ${SERVER_URL}/api/products`);
      console.log(`🤖 Админ бот: @${adminBot.options.username}`);
      console.log(`👤 Бот пользователей: @${userBot.options.username}`);
      console.log(`🌐 Сайт: ${SITE_URL}`);
      
      if (process.env.NODE_ENV === 'production') {
        console.log('⚡ Режим: Production');
      } else {
        console.log('🔧 Режим: Development');
      }
    });
    
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

// Обработчики завершения
process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, завершаем работу...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Получен SIGINT, завершаем работу...');
  process.exit(0);
});

// Запускаем сервер
startServer().catch(error => {
  console.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
