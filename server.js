require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

const BILEE_API_URL = 'https://paymentgate.bilee.ru/api';
const BILEE_SHOP_ID = process.env.BILEE_SHOP_ID;
const BILEE_PASSWORD = process.env.BILEE_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_BOT_TOKEN = process.env.USER_BOT_TOKEN;
const USER_BOT_USERNAME = process.env.USER_BOT_USERNAME;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const SERVER_URL = process.env.SERVER_URL;
const SITE_URL = process.env.SITE_URL;

// Настройка multer для загрузки файлов
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true,
    sslmode: 'require'
  }
});

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

const authSessions = new Map();
const userStates = {};
const orderPages = {};
const filterStates = {};

async function initDB() {
  try {
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
      } catch (e) {
        console.log(`Колонка ${column.name} уже существует или ошибка:`, e.message);
      }
    }

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
      { name: 'user_id', type: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
      { name: 'refund_amount', type: 'INTEGER' }
    ];
    
    for (const column of ordersColumnsToAdd) {
      try {
        await pool.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}
        `);
      } catch (e) {
        console.log(`Колонка ${column.name} уже существует или ошибка:`, e.message);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        balance INTEGER DEFAULT 0,
        frozen_balance INTEGER DEFAULT 0,
        available_balance INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await pool.query('CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id)');
    } catch (e) {
      console.log('Индекс idx_wallets_user_id уже существует:', e.message);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT,
        order_id VARCHAR(50),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await pool.query('CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_wallet_transactions_order_id ON wallet_transactions(order_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC)');
    } catch (e) {
      console.log('Индексы wallet_transactions уже существуют:', e.message);
    }

    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION update_wallet_timestamp()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS update_wallet_timestamp ON wallets;
        CREATE TRIGGER update_wallet_timestamp
          BEFORE UPDATE ON wallets
          FOR EACH ROW
          EXECUTE FUNCTION update_wallet_timestamp();
      `);
    } catch (e) {
      console.log('Ошибка создания триггера для wallets:', e.message);
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS exchange_rate (
        id SERIAL PRIMARY KEY,
        rate DECIMAL(10,2) NOT NULL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_dialogs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'active',
        subject VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id SERIAL PRIMARY KEY,
        dialog_id INTEGER REFERENCES support_dialogs(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        sender VARCHAR(10) NOT NULL CHECK (sender IN ('user', 'admin')),
        message TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await pool.query('CREATE INDEX IF NOT EXISTS idx_support_dialogs_user_id ON support_dialogs(user_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_support_dialogs_status ON support_dialogs(status)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_support_messages_dialog_id ON support_messages(dialog_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON support_messages(created_at DESC)');
    } catch (e) {
      console.log('Индексы support уже существуют:', e.message);
    }

    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION update_support_timestamp()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS update_support_timestamp ON support_dialogs;
        CREATE TRIGGER update_support_timestamp
          BEFORE UPDATE ON support_dialogs
          FOR EACH ROW
          EXECUTE FUNCTION update_support_timestamp();
      `);
    } catch (e) {
      console.log('Ошибка создания триггера для support_dialogs:', e.message);
    }

    try {
      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)');
    } catch (e) {
      console.log('Индексы уже существуют:', e.message);
    }

    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
    throw error;
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'duck-shop-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/wakeup', (req, res) => {
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
    
    const req = https.request(options, (res) => {});
    req.on('error', (err) => {});
    req.end();
  } catch (error) {}
}

function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  const interval = 4 * 60 * 1000 + Math.floor(Math.random() * 2 * 60 * 1000);
  keepAliveInterval = setInterval(pingSelf, interval);
  setTimeout(pingSelf, 3000);
  console.log(`🔄 Keep-alive system started (every ${Math.round(interval/60000)} minutes)`);
}

userBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const params = match[1];
  
  try {
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
          
          let username = '';
          
          if (userFirstName && userLastName) {
            username = `${userFirstName} ${userLastName}`;
          } else if (userFirstName) {
            username = userFirstName;
          } else if (userLastName) {
            username = userLastName;
          } else if (userUsername) {
            username = userUsername;
          } else {
            username = `User_${userId}`;
          }
          
          if (username.length > 50) {
            username = username.substring(0, 47) + '...';
          }
          
          let photoUrl = null;
          try {
            const photos = await userBot.getUserProfilePhotos(userId, { limit: 1 });
            if (photos && photos.total_count > 0 && photos.photos[0] && photos.photos[0][0]) {
              const file = await userBot.getFile(photos.photos[0][0].file_id);
              if (file && file.file_path) {
                photoUrl = `https://api.telegram.org/file/bot${USER_BOT_TOKEN}/${file.file_path}`;
              }
            }
          } catch (photoError) {}
          
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
          
          try {
            const adminText = `👤 Новый пользователь зарегистрировался!\n\n` +
              `🆔 TG ID: ${userId}\n` +
              `📛 Имя: ${username}\n` +
              (userFirstName ? `👤 Имя в TG: ${userFirstName}\n` : '') +
              (userLastName ? `👤 Фамилия в TG: ${userLastName}\n` : '') +
              (userUsername ? `👤 Username: @${userUsername}\n` : '') +
              `📅 Дата: ${new Date().toLocaleString('ru-RU')}`;
            
            await adminBot.sendMessage(ADMIN_ID, adminText);
          } catch (adminError) {}
          
          return;
        }
      } 
      else if (action === 'login' && authSessions.has(token)) {
        const session = authSessions.get(token);
        
        if (session.type === 'login') {
          console.log(`🔐 Вход пользователя ${userId} (${fullName})`);
          
          const userResult = await pool.query(
            'SELECT id, username, avatar_url FROM users WHERE tg_id = $1',
            [userId]
          );
          
          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            
            let photoUrl = user.avatar_url;
            try {
              const photos = await userBot.getUserProfilePhotos(userId, { limit: 1 });
              if (photos && photos.total_count > 0 && photos.photos[0] && photos.photos[0][0]) {
                const file = await userBot.getFile(photos.photos[0][0].file_id);
                if (file && file.file_path) {
                  photoUrl = `https://api.telegram.org/file/bot${USER_BOT_TOKEN}/${file.file_path}`;
                  
                  await pool.query(
                    'UPDATE users SET avatar_url = $1 WHERE id = $2',
                    [photoUrl, user.id]
                  );
                }
              }
            } catch (photoError) {}
            
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
            
            const fullUserResult = await pool.query(
              'SELECT username, first_name, last_name, telegram_username, avatar_url FROM users WHERE id = $1',
              [user.id]
            );
            
            const fullUser = fullUserResult.rows[0];
            
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
              (fullUser.last_name ? `👤 Фамилия в TG: ${fullUser.last_name}\n` : '') +
              (fullUser.telegram_username ? `👤 Username: @${fullUser.telegram_username}\n` : '') +
              `\nНажмите кнопку ниже для перехода в магазин:`;
            
            await userBot.sendMessage(chatId, welcomeText, { reply_markup: keyboard });
            
            return;
          } else {
            await userBot.sendMessage(chatId, 
              `❌ Аккаунт не найден!\n\n` +
              `Похоже, вы еще не зарегистрированы в нашем магазине.\n` +
              `Пожалуйста, перейдите на сайт магазина и нажмите "Зарегистрироваться".\n\n` +
              `Ссылка на магазин: ${SITE_URL}`
            );
            
            authSessions.delete(token);
            return;
          }
        }
      }
    }
    
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
    } catch (sendError) {}
  }
});

userBot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpText = `🆘 Помощь по боту авторизации\n\n` +
    `Этот бот используется для входа и регистрации в магазине Duck Shop.\n\n` +
    `📋 Как это работает:\n` +
    `1. На сайте магазина нажмите "Войти"\n` +
    `2. Выберите "Войти" или "Зарегистрироваться"\n` +
    `3. Введите данные (для регистрации)\n` +
    `4. Перейдите по полученной ссылки сюда\n` +
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
      
      if (user.avatar_url) {
        try {
          await userBot.sendPhoto(chatId, user.avatar_url, {
            caption: profileText,
            reply_markup: keyboard
          });
          return;
        } catch (photoError) {}
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
       WHERE user_id = $1 AND payment_status = 'confirmed'
       ORDER BY created_at DESC 
       LIMIT 10`,
      [user.id]
    );
    
    if (ordersResult.rows.length === 0) {
      await userBot.sendMessage(chatId, 
        `📭 У вас пока нет оплаченных заказов.\n\n` +
        `Перейдите в магазин, чтобы сделать первую покупку!`
      );
      return;
    }
    
    let ordersText = `📦 Ваши оплаченные заказы:\n\n`;
    
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
    await userBot.sendMessage(chatId, '❌ Произошла ошибка при получении заказов');
  }
});

async function getBotUsername() {
  try {
    if (USER_BOT_USERNAME) {
      return USER_BOT_USERNAME;
    }
    
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

async function generateBotLink(action, token) {
  const botUsername = await getBotUsername();
  
  if (!botUsername) {
    throw new Error('Бот не имеет username. Установите username через @BotFather или задайте USER_BOT_USERNAME в .env');
  }
  
  return `https://t.me/${botUsername}?start=${action}_${token}`;
}

function isAdmin(msg) {
  return msg.from.id === ADMIN_ID;
}

function getStatusText(status) {
  const statusMap = {
    'new': '🆕 Новый',
    'pending': '⏳ Ожидает оплаты',
    'confirmed': '✅ Оплачен',
    'waiting_code_request': '⏳ Ожидает запроса кода',
    'waiting': '⏳ Ожидает выполнения',
    'completed': '🎉 Завершен',
    'canceled': '❌ Отменен',
    'manyback': '💰 Оформлен возврат'
  };
  return statusMap[status] || status;
}

adminBot.onText(/\/start/, async (msg) => {
  if (!isAdmin(msg)) {
    adminBot.sendMessage(msg.chat.id, '⛔ Доступ запрещен');
    return;
  }
  
  const welcomeText = `👋 Привет, администратор!\n\n📋 Доступные команды:\n/orders - просмотреть заказы\n/stats - статистика магазина\n/products - список товаров\n/add_product - добавить товар\n/edit_price - изменить цену товара\n/delete_product - удалить товар\n/rate - текущий курс DCoin\n/setrate [курс] - установить курс DCoin\n/addbalance [id] [сумма] - пополнить баланс пользователя\n/debt - список задолженностей\n/cancel - отменить текущее действие\n\n💬 Поддержка:\n/dialogs - список активных диалогов\n\nℹ️ Для добавления товара используйте /add_product\n💰 Для изменения цены используйте /edit_price`;
  adminBot.sendMessage(msg.chat.id, welcomeText);
});

adminBot.onText(/\/setrate(?:\s+(\d+(?:\.\d+)?))?/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  
  try {
    if (!match[1]) {
      adminBot.sendMessage(msg.chat.id, '❌ Укажите курс. Пример: /setrate 1.5');
      return;
    }
    
    const rate = parseFloat(match[1]);
    
    if (isNaN(rate) || rate <= 0) {
      adminBot.sendMessage(msg.chat.id, '❌ Введите корректный курс (положительное число)');
      return;
    }
    
    await pool.query(
      'INSERT INTO exchange_rate (rate, updated_at) VALUES ($1, CURRENT_TIMESTAMP)',
      [rate]
    );
    
    adminBot.sendMessage(
      msg.chat.id, 
      `✅ Курс обмена установлен:\n1 RUB = ${rate} DCoin`
    );
    
  } catch (error) {
    console.error('Ошибка установки курса:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при установке курса');
  }
});

adminBot.onText(/\/addbalance(?:\s+(\d+)\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  
  try {
    if (!match[1] || !match[2]) {
      adminBot.sendMessage(msg.chat.id, '❌ Укажите ID пользователя и сумму. Пример: /addbalance 123 500');
      return;
    }
    
    const userId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    if (isNaN(userId) || userId <= 0) {
      adminBot.sendMessage(msg.chat.id, '❌ Некорректный ID пользователя');
      return;
    }
    
    if (isNaN(amount) || amount <= 0 || amount > 1000000) {
      adminBot.sendMessage(msg.chat.id, '❌ Сумма должна быть от 1 до 1 000 000');
      return;
    }
    
    const userResult = await pool.query(
      'SELECT id, tg_id, username FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      adminBot.sendMessage(msg.chat.id, '❌ Пользователь с таким ID не найден');
      return;
    }
    
    const user = userResult.rows[0];
    
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        `INSERT INTO wallets (user_id, balance, frozen_balance, available_balance) 
         VALUES ($1, 0, 0, 0) 
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );
      
      const debtResult = await client.query(
        `SELECT SUM(ABS(amount)) as total_debt 
         FROM wallet_transactions 
         WHERE user_id = $1 AND type = 'debt'`,
        [user.id]
      );
      
      const totalDebt = debtResult.rows[0]?.total_debt || 0;
      
      let remainingAmount = amount;
      let debtPaid = 0;
      
      if (totalDebt > 0) {
        const debtTransactions = await client.query(
          `SELECT id, amount, order_id, metadata 
           FROM wallet_transactions 
           WHERE user_id = $1 AND type = 'debt'
           ORDER BY created_at ASC`,
          [user.id]
        );
        
        for (const debt of debtTransactions.rows) {
          if (remainingAmount <= 0) break;
          
          const debtAmount = Math.abs(debt.amount);
          const payAmount = Math.min(debtAmount, remainingAmount);
          
          await client.query(
            `UPDATE wallet_transactions 
             SET amount = amount + $1, 
                 metadata = jsonb_set(
                   COALESCE(metadata, '{}'), 
                   '{paid}', 
                   to_jsonb(COALESCE((metadata->>'paid')::int, 0) + $2)
                 )
             WHERE id = $3`,
            [payAmount, payAmount, debt.id]
          );
          
          if (payAmount >= debtAmount) {
            await client.query(
              `UPDATE wallet_transactions 
               SET type = 'debt_paid',
                   metadata = metadata || '{"fully_paid": true}'
               WHERE id = $1`,
              [debt.id]
            );
          }
          
          debtPaid += payAmount;
          remainingAmount -= payAmount;
        }
        
        if (debtPaid > 0) {
          await client.query(
            `INSERT INTO wallet_transactions 
             (user_id, type, amount, description, metadata) 
             VALUES ($1, 'debt_payment', $2, $3, $4)`,
            [user.id, -debtPaid, `Автоматическое погашение задолженности`, 
             JSON.stringify({ auto_paid: true, amount: debtPaid })]
          );
        }
      }
      
      if (remainingAmount > 0) {
        await client.query(
          'UPDATE wallets SET available_balance = available_balance + $1 WHERE user_id = $2',
          [remainingAmount, user.id]
        );
        
        await client.query(
          `INSERT INTO wallet_transactions 
           (user_id, type, amount, description, metadata) 
           VALUES ($1, 'deposit', $2, $3, $4)`,
          [user.id, remainingAmount, `Пополнение баланса администратором`, 
           JSON.stringify({ admin: true, after_debt: true })]
        );
      }
      
      await client.query('COMMIT');
      
      let successText = `✅ Баланс пользователя пополнен!\n\n` +
        `👤 Пользователь: ${user.username || 'ID ' + user.id}\n` +
        `🆔 ID: ${user.id}\n` +
        `📱 TG ID: ${user.tg_id}\n` +
        `💰 Сумма пополнения: ${formatRub(amount)}\n`;
      
      if (debtPaid > 0) {
        successText += `💸 Погашено задолженности: ${formatRub(debtPaid)} DCoin\n`;
      }
      
      if (remainingAmount > 0) {
        successText += `💎 Зачислено на баланс: ${formatRub(remainingAmount)} DCoin\n`;
      } else {
        successText += `⚠️ Вся сумма ушла на погашение задолженности\n`;
      }
      
      adminBot.sendMessage(msg.chat.id, successText);
      
      try {
        let userMessage = `💰 Ваш баланс пополнен!\n\n`;
        
        if (debtPaid > 0) {
          userMessage += `💸 Погашено задолженности: ${formatRub(debtPaid)} DCoin\n`;
        }
        
        if (remainingAmount > 0) {
          userMessage += `💎 Зачислено на баланс: ${formatRub(remainingAmount)} DCoin\n\n`;
        } else {
          userMessage += `⚠️ Вся сумма ушла на погашение задолженности\n\n`;
        }
        
        userMessage += `👉 Проверьте свой баланс в разделе "Кошелёк"`;
        
        await userBot.sendMessage(user.tg_id, userMessage);
      } catch (notifyError) {
        console.error('Ошибка уведомления пользователя:', notifyError);
      }
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Ошибка пополнения баланса:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при пополнении баланса');
  }
});

adminBot.onText(/\/debt(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  
  try {
    const userId = match[1] ? parseInt(match[1]) : null;
    
    let query;
    let params = [];
    
    if (userId) {
      query = `
        SELECT user_id, 
               SUM(ABS(amount)) as total_debt,
               array_agg(DISTINCT order_id) as orders,
               MAX(created_at) as last_debt
        FROM wallet_transactions 
        WHERE type = 'debt' AND user_id = $1
        GROUP BY user_id
      `;
      params = [userId];
    } else {
      query = `
        SELECT user_id, 
               SUM(ABS(amount)) as total_debt,
               array_agg(DISTINCT order_id) as orders,
               MAX(created_at) as last_debt
        FROM wallet_transactions 
        WHERE type = 'debt'
        GROUP BY user_id
        ORDER BY MAX(created_at) DESC
      `;
    }
    
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      adminBot.sendMessage(msg.chat.id, '📭 Нет задолженностей');
      return;
    }
    
    let text = '📋 Задолженности пользователей:\n\n';
    
    for (const row of result.rows) {
      const userResult = await pool.query(
        'SELECT username, tg_id FROM users WHERE id = $1',
        [row.user_id]
      );
      
      const username = userResult.rows[0]?.username || `ID ${row.user_id}`;
      const tgId = userResult.rows[0]?.tg_id || 'неизвестно';
      
      text += `👤 ${username}\n`;
      text += `🆔 ID: ${row.user_id}\n`;
      text += `📱 TG: ${tgId}\n`;
      text += `💰 Долг: ${formatRub(Math.abs(row.total_debt))} DCoin\n`;
      text += `📦 Заказы: ${row.orders?.length || 0}\n`;
      text += `📅 Последний: ${new Date(row.last_debt).toLocaleDateString('ru-RU')}\n\n`;
    }
    
    adminBot.sendMessage(msg.chat.id, text);
    
  } catch (error) {
    console.error('Ошибка получения задолженностей:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении задолженностей');
  }
});

adminBot.onText(/\/rate/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  try {
    const result = await pool.query(
      'SELECT rate FROM exchange_rate ORDER BY created_at DESC LIMIT 1'
    );
    
    const rate = result.rows[0]?.rate || 1.0;
    
    adminBot.sendMessage(
      msg.chat.id,
      `📊 Текущий курс обмена:\n1 RUB = ${rate} DCoin`
    );
    
  } catch (error) {
    console.error('Ошибка получения курса:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении курса');
  }
});

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
    
    await adminBot.sendMessage(msg.chat.id, statsText);
  } catch (error) {
    console.error('❌ Ошибка получения статистики:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении статистики');
  }
});

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

adminBot.onText(/\/add_product/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  userStates[chatId] = {
    step: 'awaiting_name',
    productData: {}
  };
  
  adminBot.sendMessage(chatId, '📝 Давайте добавим новый товар.\n\nШаг 1/4: Введите название товара:');
});

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

adminBot.onText(/\/orders(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  const page = match[1] ? parseInt(match[1]) : 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  
  try {
    let query = `
      SELECT order_id, total, status, created_at, payment_status, user_id
      FROM orders 
      WHERE payment_status = 'confirmed' OR status IN ('completed', 'waiting', 'waiting_code_request', 'manyback')
    `;
    
    const queryParams = [];
    
    if (filterStates[chatId]) {
      const filter = filterStates[chatId];
      if (filter.userId) {
        query += ` AND user_id = $${queryParams.length + 1}`;
        queryParams.push(filter.userId);
      }
      if (filter.dateFrom) {
        query += ` AND created_at >= $${queryParams.length + 1}`;
        queryParams.push(filter.dateFrom);
      }
      if (filter.dateTo) {
        query += ` AND created_at <= $${queryParams.length + 1}`;
        queryParams.push(filter.dateTo);
      }
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);
    
    const result = await pool.query(query, queryParams);
    
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM orders 
      WHERE payment_status = 'confirmed' OR status IN ('completed', 'waiting', 'waiting_code_request', 'manyback')
    `;
    
    const countParams = [];
    if (filterStates[chatId]) {
      const filter = filterStates[chatId];
      if (filter.userId) {
        countQuery += ` AND user_id = $${countParams.length + 1}`;
        countParams.push(filter.userId);
      }
      if (filter.dateFrom) {
        countQuery += ` AND created_at >= $${countParams.length + 1}`;
        countParams.push(filter.dateFrom);
      }
      if (filter.dateTo) {
        countQuery += ` AND created_at <= $${countParams.length + 1}`;
        countParams.push(filter.dateTo);
      }
    }
    
    const countResult = await pool.query(countQuery, countParams);
    
    const totalOrders = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalOrders / limit);
    
    if (result.rows.length === 0) {
      let emptyMessage = '📭 Нет заказов';
      if (filterStates[chatId]) {
        emptyMessage += ' по выбранному фильтру';
      }
      adminBot.sendMessage(msg.chat.id, emptyMessage);
      return;
    }
    
    orderPages[chatId] = page;
    
    let ordersText = `📋 Заказы (страница ${page}/${totalPages})\n\n`;
    if (filterStates[chatId]) {
      ordersText += `🔍 Фильтр активен\n\n`;
    }
    
    const inlineKeyboard = [];
    
    inlineKeyboard.push([
      { text: '🔍 Фильтр заказов', callback_data: 'show_filters' }
    ]);
    
    result.rows.forEach((order, index) => {
      const orderNumber = offset + index + 1;
      
      let userInfo = '';
      if (order.user_id) {
        userInfo = ` (ID: ${order.user_id})`;
      }
      
      ordersText += `${orderNumber}. #${order.order_id}${userInfo}\n`;
      ordersText += `   Сумма: ${formatRub(order.total)}\n`;
      ordersText += `   Статус: ${getStatusText(order.status)}\n`;
      ordersText += `   Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n`;
      
      inlineKeyboard.push([
        { 
          text: `#${order.order_id} - ${formatRub(order.total)}`, 
          callback_data: `order_detail:${order.order_id}:${page}` 
        }
      ]);
    });
    
    const paginationButtons = [];
    
    if (page > 1) {
      paginationButtons.push({ text: '⬅️ Назад', callback_data: `orders_page:${page-1}` });
    }
    
    if (page < totalPages) {
      paginationButtons.push({ text: '➡️ Вперед', callback_data: `orders_page:${page+1}` });
    }
    
    if (filterStates[chatId]) {
      paginationButtons.push({ text: '❌ Сбросить фильтр', callback_data: 'clear_filters' });
    }
    
    if (paginationButtons.length > 0) {
      inlineKeyboard.push(paginationButtons);
    }
    
    const keyboard = {
      inline_keyboard: inlineKeyboard
    };
    
    adminBot.sendMessage(chatId, ordersText, { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Ошибка получения заказов:', error);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка при получении заказов');
  }
});

adminBot.onText(/\/cancel/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id;
  if (userStates[chatId]) {
    delete userStates[chatId];
    adminBot.sendMessage(chatId, '❌ Текущее действие отменено.');
  }
});

adminBot.on('message', async (msg) => {
  if (!isAdmin(msg) || !msg.text) return;
  
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  
  if (text.startsWith('/')) return;
  
  const userState = userStates[chatId];
  
  if (!userState) return;
  
  console.log('📨 Получено сообщение от админа в состоянии:', userState);
  
  if (userState.action === 'support_reply') {
    const dialogId = userState.dialog_id;
    
    try {
      const dialogInfo = await pool.query(
        'SELECT user_id FROM support_dialogs WHERE id = $1 AND status = $2',
        [dialogId, 'active']
      );
      
      if (dialogInfo.rows.length === 0) {
        await adminBot.sendMessage(chatId, '❌ Диалог не найден или уже закрыт');
        delete userStates[chatId];
        return;
      }
      
      const userId = dialogInfo.rows[0].user_id;
      
      const result = await pool.query(
        `INSERT INTO support_messages (dialog_id, user_id, sender, message) 
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [dialogId, userId, 'admin', text]
      );
      
      await pool.query(
        'UPDATE support_dialogs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [dialogId]
      );
      
      const userResult = await pool.query(
        'SELECT tg_id, username FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length > 0 && userResult.rows[0].tg_id) {
        try {
          await userBot.sendMessage(
            userResult.rows[0].tg_id,
            `✉️ Новый ответ от поддержки в диалоге #${dialogId}:\n\n${text}\n\n[Ответить можно на сайте](${SITE_URL}/support.html)`,
            { parse_mode: 'Markdown' }
          );
        } catch (notifyError) {
          console.error('Ошибка отправки уведомления пользователю:', notifyError);
        }
      }

    
      await adminBot.sendMessage(
        chatId, 
        `✅ Ответ отправлен в диалог #${dialogId}\n\nВаше сообщение: ${text}`
      );
      
      delete userStates[chatId];
      
    } catch (error) {
      console.error('❌ Ошибка отправки ответа в поддержку:', error);
      await adminBot.sendMessage(chatId, '❌ Ошибка при отправке ответа. Попробуйте еще раз.');
      delete userStates[chatId];
    }
    return;
  }
  
  else if (userState.action === 'filter_user_id') {
    const userId = parseInt(text);
    
    delete userStates[chatId];
    
    if (isNaN(userId) || userId <= 0) {
      adminBot.sendMessage(chatId, '❌ Некорректный ID пользователя. Фильтр не применен.');
      return;
    }
    
    filterStates[chatId] = { userId: userId };
    adminBot.sendMessage(chatId, `✅ Фильтр применен: заказы пользователя ID ${userId}`);
    
    await adminBot.emit('text', { ...msg, text: '/orders 1' });
    return;
  }
  
  else if (userState.action === 'edit_price') {
    await handleEditPriceStep(msg, userState);
    return;
  }
  
  else if (userState.action === 'process_refund') {
    await handleRefundStep(msg, userState);
    return;
  }
  
  else if (userState.step) {
    await handleAddProductStep(msg, userState);
    return;
  }
});

adminBot.on('callback_query', async (cb) => {
  const data = cb.data;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (cb.from.id !== ADMIN_ID) {
    return adminBot.answerCallbackQuery(cb.id, { text: '⛔ Доступ запрещён', show_alert: true });
  }

  console.log('Callback получен:', data);

  if (data.startsWith('dialogs_filter:')) {
    const filter = data.split(':')[1];
    await adminBot.deleteMessage(chatId, messageId);
    await adminBot.sendMessage(chatId, `/dialogs ${filter}`);
    return adminBot.answerCallbackQuery(cb.id);
  }

  if (data.startsWith('support_view:')) {
    const dialogId = parseInt(data.split(':')[1]);

    try {
      const dialogRes = await pool.query(`
        SELECT d.*, u.username, u.tg_id, u.first_name, u.last_name
        FROM support_dialogs d
        JOIN users u ON d.user_id = u.id
        WHERE d.id = $1
      `, [dialogId]);

      if (dialogRes.rows.length === 0) {
        return adminBot.answerCallbackQuery(cb.id, { text: 'Диалог не найден', show_alert: true });
      }

      const dialog = dialogRes.rows[0];

      const msgs = await pool.query(`
        SELECT sender, message, metadata, created_at
        FROM support_messages
        WHERE dialog_id = $1
        ORDER BY created_at ASC
      `, [dialogId]);

      let text = `💬 Диалог #${dialogId}\n\n`;
      text += `👤 ${dialog.username || dialog.tg_id || 'Аноним'}\n`;
      text += `Статус: ${dialog.status === 'active' ? '🟢 Активен' : '🔴 Закрыт'}\n`;
      text += `Сообщений: ${msgs.rows.length}\n\n────────────────────\n`;

      msgs.rows.forEach(m => {
        const sender = m.sender === 'user' ? '👤' : '🛠️';
        text += `${sender} ${new Date(m.created_at).toLocaleString('ru-RU')}\n`;
        if (m.metadata?.file) {
          text += m.metadata.file.isImage ? `[Фото: ${m.metadata.file.name}]\n` : `[Файл: ${m.metadata.file.name}]\n`;
        } else {
          text += `${m.message || '[без текста]'}\n`;
        }
        text += '────────────────────\n';
      });

      const kb = {
        inline_keyboard: [
          [
            { text: '✉️ Ответить', callback_data: `support_reply:${dialogId}` },
            { text: dialog.status === 'active' ? '🔒 Закрыть' : '🔓 Открыть', callback_data: `support_toggle:${dialogId}` }
          ],
          [{ text: '← Назад к списку', callback_data: 'dialogs_all' }]
        ]
      };

      await adminBot.sendMessage(chatId, text, { reply_markup: kb });
      await adminBot.deleteMessage(chatId, messageId);
      await adminBot.answerCallbackQuery(cb.id);
    } catch (err) {
      console.error('Ошибка при открытии диалога:', err);
      await adminBot.answerCallbackQuery(cb.id, { text: 'Ошибка загрузки диалога', show_alert: true });
    }
    return;
  }

  if (data.startsWith('support_reply:')) {
    const dialogId = parseInt(data.split(':')[1]);

    userStates[chatId] = {
      action: 'support_reply',
      dialog_id: dialogId
    };

    await adminBot.sendMessage(
      chatId,
      `✉️ Введите ответ для диалога #${dialogId}:`
    );

    await adminBot.answerCallbackQuery(cb.id, { text: 'Введите ответ', show_alert: false });
    return;
  }

  if (data.startsWith('support_toggle:')) {
    const dialogId = parseInt(data.split(':')[1]);

    try {
      const dialog = await pool.query(
        'SELECT status FROM support_dialogs WHERE id = $1',
        [dialogId]
      );

      if (dialog.rows.length === 0) {
        return adminBot.answerCallbackQuery(cb.id, { text: 'Диалог не найден', show_alert: true });
      }

      const newStatus = dialog.rows[0].status === 'active' ? 'closed' : 'active';

      await pool.query(
        'UPDATE support_dialogs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newStatus, dialogId]
      );

      const userRes = await pool.query(
        'SELECT tg_id FROM users WHERE id = (SELECT user_id FROM support_dialogs WHERE id = $1)',
        [dialogId]
      );

      if (userRes.rows.length > 0) {
        const tgId = userRes.rows[0].tg_id;
        await userBot.sendMessage(
          tgId,
          newStatus === 'closed'
            ? `✅ Диалог #${dialogId} закрыт администратором. Спасибо за обращение!`
            : `🔓 Диалог #${dialogId} снова открыт. Можете продолжить общение.`
        );
      }

      await adminBot.editMessageText(
        `✅ Диалог #${dialogId} теперь ${newStatus === 'active' ? 'активен' : 'закрыт'}`,
        { chat_id: chatId, message_id: messageId }
      );

      await adminBot.answerCallbackQuery(cb.id, {
        text: `Диалог ${newStatus === 'active' ? 'открыт' : 'закрыт'}`,
        show_alert: false
      });
    } catch (err) {
      console.error('Ошибка переключения статуса диалога:', err);
      await adminBot.answerCallbackQuery(cb.id, { text: 'Ошибка', show_alert: true });
    }
    return;
  }

  if (data.startsWith('order_detail:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const page = parts[2] || 1;
    await showOrderDetails(chatId, messageId, orderId, page);
    await adminBot.answerCallbackQuery(cb.id);
    return;
  }

  if (data.startsWith('orders_page:')) {
    const page = data.split(':')[1];
    await handleOrdersPage(cb.message, page, cb.id);
    return;
  }

  if (data === 'show_filters') {
    await showFilterOptions(cb.message, cb.id);
    return;
  }

  if (data === 'clear_filters') {
    delete filterStates[chatId];
    await adminBot.answerCallbackQuery(cb.id, { text: '✅ Фильтр сброшен' });
    await adminBot.emit('text', { ...cb.message, text: '/orders 1', chat: { id: chatId } });
    return;
  }

  if (data.startsWith('filter_date:')) {
    const filterType = data.split(':')[1];
    await handleDateFilter(cb.message, filterType, cb.id);
    return;
  }

  if (data === 'filter_user_prompt') {
    userStates[chatId] = { action: 'filter_user_id' };
    await adminBot.editMessageText('👤 Введите ID пользователя для фильтрации заказов:', {
      chat_id: chatId,
      message_id: messageId
    });
    await adminBot.answerCallbackQuery(cb.id);
    return;
  }

  if (data.startsWith('request_code:')) {
    const orderId = data.split(':')[1];
    await handleRequestCode(orderId, cb.message, cb.id);
    return;
  }

  if (data.startsWith('order_ready:')) {
    const orderId = data.split(':')[1];
    await handleOrderReady(orderId, cb.message, cb.id);
    return;
  }

  if (data.startsWith('wrong_code:')) {
    const orderId = data.split(':')[1];
    await handleWrongCode(orderId, cb.message, cb.id);
    return;
  }

  if (data.startsWith('mark_completed:')) {
    const orderId = data.split(':')[1];
    await handleMarkCompleted(orderId, cb.message, cb.id);
    return;
  }

  if (data.startsWith('back_to_orders:')) {
    const page = data.split(':')[1] || 1;
    await handleBackToOrders(cb.message, page);
    await adminBot.answerCallbackQuery(cb.id);
    return;
  }

  if (data.startsWith('force_complete:')) {
    const orderId = data.split(':')[1];
    await completeOrder(orderId, cb.message, cb.id);
    return;
  }

  if (data.startsWith('cancel_order:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const returnPage = parts[2] || 1;
    await handleCancelOrder(orderId, cb.message, cb.id, returnPage);
    return;
  }

  if (data.startsWith('confirm_cancel_order:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const returnPage = parts[2] || 1;
    await handleConfirmCancelOrder(orderId, cb.message, cb.id, returnPage);
    return;
  }

  if (data.startsWith('process_refund:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const returnPage = parts[2] || 1;
    await handleProcessRefund(orderId, cb.message, cb.id, returnPage);
    return;
  }

  if (data.startsWith('confirm_refund:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const returnPage = parts[2] || 1;
    await handleConfirmRefund(orderId, cb.message, cb.id, returnPage);
    return;
  }

  if (data.startsWith('cancel_refund:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const returnPage = parts[2] || 1;
    await handleCancelRefund(orderId, cb.message, cb.id, returnPage);
    return;
  }

  if (data.startsWith('confirm_cancel_refund:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const returnPage = parts[2] || 1;
    await handleConfirmCancelRefund(orderId, cb.message, cb.id, returnPage);
    return;
  }

  if (data === 'add_product_prompt') {
    await adminBot.answerCallbackQuery(cb.id);
    adminBot.sendMessage(chatId, '📝 Отправьте команду /add_product чтобы начать добавление товара');
    return;
  }

  if (data === 'edit_price_list') {
    await handleEditPriceList(cb.message, cb.id);
    return;
  }

  if (data.startsWith('edit_price:')) {
    const productId = data.split(':')[1];
    await handleEditPrice(productId, cb.message, cb.id);
    return;
  }

  if (data === 'delete_product_list') {
    await handleDeleteProductList(cb.message, cb.id);
    return;
  }

  if (data.startsWith('delete_product:')) {
    const productId = data.split(':')[1];
    await handleDeleteProduct(productId, cb.message, cb.id);
    return;
  }

  await adminBot.answerCallbackQuery(cb.id, {
    text: '⚠️ Неизвестная команда',
    show_alert: true
  });
});
async function showFilterOptions(msg, callbackQueryId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '📅 Сегодня', callback_data: 'filter_date:today' },
        { text: '📅 Вчера', callback_data: 'filter_date:yesterday' }
      ],
      [
        { text: '📅 Эта неделя', callback_data: 'filter_date:week' },
        { text: '📅 Этот месяц', callback_data: 'filter_date:month' }
      ],
      [
        { text: '👤 По ID пользователя', callback_data: 'filter_user_prompt' }
      ],
      [
        { text: '❌ Сбросить фильтр', callback_data: 'clear_filters' }
      ]
    ]
  };
  
  await adminBot.editMessageText('🔍 Выберите тип фильтрации:', {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_markup: keyboard
  });
  
  await adminBot.answerCallbackQuery(callbackQueryId);
}

async function handleDateFilter(msg, filterType, callbackQueryId) {
  const chatId = msg.chat.id;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  let dateFrom, dateTo;
  
  switch(filterType) {
    case 'today':
      dateFrom = today;
      dateTo = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1);
      break;
    case 'yesterday':
      dateFrom = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      dateTo = new Date(today.getTime() - 1);
      break;
    case 'week':
      const firstDayOfWeek = today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1);
      dateFrom = new Date(today.getFullYear(), today.getMonth(), firstDayOfWeek);
      dateTo = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1);
      break;
    case 'month':
      dateFrom = new Date(today.getFullYear(), today.getMonth(), 1);
      dateTo = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1);
      break;
  }
  
  filterStates[chatId] = {
    dateFrom: dateFrom,
    dateTo: dateTo
  };
  
  const filterNames = {
    today: 'сегодня',
    yesterday: 'вчера',
    week: 'эту неделю',
    month: 'этот месяц'
  };
  
  await adminBot.answerCallbackQuery(callbackQueryId, { 
    text: `✅ Фильтр применен: ${filterNames[filterType]}` 
  });
  
  await adminBot.emit('text', { ...msg, text: '/orders 1', chat: { id: chatId } });
}

async function showSupportDialog(msg, dialogId, callbackQueryId) {
  try {
    const dialogInfo = await pool.query(`
      SELECT 
        d.*,
        u.id as user_id,
        u.username,
        u.tg_id,
        u.telegram_username,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM support_dialogs d
      JOIN users u ON d.user_id = u.id
      WHERE d.id = $1
    `, [dialogId]);
    
    if (dialogInfo.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Диалог не найден',
        show_alert: true 
      });
      return;
    }
    
    const dialog = dialogInfo.rows[0];
    
    const messages = await pool.query(`
      SELECT * FROM support_messages 
      WHERE dialog_id = $1 
      ORDER BY created_at ASC
    `, [dialogId]);
    
    let docContent = `ДИАЛОГ ПОДДЕРЖКИ #${dialogId}\n`;
    docContent += `================================\n\n`;
    docContent += `ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ:\n`;
    docContent += `• ID в магазине: ${dialog.user_id}\n`;
    docContent += `• Имя: ${dialog.username || 'Не указано'}\n`;
    docContent += `• TG ID: ${dialog.tg_id}\n`;
    docContent += `• Username: @${dialog.telegram_username || 'отсутствует'}\n`;
    docContent += `• Имя в TG: ${dialog.first_name || ''} ${dialog.last_name || ''}`.trim() || 'Не указано';
    docContent += `\n\nИСТОРИЯ ПЕРЕПИСКИ:\n`;
    docContent += `================================\n\n`;
    
    messages.rows.forEach(msg => {
      const date = new Date(msg.created_at).toLocaleString('ru-RU');
      const sender = msg.sender === 'user' ? '👤 ПОЛЬЗОВАТЕЛЬ' : '🛠️ ПОДДЕРЖКА';
      docContent += `[${date}] ${sender}:\n${msg.message}\n\n`;
    });
    
    docContent += `================================\n`;
    docContent += `Статус диалога: ${dialog.status === 'active' ? 'Активен' : 'Закрыт'}\n`;
    docContent += `Создан: ${new Date(dialog.created_at).toLocaleString('ru-RU')}\n`;
    docContent += `Обновлен: ${new Date(dialog.updated_at).toLocaleString('ru-RU')}`;
    
    await adminBot.sendDocument(
      msg.chat.id,
      Buffer.from(docContent, 'utf-8'),
      {
        filename: `support_dialog_${dialogId}.txt`,
        caption: `💬 Диалог #${dialogId} с пользователем ${dialog.username || 'ID ' + dialog.user_id}`
      }
    );
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✉️ Ответить', callback_data: `support_reply:${dialogId}` },
          { text: '✅ Закрыть', callback_data: `support_close:${dialogId}` }
        ],
        [
          { text: '👤 Инфо о клиенте', callback_data: `support_userinfo:${dialog.user_id}` }
        ]
      ]
    };
    
    let statusText = `📋 **Управление диалогом #${dialogId}**\n\n`;
    statusText += `**Пользователь:** ${dialog.username || 'Неизвестно'}\n`;
    statusText += `**Статус:** ${dialog.status === 'active' ? '✅ Активен' : '❌ Закрыт'}\n`;
    statusText += `**Сообщений:** ${messages.rows.length}\n`;
    
    await adminBot.sendMessage(msg.chat.id, statusText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId);
    
  } catch (error) {
    console.error('❌ Ошибка показа диалога:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка загрузки диалога',
      show_alert: true 
    });
  }
}

async function showUserInfo(msg, userId, callbackQueryId) {
  try {
    const userResult = await pool.query(`
      SELECT u.*, 
             (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as orders_count,
             (SELECT SUM(total) FROM orders WHERE user_id = u.id AND payment_status = 'confirmed') as total_spent,
             (SELECT COUNT(*) FROM support_dialogs WHERE user_id = u.id) as dialogs_count
      FROM users u
      WHERE u.id = $1
    `, [userId]);
    
    if (userResult.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Пользователь не найден',
        show_alert: true 
      });
      return;
    }
    
    const user = userResult.rows[0];
    
    let infoText = `👤 **Информация о пользователе**\n\n`;
    infoText += `**ID в магазине:** ${user.id}\n`;
    infoText += `**Имя:** ${user.username || 'Не указано'}\n`;
    infoText += `**TG ID:** ${user.tg_id}\n`;
    infoText += `**Telegram Username:** @${user.telegram_username || 'отсутствует'}\n`;
    infoText += `**Имя в TG:** ${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Не указано';
    infoText += `\n\n**Статистика:**\n`;
    infoText += `• Заказов: ${user.orders_count || 0}\n`;
    infoText += `• Потрачено: ${formatRub(user.total_spent || 0)}\n`;
    infoText += `• Обращений в поддержку: ${user.dialogs_count || 0}\n`;
    infoText += `\n**Дата регистрации:** ${new Date(user.created_at).toLocaleDateString('ru-RU')}\n`;
    infoText += `**Последний вход:** ${new Date(user.last_login).toLocaleDateString('ru-RU')}`;
    
    await adminBot.sendMessage(msg.chat.id, infoText, { parse_mode: 'Markdown' });
    await adminBot.answerCallbackQuery(callbackQueryId);
    
  } catch (error) {
    console.error('❌ Ошибка получения инфо о пользователе:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

adminBot.onText(/\/dialogs(?:\s+(all|active|closed))?/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const filter = match[1] || 'all';

  let query = `
    SELECT 
      d.id, d.status, d.updated_at, d.created_at,
      u.username, u.tg_id, u.first_name, u.last_name,
      (SELECT COUNT(*) FROM support_messages WHERE dialog_id = d.id) as msg_count
    FROM support_dialogs d
    JOIN users u ON d.user_id = u.id
  `;

  const params = [];

  if (filter === 'active') {
    query += ` WHERE d.status = 'active'`;
  } else if (filter === 'closed') {
    query += ` WHERE d.status = 'closed'`;
  }

  query += ` ORDER BY d.updated_at DESC LIMIT 50`;

  try {
    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return adminBot.sendMessage(msg.chat.id, `📭 Нет диалогов в категории "${filter}"`);
    }

    let text = `💬 Диалоги (${filter.toUpperCase()}) — ${rows.length} шт.\n\n`;

    const keyboard = {
      inline_keyboard: rows.map(row => {
        const date = new Date(row.updated_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const statusEmoji = row.status === 'active' ? '🟢' : '🔴';
        const name = row.username || row.first_name || `ID ${row.tg_id}`;
        const shortName = name.length > 18 ? name.substring(0, 15) + '…' : name;
        return [{
          text: `${statusEmoji} #${row.id} | ${shortName} | ${row.msg_count} смс | ${date}`,
          callback_data: `support_view:${row.id}`
        }];
      })
    };

    keyboard.inline_keyboard.unshift([
      { text: 'Все', callback_data: 'dialogs_filter:all' },
      { text: 'Активные', callback_data: 'dialogs_filter:active' },
      { text: 'Завершённые', callback_data: 'dialogs_filter:closed' }
    ]);

    adminBot.sendMessage(msg.chat.id, text, { reply_markup: keyboard });
  } catch (err) {
    console.error('Ошибка /dialogs:', err);
    adminBot.sendMessage(msg.chat.id, '❌ Ошибка загрузки диалогов');
  }
});

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
        
        const productId = userState.productId;
        const productName = userState.productName;
        const oldPrice = userState.oldPrice;
        
        await pool.query(
          'UPDATE products SET price = $1 WHERE id = $2',
          [price, productId]
        );
        
        const successText = `✅ Цена товара изменена!\n\n🏷️ Товар: ${productName}\n🆔 ID: ${productId}\n💰 Было: ${formatRub(oldPrice)}\n💰 Стало: ${formatRub(price)}`;
        
        delete userStates[chatId];
        
        adminBot.sendMessage(chatId, successText);
        
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

async function handleOrdersPage(msg, page, callbackQueryId) {
  try {
    const chatId = msg.chat.id;
    const limit = 10;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT order_id, total, status, created_at, payment_status, user_id
      FROM orders 
      WHERE payment_status = 'confirmed' OR status IN ('completed', 'waiting', 'waiting_code_request', 'manyback')
    `;
    
    const queryParams = [];
    
    if (filterStates[chatId]) {
      const filter = filterStates[chatId];
      if (filter.userId) {
        query += ` AND user_id = $${queryParams.length + 1}`;
        queryParams.push(filter.userId);
      }
      if (filter.dateFrom) {
        query += ` AND created_at >= $${queryParams.length + 1}`;
        queryParams.push(filter.dateFrom);
      }
      if (filter.dateTo) {
        query += ` AND created_at <= $${queryParams.length + 1}`;
        queryParams.push(filter.dateTo);
      }
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);
    
    const result = await pool.query(query, queryParams);
    
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM orders 
      WHERE payment_status = 'confirmed' OR status IN ('completed', 'waiting', 'waiting_code_request', 'manyback')
    `;
    
    const countParams = [];
    if (filterStates[chatId]) {
      const filter = filterStates[chatId];
      if (filter.userId) {
        countQuery += ` AND user_id = $${countParams.length + 1}`;
        countParams.push(filter.userId);
      }
      if (filter.dateFrom) {
        countQuery += ` AND created_at >= $${countParams.length + 1}`;
        countParams.push(filter.dateFrom);
      }
      if (filter.dateTo) {
        countQuery += ` AND created_at <= $${countParams.length + 1}`;
        countParams.push(filter.dateTo);
      }
    }
    
    const countResult = await pool.query(countQuery, countParams);
    
    const totalOrders = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalOrders / limit);
    
    if (result.rows.length === 0) {
      await adminBot.editMessageText('📭 Нет заказов', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      return;
    }
    
    orderPages[chatId] = parseInt(page);
    
    let ordersText = `📋 Заказы (страница ${page}/${totalPages})\n\n`;
    if (filterStates[chatId]) {
      ordersText += `🔍 Фильтр активен\n\n`;
    }
    
    const inlineKeyboard = [];
    
    inlineKeyboard.push([
      { text: '🔍 Фильтр заказов', callback_data: 'show_filters' }
    ]);
    
    result.rows.forEach((order, index) => {
      const orderNumber = offset + index + 1;
      
      let userInfo = '';
      if (order.user_id) {
        userInfo = ` (ID: ${order.user_id})`;
      }
      
      ordersText += `${orderNumber}. #${order.order_id}${userInfo}\n`;
      ordersText += `   Сумма: ${formatRub(order.total)}\n`;
      ordersText += `   Статус: ${getStatusText(order.status)}\n`;
      ordersText += `   Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n`;
      
      inlineKeyboard.push([
        { 
          text: `#${order.order_id} - ${formatRub(order.total)}`, 
          callback_data: `order_detail:${order.order_id}:${page}` 
        }
      ]);
    });
    
    const paginationButtons = [];
    
    if (page > 1) {
      paginationButtons.push({ text: '⬅️ Назад', callback_data: `orders_page:${parseInt(page)-1}` });
    }
    
    if (page < totalPages) {
      paginationButtons.push({ text: '➡️ Вперед', callback_data: `orders_page:${parseInt(page)+1}` });
    }
    
    if (filterStates[chatId]) {
      paginationButtons.push({ text: '❌ Сбросить фильтр', callback_data: 'clear_filters' });
    }
    
    if (paginationButtons.length > 0) {
      inlineKeyboard.push(paginationButtons);
    }
    
    const keyboard = {
      inline_keyboard: inlineKeyboard
    };
    
    await adminBot.editMessageText(ordersText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId);
  } catch (error) {
    console.error('❌ Ошибка смены страницы:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при загрузке страницы',
      show_alert: true 
    });
  }
}

async function handleCancelOrder(orderId, msg, callbackQueryId, returnPage = 1) {
  try {
    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Да, отменить заказ', callback_data: `confirm_cancel_order:${orderId}:${returnPage}` },
          { text: '❌ Нет, оставить', callback_data: `order_detail:${orderId}:${returnPage}` }
        ]
      ]
    };
    
    await adminBot.editMessageText(`⚠️ Вы уверены, что хотите отменить заказ #${orderId}?\n\nЭто действие нельзя отменить.`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: confirmKeyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
      text: 'Подтвердите отмену',
      show_alert: false 
    });
  } catch (error) {
    console.error('❌ Ошибка подтверждения отмены:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleConfirmCancelOrder(orderId, msg, callbackQueryId, returnPage = 1) {
  try {
    await pool.query(
      'UPDATE orders SET status = $1 WHERE order_id = $2',
      ['canceled', orderId]
    );
    
    const orderResult = await pool.query(
      'SELECT total, email FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    const order = orderResult.rows[0];
    let message = `✅ Заказ #${orderId} отменен\n\n`;
    message += `💰 Сумма: ${formatRub(order.total)}\n`;
    if (order.email) message += `📧 Email: ${order.email}\n`;
    message += `\n❌ Статус заказа изменен на "Отменен".`;
    
    await adminBot.editMessageText(message, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '✅ Заказ отменен',
      show_alert: false
    });
    
    setTimeout(async () => {
      await showOrderDetails(msg.chat.id, msg.message_id, orderId, returnPage);
    }, 2000);
  } catch (error) {
    console.error('❌ Ошибка отмены заказа:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка при отмене заказа',
      show_alert: true 
    });
  }
}

async function handleProcessRefund(orderId, msg, callbackQueryId, returnPage = 1) {
  try {
    const orderResult = await pool.query(
      'SELECT total, status FROM orders WHERE order_id = $1',
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
    
    if (order.status === 'manyback') {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '⚠️ Возврат уже оформлен',
        show_alert: true 
      });
      return;
    }
    
    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Да, оформить возврат', callback_data: `confirm_refund:${orderId}:${returnPage}` },
          { text: '❌ Нет, отмена', callback_data: `order_detail:${orderId}:${returnPage}` }
        ]
      ]
    };
    
    await adminBot.editMessageText(`💰 Оформление возврата для заказа #${orderId}\n\n💰 Сумма заказа: ${formatRub(order.total)}\n\n⚠️ Вы уверены, что хотите оформить возврат?\nПосле подтверждения нужно будет ввести сумму возврата.`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: confirmKeyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
      text: 'Подтвердите оформление возврата',
      show_alert: false 
    });
  } catch (error) {
    console.error('❌ Ошибка оформления возврата:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleConfirmRefund(orderId, msg, callbackQueryId, returnPage = 1) {
  try {
    const orderResult = await pool.query(
      'SELECT total, user_id FROM orders WHERE order_id = $1',
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
    const maxAmount = order.total;
    const userId = order.user_id;
    
    if (!userId) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ К заказу не привязан пользователь',
        show_alert: true 
      });
      return;
    }
    
    const chatId = msg.chat.id;
    userStates[chatId] = {
      action: 'process_refund',
      step: 'awaiting_refund_amount',
      orderId: orderId,
      userId: userId,
      orderTotal: maxAmount,
      returnPage: parseInt(returnPage)
    };
    
    await adminBot.editMessageText(`💰 Введите сумму возврата для заказа #${orderId}\n\n💰 Сумма заказа: ${formatRub(maxAmount)}\n\nВведите сумму возврата (не больше ${maxAmount}₽):`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
      text: 'Введите сумму возврата',
      show_alert: false
    });
  } catch (error) {
    console.error('❌ Ошибка подтверждения возврата:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleRefundStep(msg, userState) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  
  try {
    switch(userState.step) {
      case 'awaiting_refund_amount':
        const refundAmount = parseInt(text);
        const maxAmount = userState.orderTotal;
        
        if (isNaN(refundAmount) || refundAmount <= 0 || refundAmount > maxAmount) {
          adminBot.sendMessage(chatId, `❌ Сумма должна быть числом от 1 до ${maxAmount}. Введите сумму еще раз:`);
          return;
        }
        
        const orderId = userState.orderId;
        const userId = userState.userId;
        
        const client = await pool.connect();
        
        try {
          await client.query('BEGIN');
          
          await client.query(
            'UPDATE orders SET status = $1, refund_amount = $2 WHERE order_id = $3',
            ['manyback', refundAmount, orderId]
          );
          
          await client.query(
            `INSERT INTO wallets (user_id, frozen_balance, balance, available_balance) 
             VALUES ($1, 0, 0, 0) 
             ON CONFLICT (user_id) DO NOTHING`,
            [userId]
          );
          
          await client.query(
            'UPDATE wallets SET frozen_balance = frozen_balance + $1 WHERE user_id = $2',
            [refundAmount, userId]
          );
          
          await client.query(
            `INSERT INTO wallet_transactions 
             (user_id, type, amount, description, order_id, metadata) 
             VALUES ($1, 'refund', $2, $3, $4, $5)`,
            [userId, refundAmount, `Возврат по заказу #${orderId}`, orderId, JSON.stringify({ frozen: true })]
          );
          
          await client.query('COMMIT');
          
          const successText = `✅ Возврат оформлен!\n\n` +
            `📦 Заказ: #${orderId}\n` +
            `💰 Сумма заказа: ${formatRub(maxAmount)}\n` +
            `💰 Сумма возврата: ${formatRub(refundAmount)}\n` +
            `❄️ Средства заморожены на кошельке пользователя`;
          
          delete userStates[chatId];
          
          adminBot.sendMessage(chatId, successText);
          
          try {
            const userResult = await client.query(
              'SELECT tg_id FROM users WHERE id = $1',
              [userId]
            );
            
            if (userResult.rows.length > 0) {
              const userTgId = userResult.rows[0].tg_id;
              
              await userBot.sendMessage(userTgId, 
                `💰 Вам начислен возврат!\n\n` +
                `📦 Заказ: #${orderId}\n` +
                `💰 Сумма: ${formatRub(refundAmount)}\n\n` +
                `❄️ Средства заморожены.\n` +
                `👉 Перейдите в "Кошелёк" → "Разморозить деньги", чтобы обменять их на DCoin.`
              );
            }
          } catch (notifyError) {
            console.error('Ошибка уведомления пользователя:', notifyError);
          }
          
          await showOrderDetails(chatId, null, orderId, userState.returnPage || 1);
          
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        
        break;
    }
  } catch (error) {
    console.error('❌ Ошибка оформления возврата:', error);
    adminBot.sendMessage(chatId, '❌ Произошла ошибка. Начните заново.');
    delete userStates[chatId];
  }
}

async function handleCancelRefund(orderId, msg, callbackQueryId, returnPage = 1) {
  try {
    const orderResult = await pool.query(
      'SELECT refund_amount, user_id, total FROM orders WHERE order_id = $1 AND status = $2',
      [orderId, 'manyback']
    );
    
    if (orderResult.rows.length === 0) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Возврат не найден или уже отменен',
        show_alert: true 
      });
      return;
    }
    
    const order = orderResult.rows[0];
    const refundAmount = order.refund_amount;
    const userId = order.user_id;
    
    if (!userId) {
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ К заказу не привязан пользователь',
        show_alert: true 
      });
      return;
    }
    
    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Да, отменить возврат', callback_data: `confirm_cancel_refund:${orderId}:${returnPage}` },
          { text: '❌ Нет', callback_data: `order_detail:${orderId}:${returnPage}` }
        ]
      ]
    };
    
    await adminBot.editMessageText(`⚠️ Отмена возврата для заказа #${orderId}\n\n` +
      `💰 Сумма возврата: ${formatRub(refundAmount)}\n` +
      `👤 Пользователь ID: ${userId}\n\n` +
      `⚠️ Средства будут списаны с доступного баланса пользователя DCoin.\n` +
      `💰 Баланс пользователя может уйти в минус, если средств недостаточно.\n\n` +
      `Вы уверены?`, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: confirmKeyboard
    });
    
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
      text: 'Подтвердите отмену возврата',
      show_alert: false
    });
    
  } catch (error) {
    console.error('❌ Ошибка отмены возврата:', error);
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  }
}

async function handleConfirmCancelRefund(orderId, msg, callbackQueryId, returnPage = 1) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const orderResult = await client.query(
      'SELECT refund_amount, user_id FROM orders WHERE order_id = $1 AND status = $2 FOR UPDATE',
      [orderId, 'manyback']
    );
    
    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await adminBot.answerCallbackQuery(callbackQueryId, { 
        text: '❌ Возврат не найден',
        show_alert: true 
      });
      return;
    }
    
    const order = orderResult.rows[0];
    const refundAmount = order.refund_amount;
    const userId = order.user_id;
    
    const walletResult = await client.query(
      'SELECT available_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    
    let wallet = walletResult.rows[0];
    
    if (!wallet) {
      await client.query(
        'INSERT INTO wallets (user_id, balance, frozen_balance, available_balance) VALUES ($1, 0, 0, 0)',
        [userId]
      );
      wallet = { available_balance: 0 };
    }
    
    const currentBalance = wallet.available_balance || 0;
    
    await client.query(
      'UPDATE wallets SET available_balance = available_balance - $1 WHERE user_id = $2',
      [refundAmount, userId]
    );
    
    await client.query(
      'UPDATE orders SET status = $1, refund_amount = NULL WHERE order_id = $2',
      ['completed', orderId]
    );
    
    await client.query(
      `INSERT INTO wallet_transactions 
       (user_id, type, amount, description, order_id, metadata) 
       VALUES ($1, 'withdraw', $2, $3, $4, $5)`,
      [userId, -refundAmount, `Отмена возврата по заказу #${orderId}`, orderId, 
       JSON.stringify({ 
         cancel_refund: true,
         spent: Math.min(refundAmount, currentBalance),
         remaining_debt: Math.max(0, refundAmount - currentBalance)
       })]
    );
    
    if (refundAmount > currentBalance) {
      const debtAmount = refundAmount - currentBalance;
      await client.query(
        `INSERT INTO wallet_transactions 
         (user_id, type, amount, description, order_id, metadata) 
         VALUES ($1, 'debt', $2, $3, $4, $5)`,
        [userId, -debtAmount, `Задолженность по отмене возврата #${orderId}`, orderId,
         JSON.stringify({ 
           debt: true,
           original_refund: refundAmount,
           remaining: debtAmount
         })]
      );
    }
    
    await client.query('COMMIT');
    
    let debtText = '';
    if (refundAmount > currentBalance) {
      const debtAmount = refundAmount - currentBalance;
      debtText = `\n\n⚠️ На балансе недостаточно средств!\n` +
        `💰 Списано: ${formatRub(currentBalance)} DCoin\n` +
        `📉 Задолженность: ${formatRub(debtAmount)} DCoin\n` +
        `💳 При пополнении баланса задолженность будет списана автоматически.`;
    }
    
    const successText = `✅ Возврат отменен!\n\n` +
      `📦 Заказ: #${orderId}\n` +
      `💰 Сумма возврата: ${formatRub(refundAmount)} RUB\n` +
      `💎 Списано с DCoin баланса: ${formatRub(Math.min(refundAmount, currentBalance))} DCoin` +
      debtText;
    
    await adminBot.editMessageText(successText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    try {
      const userResult = await client.query(
        'SELECT tg_id FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length > 0) {
        const userTgId = userResult.rows[0].tg_id;
        
        let userMessage = `⚠️ Возврат по заказу #${orderId} отменен администратором.\n\n` +
          `💰 Сумма возврата: ${formatRub(refundAmount)} RUB\n` +
          `💎 Списано с вашего DCoin баланса: ${formatRub(Math.min(refundAmount, currentBalance))} DCoin`;
        
        if (refundAmount > currentBalance) {
          const debtAmount = refundAmount - currentBalance;
          userMessage += `\n\n⚠️ На вашем балансе недостаточно средств!\n` +
            `💰 Списано: ${formatRub(currentBalance)} DCoin\n` +
            `📉 Задолженность: ${formatRub(debtAmount)} DCoin\n` +
            `💳 При следующем пополнении баланса задолженность будет списана автоматически.`;
        }
        
        await userBot.sendMessage(userTgId, userMessage);
      }
    } catch (notifyError) {
      console.error('Ошибка уведомления пользователя:', notifyError);
    }
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: refundAmount > currentBalance ? '⚠️ Возврат отменен, но есть задолженность' : '✅ Возврат отменен',
      show_alert: false
    });
    
    setTimeout(async () => {
      await showOrderDetails(msg.chat.id, msg.message_id, orderId, returnPage);
    }, 2000);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Ошибка подтверждения отмены возврата:', error);
    
    await adminBot.editMessageText('❌ Ошибка при отмене возврата. Баланс пользователя не изменен.', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    
    await adminBot.answerCallbackQuery(callbackQueryId, { 
      text: '❌ Ошибка',
      show_alert: true 
    });
  } finally {
    client.release();
  }
}

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
      
      await adminBot.editMessageText(`⚠️ Внимание!\n\nКод был запрошен у пользователя, но он еще не ввел код.\n\nВы уверены, что хотите завершить заказ без кода?`, {
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
    
    await adminBot.answerCallbackQuery(callbackQuery.id, { 
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

async function showOrderDetails(chatId, messageId, orderId, returnPage = 1) {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      if (messageId) {
        await adminBot.editMessageText('❌ Заказ не найден', {
          chat_id: chatId,
          message_id: messageId
        });
      } else {
        await adminBot.sendMessage(chatId, '❌ Заказ не найден');
      }
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
      (order.refund_amount ? `💰 К возврату: ${formatRub(order.refund_amount)}\n` : '') +
      `📧 Почта: ${order.email || 'не указана'}\n` +
      `🔢 Код: ${order.code || 'не введен'}\n` +
      `📦 Товаров: ${totalItems} шт.\n` +
      `📊 Статус: ${getStatusText(order.status)}\n` +
      `💳 Оплата: ${order.payment_status === 'confirmed' ? '✅ Оплачен' : '❌ Не оплачен'}\n` +
      `📅 Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n` +
      `🛒 Состав заказа:\n${itemsText}`;
    
    let keyboardRows = [];
    
    keyboardRows.push([
      { text: '❌ Отменить заказ', callback_data: `cancel_order:${orderId}:${returnPage}` }
    ]);
    
    if (order.status !== 'completed') {
      keyboardRows.push([
        { text: '✅ Сделать готовым', callback_data: `mark_completed:${orderId}` }
      ]);
    }
    
    if (order.email && !order.code_requested && order.status !== 'completed' && !order.code && order.status === 'waiting_code_request') {
      keyboardRows.push([
        { text: '📝 Запросить код', callback_data: `request_code:${orderId}` }
      ]);
    }
    
    if (order.status === 'manyback' && order.refund_amount > 0) {
      keyboardRows.push([
        { text: '↩️ Отменить возврат', callback_data: `cancel_refund:${orderId}:${returnPage}` }
      ]);
    }
    
    if (order.status !== 'manyback') {
      keyboardRows.push([
        { text: '💰 Оформить возврат', callback_data: `process_refund:${orderId}:${returnPage}` }
      ]);
    }
    
    if (order.code && order.status === 'waiting') {
      keyboardRows.push([
        { text: '✅ Подтвердить код', callback_data: `order_ready:${orderId}` },
        { text: '❌ Неверный код', callback_data: `wrong_code:${orderId}` }
      ]);
    }
    
    keyboardRows.push([
      { text: '⬅️ Назад к заказам', callback_data: `back_to_orders:${returnPage}` }
    ]);
    
    const keyboard = {
      inline_keyboard: keyboardRows
    };
    
    if (messageId) {
      await adminBot.editMessageText(orderText, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
    } else {
      await adminBot.sendMessage(chatId, orderText, { reply_markup: keyboard });
    }
  } catch (error) {
    console.error('Ошибка показа деталей заказа:', error);
    if (messageId) {
      await adminBot.editMessageText('❌ Ошибка при получении деталей заказа', {
        chat_id: chatId,
        message_id: messageId
      });
    } else {
      await adminBot.sendMessage(chatId, '❌ Ошибка при получении деталей заказа');
    }
  }
}

async function handleBackToOrders(msg, page = 1) {
  try {
    const chatId = msg.chat.id;
    const limit = 10;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT order_id, total, status, created_at, payment_status, user_id
      FROM orders 
      WHERE payment_status = 'confirmed' OR status IN ('completed', 'waiting', 'waiting_code_request', 'manyback')
    `;
    
    const queryParams = [];
    
    if (filterStates[chatId]) {
      const filter = filterStates[chatId];
      if (filter.userId) {
        query += ` AND user_id = $${queryParams.length + 1}`;
        queryParams.push(filter.userId);
      }
      if (filter.dateFrom) {
        query += ` AND created_at >= $${queryParams.length + 1}`;
        queryParams.push(filter.dateFrom);
      }
      if (filter.dateTo) {
        query += ` AND created_at <= $${queryParams.length + 1}`;
        queryParams.push(filter.dateTo);
      }
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);
    
    const result = await pool.query(query, queryParams);
    
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM orders 
      WHERE payment_status = 'confirmed' OR status IN ('completed', 'waiting', 'waiting_code_request', 'manyback')
    `;
    
    const countParams = [];
    if (filterStates[chatId]) {
      const filter = filterStates[chatId];
      if (filter.userId) {
        countQuery += ` AND user_id = $${countParams.length + 1}`;
        countParams.push(filter.userId);
      }
      if (filter.dateFrom) {
        countQuery += ` AND created_at >= $${countParams.length + 1}`;
        countParams.push(filter.dateFrom);
      }
      if (filter.dateTo) {
        countQuery += ` AND created_at <= $${countParams.length + 1}`;
        countParams.push(filter.dateTo);
      }
    }
    
    const countResult = await pool.query(countQuery, countParams);
    
    const totalOrders = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalOrders / limit);
    
    if (result.rows.length === 0) {
      await adminBot.editMessageText('📭 Нет заказов', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      return;
    }
    
    orderPages[chatId] = page;
    
    let ordersText = `📋 Заказы (страница ${page}/${totalPages})\n\n`;
    if (filterStates[chatId]) {
      ordersText += `🔍 Фильтр активен\n\n`;
    }
    
    const inlineKeyboard = [];
    
    inlineKeyboard.push([
      { text: '🔍 Фильтр заказов', callback_data: 'show_filters' }
    ]);
    
    result.rows.forEach((order, index) => {
      const orderNumber = offset + index + 1;
      
      let userInfo = '';
      if (order.user_id) {
        userInfo = ` (ID: ${order.user_id})`;
      }
      
      ordersText += `${orderNumber}. #${order.order_id}${userInfo}\n`;
      ordersText += `   Сумма: ${formatRub(order.total)}\n`;
      ordersText += `   Статус: ${getStatusText(order.status)}\n`;
      ordersText += `   Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}\n\n`;
      
      inlineKeyboard.push([
        { 
          text: `#${order.order_id} - ${formatRub(order.total)}`, 
          callback_data: `order_detail:${order.order_id}:${page}` 
        }
      ]);
    });
    
    const paginationButtons = [];
    
    if (page > 1) {
      paginationButtons.push({ text: '⬅️ Назад', callback_data: `orders_page:${page-1}` });
    }
    
    if (page < totalPages) {
      paginationButtons.push({ text: '➡️ Вперед', callback_data: `orders_page:${page+1}` });
    }
    
    if (filterStates[chatId]) {
      paginationButtons.push({ text: '❌ Сбросить фильтр', callback_data: 'clear_filters' });
    }
    
    if (paginationButtons.length > 0) {
      inlineKeyboard.push(paginationButtons);
    }
    
    const keyboard = {
      inline_keyboard: inlineKeyboard
    };
    
    await adminBot.editMessageText(ordersText, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Ошибка возврата к заказам:', error);
  }
}

app.post('/api/support/message', upload.single('file'), async (req, res) => {
  try {
    let user_id, message, dialog_id;
    let fileData = null;

    if (req.file) {
      user_id = req.body.user_id;
      dialog_id = req.body.dialog_id;
      message = req.body.message || '';

      const mimeType = req.file.mimetype;
      const isImage = mimeType.startsWith('image/');

      let fileBuffer = req.file.buffer;
      let finalMimeType = mimeType;

      if (isImage) {
        try {
          fileBuffer = await sharp(req.file.buffer)
            .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80, progressive: true })
            .toBuffer();
          finalMimeType = 'image/jpeg';
        } catch (sharpError) {
          console.error('Ошибка оптимизации изображения:', sharpError);
        }
      }

      const base64File = fileBuffer.toString('base64');
      const dataUrl = `data:${finalMimeType};base64,${base64File}`;

      let preview = null;
      if (isImage) {
        try {
          const previewBuffer = await sharp(req.file.buffer)
            .resize(200, 200, { fit: 'cover' })
            .jpeg({ quality: 70 })
            .toBuffer();
          preview = `data:image/jpeg;base64,${previewBuffer.toString('base64')}`;
        } catch (previewError) {
          console.error('Ошибка создания preview:', previewError);
        }
      }

      fileData = {
        name: req.file.originalname,
        size: fileBuffer.length,
        type: finalMimeType,
        url: dataUrl,
        isImage: isImage,
        preview: preview,
        thumbnail: preview
      };
    } else {
      user_id = req.body.user_id;
      message = req.body.message;
      dialog_id = req.body.dialog_id;
    }

    if (!user_id || (!message && !fileData)) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let dialogId = dialog_id;
    if (!dialogId) {
      const existing = await pool.query(
        'SELECT id FROM support_dialogs WHERE user_id = $1 AND status = $2',
        [user_id, 'active']
      );

      if (existing.rows.length > 0) {
        dialogId = existing.rows[0].id;
      } else {
        const newDialog = await pool.query(
          'INSERT INTO support_dialogs (user_id, status) VALUES ($1, $2) RETURNING id',
          [user_id, 'active']
        );
        dialogId = newDialog.rows[0].id;
      }
    }

    let finalMessage = message;
    let metadata = {};
    if (fileData) {
      metadata.file = fileData;
      finalMessage = finalMessage || (fileData.isImage ? '[Изображение]' : `[Файл: ${fileData.name}]`);
    }

    const result = await pool.query(
      `INSERT INTO support_messages (dialog_id, user_id, sender, message, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [dialogId, user_id, 'user', finalMessage, metadata]
    );

    await pool.query(
      'UPDATE support_dialogs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [dialogId]
    );

    const userResult = await pool.query(
      'SELECT username FROM users WHERE id = $1',
      [user_id]
    );
    const username = userResult.rows[0]?.username || `ID ${user_id}`;

    let adminMessage = `💬 Новое сообщение в диалоге #${dialogId}\n\n👤 ${username}\n`;

    if (message) {
      adminMessage += `📝 ${message}\n`;
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: '📤 Ответить', callback_data: `support_reply:${dialogId}` },
          { text: '🔐 Закрыть', callback_data: `support_close:${dialogId}` }
        ]
      ]
    };

   try {
  if (fileData && fileData.isImage) {
    // Отправляем как буфер файла, а не как base64-URL
    await adminBot.sendPhoto(ADMIN_ID, {
      source: req.file.buffer,           // ← берём оригинальный буфер из multer
      filename: req.file.originalname
    }, {
      caption: adminMessage,
      reply_markup: keyboard
    });
  } else {
    await adminBot.sendMessage(ADMIN_ID, adminMessage, { reply_markup: keyboard });
  }
} catch (botError) {
  console.error('Ошибка отправки в админ-бот:', botError);
  await adminBot.sendMessage(ADMIN_ID, adminMessage + '\n(Не удалось отправить фото)', { reply_markup: keyboard });
}

    res.json({
      success: true,
      message: result.rows[0],
      dialog_id: dialogId
    });
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/support/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const dialog = await pool.query(
      'SELECT id FROM support_dialogs WHERE user_id = $1 AND status = $2',
      [userId, 'active']
    );
    
    if (dialog.rows.length === 0) {
      return res.json({ success: true, messages: [] });
    }
    
    const dialogId = dialog.rows[0].id;
    
    const messages = await pool.query(
      'SELECT * FROM support_messages WHERE dialog_id = $1 ORDER BY created_at ASC',
      [dialogId]
    );
    
    // Добавляем флаг isImage для удобства на клиенте
    const messagesWithFlags = messages.rows.map(msg => {
      if (msg.metadata && msg.metadata.file) {
        return {
          ...msg,
          metadata: {
            ...msg.metadata,
            file: {
              ...msg.metadata.file,
              isImage: msg.metadata.file.type?.startsWith('image/') || false
            }
          }
        };
      }
      return msg;
    });
    
    await pool.query(
      'UPDATE support_messages SET read = true WHERE dialog_id = $1 AND sender = $2',
      [dialogId, 'admin']
    );
    
    res.json({
      success: true,
      messages: messagesWithFlags,
      dialog_id: dialogId
    });
    
  } catch (error) {
    console.error('Ошибка получения истории:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/support/new/:userId/:lastId', async (req, res) => {
  try {
    const { userId, lastId } = req.params;
    const lastMessageId = parseInt(lastId) || 0;
    
    const dialog = await pool.query(
      'SELECT id FROM support_dialogs WHERE user_id = $1 AND status = $2',
      [userId, 'active']
    );
    
    if (dialog.rows.length === 0) {
      return res.json({ success: true, messages: [] });
    }
    
    const dialogId = dialog.rows[0].id;
    
    const messages = await pool.query(
      'SELECT * FROM support_messages WHERE dialog_id = $1 AND id > $2 ORDER BY created_at ASC',
      [dialogId, lastMessageId]
    );
    
    // Добавляем флаг isImage
    const messagesWithFlags = messages.rows.map(msg => {
      if (msg.metadata && msg.metadata.file) {
        return {
          ...msg,
          metadata: {
            ...msg.metadata,
            file: {
              ...msg.metadata.file,
              isImage: msg.metadata.file.type?.startsWith('image/') || false
            }
          }
        };
      }
      return msg;
    });
    
    if (messages.rows.length > 0) {
      await pool.query(
        'UPDATE support_messages SET read = true WHERE dialog_id = $1 AND sender = $2 AND id > $3',
        [dialogId, 'admin', lastMessageId]
      );
    }
    
    res.json({
      success: true,
      messages: messagesWithFlags
    });
    
  } catch (error) {
    console.error('Ошибка проверки новых сообщений:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/auth/start-register', async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    
    try {
      const telegramLink = await generateBotLink('reg', token);
      
      authSessions.set(token, {
        type: 'register',
        createdAt: Date.now()
      });
      
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

app.post('/api/auth/start-login', async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    
    try {
      const telegramLink = await generateBotLink('login', token);
      
      authSessions.set(token, {
        type: 'login',
        createdAt: Date.now()
      });
      
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

app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    await pool.query(
      `INSERT INTO wallets (user_id, frozen_balance, balance, available_balance) 
       VALUES ($1, 0, 0, 0) 
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    
    const walletResult = await pool.query(
      'SELECT balance, frozen_balance, available_balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    
    const wallet = walletResult.rows[0];
    
    const transactionsResult = await pool.query(
      `SELECT id, type, amount, description as title, order_id as "orderId", created_at as date, metadata
       FROM wallet_transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 100`,
      [userId]
    );
    
    res.json({
      success: true,
      balance: wallet?.balance || 0,
      frozenBalance: wallet?.frozen_balance || 0,
      availableBalance: wallet?.available_balance || 0,
      transactions: transactionsResult.rows
    });
    
  } catch (error) {
    console.error('Ошибка получения кошелька:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/user/debt/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      `SELECT SUM(ABS(amount)) as total_debt 
       FROM wallet_transactions 
       WHERE user_id = $1 AND type = 'debt'`,
      [userId]
    );
    
    const debt = result.rows[0]?.total_debt || 0;
    
    res.json({
      success: true,
      debt: debt
    });
    
  } catch (error) {
    console.error('Ошибка получения задолженности:', error);
    res.json({ success: true, debt: 0 });
  }
});

app.get('/api/exchange/rate', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT rate FROM exchange_rate ORDER BY updated_at DESC LIMIT 1'
    );
    
    const rate = result.rows[0]?.rate || 1.0;
    
    res.json({
      success: true,
      rate: rate
    });
  } catch (error) {
    console.error('Ошибка получения курса:', error);
    res.json({ success: true, rate: 1.0 });
  }
});

app.post('/api/exchange/rate', async (req, res) => {
  try {
    const { rate } = req.body;
    
    await pool.query(
      'INSERT INTO exchange_rate (rate) VALUES ($1)',
      [rate]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка установки курса:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/exchange/swap', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { userId, amount, rate } = req.body;
    
    await client.query('BEGIN');
    
    const walletResult = await client.query(
      'SELECT frozen_balance, available_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    
    let wallet = walletResult.rows[0];
    
    if (!wallet) {
      await client.query(
        'INSERT INTO wallets (user_id, frozen_balance, available_balance) VALUES ($1, 0, 0)',
        [userId]
      );
      wallet = { frozen_balance: 0, available_balance: 0 };
    }
    
    if (wallet.frozen_balance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        error: 'Недостаточно замороженных средств' 
      });
    }
    
    const receivedAmount = amount * rate;
    
    await client.query(
      'UPDATE wallets SET frozen_balance = frozen_balance - $1 WHERE user_id = $2',
      [amount, userId]
    );
    
    await client.query(
      'UPDATE wallets SET available_balance = available_balance + $1 WHERE user_id = $2',
      [receivedAmount, userId]
    );
    
    await client.query(
      `INSERT INTO wallet_transactions 
       (user_id, type, amount, description, metadata) 
       VALUES ($1, 'withdraw', $2, $3, $4)`,
      [userId, -amount, `Обмен на DCoin`, JSON.stringify({ rate, received: receivedAmount })]
    );
    
    await client.query(
      `INSERT INTO wallet_transactions 
       (user_id, type, amount, description, metadata) 
       VALUES ($1, 'deposit', $2, $3, $4)`,
      [userId, receivedAmount, `Получено от обмена`, JSON.stringify({ rate, spent: amount })]
    );
    
    await client.query('COMMIT');
    
    res.json({ success: true });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Ошибка обмена:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/wallet/deposit', async (req, res) => {
  try {
    const { userId, amount, orderId, description } = req.body;
    
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        `INSERT INTO wallets (user_id, balance) 
         VALUES ($1, 0) 
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
      
      await client.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
        [amount, userId]
      );
      
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, order_id) 
         VALUES ($1, 'deposit', $2, $3, $4)`,
        [userId, amount, description || 'Пополнение кошелька', orderId]
      );
      
      await client.query('COMMIT');
      
      res.json({ success: true });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Ошибка пополнения кошелька:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/orders/refund', async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    
    const orderResult = await pool.query(
      'SELECT user_id FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const userId = orderResult.rows[0].user_id;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User not linked to order' });
    }
    
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        `INSERT INTO wallets (user_id, frozen_balance, balance, available_balance) 
         VALUES ($1, 0, 0, 0) 
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
      
      await client.query(
        'UPDATE wallets SET frozen_balance = frozen_balance + $1 WHERE user_id = $2',
        [amount, userId]
      );
      
      await client.query(
        `INSERT INTO wallet_transactions 
         (user_id, type, amount, description, order_id, metadata) 
         VALUES ($1, 'refund', $2, $3, $4, $5)`,
        [userId, amount, `Возврат по заказу #${orderId}`, orderId, JSON.stringify({ frozen: true, rate: 1.0 })]
      );
      
      await client.query(
        'UPDATE orders SET status = $1, refund_amount = $2 WHERE order_id = $3',
        ['manyback', amount, orderId]
      );
      
      await client.query('COMMIT');
      
      res.json({ success: true });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Ошибка оформления возврата:', error);
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
      res.json({
        success: true,
        authenticated: false,
        pending: true
      });
    } else {
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
    
    const ordersResult = await pool.query(
      `SELECT order_id as id, total, status, payment_status, email, code, 
              code_requested, wrong_code_attempts, created_at as date, refund_amount
       FROM orders 
       WHERE user_id = $1 AND (
         payment_status = 'confirmed' 
         OR status IN ('waiting', 'waiting_code_request', 'waiting_execution', 'completed', 'manyback')
       )
       ORDER BY created_at DESC`,
      [userId]
    );
    
    const orders = ordersResult.rows.map(order => ({
      id: order.id,
      total: order.total,
      status: order.status,
      date: order.date,
      email: order.email,
      code: order.code,
      refundAmount: order.refund_amount,
      codeRequested: order.code_requested,
      wrongAttempts: order.wrong_code_attempts,
      paymentStatus: order.payment_status,
      isActive: order.status !== 'completed' && order.status !== 'canceled' && order.status !== 'manyback'
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

app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT status, payment_status, code, wrong_code_attempts, email, code_requested, refund_amount FROM orders WHERE order_id = $1',
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
      refundAmount: order.refund_amount,
      maxAttemptsReached: (order.wrong_code_attempts || 0) >= 2,
      isCompleted: order.status === 'completed',
      isWaiting: order.status === 'waiting'
    });
  } catch (error) {
    console.error('Ошибка проверки статуса:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY price');
    res.json({ success: true, products: result.rows });
  } catch (error) {
    console.error('Ошибка получения товаров:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

app.get('/api/order-details/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = result.rows[0];
    
    const orderData = {
      id: order.order_id,
      date: order.created_at,
      email: order.email,
      status: order.status,
      total: order.total,
      items: order.items || {},
      code: order.code,
      refundAmount: order.refund_amount,
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

app.get('/api/order-stage/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const result = await pool.query(
      'SELECT status, email, code_requested, code, wrong_code_attempts, refund_amount FROM orders WHERE order_id = $1',
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
    const hasRefund = order.refund_amount > 0;
    
    let stage = '';
    let redirectUrl = '';
    
    if (status === 'manyback') {
      stage = 'refund_processed';
      redirectUrl = `moreorder.html?order=${orderId}`;
    } else if (!hasEmail && (status === 'new' || status === 'pending' || status === 'confirmed')) {
      stage = 'email_required';
      redirectUrl = `success.html?order=${orderId}`;
    } else if (hasEmail && !codeRequested && status === 'waiting_code_request') {
      stage = 'waiting_code_request';
      redirectUrl = `waiting_code.html?order=${orderId}`;
    } else if (codeRequested && !hasCode) {
      if (wrongAttempts >= 2) {
        stage = 'support_needed';
        redirectUrl = `bad_enter_code.html?order=${orderId}`;
      } else {
        stage = 'code_required';
        redirectUrl = `code.html?order=${orderId}`;
      }
    } else if (hasCode && status === 'waiting') {
      stage = 'waiting_execution';
      redirectUrl = `waiting_order.html?order=${orderId}`;
    } else if (status === 'completed') {
      stage = 'completed';
      redirectUrl = `ready.html?order=${orderId}`;
    } else if (status === 'canceled') {
      stage = 'canceled';
      redirectUrl = `moreorder.html?order=${orderId}`;
    } else {
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
        wrongAttempts: wrongAttempts,
        hasRefund: hasRefund,
        refundAmount: order.refund_amount
      }
    });
    
  } catch (error) {
    console.error('Ошибка определения этапа заказа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/order/:orderId/cancel', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    await pool.query(
      'UPDATE orders SET status = $1 WHERE order_id = $2',
      ['canceled', orderId]
    );
    
    res.json({
      success: true,
      message: 'Заказ отменен'
    });
  } catch (error) {
    console.error('Ошибка отмены заказа:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/order/:orderId/refund', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amount } = req.body;
    
    const orderResult = await pool.query(
      'SELECT total FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const order = orderResult.rows[0];
    
    if (amount <= 0 || amount > order.total) {
      return res.status(400).json({ 
        success: false, 
        error: `Сумма возврата должна быть от 1 до ${order.total}` 
      });
    }
    
    await pool.query(
      'UPDATE orders SET status = $1, refund_amount = $2 WHERE order_id = $3',
      ['manyback', amount, orderId]
    );
    
    res.json({
      success: true,
      message: 'Возврат оформлен'
    });
  } catch (error) {
    console.error('Ошибка оформления возврата:', error);
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
        { text: '📝 Управление заказом', callback_data: `order_detail:${orderId}:1` }
      ]]
    };
    
    await adminBot.sendMessage(ADMIN_ID, text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Ошибка отправки уведомления:', error);
  }
}

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

async function startServer() {
  try {
    await initDB();
    await loadSampleProducts();
    
    app.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
      console.log(`📞 API доступен по адресу: ${SERVER_URL}`);
      console.log(`🤖 Админ бот запущен`);
      console.log(`🤖 Бот для пользователей запущен`);
      console.log(`👑 Админ ID: ${ADMIN_ID}`);
      console.log(`🌐 Сайт: ${SITE_URL}`);
      
      startKeepAlive();
    });
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

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

startServer();
