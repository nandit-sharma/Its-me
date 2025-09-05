const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Telegram bot token - Consider using environment variable for security
const token = process.env.TELEGRAM_BOT_TOKEN || "8377750008:AAFLWgl2JGVpzBhLChKQe-LfRDwQmNgnOp4";
const bot = new TelegramBot(token, { polling: true });

// Admin chat IDs (users who can manage rules)
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS ? process.env.ADMIN_CHAT_IDS.split(',').map(id => parseInt(id)) : [];

// WhatsApp client setup
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
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

// --- RULES FILE ---
const RULES_FILE = path.join(__dirname, 'rules.json');

// --- Load Rules ---
let rules = {};
function loadRules() {
    if (fs.existsSync(RULES_FILE)) {
        try {
            const data = fs.readFileSync(RULES_FILE, 'utf8');
            rules = data.trim() ? JSON.parse(data) : {};
            console.log("✅ Rules loaded:", Object.keys(rules).length, "rules found");
        } catch (err) {
            console.error("⚠️ Error reading rules.json:", err);
            rules = {};
        }
    } else {
        rules = {};
        fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
        console.log("🆕 rules.json created");
    }
}

function saveRules() {
    try {
        fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
        console.log("💾 Rules saved:", Object.keys(rules).length, "rules total");
    } catch (err) {
        console.error("⚠️ Error saving rules.json:", err);
    }
}

// Function to check if user is admin
function isAdmin(chatId) {
    return ADMIN_CHAT_IDS.length === 0 || ADMIN_CHAT_IDS.includes(chatId);
}

// --- Load rules at startup ---
loadRules();

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

// Add rule
bot.onText(/\/addrule\s*"([^"]+)"\s*"([^"]+)"/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage rules.");
        return;
    }
    
    const trigger = match[1].toLowerCase();
    const reply = match[2];

    rules[trigger] = reply;
    saveRules();
    bot.sendMessage(chatId, `✅ Rule added:\nTrigger: "${trigger}"\nReply: "${reply}"\n\nThis rule will now auto-reply to messages containing "${trigger}"`);
});

// Delete rule
bot.onText(/\/deleterule\s*"([^"]+)"/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "❌ You don't have permission to manage rules.");
        return;
    }
    
    const trigger = match[1].toLowerCase();

    if (Object.prototype.hasOwnProperty.call(rules, trigger)) {
        delete rules[trigger];
        saveRules();
        bot.sendMessage(chatId, `🗑️ Rule "${trigger}" deleted successfully.`);
    } else {
        bot.sendMessage(chatId, `⚠️ Rule "${trigger}" not found.`);
    }
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

    if (Object.prototype.hasOwnProperty.call(rules, trigger)) {
        const oldReply = rules[trigger];
        rules[trigger] = newReply;
        saveRules();
        bot.sendMessage(chatId, `✏️ Rule updated:\nTrigger: "${trigger}"\nOld reply: "${oldReply}"\nNew reply: "${newReply}"`);
    } else {
        bot.sendMessage(chatId, `⚠️ Rule "${trigger}" not found. Use /addrule to create a new rule.`);
    }
});

// Help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `🤖 **Telegram Auto-Reply Bot Commands**\n\n` +
        `**Message Auto-Reply:**\n` +
        `• Bot automatically replies to messages based on saved rules\n\n` +
        `**Rule Management:**\n` +
        `• /listrules - List all saved rules\n` +
        `• /addrule "trigger" "reply" - Add new rule\n` +
        `• /editrule "trigger" "new_reply" - Edit existing rule\n` +
        `• /deleterule "trigger" - Delete rule\n\n` +
        `**WhatsApp Integration:**\n` +
        `• /send <number> "message" - Send message to WhatsApp\n\n` +
        `**Scheduled Messages:**\n` +
        `• /schedule <number> "message" HH:MM - Schedule daily message\n` +
        `• /listschedules - List all active schedules\n` +
        `• /cancelschedule <number> HH:MM - Cancel a schedule\n\n` +
        `**Examples:**\n` +
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
    
    const body = msg.body.toLowerCase();
    console.log(`📥 WhatsApp message received: "${msg.body}" from ${msg.from}`);
    
    for (const trigger in rules) {
        if (body.includes(trigger.toLowerCase())) {
            await msg.reply(rules[trigger]);
            console.log(`📤 WhatsApp auto-replied with rule "${trigger}" → "${rules[trigger]}"`);
            break; // Reply only to the first matching rule
        }
    }
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
