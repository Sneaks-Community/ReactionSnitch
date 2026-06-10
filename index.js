import {
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Client,
  Partials,
} from "discord.js";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

import { server as healthServer } from "./healthcheck.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageData = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf8"),
);

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction
    ? {}
    : {
        transport: {
          options: {
            colorize: true,
            ignore: "pid,hostname",
            singleLine: false,
            translateTime: "mm-dd-yyyy HH:MM:ss Z",
          },
          target: "pino-pretty",
        },
      }),
});

// Validate required environment variables after logger initialization
// so that startup failures produce structured log output
if (!process.env.DISCORD_TOKEN || !process.env.CHANNEL_ID) {
  logger.error(
    {},
    "Missing required environment variables: DISCORD_TOKEN and CHANNEL_ID must be set in the .env file.",
  );
  throw new Error(
    "Missing required environment variables: DISCORD_TOKEN and CHANNEL_ID must be set in the .env file.",
  );
}

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Partials let MessageReactionAdd fire for reactions on uncached (older)
  // messages, not just messages cached since startup. Without these, reactions
  // on old messages would be silently dropped.
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

bot.on(Events.ClientReady, (client) => {
  logger.info({ tag: client.user.tag }, `Ready as ${client.user.tag}`);
  logger.debug({
    intents: {
      GuildMessageReactions: true,
      GuildMessages: true,
      Guilds: true,
    },
  }, "Intents enabled: Guilds, GuildMessages, GuildMessageReactions");
  logger.debug(
    {},
    'Make sure "GUILD_MESSAGE_REACTIONS" privileged intent is enabled in Discord Developer Portal > Bot > Privileged Gateway Intents',
  );
  client.user.setActivity(packageData.version);

  // Verify notification channel accessibility on startup
  const notifChannel = client.channels.cache.get(process.env.CHANNEL_ID);
  if (notifChannel) {
    const hasPermission = notifChannel.permissionsFor(client.user).has(["SendMessages"]);
    if (hasPermission) {
      logger.info(
        { channelId: process.env.CHANNEL_ID },
        "Notification channel verified and accessible",
      );
    } else {
      logger.warn(
        { channelId: process.env.CHANNEL_ID },
        "Notification channel exists but bot lacks SendMessages permission",
      );
    }
  } else {
    logger.warn(
      { channelId: process.env.CHANNEL_ID },
      "Notification channel not found in cache — it may be in a guild the bot is not yet aware of",
    );
  }
});

bot.on(Events.ClientError, (error) => {
  logger.error({ message: error.message }, `Bot Error: ${error.message}`);
});

// Handle WebSocket/shard errors — per discord.js production best practices.
// These errors (ECONNRESET, ETIMEDOUT) can cause silent disconnections
// if not explicitly handled.
bot.on(Events.ShardError, (error) => {
  logger.error({ message: error.message }, `Shard Error: ${error.message}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled Rejection");
});

// Deduplication set guarding against the same reaction event being processed
// more than once (e.g. a duplicate gateway delivery after a resume), which would
// otherwise send a second notification for the same first reaction.
// Keys are formatted as "messageId:userId:emojiName:emojiId".
const processedReactions = new Set();

function shouldProcessReaction(messageId, userId, emojiName, emojiId) {
  const key = `${messageId}:${userId}:${emojiName}:${emojiId || ""}`;
  if (processedReactions.has(key)) return false;
  processedReactions.add(key);
  return true;
}

// Periodically clean up the deduplication set to prevent unbounded memory growth.
// We clear the entire set periodically. This is safe because reactions are
// processed within seconds of occurring.
setInterval(() => {
  if (processedReactions.size > 10_000) {
    processedReactions.clear();
    logger.debug("Cleared deduplication set (size > 10000)");
  }
}, 5 * 60 * 1000);

// Resolve the notification channel, falling back to API fetch if not in cache.
// This handles reconnection scenarios where the channel cache may be empty.
async function getNotificationChannel(client) {
  let channel = client.channels.cache.get(process.env.CHANNEL_ID);
  if (channel) return channel;

  try {
    channel = await client.channels.fetch(process.env.CHANNEL_ID);
    return channel;
  } catch {
    // Channel not found — caller checks with `if (!channel)`
  }
}

// Shared notification function used by both MessageReactionAdd and raw handlers
async function sendNotification(user, emoji, message) {
  const emojiDisplay = emoji.id
    ? `<:${emoji.name}:${emoji.id}>`
    : emoji.name;

  const embedColor = process.env.EMBED_COLOR
    ? Number.parseInt(process.env.EMBED_COLOR.replace("#", ""), 16)
    : 9_442_302;

  const embed = new EmbedBuilder()
    .setTitle("Member has added a reaction")
    .setColor(embedColor)
    .setAuthor({
      iconURL: user.displayAvatarURL({ forceStatic: false, size: 128 }),
      name: user.tag,
    })
    .setDescription(
      `${user} added the ${emojiDisplay} reaction to this [message](${message.url}) in ${message.channel}.`,
    )
    .setFooter({ text: `ID: ${user.id}` })
    .setTimestamp();

  if (emoji.id) {
    embed.setThumbnail(
      `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=128`,
    );
  }

  const notifChannel = await getNotificationChannel(bot);
  if (!notifChannel) {
    logger.error(
      { channelId: process.env.CHANNEL_ID },
      "ReactionAdd: Could not find notification channel",
    );
    return;
  }

  try {
    await notifChannel.send({ embeds: [embed] });
    logger.debug(
      { channelId: process.env.CHANNEL_ID },
      "ReactionAdd: Message sent successfully",
    );
  } catch (sendError) {
    logger.error(
      { channelId: process.env.CHANNEL_ID, err: sendError.message },
      "ReactionAdd: Failed to send notification",
    );
  }
}

// Handle MESSAGE_REACTION_ADD event — only notifies on the first reaction of
// each emoji (reaction.count === 1). Partials are enabled (see Client config)
// so this fires for reactions on uncached/older messages too.
bot.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    // Skip bots
    if (user.bot) {
      logger.debug({ userTag: user.tag }, "ReactionAdd: Skipping bot reaction");
      return;
    }

    // Reactions on uncached messages arrive as partials with a null count.
    // Fetch to populate reaction.count from Discord's API before the count check.
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (fetchError) {
        logger.error(
          { err: fetchError.message },
          "ReactionAdd: Failed to fetch partial reaction",
        );
        return;
      }
    }

    // Only notify on the first reaction of each emoji.
    if (reaction.count !== 1) {
      logger.debug(
        { count: reaction.count },
        "ReactionAdd: Skipping — count is not 1",
      );
      return;
    }

    // Guard against the same first reaction being processed twice
    // (e.g. a duplicate gateway delivery after a resume).
    if (!shouldProcessReaction(reaction.message.id, user.id, reaction.emoji.name, reaction.emoji.id)) {
      logger.debug(
        { emojiId: reaction.emoji.id, emojiName: reaction.emoji.name, messageId: reaction.message.id, userId: user.id },
        "ReactionAdd: Duplicate — skipping",
      );
      return;
    }

    await sendNotification(user, reaction.emoji, reaction.message);
  } catch (error) {
    logger.error({ err: error.message }, "ReactionAdd: Unexpected error");
  }
});

bot.login(process.env.DISCORD_TOKEN);

// Graceful shutdown
let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, `Received ${signal}. Shutting down gracefully...`);
  try {
    // Close health server first
    await new Promise((resolve) => {
      healthServer.close(() => resolve());
    });
    await bot.destroy();
    logger.info("Bot disconnected.");
    process.exit(0);
  } catch (error) {
    logger.fatal({ err: error }, `Error during shutdown: ${error.message}`);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.fatal(
    { err: error.message, stack: error.stack },
    "Uncaught Exception — shutting down",
  );
  shutdown("uncaughtException");
});
