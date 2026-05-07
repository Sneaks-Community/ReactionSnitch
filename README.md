# ReactionSnitch

A Discord bot that posts notifications to a specified channel when someone adds a reaction to a message. It only notifies on the **first** reaction — subsequent reactions by the same or other users are ignored.

## Features

- Instant notification when a user reacts to a message for the first time
- Supports both emoji and custom guild emojis
- Skips bot reactions to prevent notification loops
- Configurable log levels

## Prerequisites

- **Node.js** >= 24
- A [Discord Bot Token](https://discord.com/developers/docs/intro#getting-a-bot-token)
- A target Discord [Channel ID](https://support.discord.com/hc/en-us/articles/206346498-Putting-Server-on-Test-Mode) where notifications will be posted

## Setup

### 1. Create a Discord Application & Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, give it a name, and create it.
3. Navigate to the **Bot** section and click **Add Bot**.
4. Under **Privileged Gateway Intents**, enable:
   - **Guild Messages** intent
   - **Guild Message Reactions** intent
5. Copy the **Token** — you will need it for the `.env` file.

### 2. Get a Channel ID

1. In Discord, enable **Developer Mode**: go to **User Settings → Advanced → Developer Mode**.
2. Right-click the channel where you want notifications to appear and select **Copy ID**.

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=your_notification_channel_id_here
LOG_LEVEL=info
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Your Discord bot token |
| `CHANNEL_ID` | Yes | The channel ID where notifications will be sent |
| `LOG_LEVEL` | No | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`) |

### 4. Install Dependencies

```bash
npm install
```

### 5. Run the Bot

**Production:**

```bash
npm start
```

**Development (with auto-reload):**

```bash
npm run dev
```

## Docker

### Using Docker Compose (recommended)

1. Copy `.env.example` to `.env` and fill in your values (see [Configure Environment Variables](#3-configure-environment-variables)).

2. Start the container:

   ```bash
   docker compose up -d
   ```

### Using Docker directly

1. Build the image:

   ```bash
   docker build -t reactionsnitch .
   ```

2. Run the container:

   ```bash
   docker run -d --name reactionsnitch --env-file .env --restart unless-stopped reactionsnitch
   ```
