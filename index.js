import {
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Client,
  Options,
  Partials,
  resolveColor,
  Routes,
} from "discord.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pino from "pino";

import { startHealthServer } from "./healthcheck.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageData = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf8"),
);

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(!isProduction && {
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

// Set when parked; the health endpoint reports it as a 503.
const parked = {};
const healthServer = startHealthServer(() => parked.reason);

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
  // Expire cached messages so idle channels don't pin 200 messages each forever;
  // reactions on expired messages fall back to the partial fetch.
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 600, lifetime: 1800 },
  },
});

// Permanent failure: stay alive and idle rather than exit, so no supervisor restart-loops the bot.
function park(reason, error) {
  parked.reason = reason;
  logger.fatal({ err: error }, `${reason}. Not retrying; fix the configuration and restart.`);
  bot.destroy();
}

if (!process.env.DISCORD_TOKEN || !process.env.CHANNEL_ID) {
  park("Missing DISCORD_TOKEN or CHANNEL_ID");
}

// Cosmetic setting, so a bad value warns and falls back instead of parking.
let embedColor = 9_442_302;
if (process.env.EMBED_COLOR) {
  try {
    embedColor = resolveColor(process.env.EMBED_COLOR);
  } catch {
    logger.warn({ value: process.env.EMBED_COLOR }, "Invalid EMBED_COLOR, using default");
  }
}

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
  logger.error({ err: error }, `Bot Error: ${error.message}`);
});

// Handle WebSocket/shard errors. These are transient connectivity blips
// (handshake timeouts, DNS failures, 5xx from the gateway) that djs
// recovers from on its own via automatic reconnect
bot.on(Events.ShardError, (error) => {
  logger.warn(
    { err: error },
    `Shard Error (transient — discord.js will auto-retry): ${error.message}`,
  );
});

// discord.js emits this only for close codes it won't reconnect from (bad token, disallowed intents).
bot.on(Events.ShardDisconnect, ({ code }, shardId) => {
  park(`Gateway closed shard ${shardId} with fatal code ${code}`);
});

bot.on(Events.ShardReconnecting, (shardId) => {
  logger.warn({ shardId }, `Shard ${shardId} reconnecting`);
});

bot.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info(
    { replayedEvents, shardId },
    `Shard ${shardId} resumed (${replayedEvents} events replayed)`,
  );
});

bot.on(Events.ShardReady, (shardId) => {
  logger.info({ shardId }, `Shard ${shardId} ready`);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled Rejection");
});

// Deduplication set guarding against the same reaction event being processed
// more than once (e.g. a duplicate gateway delivery after a resume), which would
// otherwise send a second notification for the same first reaction.
// Keys are formatted as "messageId:userId:emojiName:emojiId".
const processedReactions = new Set();

function shouldProcessReaction(messageId, userId, emojiName, emojiId) {
  const key = `${messageId}:${userId}:${emojiName}:${emojiId}`;
  if (processedReactions.has(key)) return false;
  processedReactions.add(key);
  return true;
}

// Periodically clean up the deduplication set to prevent unbounded memory growth.
// We clear the entire set periodically. This is safe because reactions are
// processed within seconds of occurring.
setInterval(() => {
  if (processedReactions.size <= 10_000) return;

  processedReactions.clear();
  logger.debug("Cleared deduplication set (size > 10000)");
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
      { channelId: process.env.CHANNEL_ID, err: sendError },
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
          { err: fetchError },
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
    logger.error({ err: error }, "ReactionAdd: Unexpected error");
  }
});

// A failed login() leaves the client permanently destroyed, so retry a REST pre-check and call login() once.
// ponytail: a failure inside login() parks; upgrade path is a fresh Client per attempt.
async function connect() {
  bot.rest.setToken(process.env.DISCORD_TOKEN);
  for (let delay = 5000; ; delay = Math.min(delay * 2, 300_000)) {
    try {
      await bot.rest.get(Routes.gatewayBot());
      break;
    } catch (error) {
      if (error.status === 401) return park("Discord rejected DISCORD_TOKEN", error);
      logger.warn({ err: error, retryInMs: delay }, "Discord unreachable, retrying");
      await sleep(delay);
    }
  }
  try {
    await bot.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    park("Login failed after Discord was reachable", error);
  }
}

// Graceful shutdown
const shutdownState = { inProgress: false };

const shutdown = async (signal, exitCode = 0) => {
  if (shutdownState.inProgress) return;
  shutdownState.inProgress = true;
  // Force exit if graceful shutdown hangs; unref so it never delays a clean exit.
  setTimeout(() => process.exit(1), 5000).unref();

  logger.info({ signal }, `Received ${signal}. Shutting down gracefully...`);
  try {
    // Close health server first
    await new Promise((resolve) => {
      healthServer.close(() => resolve());
    });
    await bot.destroy();
    logger.info("Bot disconnected.");
    process.exit(exitCode);
  } catch (error) {
    logger.fatal({ err: error }, `Error during shutdown: ${error.message}`);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception, shutting down");
  shutdown("uncaughtException", 1);
});

if (!parked.reason) await connect();
