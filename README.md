# Crypto Telegram Bot

A Telegram bot that provides cryptocurrency price information and market insights using CoinGecko API and AI-powered analysis.

## Features

- Get real-time cryptocurrency prices and market data
- AI-powered market insights using OpenAI
- DEX data integration via DexScreener API
- RESTful API endpoints for token analysis

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Telegram Bot Token (get from @BotFather)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# OpenAI API Key (for AI insights)
OPENAI_API_KEY=your_openai_api_key_here

# Database URL (if using Prisma)
DATABASE_URL="postgresql://username:password@localhost:5432/crypto_bot"
```

### 3. Get Telegram Bot Token

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` command
3. Follow the instructions to create your bot
4. Copy the token and add it to your `.env` file

### 4. Get OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Navigate to API Keys section
4. Create a new API key
5. Add it to your `.env` file

## Usage

### Start the Telegram Bot

```bash
npm run dev:bot
```

### Start the REST API Server

```bash
npm run dev:server
```

### Build for Production

```bash
npm run build
npm start
```

## API Endpoints

### GET /token/:address

Get comprehensive token analysis including DEX data, CoinGecko data, and AI insights.

Example:
```bash
curl http://localhost:3000/token/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984
```

## Telegram Bot Commands

- `/start` - Welcome message and instructions
- `/help` - Show available commands
- `/price <symbol>` - Get cryptocurrency price and market data

Examples:
- `/price BTC`
- `/price ETH`
- `/price DOGE`

## Troubleshooting

### Common Issues

1. **"TELEGRAM_BOT_TOKEN is not defined"**
   - Make sure you've created a `.env` file with your bot token
   - Verify the token is correct and active

2. **"OpenAI API key not found"**
   - Add your OpenAI API key to the `.env` file
   - Ensure you have sufficient credits in your OpenAI account

3. **Import/Module errors**
   - Make sure all dependencies are installed: `npm install`
   - Check that TypeScript is properly configured

4. **API rate limits**
   - CoinGecko has rate limits for free tier
   - Consider upgrading to paid tier for higher limits

### Development

- The bot uses TypeScript with ES modules
- Make sure `ts-node` is installed for development
- Use `npm run dev:bot` for bot development
- Use `npm run dev:server` for API development

## Project Structure

```
src/
├── api/           # REST API routes
├── bot/           # Telegram bot logic
├── services/      # External API integrations
│   ├── ai.ts      # OpenAI integration
│   ├── coingecko.ts # CoinGecko API
│   └── dex.ts     # DexScreener API
└── server.ts      # Fastify server setup
```

## Dependencies

- **telegraf** - Telegram bot framework
- **fastify** - Web framework for API
- **axios** - HTTP client
- **openai** - OpenAI API client
- **typescript** - Type safety
- **ts-node** - TypeScript execution
