# Telegram Auto-Reply Bot

A powerful Telegram bot that automatically replies to messages based on configurable rules and integrates with WhatsApp for message forwarding.

## Features

- **Auto-Reply System**: Automatically responds to Telegram messages based on predefined rules
- **Dynamic Rule Management**: Add, edit, and delete rules through Telegram commands
- **WhatsApp Integration**: Send messages to WhatsApp contacts directly from Telegram
- **Persistent Storage**: Rules are saved in `rules.json` file
- **Admin Controls**: Restrict rule management to specific users
- **Cloud Ready**: Configured for easy deployment to cloud platforms

## Setup

### 1. Prerequisites
- Node.js 16+ installed
- Telegram Bot Token (get from [@BotFather](https://t.me/botfather))
- WhatsApp account for integration

### 2. Installation
```bash
# Clone or download the project
cd telegram-auto-reply-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env
```

### 3. Configuration
Edit `.env` file with your settings:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_CHAT_IDS=your_telegram_user_id
NODE_ENV=production
PORT=3000
```

### 4. Running the Bot

#### Local Development
```bash
npm run dev
```

#### Production with PM2
```bash
# Install PM2 globally
npm install -g pm2

# Start bot with PM2
npm run pm2:start

# View logs
npm run pm2:logs

# Stop bot
npm run pm2:stop
```

## Commands

### Bot Commands
- `/start` - Welcome message and bot info
- `/help` - Show all available commands

### Rule Management (Admin Only)
- `/listrules` - List all saved rules
- `/addrule "trigger" "reply"` - Add new auto-reply rule
- `/editrule "trigger" "new_reply"` - Edit existing rule
- `/deleterule "trigger"` - Delete a rule

### WhatsApp Integration
- `/send <number> <message>` - Send message to WhatsApp contact

### Examples
```
/addrule "hello" "Hi there! How can I help you?"
/addrule "urgent" "I'll get back to you ASAP!"
/send 1234567890 "Hello from Telegram!"
```

## Cloud Deployment

### Docker Deployment
```bash
# Build Docker image
docker build -t telegram-bot .

# Run container
docker run -d --name telegram-bot \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e ADMIN_CHAT_IDS=your_user_id \
  -v $(pwd)/rules.json:/app/rules.json \
  -v $(pwd)/.wwebjs_cache:/app/.wwebjs_cache \
  telegram-bot
```

### Heroku Deployment
1. Create a new Heroku app
2. Set environment variables in Heroku dashboard
3. Deploy using Git:
```bash
git init
git add .
git commit -m "Initial commit"
heroku git:remote -a your-app-name
git push heroku main
```

### VPS Deployment
1. Upload files to your server
2. Install Node.js and PM2
3. Set environment variables
4. Run with PM2:
```bash
npm install
npm run pm2:start
```

## File Structure
```
├── index.js          # Main bot application
├── rules.json        # Auto-reply rules storage
├── package.json      # Dependencies and scripts
├── Dockerfile        # Docker configuration
├── .env.example      # Environment variables template
└── README.md         # This file
```

## How It Works

1. **Auto-Reply**: Bot monitors all incoming text messages and checks against rules in `rules.json`
2. **Rule Matching**: Uses case-insensitive partial text matching
3. **WhatsApp Integration**: Connects to WhatsApp Web for message forwarding
4. **Persistent Rules**: All rules are saved to `rules.json` and loaded on startup

## Security Notes

- Keep your `TELEGRAM_BOT_TOKEN` secure
- Use `ADMIN_CHAT_IDS` to restrict rule management
- Consider using environment variables for sensitive data
- Regularly backup your `rules.json` file

## Troubleshooting

### WhatsApp QR Code
- QR code will be displayed in console on first run
- Scan with WhatsApp mobile app to authenticate
- Session data is saved in `.wwebjs_cache/` folder

### Bot Not Responding
- Check if bot token is correct
- Ensure bot is started with `/start` command
- Verify rules exist with `/listrules`

### Permission Errors
- Check if your user ID is in `ADMIN_CHAT_IDS`
- Leave `ADMIN_CHAT_IDS` empty to allow all users

## Support

For issues and questions, check the console logs and ensure all environment variables are properly set.
