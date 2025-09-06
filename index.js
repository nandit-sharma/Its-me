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

// WhatsApp client setup with session persistence
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-session",
        dataPath: path.join(__dirname, '.wwebjs_auth')
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
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('WhatsApp QR Code generated. Scan with your phone:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated');
});

client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp client disconnected:', reason);
});

// Initialize WhatsApp client
client.initialize().catch(err => {
    console.error('❌ Failed to initialize WhatsApp client:', err);
});

// --- SQLITE DATABASE SETUP ---
const DB_FILE = path.join(__dirname, 'rules.db');
const db = new sqlite3.Database(DB_FILE);

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS rules (
        trigger TEXT PRIMARY KEY,
        reply TEXT
    )`);
    console.log("✅ SQLite database initialized");
});

// --- AUTHORIZED NUMBERS FILE ---
const AUTHORIZED_NUMBERS_FILE = path.join(__dirname, 'authorized_numbers.json');

// --- Load Authorized Numbers ---
let authorizedNumbers = [];

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

function loadAuthorizedNumbers() {
    if (fs.existsSync(AUTHORIZED_NUMBERS_FILE)) {
        try {
            const data = fs.readFileSync(AUTHORIZED_NUMBERS_FILE, 'utf8');
            authorizedNumbers = data.trim() ? JSON.parse(data) : [];
            console.log("✅ Authorized numbers loaded:", authorizedNumbers.length, "numbers found");
        } catch (err) {
            console.error("⚠️ Error reading authorized_numbers.json:", err);
            authorizedNumbers = [];
        }
    } else {
        authorizedNumbers = [];
        fs.writeFileSync(AUTHORIZED_NUMBERS_FILE, JSON.stringify(authorizedNumbers, null, 2));
        console.log("🆕 authorized_numbers.json created");
    }
}

function saveAuthorizedNumbers() {
    try {
        fs.writeFileSync(AUTHORIZED_NUMBERS_FILE, JSON.stringify(authorizedNumbers, null, 2));
        console.log("💾 Authorized numbers saved:", authorizedNumbers.length, "numbers total");
    } catch (err) {
        console.error("⚠️ Error saving authorized_numbers.json:", err);
    }
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

// --- Load authorized numbers at startup ---
loadAuthorizedNumbers();

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
bot.onText(/\/addnumber\s+(\d+)/, (msg, match) => {
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
        authorizedNumbers.push(number);
        saveAuthorizedNumbers();
        bot.sendMessage(chatId, `✅ Number +${number} added to authorized list.\n\nThis number can now receive auto-replies from the bot.`);
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
bot.onText(/\/removenumber\s+(\d+)/, (msg, match) => {
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
        authorizedNumbers.splice(index, 1);
        saveAuthorizedNumbers();
        bot.sendMessage(chatId, `🗑️ Number +${number} removed from authorized list.`);
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

// --- SCHEDULED MESSAGES ---
// Requires: npm install node-cron
const cron = require('node-cron');
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');

// --- Load Schedules ---
let schedules = {};
function loadSchedules() {
    if (fs.existsSync(SCHEDULE_FILE)) {
        try {
            const data = fs.readFileSync(SCHEDULE_FILE, 'utf8');
            schedules = data.trim() ? JSON.parse(data) : {};
            console.log("✅ Schedules loaded:", Object.keys(schedules).length, "found");
        } catch (err) {
            console.error("⚠️ Error reading schedule.json:", err);
            schedules = {};
        }
    } else {
        schedules = {};
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
        console.log("🆕 schedule.json created");
    }
}

function saveSchedules() {
    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
        console.log("💾 Schedules saved:", Object.keys(schedules).length, "total");
    } catch (err) {
        console.error("⚠️ Error saving schedule.json:", err);
    }
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
bot.onText(/^\/schedule\s+(\d+)\s+"([^"]+)"\s+(\d{2}):(\d{2})$/, (msg, match) => {
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

    // Save to schedules.json
    schedules[id] = { number, text, hour, minute };
    saveSchedules();

    // Create new schedule
    try {
        createSchedule(id, schedules[id]);
        bot.sendMessage(chatId, `✅ Scheduled daily message:\nTo: +${number}\nText: "${text}"\nTime: ${hour}:${minute}\n\n📅 This message will be sent every day at ${hour}:${minute}`);
    } catch (err) {
        console.error('Error creating schedule:', err);
        bot.sendMessage(chatId, `⚠️ Failed to create schedule: ${err.message}`);
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
bot.onText(/^\/cancelschedule\s+(\d+)\s+(\d{2}):(\d{2})$/, (msg, match) => {
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
        delete schedules[id];
        saveSchedules();
        bot.sendMessage(chatId, `🗑️ Schedule for +${number} at ${hour}:${minute} cancelled.`);
    } else {
        bot.sendMessage(chatId, `⚠️ No schedule found for +${number} at ${hour}:${minute}.`);
    }
});

// Load schedules on startup
loadSchedules();
initSchedules();
