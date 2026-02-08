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
const USER_BOT_TOKEN = process.env.USER_BOT_TOKEN;
const USER_BOT_USERNAME = process.env.USER_BOT_USERNAME;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const SERVER_URL = process.env.SERVER_URL;
const SITE_URL = process.env.SITE_URL;

// ===== ИНИЦИАЛИЗАЦИЯ =====
app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Два Telegram бота
let adminBot;
let userBot;

try {
  if (process.env.NODE_ENV === 'production') {
    adminBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
      polling: {
        timeout: 10,
        interval: 300,
        autoStart: true
      }
    });
    userBot = new TelegramBot(USER_BOT_TOKEN, { 
      polling: {
        timeout: 10,
        interval: 300,
        autoStart: true
      }
    });
  } else {
    adminBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    userBot = new TelegramBot(USER_BOT_TOKEN, { polling: true });
  }
  console.log('🤖 Telegram боты инициализированы');
} catch (error) {
  console.error('❌ Ошибка инициализации ботов:', error);
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

// Хранилище временных данных для регистрации/входа
const authSessions = new Map();

// Глобальный объект для хранения состояний пользователей (для админского бота)
const userStates = {};

async function initDB() {
  try {
    // Таблица пользователей (с новыми полями)
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

    // Добавляем отсутствующие столбцы если их нет
    const columnsToAdd = [
      { name: 'first_name', type: 'VARCHAR(100)' },
      { name: 'last_name', type: 'VARCHAR(100)' },
      { name: 'telegram_username', type: 'VARCHAR(100)' },
      { name: 'avatar_url', type: 'TEXT' }
    ];
    
    for (const column of columnsToAdd) {
      try {
        await pool.query(`
          ALTER TABLE users 
          ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}
        `);
        console.log(`ℹ️ Столбец ${column.name} добавлен в таблицу users`);
      } catch (e) {
        console.log(`ℹ️ Столбец ${column.name} уже существует:`, e.message);
      }
    }

    // Таблица заказов (обновляем)
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
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const ordersColumnsToAdd = [
      { name: 'code_requested', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'wrong_code_attempts', type: 'INTEGER DEFAULT 0' },
      { name: 'user_id', type: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' }
    ];
    
    for (const column of ordersColumnsToAdd) {
      try {
        await pool.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}
        `);
        console.log(`ℹ️ Столбец ${column.name} добавлен в таблицу orders`);
      } catch (e) {
        console.log(`ℹ️ Столбец ${column.name} уже существует:`, e.message);
      }
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

// ===== БОТ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ =====
userBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const params = match[1];
  
  try {
    // Получаем информацию о пользователе из Telegram
    const userFirstName = msg.from.first_name || '';
    const userLastName = msg.from.last_name || '';
    const userUsername = msg.from.username || '';
    const fullName = `${userFirstName} ${userLastName}`.trim() || userUsername || `Пользователь ${userId}`;
    
    if (params) {
      const [action, token] = params.split('_');
      
      if (action === 'reg' && authSessions.has(token)) {
        const session = authSessions.get(token);
        
        if (session.type === 'register') {
          console.log(`📝 Регистрация пользователя ${userId} (${fullName})`);
          
          // Генерируем username из данных Telegram
          let username = '';
          
          // Пробуем разные варианты для username
          if (userFirstName && userLastName) {
            username = `${userFirstName} ${userLastName}`;
          } else if (userFirstName) {
            username = userFirstName;
          } else if (userLastName) {
            username = userLastName;
          } else if (userUsername) {
            username = userUsername;
          } else {
            // Если ничего нет, используем ID
            username = `User_${userId}`;
          }
          
          // Ограничиваем длину username
          if (username.length > 50) {
            username = username.substring(0, 47) + '...';
          }
          
          // Получаем фото профиля пользователя из Telegram
          let photoUrl = null;
          try {
            const photos = await userBot.getUserProfilePhotos(userId, { limit: 1 });
            if (photos && photos.total_count > 0 && photos.photos[0] && photos.photos[0][0]) {
              const file = await userBot.getFile(photos.photos[0][0].file_id);
              if (file && file.file_path) {
                photoUrl = `https://api.telegram.org/file/bot${USER_BOT_TOKEN}/${file.file_path}`;
                console.log(`📸 Получена аватарка пользователя: ${photoUrl}`);
              }
            }
          } catch (photoError) {
            console.log('ℹ️ Не удалось получить фото профиля:', photoError.message);
          }
          
          // Регистрация пользователя с данными из Telegram
          const result = await pool.query(
            `INSERT INTO users (tg_id, username, avatar_url, first_name, last_name, telegram_username) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             ON CONFLICT (tg_id) DO UPDATE SET 
               last_login = CURRENT_TIMESTAMP, 
               avatar_url = COALESCE($3, users.avatar_url),
               first_name = COALESCE($4, users.first_name),
               last_name = COALESCE($5, users.last_name),
               telegram_username = COALESCE($6, users.telegram_username)
             RETURNING id`,
            [userId, username, photoUrl, userFirstName, userLastName, userUsername]
          );
          
          const user = result.rows[0];
          console.log(`✅ Пользователь зарегистрирован с ID: ${user.id}, username: ${username}`);
          
          // Сохраняем токен для верификации с полными данными из БД
          authSessions.set(`auth_${token}`, {
            userId: user.id,
            tgId: userId,
            username: username,
            firstName: userFirstName,
            lastName: userLastName,
            telegramUsername: userUsername,
            avatarUrl: photoUrl,
            type: 'auth_success'
          });
          
          // Удаляем сессию регистрации
          authSessions.delete(token);
          
          const keyboard = {
            inline_keyboard: [[
              { 
                text: '✅ Перейти в магазин', 
                url: `${SITE_URL}/main.html?auth=${token}` 
              }
            ]]
          };
          
          const welcomeText = `✅ Регистрация успешна!\n\n` +
            `👤 Ваш профиль:\n` +
            `🆔 TG ID: ${userId}\n` +
            `📛 Имя: ${username}\n` +
            (userFirstName ? `👤 Имя в TG: ${userFirstName}\n` : '') +
            (userLastName ? `👤 Фамилия: ${userLastName}\n` : '') +
            (userUsername ? `👤 Username: @${userUsername}\n` : '') +
            (photoUrl ? `🖼️ Аватарка: получена\n` : '') +
            `\nНажмите кнопку ниже для перехода в магазин:`;
          
          await userBot.sendMessage(chatId, welcomeText, { reply_markup: keyboard });
          
          // Отправляем администратору уведомление о новой регистрации
          try {
            const adminText = `👤 Новый пользователь зарегистрировался!\n\n` +
              `🆔 TG ID: ${userId}\n` +
              `📛 Имя: ${username}\n` +
              (userFirstName ? `👤 Имя в TG: ${userFirstName}\n` : '') +
              (userLastName ? `👤 Фамилия: ${userLastName}\n` : '') +
              (userUsername ? `👤 Username: @${userUsername}\n` : '') +
              `📅 Дата: ${new Date().toLocaleString('ru-RU')}`;
            
            await adminBot.sendMessage(ADMIN_ID, adminText);
          } catch (adminError) {
            console.log('⚠️ Не удалось отправить уведомление администратору:', adminError.message);
          }
          
          return;
        }
      } 
      else if (action === 'login' && authSessions.has(token)) {
        const session = authSessions.get(token);
        
        if (session.type === 'login') {
          console.log(`🔐 Вход пользователя ${userId} (${fullName})`);
          
          // Проверяем, есть ли пользователь
          const userResult = await pool.query(
            'SELECT id, username, avatar_url FROM users WHERE tg_id = $1',
            [userId]
          );
          
          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            
            // Получаем актуальное фото профиля (на случай если изменилось)
            let photoUrl = user.avatar_url;
            try {
              const photos = await userBot.getUserProfilePhotos(userId, { limit: 1 });
              if (photos && photos.total_count > 0 && photos.photos[0] && photos.photos[0][0]) {
                const file = await userBot.getFile(photos.photos[0][0].file_id);
                if (file && file.file_path) {
                  photoUrl = `https://api.telegram.org/file/bot${USER_BOT_TOKEN}/${file.file_path}`;
                  
                  // Обновляем аватарку в БД если она изменилась
                  await pool.query(
                    'UPDATE users SET avatar_url = $1 WHERE id = $2',
                    [photoUrl, user.id]
                  );
                }
              }
            } catch (photoError) {
              console.log('ℹ️ Не удалось обновить фото профиля:', photoError.message);
            }
            
            // Обновляем время входа и информацию
            await pool.query(
              `UPDATE users SET 
                last_login = CURRENT_TIMESTAMP,
                first_name = COALESCE($1, first_name),
                last_name = COALESCE($2, last_name),
                telegram_username = COALESCE($3, telegram_username),
                avatar_url = COALESCE($4, avatar_url)
               WHERE id = $5`,
              [userFirstName, userLastName, userUsername, photoUrl, user.id]
            );
            
            // Получаем полные данные пользователя для сессии
            const fullUserResult = await pool.query(
              'SELECT username, first_name, last_name, telegram_username, avatar_url FROM users WHERE id = $1',
              [user.id]
            );
            
            const fullUser = fullUserResult.rows[0];
            
            // Сохраняем токен для верификации с полными данными
            authSessions.set(`auth_${token}`, {
              userId: user.id,
              tgId: userId,
              username: fullUser.username,
              firstName: fullUser.first_name,
              lastName: fullUser.last_name,
              telegramUsername: fullUser.telegram_username,
              avatarUrl: fullUser.avatar_url,
              type: 'auth_success'
            });
            
            // Удаляем сессию входа
            authSessions.delete(token);
            
            const keyboard = {
              inline_keyboard: [[
                { 
                  text: '✅ Перейти в магазин', 
                  url: `${SITE_URL}/main.html?auth=${token}` 
                }
              ]]
            };
            
            const welcomeText = `✅ Вход выполнен!\n\n` +
              `👤 Ваш профиль:\n` +
              `🆔 TG ID: ${userId}\n` +
              `📛 Имя: ${fullUser.username}\n` +
              (fullUser.first_name ? `👤 Имя в TG: ${fullUser.first_name}\n` : '') +
              (fullUser.last_name ? `👤 Фамилия: ${fullUser.last_name}\n` : '') +
              (fullUser.telegram_username ? `👤 Username: @${fullUser.telegram_username}\n` : '') +
              `\nНажмите кнопку ниже для перехода в магазин:`;
            
            await userBot.sendMessage(chatId, welcomeText, { reply_markup: keyboard });
            
            return;
          } else {
            // Пользователь не найден - предлагаем зарегистрироваться
            await userBot.sendMessage(chatId, 
              `❌ Аккаунт не найден!\n\n` +
              `Похоже, вы еще не зарегистрированы в нашем магазине.\n` +
              `Пожалуйста, перейдите на сайт магазина и нажмите "Зарегистрироваться".\n\n` +
              `Ссылка на магазин: ${SITE_URL}`
            );
            
            // Удаляем невалидную сессию
            authSessions.delete(token);
            return;
          }
        }
      }
    }
    
    // Стандартное приветствие
    const keyboard = {
      inline_keyboard: [[
        { 
          text: '🛒 Перейти в магазин', 
          url: SITE_URL 
        }
      ]]
    };
    
    await userBot.sendMessage(chatId, 
      `👋 Привет${userFirstName ? `, ${userFirstName}` : ''}!\n\n` +
      `Я бот для авторизации в магазине Duck Shop.\n\n` +
      `Для входа или регистрации:\n` +
      `1. Перейдите на сайт магазина\n` +
      `2. Нажмите кнопку "Войти"\n` +
      `3. Выберите "Войти" или "Зарегистрироваться"\n` +
      `4. Перейдите по полученной ссылке\n\n` +
      `Это быстро, безопасно и не требует ввода пароля!`, 
      { reply_markup: keyboard }
    );
    
  } catch (error) {
    console.error('❌ Ошибка обработки /start в userBot:', error);
    
    try {
      await userBot.sendMessage(chatId, 
        `❌ Произошла ошибка при обработке вашего запроса.\n\n` +
        `Пожалуйста, попробуйте:\n` +
        `1. Перезагрузить страницу магазина\n` +
        `2. Повторить попытку авторизации\n` +
        `3. Если проблема persists, свяжитесь с поддержкой\n\n` +
        `Ссылка на магазин: ${SITE_URL}`
      );
    } catch (sendError) {
      console.error('❌ Не удалось отправить сообщение об ошибке:', sendError);
    }
  }
});

// Обработка команды /help
userBot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpText = `🆘 Помощь по боту авторизации\n\n` +
    `Этот бот используется для входа и регистрации в магазине Duck Shop.\n\n` +
    `📋 Как это работает:\n` +
    `1. На сайте магазина нажмите "Войти"\n` +
    `2. Выберите "Войти" или "Зарегистрироваться"\n` +
    `3. Введите данные (для регистрации)\n` +
    `4. Перейдите по полученной ссылке сюда\n` +
    `5. Бот подтвердит вашу личность\n` +
    `6. Вы автоматически вернетесь в магазин\n\n` +
    `🔐 Безопасность:\n` +
    `• Бот не хранит ваши пароли\n` +
    `• Используется безопасное соединение\n` +
    `• Ваши данные защищены\n\n` +
    `📞 Поддержка:\n` +
    `Если у вас возникли проблемы, свяжитесь с администратором магазина.\n\n` +
    `Ссылка на магазин: ${SITE_URL}`;
  
  await userBot.sendMessage(chatId, helpText);
});

// Обработка команды /profile
userBot.onText(/\/profile/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    const userResult = await pool.query(
      'SELECT id, username, first_name, last_name, telegram_username, avatar_url, created_at, last_login FROM users WHERE tg_id = $1',
      [userId]
    );
    
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const createdDate = new Date(user.created_at).toLocaleDateString('ru-RU');
      const lastLoginDate = new Date(user.last_login).toLocaleDateString('ru-RU');
      
      let profileText = `👤 Ваш профиль в магазине:\n\n` +
        `📛 Имя: ${user.username}\n` +
        `🆔 ID в магазине: ${user.id}\n` +
        `🆔 TG ID: ${userId}\n` +
        (user.first_name ? `👤 Имя в TG: ${user.first_name}\n` : '') +
        (user.last_name ? `👤 Фамилия в TG: ${user.last_name}\n` : '') +
        (user.telegram_username ? `👤 Username: @${user.telegram_username}\n` : '') +
        `📅 Дата регистрации: ${createdDate}\n` +
        `📅 Последний вход: ${lastLoginDate}\n\n` +
        `Вы можете войти в магазин по ссылке ниже:`;
      
      const keyboard = {
        inline_keyboard: [[
          { 
            text: '🛒 Перейти в магазин', 
            url: SITE_URL 
          }
        ]]
      };
      
      // Если есть аватарка, отправляем ее
      if (user.avatar_url) {
        try {
          await userBot.sendPhoto(chatId, user.avatar_url, {
            caption: profileText,
            reply_markup: keyboard
          });
          return;
        } catch (photoError) {
          console.log('Не удалось отправить фото:', photoError.message);
        }
      }
      
      await userBot.sendMessage(chatId, profileText, { reply_markup: keyboard });
      
    } else {
      await userBot.sendMessage(chatId, 
        `❌ Вы еще не зарегистрированы в магазине.\n\n` +
        `Пожалуйста, перейдите на сайт и нажмите "Зарегистрироваться".\n\n` +
        `Ссылка на магазин: ${SITE_URL}`
      );
    }
  } catch (error) {
    console.error('Ошибка обработки /profile:', error);
    await userBot.sendMessage(chatId, '❌ Произошла ошибка при получении профиля.');
  }
});

// Обработка команды /orders
userBot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    const userResult = await pool.query(
      'SELECT id FROM users WHERE tg_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      await userBot.sendMessage(chatId, 
        `❌ Вы еще не зарегистрированы в магазине.\n\n` +
        `Пожалуйста, сначала зарегистрируйтесь на сайте.`
      );
      return;
    }
    
    const user = userResult.rows[0];
    
    const ordersResult = await pool.query(
      `SELECT order_id, total, status, created_at 
       FROM orders 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 5`,
      [user.id]
    );
    
    if (ordersResult.rows.length === 0) {
      await userBot.sendMessage(chatId, 
        `📭 У вас пока нет заказов.\n\n` +
        `Перейдите в магазин, чтобы сделать первую покупку!`
      );
      return;
    }
    
    let ordersText = `📦 Ваши последние заказы:\n\n`;
    
    ordersResult.rows.forEach((order, index) => {
      const orderDate = new Date(order.created_at).toLocaleDateString('ru-RU');
      const statusText = getStatusText(order.status);
      ordersText += `${index + 1}. Заказ #${order.order_id}\n`;
      ordersText += `   💰 Сумма: ${formatRub(order.total)}\n`;
      ordersText += `   📊 Статус: ${statusText}\n`;
      ordersText += `   📅 Дата: ${orderDate}\n\n`;
    });
    
    const keyboard = {
      inline_keyboard: [[
        { 
          text: '🛒 Перейти в магазин', 
          url: SITE_URL 
        }
      ]]
    };
    
    await userBot.sendMessage(chatId, ordersText, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Ошибка обработки /orders:', error);
    await userBot.sendMessage(chatId, '❌ Произошла ошибка при получении заказов.');
  }
});

// Функция для получения username бота
async function getBotUsername() {
  try {
    // Сначала пробуем из переменной окружения
    if (USER_BOT_USERNAME) {
      return USER_BOT_USERNAME;
    }
    
    // Пробуем получить из бота
    const botInfo = await userBot.getMe();
    if (botInfo && botInfo.username) {
      return botInfo.username;
    }
    
    return null;
  } catch (error) {
    console.error('Ошибка получения username бота:', error);
    return null;
  }
}

// Функция для генерации ссылки на бота
async function generateBotLink(action, token) {
  const botUsername = await getBotUsername();
  
  if (!botUsername) {
    throw new Error('Бот не имеет username. Установите username через @BotFather или задайте USER_BOT_USERNAME в .env');
  }
  
  return `https://t.me/${botUsername}?start=${action}_${token}`;
}

// ===== АДМИНСКИЙ БОТ (существующая логика) =====
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

// Команда /start
adminBot.onText(/\/start/, async (msg) => {
  if (!isAdmin(msg)) {
    adminBot.sendMessage(msg.chat.id, '⛔ Доступ запрещен');
    return;
  }
  
  const welcomeText = `👋 Привет, администратор!\n\n📋 Доступные команды:\n/orders - просмотреть заказы\n/stats - статистика магазина\n/products - список товаров\n/add_product - добавить товар\n/edit_price - изменить цену товара\n/delete_product - удалить товар\n/cancel - отменить текущее действие\n\nℹ️ Для добавления товара используйте /add_product\n💰 Для изменения цены используйте /edit_price`;
  adminBot.sendMessage(msg.chat.id, welcomeText);
});

// Команда /stats
adminBot.onText(/\/stats/, async (msg) => {
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
    
    await adminBot.sendMessage(msg.chat.id, statsText);
  } catch (error) {
    console.error('❌ Ошибка получения статистики:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении статистики');
  }
});

// Команда /products
adminBot.onText(/\/products/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT id, name, price, is_gift FROM products ORDER BY created_at DESC'
    );
    
    if (result.rows.length === 0) {
      adminBot.sendMessage(msg.chat.id, '📭 Нет товаров в базе данных');
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
          { text: '💰 Изменить цену', callback_data: 'edit_price_list' }
        ],
        [
          { text: '🗑️ Удалить товар', callback_data: 'delete_product_list' }
        ]
      ]
    };
    
    adminBot.sendMessage(msg.chat.id, productsText, { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
});

// Команда /add_product
adminBot.onText(/\/add_product/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  userStates[chatId] = {
    step: 'awaiting_name',
    productData: {}
  };
  
  adminBot.sendMessage(chatId, '📝 Давайте добавим новый товар.\n\nШаг 1/4: Введите название товара:');
});

// Команда /edit_price (НОВАЯ КОМАНДА)
adminBot.onText(/\/edit_price/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT id, name, price FROM products ORDER BY name'
    );
    
    if (result.rows.length === 0) {
      adminBot.sendMessage(msg.chat.id, '📭 Нет товаров для изменения цены');
      return;
    }
    
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        { text: `${product.name} - ${formatRub(product.price)}`, callback_data: `edit_price:${product.id}` }
      ])
    };
    
    adminBot.sendMessage(msg.chat.id, '💰 Выберите товар для изменения цены:', { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
});

// Команда /delete_product
adminBot.onText(/\/delete_product/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT id, name, price FROM products ORDER BY name'
    );
    
    if (result.rows.length === 0) {
      adminBot.sendMessage(msg.chat.id, '📭 Нет товаров для удаления');
      return;
    }
    
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        { text: `${product.name} - ${formatRub(product.price)}`, callback_data: `delete_product:${product.id}` }
      ])
    };
    
    adminBot.sendMessage(msg.chat.id, '🗑️ Выберите товар для удаления:', { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения товаров:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка товаров');
  }
});

// Команда /orders
adminBot.onText(/\/orders/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT order_id, total, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10'
    );
    
    if (result.rows.length === 0) {
      adminBot.sendMessage(msg.chat.id, '📭 Нет заказов');
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
    
    adminBot.sendMessage(msg.chat.id, ordersText, { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения заказов:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении заказов');
  }
});

// Команда /cancel
adminBot.onText(/\/cancel/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  if (userStates[chatId]) {
    delete userStates[chatId];
    adminBot.sendMessage(chatId, '❌ Текущее действие отменено.');
  }
});

// Обработка текстовых сообщений (для добавления товара и изменения цены)
adminBot.on('message', async (msg) => {
  if (!isAdmin(msg) || !msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const userState = userStates[chatId];
  
  if (userState && userState.step) {
    if (userState.action === 'edit_price') {
      await handleEditPriceStep(msg, userState);
    } else {
      await handleAddProductStep(msg, userState);
    }
  }
});

// Обработка шагов изменения цены
async function handleEditPriceStep(msg, userState) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  
  try {
    switch(userState.step) {
      case 'awaiting_new_price':
        const price = parseInt(text);
        if (isNaN(price) || price < 10 || price > 10000) {
          adminBot.sendMessage(chatId, '❌ Цена должна быть числом от 10 до 10000 рублей. Введите цену еще раз:');
          return;
        }
        
        // Сохраняем новую цену
        const productId = userState.productId;
        const productName = userState.productName;
        const oldPrice = userState.oldPrice;
        
        // Обновляем цену в базе данных
        await pool.query(
          'UPDATE products SET price = $1 WHERE id = $2',
          [price, productId]
        );
        
        const successText = `✅ Цена товара изменена!\n\n🏷️ Товар: ${productName}\n🆔 ID: ${productId}\n💰 Было: ${formatRub(oldPrice)}\n💰 Стало: ${formatRub(price)}`;
        
        delete userStates[chatId];
        
        adminBot.sendMessage(chatId, successText);
        
        // Отправляем уведомление об изменении
        const notificationText = `💰 Цена товара изменена администратором\n\n🏷️ Товар: ${productName}\n💰 Было: ${formatRub(oldPrice)}\n💰 Стало: ${formatRub(price)}\n📅 Дата: ${new Date().toLocaleString('ru-RU')}`;
        await adminBot.sendMessage(ADMIN_ID, notificationText);
        break;
    }
  } catch (error) {
    console.error('❌ Ошибка изменения цены:', error);
    adminBot.sendMessage(chatId, '❌ Произошла ошибка. Начните заново командой /edit_price');
    delete userStates[chatId];
  }
}

async function handleAddProductStep(msg, userState) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  
  try {
    switch(userState.step) {
      case 'awaiting_name':
        if (text.length < 2 || text.length > 100) {
          adminBot.sendMessage(chatId, '❌ Название должно быть от 2 до 100 символов. Введите название еще раз:');
          return;
        }
        userState.productData.name = text;
        userState.step = 'awaiting_price';
        adminBot.sendMessage(chatId, '✅ Название сохранено.\n\nШаг 2/4: Введите цену товара (в рублях, только цифры):');
        break;
        
      case 'awaiting_price':
        const price = parseInt(text);
        if (isNaN(price) || price < 10 || price > 10000) {
          adminBot.sendMessage(chatId, '❌ Цена должна быть числом от 10 до 10000 рублей. Введите цену еще раз:');
          return;
        }
        userState.productData.price = price;
        userState.step = 'awaiting_image';
        adminBot.sendMessage(chatId, '✅ Цена сохранена.\n\nШаг 3/4: Введите URL изображения товара:');
        break;
        
      case 'awaiting_image':
        if (!text.startsWith('http://') && !text.startsWith('https://')) {
          adminBot.sendMessage(chatId, '❌ URL должен начинаться с http:// или https://. Введите URL еще раз:');
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
        adminBot.sendMessage(chatId, '✅ URL изображения сохранен.\n\nШаг 4/4: Это подарочный товар?', keyboard);
        break;
        
      case 'awaiting_gift':
        adminBot.sendMessage(chatId, 'ℹ️ Пожалуйста, используйте кнопки выше для выбора типа товара.');
        return;
    }
    
    userStates[chatId] = userState;
  } catch (error) {
    console.error('❌ Ошибка обработки шага:', error);
    adminBot.sendMessage(chatId, '❌ Произошла ошибка. Начните заново командой /add_product');
    delete userStates[chatId];
  }
}

// Основной обработчик callback-кнопок админского бота
adminBot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  
  if (!isAdmin(callbackQuery)) {
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
      text: '⛔ Доступ запрещен',
      show_alert: true 
    });
    return;
  }
  
  try {
    if (data.startsWith('order_detail:')) {
      const orderId = data.split(':')[1];
      await showOrderDetails(msg.chat.id, msg.message_id, orderId);
      await adminBot.answerCallbackQuery(callbackQuery.id);
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
        await adminBot.answerCallbackQuery(callbackQuery.id);
        break;
      case 'force_complete':
        await completeOrder(params[0], msg, callbackQuery.id);
        break;
      case 'add_product_prompt':
        await adminBot.answerCallbackQuery(callbackQuery.id);
        adminBot.sendMessage(msg.chat.id, '📝 Отправьте команду /add_product чтобы начать добавление товара');
        break;
      case 'edit_price_list':
        await handleEditPriceList(msg, callbackQuery.id);
        break;
      case 'edit_price':
        await handleEditPrice(params[0], msg, callbackQuery.id);
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
        await adminBot.answerCallbackQuery(callbackQuery.id, { text: '❌ Добавление отменено' });
        await adminBot.editMessageText('❌ Добавление товара отменено.', {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        break;
      default:
        await adminBot.answerCallbackQuery(callbackQuery.id, { 
          text: '⚠️ Неизвестная команда',
          show_alert: true 
        });
    }
  } catch (error) {
    console.error('❌ Ошибка обработки callback:', error);
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
      text: '❌ Ошибка обработки запроса',
      show_alert: true 
    });
  }
});

// Обработка списка товаров для изменения цены
async function handleEditPriceList(msg, callbackQueryId) {
  try {
    const result = await pool.query(
      'SELECT id, name, price FROM products ORDER BY name'
    );
    
    if (result.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { text: '📭 Нет товаров для изменения цены' });
      return;
    }
    
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        { text: `${product.name} - ${formatRub(product.price)}`, callback_data: `edit_price:${product.id}` }
      ])
    };
    
    await adminBot.editMessageText('💰 Выберите товар для изменения цены:', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId);
  } catch (error) {
    console.error('❌ Ошибка получения списка товаров:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при получении списка товаров',
      show_alert: true 
    });
  }
}

// Обработка выбора товара для изменения цены
async function handleEditPrice(productId, msg, callbackQueryId) {
  try {
    const productResult = await pool.query(
      'SELECT name, price FROM products WHERE id = $1',
      [productId]
    );
    
    if (productResult.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Товар не найден',
        show_alert: true 
      });
      return;
    }
    
    const product = productResult.rows[0];
    const chatId = msg.chat.id;
    
    // Сохраняем состояние для изменения цены
    userStates[chatId] = {
      action: 'edit_price',
      step: 'awaiting_new_price',
      productId: productId,
      productName: product.name,
      oldPrice: product.price
    };
    
    const infoText = `💰 Изменение цены товара\n\n🏷️ Товар: ${product.name}\n🆔 ID: ${productId}\n💰 Текущая цена: ${formatRub(product.price)}\n\nВведите новую цену (в рублях, только цифры):`;
    
    await adminBot.editMessageText(infoText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: 'Введите новую цену',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка выбора товара для изменения цены:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleSetGift(isGift, msg, callbackQueryId) {
  const chatId = msg.chat.id;
  const userState = userStates[chatId];
  
  if (!userState || userState.step !== 'awaiting_gift') {
    await adminBot.answerCallbackQuery(callbackQueryId, { text: '❌ Сессия устарела. Начните заново командой /add_product' });
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
    
    await adminBot.editMessageText(successText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Товар добавлен!',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка сохранения товара:', error);
    delete userStates[chatId];
    await adminBot.editMessageText('❌ Ошибка при сохранении товара. Попробуйте еще раз командой /add_product', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка сохранения',
      show_alert: true
    });
  }
}

async function handleRequestCode(orderId, msg, callbackQueryId) {
  try {
    console.log(`📝 Запрос кода для заказа ${orderId}`);
    
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
    
    await adminBot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Код запрошен у пользователя',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка запроса кода:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при запросе кода',
      show_alert: true
    });
  }
}

async function handleWrongCode(orderId, msg, callbackQueryId) {
  try {
    console.log(`❌ Отмечаем код как неверный для заказа ${orderId}`);
    
    const orderResult = await pool.query(
      'SELECT wrong_code_attempts, email FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Заказ не найден',
        show_alert: true 
      });
      return;
    }
    
    const currentAttempts = orderResult.rows[0].wrong_code_attempts || 0;
    const newAttempts = currentAttempts + 1;
    
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
    
    await adminBot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Код отмечен неверным',
      show_alert: false 
    });
  } catch (error) {
    console.error('❌ Ошибка отметки кода как неверного:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
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
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Заказ не найден',
        show_alert: true 
      });
      return;
    }
    
    const order = orderResult.rows[0];
    if (order.status === 'completed') {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
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
      
      await adminBot.editMessageText(`⚠️ Внимание!\n\nКод был запрошен у пользователя, но он еще не ввел его.\n\nВы уверены, что хотите завершить заказ без кода?`, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: confirmKeyboard
      });
      
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '⚠️ Требуется подтверждение',
        show_alert: false 
      });
      return;
    }
    
    await completeOrder(orderId, msg, callbackQueryId);
  } catch (error) {
    console.error('❌ Ошибка отметки заказа как готового:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
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
  
  await adminBot.editMessageText(message, {
    chat_id: msg.chat.id,
    message_id: msg.message_id
  });
  
  await adminBot.answerCallbackQuery(callbackQueryId, { 
    text: '✅ Заказ отмечен как готовый',
    show_alert: false
  });
}

async function handleOrderReady(orderId, msg, callbackQueryId) {
  try {
    console.log(`✅ Подтверждаем код для заказа ${orderId}`);
    const orderResult = await pool.query(
      'SELECT code, email, total FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Заказ не найден',
        show_alert: true 
      });
      return;
    }
    
    const order = orderResult.rows[0];
    if (!order.code) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
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
    
    await adminBot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Заказ завершен',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка подтверждения кода:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
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
      await adminBot.answerCallbackQuery(callbackQueryId, { text: '📭 Нет товаров для удаления' });
      return;
    }
    
    const keyboard = {
      inline_keyboard: result.rows.map(product => [
        { text: `${product.name} - ${formatRub(product.price)}`, callback_data: `delete_product:${product.id}` }
      ])
    };
    
    await adminBot.editMessageText('🗑️ Выберите товар для удаления:', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId);
  } catch (error) {
    console.error('❌ Ошибка получения списка товаров:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
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
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Товар не найден',
        show_alert: true 
      });
      return;
    }
    
    const product = productResult.rows[0];
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    
    const successText = `🗑️ Товар удален!\n\nНазвание: ${product.name}\nЦена: ${formatRub(product.price)}\nID: ${productId}`;
    
    await adminBot.editMessageText(successText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Товар удален',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка удаления товара:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при удалении товара',
      show_alert: true 
    });
  }
}

async function showOrderDetails(chatId, messageId, orderId) {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      await adminBot.editMessageText('❌ Заказ не найден', {
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
    
    await adminBot.editMessageText(orderText, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Ошибка показа деталей заказа:', error);
    await adminBot.editMessageText('❌ Ошибка при получении деталей заказа', {
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
      await adminBot.editMessageText('📭 Нет заказов', {
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
    
    await adminBot.editMessageText(ordersText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Ошибка возврата к заказам:', error);
  }
}

// ===== API ДЛЯ АВТОРИЗАЦИИ =====

// 1. Начать регистрацию (УПРОЩЕННАЯ ВЕРСИЯ - без запроса имени)
app.post('/api/auth/start-register', async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    
    try {
      const telegramLink = await generateBotLink('reg', token);
      
      // Сохраняем сессию БЕЗ username - он будет получен из Telegram
      authSessions.set(token, {
        type: 'register',
        createdAt: Date.now()
      });
      
      // Очищаем старые сессии (старше 10 минут)
      for (const [key, session] of authSessions.entries()) {
        if (Date.now() - session.createdAt > 10 * 60 * 1000) {
          authSessions.delete(key);
        }
      }
      
      res.json({
        success: true,
        token: token,
        telegramLink: telegramLink,
        message: 'Перейдите по ссылке в Telegram бота для завершения регистрации'
      });
    } catch (linkError) {
      console.error('Ошибка генерации ссылки:', linkError);
      res.status(500).json({ 
        success: false, 
        error: 'Ошибка генерации ссылки на бота. Проверьте настройки бота.' 
      });
    }
  } catch (error) {
    console.error('Ошибка начала регистрации:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});
// 2. Начать вход
app.post('/api/auth/start-login', async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    
    try {
      const telegramLink = await generateBotLink('login', token);
      
      // Сохраняем сессию
      authSessions.set(token, {
        type: 'login',
        createdAt: Date.now()
      });
      
      // Очищаем старые сессии
      for (const [key, session] of authSessions.entries()) {
        if (Date.now() - session.createdAt > 10 * 60 * 1000) {
          authSessions.delete(key);
        }
      }
      
      res.json({
        success: true,
        token: token,
        telegramLink: telegramLink,
        message: 'Перейдите по ссылке в Telegram бота для входа'
      });
    } catch (linkError) {
      console.error('Ошибка генерации ссылки:', linkError);
      res.status(500).json({ 
        success: false, 
        error: 'Ошибка генерации ссылки на бота. Проверьте настройки бота.' 
      });
    }
  } catch (error) {
    console.error('Ошибка начала входа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 3. Проверить статус авторизации
app.get('/api/auth/check/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const authKey = `auth_${token}`;
    
    if (authSessions.has(authKey)) {
      const session = authSessions.get(authKey);
      
      if (session.type === 'auth_success') {
        // Получаем полные данные пользователя из БД
        const userResult = await pool.query(
          'SELECT id, tg_id, username, first_name, last_name, telegram_username, avatar_url FROM users WHERE id = $1',
          [session.userId]
        );
        
        if (userResult.rows.length === 0) {
          return res.json({
            success: true,
            authenticated: false,
            expired: true
          });
        }
        
        const user = userResult.rows[0];
        
        // Удаляем сессию после проверки
        authSessions.delete(authKey);
        
        res.json({
          success: true,
          authenticated: true,
          user: {
            id: user.id,
            tgId: user.tg_id,
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            telegramUsername: user.telegram_username,
            avatarUrl: user.avatar_url
          }
        });
      }
    } else if (authSessions.has(token)) {
      // Сессия еще не завершена
      res.json({
        success: true,
        authenticated: false,
        pending: true
      });
    } else {
      // Токен не найден или истек
      res.json({
        success: true,
        authenticated: false,
        pending: false,
        expired: true
      });
    }
  } catch (error) {
    console.error('Ошибка проверки авторизации:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 4. Получить профиль пользователя (ИЗМЕНЕНО: возвращаем ВСЕ заказы)
app.get('/api/auth/profile', async (req, res) => {
  try {
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }
    
    const userResult = await pool.query(
      'SELECT id, tg_id, username, first_name, last_name, telegram_username, avatar_url, created_at FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Получаем ВСЕ заказы пользователя, а не только завершенные
    const ordersResult = await pool.query(
      `SELECT order_id as id, total, status, payment_status, email, code, 
              code_requested, wrong_code_attempts, created_at as date 
       FROM orders 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // Преобразуем заказы для фронтенда
    const orders = ordersResult.rows.map(order => ({
      id: order.id,
      total: order.total,
      status: order.status,
      date: order.date,
      email: order.email,
      code: order.code,
      codeRequested: order.code_requested,
      wrongAttempts: order.wrong_code_attempts,
      paymentStatus: order.payment_status,
      isActive: order.status !== 'completed' && order.status !== 'canceled'
    }));
    
    res.json({
      success: true,
      user: {
        id: user.id,
        tgId: user.tg_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        telegramUsername: user.telegram_username,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at
      },
      orders: orders
    });
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 5. Выход из системы
app.post('/api/auth/logout', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Ошибка выхода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ===== ОБНОВЛЕННЫЙ СОЗДАНИЕ ЗАКАЗА (привязка к пользователю) =====
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, userId } = req.body;
    const orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    
    await pool.query(
      'INSERT INTO orders (order_id, items, total, user_id, status) VALUES ($1, $2, $3, $4, $5)',
      [orderId, items, total, userId || null, 'new']
    );
    
    const paymentData = {
      order_id: orderId,
      method_slug: 'card',
      amount: total,
      description: `Заказ #${orderId}`,
      shop_id: parseInt(BILEE_SHOP_ID),
      notify_url: `${SERVER_URL}/api/bilee-webhook`,
      success_url: `${SITE_URL}/success.html?order=${orderId}`,
      fail_url: `${SITE_URL}/main.html?payment=fail&order=${orderId}`,
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

// ===== ОСТАЛЬНЫЕ API =====

// 6. Сохранение email
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

// 8. Проверка кода
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
    
    await adminBot.sendMessage(ADMIN_ID, text, { reply_markup: keyboard });
    
    res.json({ 
      success: true, 
      status: 'waiting'
    });
  } catch (error) {
    console.error('Ошибка проверки кода:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 9. Вебхук от Bilee Pay
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
        await adminBot.sendMessage(ADMIN_ID, text);
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
    res.status(500).send('Internal server error');
  }
});

// 10. Проверка статуса заказа
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
      hasCode: !!order.code,
      wrongAttempts: order.wrong_code_attempts || 0,
      hasEmail: !!order.email,
      codeRequested: order.code_requested,
      maxAttemptsReached: (order.wrong_code_attempts || 0) >= 2,
      isCompleted: order.status === 'completed',
      isWaiting: order.status === 'waiting'
    });
  } catch (error) {
    console.error('Ошибка проверки статуса:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 11. Получение списка товаров
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY price');
    res.json({ success: true, products: result.rows });
  } catch (error) {
    console.error('Ошибка получения товаров:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 12. Получение деталей заказа (ДОБАВЛЕНЫ ПОЛНЫЕ ДАННЫЕ ДЛЯ ОПРЕДЕЛЕНИЯ ЭТАПА)
app.get('/api/order-details/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Получаем заказ из БД со ВСЕМИ полями для определения этапа
    const result = await pool.query(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = result.rows[0];
    
    // Форматируем данные с дополнительными полями для определения этапа
    const orderData = {
      id: order.order_id,
      date: order.created_at,
      email: order.email,
      status: order.status,
      total: order.total,
      items: order.items || {},
      code: order.code,
      paymentStatus: order.payment_status,
      codeRequested: order.code_requested,
      wrongAttempts: order.wrong_code_attempts || 0
    };
    
    res.json({
      success: true,
      order: orderData
    });
    
  } catch (error) {
    console.error('Ошибка получения деталей заказа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 13. Определение этапа заказа (НОВЫЙ API)
app.get('/api/order-stage/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT status, email, code_requested, code, wrong_code_attempts FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = result.rows[0];
    const status = order.status;
    const hasEmail = order.email && order.email.trim() !== '';
    const codeRequested = order.code_requested;
    const hasCode = order.code && order.code.trim() !== '';
    const wrongAttempts = order.wrong_code_attempts || 0;
    
    let stage = '';
    let redirectUrl = '';
    
    // Определяем этап
    if (!hasEmail && (status === 'new' || status === 'pending' || status === 'confirmed')) {
      // Email еще не введен
      stage = 'email_required';
      redirectUrl = `success.html?order=${orderId}`;
    } else if (hasEmail && !codeRequested && status === 'waiting_code_request') {
      // Email введен, ждем запроса кода
      stage = 'waiting_code_request';
      redirectUrl = `waiting_code.html?order=${orderId}`;
    } else if (codeRequested && !hasCode) {
      // Код запрошен, нужно ввести
      if (wrongAttempts >= 2) {
        stage = 'support_needed';
        redirectUrl = `bad_enter_code.html?order=${orderId}`;
      } else {
        stage = 'code_required';
        redirectUrl = `code.html?order=${orderId}`;
      }
    } else if (hasCode && status === 'waiting') {
      // Код введен, ждем выполнения
      stage = 'waiting_execution';
      redirectUrl = `waiting_order.html?order=${orderId}`;
    } else if (status === 'completed') {
      // Заказ завершен
      stage = 'completed';
      redirectUrl = `ready.html?order=${orderId}`;
    } else {
      // Неизвестный этап
      stage = 'unknown';
      redirectUrl = `profile.html`;
    }
    
    res.json({
      success: true,
      stage: stage,
      redirectUrl: redirectUrl,
      order: {
        status: status,
        hasEmail: hasEmail,
        codeRequested: codeRequested,
        hasCode: hasCode,
        wrongAttempts: wrongAttempts
      }
    });
    
  } catch (error) {
    console.error('Ошибка определения этапа заказа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

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

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

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
    
    await adminBot.sendMessage(ADMIN_ID, text, { reply_markup: keyboard });
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
      console.log(`🤖 Админ бот запущен: @${adminBot.options.username}`);
      console.log(`🤖 Бот для пользователей запущен: @${userBot.options.username}`);
      console.log(`👑 Админ ID: ${ADMIN_ID}`);
      console.log(`🌐 Сайт: ${SITE_URL}`);
      
      startKeepAlive();
    });
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

// Обработчики завершения
process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, завершаем работу...');
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (adminBot) adminBot.stopPolling();
  if (userBot) userBot.stopPolling();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGINT', () => {
  console.log('🛑 Получен SIGINT, завершаем работу...');
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (adminBot) adminBot.stopPolling();
  if (userBot) userBot.stopPolling();
  setTimeout(() => process.exit(0), 1000);
});

startServer().catch(error => {
  console.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
