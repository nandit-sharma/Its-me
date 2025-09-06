const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Telegram bot token - MUST be set via environment variable for security
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("❌ TELEGRAM_BOT_TOKEN is missing in environment variables.");
}
const bot = new TelegramBot(token, { polling: true });

// Admin chat IDs (users who can manage rules)
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS ? process.env.ADMIN_CHAT_IDS.split(',').map(id => parseInt(id)) : [];

// Express server for Railway keep-alive
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is running ✅"));
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));

// WhatsApp client setup with enhanced session persistence
let client;
let isClientInitialized = false;
let qrShown = false;

function initializeWhatsAppClient() {
    if (isClientInitialized) {
        console.log('⚠️ WhatsApp client already initialized, skipping...');
        return;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "whatsapp-bot-session",
            dataPath: path.join(__dirname, '.wwebjs_auth'),
            backupSyncIntervalMs: 300000 // 5 minutes backup sync
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        }
    });

    client.on('qr', (qr) => {
        if (!qrShown) {
            console.log('WhatsApp QR Code generated. Scan with your phone:');
            qrcode.generate(qr, { small: true });
            qrShown = true;
        }
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp client is ready!');
        qrShown = false; // Reset for future sessions
    });

    client.on('authenticated', () => {
        console.log('✅ WhatsApp authenticated');
        qrShown = false;
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ WhatsApp authentication failed:', msg);
        qrShown = false;
        // Don't reinitialize immediately to prevent loops
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp client disconnected:', reason);
        qrShown = false;
        isClientInitialized = false;
        // Only reinitialize after a delay to prevent rapid restarts
        setTimeout(() => {
            if (!isClientInitialized) {
                console.log('🔄 Attempting to reconnect WhatsApp client...');
                initializeWhatsAppClient();
            }
        }, 10000); // 10 second delay
    });

    // Initialize the client
    client.initialize().then(() => {
        isClientInitialized = true;
        console.log('🚀 WhatsApp client initialization started');
    }).catch(err => {
        console.error('❌ Failed to initialize WhatsApp client:', err);
        isClientInitialized = false;
        qrShown = false;
    });
}

// Start WhatsApp client initialization
initializeWhatsAppClient();

// --- ENHANCED DATABASE SETUP WITH PERSISTENCE ---
const DB_FILE = path.join(__dirname, 'rules.db');
let db;

// Initialize database with better error handling
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                console.error('❌ Error opening database:', err);
                reject(err);
                return;
            }
            console.log('📊 Connected to SQLite database');
            
            // Create tables with enhanced structure
            db.serialize(() => {
                // Rules table
                db.run(`CREATE TABLE IF NOT EXISTS rules (
                    trigger TEXT PRIMARY KEY,
                    reply TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`);
                
                // Authorized numbers table (migrate from JSON)
                db.run(`CREATE TABLE IF NOT EXISTS authorized_numbers (
                    number TEXT PRIMARY KEY,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`);
                
                // Schedules table (migrate from JSON)
                db.run(`CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY,
                    number TEXT NOT NULL,
                    message TEXT NOT NULL,
                    hour INTEGER NOT NULL,
                    minute INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`);
                
                console.log("✅ SQLite database initialized with all tables");
                resolve(db);
            });
        });
    });
}

// Initialize database at startup
initializeDatabase().catch(err => {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
});

// --- AUTHORIZED NUMBERS WITH DATABASE PERSISTENCE ---
const AUTHORIZED_NUMBERS_FILE = path.join(__dirname, 'authorized_numbers.json');
let authorizedNumbers = [];

// Migrate JSON data to database
function migrateAuthorizedNumbersToDb() {
    if (fs.existsSync(AUTHORIZED_NUMBERS_FILE)) {
        try {
            const data = fs.readFileSync(AUTHORIZED_NUMBERS_FILE, 'utf8');
            const jsonNumbers = data.trim() ? JSON.parse(data) : [];
            
            if (jsonNumbers.length > 0) {
                console.log('🔄 Migrating authorized numbers to database...');
                jsonNumbers.forEach(number => {
                    db.run('INSERT OR IGNORE INTO authorized_numbers (number) VALUES (?)', [number]);
                });
                console.log(`✅ Migrated ${jsonNumbers.length} authorized numbers to database`);
            }
        } catch (err) {
            console.error('⚠️ Error migrating authorized numbers:', err);
        }
    }
}

// Load authorized numbers from database
function loadAuthorizedNumbersFromDb() {
    return new Promise((resolve) => {
        db.all('SELECT number FROM authorized_numbers', (err, rows) => {
            if (err) {
                console.error('⚠️ Error loading authorized numbers from database:', err);
                resolve([]);
                return;
            }
            const numbers = rows.map(row => row.number);
            console.log(`✅ Authorized numbers loaded from database: ${numbers.length} numbers found`);
            resolve(numbers);
        });
    });
}

// Save authorized number to database
function saveAuthorizedNumberToDb(number) {
    return new Promise((resolve) => {
        db.run('INSERT OR IGNORE INTO authorized_numbers (number) VALUES (?)', [number], function(err) {
            if (err) {
                console.error('⚠️ Error saving authorized number:', err);
                resolve(false);
                return;
            }
            console.log(`💾 Authorized number saved to database: +${number}`);
            resolve(true);
        });
    });
}

// Remove authorized number from database
function removeAuthorizedNumberFromDb(number) {
    return new Promise((resolve) => {
        db.run('DELETE FROM authorized_numbers WHERE number = ?', [number], function(err) {
            if (err) {
                console.error('⚠️ Error removing authorized number:', err);
                resolve(false);
                return;
            }
            console.log(`🗑️ Authorized number removed from database: +${number}`);
            resolve(this.changes > 0);
        });
    });
}

// Database helper functions
function loadRulesFromDB(callback) {
    db.all("SELECT * FROM rules", (err, rows) => {
        if (err) {
            console.error("⚠️ Error loading rules from database:", err);
            callback({});
            return;
        }
        const rules = {};
        rows.forEach(row => {
            rules[row.trigger] = row.reply;
        });
        console.log("✅ Rules loaded from database:", rows.length, "rules found");
        callback(rules);
    });
}

function saveRuleToDB(trigger, reply, callback) {
    db.run("INSERT OR REPLACE INTO rules (trigger, reply) VALUES (?, ?)", [trigger, reply], function(err) {
        if (err) {
            console.error("⚠️ Error saving rule to database:", err);
            callback(false);
            return;
        }
        console.log("💾 Rule saved to database:", trigger, "→", reply);
        // Update global rules object
        rules[trigger] = reply;
        callback(true);
    });
}

function deleteRuleFromDB(trigger, callback) {
    db.run("DELETE FROM rules WHERE trigger = ?", [trigger], function(err) {
        if (err) {
            console.error("⚠️ Error deleting rule from database:", err);
            callback(false);
            return;
        }
        console.log("🗑️ Rule deleted from database:", trigger);
        // Update global rules object
        delete rules[trigger];
        callback(this.changes > 0);
    });
}

function getRuleFromDB(trigger, callback) {
    db.get("SELECT reply FROM rules WHERE trigger = ?", [trigger], (err, row) => {
        if (err) {
            console.error("⚠️ Error getting rule from database:", err);
            callback(null);
            return;
        }
        callback(row ? row.reply : null);
    });
}

// Legacy functions for backward compatibility
function loadAuthorizedNumbers() {
    // This now loads from database instead of JSON
    loadAuthorizedNumbersFromDb().then(numbers => {
        authorizedNumbers = numbers;
    });
}

function saveAuthorizedNumbers() {
    // This is now handled by individual database operations
    console.log("💾 Authorized numbers are automatically saved to database");
}

// Function to check if a number is authorized
function isAuthorizedNumber(phoneNumber) {
    // Extract number from WhatsApp format (e.g., "919876543210@c.us" -> "919876543210")
    const cleanNumber = phoneNumber.replace('@c.us', '').replace('@g.us', '');
    return authorizedNumbers.includes(cleanNumber);
}

// Function to check if user is admin
function isAdmin(chatId) {
    return ADMIN_CHAT_IDS.length === 0 || ADMIN_CHAT_IDS.includes(chatId);
}

// Initialize global rules object
let rules = {};

// Load rules at startup
loadRulesFromDB((loadedRules) => {
    rules = loadedRules;
});

// --- Initialize data at startup ---
// Wait for database to be ready, then migrate and load data
setTimeout(async () => {
    // Migrate existing JSON data to database
    migrateAuthorizedNumbersToDb();
    
    // Load authorized numbers from database
    authorizedNumbers = await loadAuthorizedNumbersFromDb();
    
    // Load rules
    loadRulesFromDB((loadedRules) => {
        rules = loadedRules;
    });
}, 1000); // Wait 1 second for database initialization

// --- SEND COMMAND ---
// Format: /send <number> "message"
// Handles phone numbers with +91 as default country code
bot.onText(/^\/send\s+(\d+)\s+"([^"]+)"/, async (msg, match) => {
    const chatId = msg.chat.id;
    let number = match[1]; // Phone number without country code
    const text = match[2]; // Message text

    // Add +91 if number doesn't start with country code
    if (!number.startsWith('+')) {
        // Remove leading 0 if present and add +91
        number = number.startsWith('0') ? number.substring(1) : number;
        number = `91${number}`;
    }

    try {
        // Check if WhatsApp client is ready
        if (!client.info) {
            bot.sendMessage(chatId, '❌ WhatsApp client is not ready. Please scan the QR code first.');
            return;
        }

        // Format number for WhatsApp
        const formattedNumber = `${number}@c.us`;
        
        // Check if number is registered on WhatsApp
        const numberId = await client.getNumberId(number);
        if (!numberId) {
            bot.sendMessage(chatId, `❌ Number "${number}" is not registered on WhatsApp.`);
            return;
        }

        // Send message
        await client.sendMessage(numberId._serialized, text);
        bot.sendMessage(chatId, `✅ Message sent to +${number}:\n"${text}"`);
        console.log(`📤 WhatsApp message sent to +${number}: ${text}`);
        
    } catch (err) {
        console.error('Send error:', err);
        bot.sendMessage(chatId, `⚠️ Failed to send message: ${err.message}`);
    }
});

// --- TELEGRAM AUTO-REPLY SYSTEM ---
// Auto-reply to all text messages based on rules
bot.on('message', async (msg) => {
    // Skip if it's a command or not a text message
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const messageText = msg.text.toLowerCase();
    
    // Check rules for matches
    for (const [trigger, reply] of Object.entries(rules)) {
        if (messageText.includes(trigger.toLowerCase())) {
            await bot.sendMessage(chatId, reply);
            console.log(`📤 Auto-replied to "${msg.text}" with rule "${trigger}" → "${reply}"`);
            break; // Reply only to the first matching rule
        }
    }
});

// --- RULE MANAGEMENT COMMANDS ---
// List rules
bot.onText(/\/listrules/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage rules.");
        return;
    }
    
    loadRulesFromDB((rules) => {
        if (Object.keys(rules).length === 0) {
            bot.sendMessage(chatId, "📭 No rules saved yet.");
        } else {
            let text = "📜 Saved Rules:\n\n";
            let count = 1;
            for (const [trigger, reply] of Object.entries(rules)) {
                text += `${count}. "${trigger}" → "${reply}"\n`;
                count++;
            }
            bot.sendMessage(chatId, text);
        }
    });
});

// Add rule
bot.onText(/\/addrule\s*"([^"]+)"\s*"([^"]+)"/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage rules.");
        return;
    }
    
    const trigger = match[1].toLowerCase();
    const reply = match[2];

    saveRuleToDB(trigger, reply, (success) => {
        if (success) {
            bot.sendMessage(chatId, `✅ Rule added:\nTrigger: "${trigger}"\nReply: "${reply}"\n\nThis rule will now auto-reply to messages containing "${trigger}"`);
        } else {
            bot.sendMessage(chatId, "❌ Failed to save rule to database.");
        }
    });
});

// Delete rule
bot.onText(/\/deleterule\s*"([^"]+)"/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage rules.");
        return;
    }
    
    const trigger = match[1].toLowerCase();

    deleteRuleFromDB(trigger, (success) => {
        if (success) {
            bot.sendMessage(chatId, `🗑️ Rule "${trigger}" deleted successfully.`);
        } else {
            bot.sendMessage(chatId, `⚠️ Rule "${trigger}" not found.`);
        }
    });
});

// Edit rule
bot.onText(/\/editrule\s*"([^"]+)"\s*"([^"]+)"/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage rules.");
        return;
    }
    
    const trigger = match[1].toLowerCase();
    const newReply = match[2];

    getRuleFromDB(trigger, (oldReply) => {
        if (oldReply) {
            saveRuleToDB(trigger, newReply, (success) => {
                if (success) {
                    bot.sendMessage(chatId, `✏️ Rule updated:\nTrigger: "${trigger}"\nOld reply: "${oldReply}"\nNew reply: "${newReply}"`);
                } else {
                    bot.sendMessage(chatId, "❌ Failed to update rule in database.");
                }
            });
        } else {
            bot.sendMessage(chatId, `⚠️ Rule "${trigger}" not found. Use /addrule to create a new rule.`);
        }
    });
});

// --- AUTHORIZED NUMBERS MANAGEMENT COMMANDS ---
// Add authorized number
bot.onText(/\/addnumber\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage authorized numbers.");
        return;
    }
    
    let number = match[1];
    
    // Add +91 if number doesn't start with country code
    if (!number.startsWith('+')) {
        number = number.startsWith('0') ? number.substring(1) : number;
        number = `91${number}`;
    }
    
    if (authorizedNumbers.includes(number)) {
        bot.sendMessage(chatId, `⚠️ Number +${number} is already authorized.`);
    } else {
        const success = await saveAuthorizedNumberToDb(number);
        if (success) {
            authorizedNumbers.push(number);
            bot.sendMessage(chatId, `✅ Number +${number} added to authorized list.\n\nThis number can now receive auto-replies from the bot.`);
        } else {
            bot.sendMessage(chatId, `❌ Failed to add number +${number} to database.`);
        }
    }
});

// List authorized numbers
bot.onText(/\/listnumbers/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to view authorized numbers.");
        return;
    }
    
    if (authorizedNumbers.length === 0) {
        bot.sendMessage(chatId, "📭 No authorized numbers saved yet.\n\nUse /addnumber <number> to add numbers that can receive auto-replies.");
    } else {
        let text = "📱 Authorized Numbers:\n\n";
        authorizedNumbers.forEach((number, index) => {
            text += `${index + 1}. +${number}\n`;
        });
        text += `\n📊 Total: ${authorizedNumbers.length} numbers`;
        bot.sendMessage(chatId, text);
    }
});

// Remove authorized number
bot.onText(/\/removenumber\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage authorized numbers.");
        return;
    }
    
    let number = match[1];
    
    // Add +91 if number doesn't start with country code
    if (!number.startsWith('+')) {
        number = number.startsWith('0') ? number.substring(1) : number;
        number = `91${number}`;
    }
    
    const index = authorizedNumbers.indexOf(number);
    if (index > -1) {
        const success = await removeAuthorizedNumberFromDb(number);
        if (success) {
            authorizedNumbers.splice(index, 1);
            bot.sendMessage(chatId, `🗑️ Number +${number} removed from authorized list.`);
        } else {
            bot.sendMessage(chatId, `❌ Failed to remove number +${number} from database.`);
        }
    } else {
        bot.sendMessage(chatId, `⚠️ Number +${number} is not in the authorized list.`);
    }
});

// Help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `🤖 **Telegram Auto-Reply Bot Commands**\n\n` +
        `**Message Auto-Reply:**\n` +
        `• Bot automatically replies to messages from authorized numbers only\n\n` +
        `**Rule Management:**\n` +
        `• /listrules - List all saved rules\n` +
        `• /addrule "trigger" "reply" - Add new rule\n` +
        `• /editrule "trigger" "new_reply" - Edit existing rule\n` +
        `• /deleterule "trigger" - Delete rule\n\n` +
        `**Authorized Numbers:**\n` +
        `• /addnumber <number> - Add number to authorized list\n` +
        `• /listnumbers - List all authorized numbers\n` +
        `• /removenumber <number> - Remove number from authorized list\n\n` +
        `**WhatsApp Integration:**\n` +
        `• /send <number> "message" - Send message to WhatsApp\n\n` +
        `**Scheduled Messages:**\n` +
        `• /schedule <number> "message" HH:MM - Schedule daily message\n` +
        `• /listschedules - List all active schedules\n` +
        `• /cancelschedule <number> HH:MM - Cancel a schedule\n\n` +
        `**Examples:**\n` +
        `• /addnumber 9876543210 - Allow this number to receive auto-replies\n` +
        `• /addrule "hello" "Hi there! How can I help you?"\n` +
        `• /send 9876543210 "Hello from Telegram!"\n` +
        `• /schedule 9876543210 "Good morning!" 08:00\n\n` +
        `**Note:** Rules are case-insensitive and match partial text.`;
    
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// Start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeText = `🎉 **Welcome to Telegram Auto-Reply Bot!**\n\n` +
        `This bot automatically replies to your messages based on predefined rules.\n\n` +
        `Type /help to see all available commands.\n\n` +
        `Current rules: ${Object.keys(rules).length}`;
    
    bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
});

// --- WhatsApp Auto-Reply ---
client.on('message', async (msg) => {
    // Skip if message is from status broadcast or if it's from us
    if (msg.isStatus || msg.fromMe) return;
    
    // Check if the sender is authorized
    if (!isAuthorizedNumber(msg.from)) {
        console.log(`🚫 Message from unauthorized number: ${msg.from} - "${msg.body}"`);
        return;
    }
    
    const body = msg.body.toLowerCase();
    console.log(`📥 WhatsApp message received: "${msg.body}" from authorized number ${msg.from}`);
    
    // Load rules from database and check for matches
    loadRulesFromDB((rules) => {
        for (const trigger in rules) {
            if (body.includes(trigger.toLowerCase())) {
                console.log(`⏳ Waiting 5 seconds before replying to appear more human...`);
                
                // Add 5-second delay to make replies appear more natural
                setTimeout(async () => {
                    try {
                        await client.sendMessage(msg.from, rules[trigger]);
                        console.log(`📤 WhatsApp auto-replied with rule "${trigger}" → "${rules[trigger]}" (after 5s delay)`);
                    } catch (err) {
                        console.error('⚠️ Error sending delayed WhatsApp reply:', err);
                    }
                }, 5000); // 5 seconds = 5000 milliseconds
                
                break; // Reply only to the first matching rule
            }
        }
    });
});


// NEW WORk...

// --- SCHEDULED MESSAGES WITH DATABASE PERSISTENCE ---
const cron = require('node-cron');
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');

// --- Enhanced Schedule Management ---
let schedules = {};

// Migrate JSON schedules to database
function migrateSchedulesToDb() {
    if (fs.existsSync(SCHEDULE_FILE)) {
        try {
            const data = fs.readFileSync(SCHEDULE_FILE, 'utf8');
            const jsonSchedules = data.trim() ? JSON.parse(data) : {};
            
            if (Object.keys(jsonSchedules).length > 0) {
                console.log('🔄 Migrating schedules to database...');
                for (const [id, schedule] of Object.entries(jsonSchedules)) {
                    db.run('INSERT OR IGNORE INTO schedules (id, number, message, hour, minute) VALUES (?, ?, ?, ?, ?)', 
                        [id, schedule.number, schedule.text, schedule.hour, schedule.minute]);
                }
                console.log(`✅ Migrated ${Object.keys(jsonSchedules).length} schedules to database`);
            }
        } catch (err) {
            console.error('⚠️ Error migrating schedules:', err);
        }
    }
}

// Load schedules from database
function loadSchedulesFromDb() {
    return new Promise((resolve) => {
        db.all('SELECT * FROM schedules', (err, rows) => {
            if (err) {
                console.error('⚠️ Error loading schedules from database:', err);
                resolve({});
                return;
            }
            const dbSchedules = {};
            rows.forEach(row => {
                dbSchedules[row.id] = {
                    number: row.number,
                    text: row.message,
                    hour: row.hour,
                    minute: row.minute
                };
            });
            console.log(`✅ Schedules loaded from database: ${rows.length} found`);
            resolve(dbSchedules);
        });
    });
}

// Save schedule to database
function saveScheduleToDb(id, schedule) {
    return new Promise((resolve) => {
        db.run('INSERT OR REPLACE INTO schedules (id, number, message, hour, minute) VALUES (?, ?, ?, ?, ?)', 
            [id, schedule.number, schedule.text, schedule.hour, schedule.minute], function(err) {
            if (err) {
                console.error('⚠️ Error saving schedule:', err);
                resolve(false);
                return;
            }
            console.log(`💾 Schedule saved to database: ${id}`);
            resolve(true);
        });
    });
}

// Remove schedule from database
function removeScheduleFromDb(id) {
    return new Promise((resolve) => {
        db.run('DELETE FROM schedules WHERE id = ?', [id], function(err) {
            if (err) {
                console.error('⚠️ Error removing schedule:', err);
                resolve(false);
                return;
            }
            console.log(`🗑️ Schedule removed from database: ${id}`);
            resolve(this.changes > 0);
        });
    });
}

// Legacy functions for backward compatibility
function loadSchedules() {
    loadSchedulesFromDb().then(dbSchedules => {
        schedules = dbSchedules;
    });
}

function saveSchedules() {
    console.log("💾 Schedules are automatically saved to database");
}

// Store active cron jobs
let scheduledJobs = {};

// Initialize schedules at startup
function initSchedules() {
    console.log(`🔄 Initializing ${Object.keys(schedules).length} saved schedules...`);
    let successCount = 0;
    for (const id in schedules) {
        try {
            createSchedule(id, schedules[id]);
            successCount++;
        } catch (err) {
            console.error(`⚠️ Failed to initialize schedule ${id}:`, err);
        }
    }
    console.log(`✅ Successfully initialized ${successCount}/${Object.keys(schedules).length} schedules`);
}

// Helper: create cron job
function createSchedule(id, { number, text, hour, minute }) {
    const cronTime = `${minute} ${hour} * * *`;
    try {
        scheduledJobs[id] = cron.schedule(cronTime, async () => {
            try {
                if (!client.info) {
                    console.log('❌ WhatsApp client not ready.');
                    return;
                }
                const numberId = await client.getNumberId(number);
                if (!numberId) {
                    console.log(`❌ Number "${number}" is not registered on WhatsApp.`);
                    return;
                }
                await client.sendMessage(numberId._serialized, text);
                console.log(`📤 Scheduled message sent to +${number}: ${text}`);
            } catch (err) {
                console.error('⚠️ Error sending scheduled message:', err);
            }
        }, {
            scheduled: false
        });
        
        // Start the cron job
        scheduledJobs[id].start();
        console.log(`🕒 Schedule created for +${number} at ${hour}:${minute} (${cronTime})`);
    } catch (err) {
        console.error(`⚠️ Error creating schedule ${id}:`, err);
    }
}

// --- Telegram Commands ---
// /schedule <number> "message" HH:MM
bot.onText(/^\/schedule\s+(\d+)\s+"([^"]+)"\s+(\d{2}):(\d{2})$/, async (msg, match) => {
    const chatId = msg.chat.id;
    let number = match[1];
    const text = match[2];
    const hour = match[3];
    const minute = match[4];

    if (!number.startsWith('+')) {
        number = number.startsWith('0') ? number.substring(1) : number;
        number = `91${number}`; // default India code
    }

    // Unique ID per schedule (number + time)
    const id = `${number}_${hour}:${minute}`;

    // Remove old job if exists
    if (scheduledJobs[id]) {
        scheduledJobs[id].stop();
        delete scheduledJobs[id];
    }

    // Save to database
    const scheduleData = { number, text, hour, minute };
    const success = await saveScheduleToDb(id, scheduleData);
    
    if (success) {
        schedules[id] = scheduleData;
        
        // Create new schedule
        try {
            createSchedule(id, schedules[id]);
            bot.sendMessage(chatId, `✅ Scheduled daily message:\nTo: +${number}\nText: "${text}"\nTime: ${hour}:${minute}\n\n📅 This message will be sent every day at ${hour}:${minute}`);
        } catch (err) {
            console.error('Error creating schedule:', err);
            bot.sendMessage(chatId, `⚠️ Failed to create schedule: ${err.message}`);
        }
    } else {
        bot.sendMessage(chatId, `❌ Failed to save schedule to database.`);
    }
});

// /listschedules
bot.onText(/\/listschedules/, (msg) => {
    const chatId = msg.chat.id;
    if (Object.keys(schedules).length === 0) {
        bot.sendMessage(chatId, "📭 No schedules set.");
    } else {
        let text = "📅 Active Schedules:\n\n";
        let count = 1;
        for (const [id, sched] of Object.entries(schedules)) {
            text += `${count}. +${sched.number} → "${sched.text}" at ${sched.hour}:${sched.minute}\n`;
            count++;
        }
        bot.sendMessage(chatId, text);
    }
});

// /cancelschedule <number> HH:MM
bot.onText(/^\/cancelschedule\s+(\d+)\s+(\d{2}):(\d{2})$/, async (msg, match) => {
    const chatId = msg.chat.id;
    let number = match[1];
    const hour = match[2];
    const minute = match[3];

    if (!number.startsWith('+')) {
        number = number.startsWith('0') ? number.substring(1) : number;
        number = `91${number}`;
    }

    const id = `${number}_${hour}:${minute}`;

    if (scheduledJobs[id]) {
        scheduledJobs[id].stop();
        scheduledJobs[id].destroy();
        delete scheduledJobs[id];
        console.log(`🛑 Stopped cron job for ${id}`);
    }

    if (schedules[id]) {
        const success = await removeScheduleFromDb(id);
        if (success) {
            delete schedules[id];
            bot.sendMessage(chatId, `🗑️ Schedule for +${number} at ${hour}:${minute} cancelled.`);
        } else {
            bot.sendMessage(chatId, `❌ Failed to remove schedule from database.`);
        }
    } else {
        bot.sendMessage(chatId, `⚠️ No schedule found for +${number} at ${hour}:${minute}.`);
    }
});

// Load schedules on startup with database migration
setTimeout(async () => {
    // Migrate existing JSON schedules to database
    migrateSchedulesToDb();
    
    // Load schedules from database
    schedules = await loadSchedulesFromDb();
    
    // Initialize cron jobs
    initSchedules();
}, 2000); // Wait 2 seconds for database initialization
