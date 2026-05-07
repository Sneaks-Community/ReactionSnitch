import {
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Client,
} from "discord.js";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

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

// Deduplication set to prevent duplicate notifications when both the
// MessageReactionAdd event and raw handler fire for the same reaction.
// Keys are formatted as "messageId:user_id:emojiName:emojiId".
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

  const embed = new EmbedBuilder()
    .setTitle("Member has added a reaction")
    .setColor(9_442_302)
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

// Handle MESSAGE_REACTION_ADD event — only notifies on the first reaction (count === 1)
bot.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    // Skip bots
    if (user.bot) {
      logger.debug({ userTag: user.tag }, "ReactionAdd: Skipping bot reaction");
      return;
    }

    // Always create dedup key for all reactions to prevent Raw handler from
    // processing subsequent reactions that fail the count check.
    if (!shouldProcessReaction(reaction.message.id, user.id, reaction.emoji.name, reaction.emoji.id)) {
      logger.debug(
        { emojiId: reaction.emoji.id, emojiName: reaction.emoji.name, messageId: reaction.message.id, userId: user.id },
        "ReactionAdd: Duplicate — skipping",
      );
      return;
    }

    // Check if count is available (requires GUILD_MESSAGE_REACTIONS privileged intent)
    if (reaction.count === undefined || reaction.count === null) {
      logger.error(
        { count: reaction.count },
        "ReactionAdd: reaction.count is undefined — GUILD_MESSAGE_REACTIONS privileged intent must be enabled",
      );
      return;
    }

    // Wait for the reaction to be fully synced with Discord's API
    try {
      await reaction.fetch();
    } catch (fetchError) {
      logger.error(
        { err: fetchError.message },
        "ReactionAdd: reaction.fetch() failed — ensure GUILD_MESSAGE_REACTIONS privileged intent is enabled",
      );
      return;
    }

    // Only notify on the first reaction to avoid duplicate notifications
    if (reaction.count !== 1) {
      logger.debug(
        { count: reaction.count },
        "ReactionAdd: Skipping — count is not 1",
      );
      return;
    }

    await sendNotification(user, reaction.emoji, reaction.message);
  } catch (error) {
    logger.error({ err: error.message }, "ReactionAdd: Unexpected error");
  }
});

// Raw event handler as fallback for when GUILD_MESSAGE_REACTIONS privileged intent is NOT enabled.
// This catches reactions that the MessageReactionAdd event cannot provide count data for.
bot.on(Events.Raw, async (data) => {
  if (data.t !== "MESSAGE_REACTION_ADD") return;

  const d = data.d;
  if (!d) return;

  const messageId = d.message_id;
  const userId = d.user_id;
  const emojiName = d.emoji?.name || "";
  const emojiId = d.emoji?.id || undefined;
  const emojiAnimated = d.emoji?.animated || false;
  const guildId = d.guild_id;
  const channelId = d.channel_id;

  // Deduplication check
  if (!shouldProcessReaction(messageId, userId, emojiName, emojiId)) {
    logger.debug({ emojiId, emojiName, messageId, userId }, "RawReaction: Duplicate — skipping");
    return;
  }

  try {
    // Fetch the channel
    let channel = bot.channels.cache.get(channelId);
    if (!channel && guildId) {
      const guild = bot.guilds.cache.get(guildId);
      if (guild) {
        channel = await guild.channels.fetch(channelId).catch(() => {});
      }
    }

    if (!channel) {
      logger.error({ channelId }, "RawReaction: Could not find channel");
      return;
    }

    // Fetch the message from API
    let message;
    try {
      message = await channel.messages.fetch(messageId);
    } catch {
      logger.error({ channelId, messageId }, "RawReaction: Could not fetch message");
      return;
    }

    // Fetch the user
    let user = bot.users.cache.get(userId);
    if (!user) {
      try {
        user = await bot.users.fetch(userId);
      } catch {
        logger.error({ userId }, "RawReaction: Could not fetch user");
        return;
      }
    }

    // Skip bots
    if (user.bot) {
      logger.debug({ userTag: user.tag }, "RawReaction: Skipping bot reaction");
      return;
    }

    logger.debug({ messageId, userId, userTag: user.tag }, "RawReaction: Processing reaction");

    const emoji = { animated: emojiAnimated, id: emojiId, name: emojiName };
    await sendNotification(user, emoji, message);
  } catch (error) {
    logger.error({ err: error.message, messageId }, "RawReaction: Unexpected error");
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
    await bot.destroy();
    logger.info("Bot disconnected.");
  } catch (error) {
    logger.fatal({ err: error.message }, `Error during shutdown: ${error.message}`);
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
