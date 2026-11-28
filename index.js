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
const healthServer = startHealthServer(logger, () => parked.reason);

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
  // Sent with every identify, so the status survives full reconnects (setActivity would not).
  presence: { activities: [{ name: packageData.version }] },
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

// Holds the notification channel once it passes the ready check.
const notification = {};

bot.on(Events.ClientReady, async (client) => {
  logger.info({ tag: client.user.tag }, `Ready as ${client.user.tag}`);

  // Guild channels are cached at ready, so this usually verifies synchronously,
  // before discord.js replays queued reaction events.
  const id = process.env.CHANNEL_ID;
  let channel;
  try {
    channel = client.channels.cache.get(id) ?? (await client.channels.fetch(id));
  } catch (error) {
    return park(`Cannot fetch notification channel ${id}`, error);
  }
  if (!channel?.isSendable() || !channel.permissionsFor) {
    return park(`Notification channel ${id} is not a server channel the bot can post in`);
  }
  const required = ["ViewChannel", channel.isThread() ? "SendMessagesInThreads" : "SendMessages", "EmbedLinks"];
  const missing = channel.permissionsFor(client.user)?.missing(required) ?? required;
  if (missing.length > 0) {
    return park(`Bot lacks ${missing.join(", ")} in notification channel ${id}`);
  }

  notification.channel = channel;
  logger.info({ channelId: id, guildId: channel.guildId }, "Notification channel verified");
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

// Caps notifications per user so one account can't flood the notification channel.
// ponytail: fixed window per user; a sliding window if bursts at window edges matter.
const FLOOD_LIMIT = 10;
const FLOOD_WINDOW_MS = 60_000;
const floodWindows = new Map();

function floodCount(userId) {
  const now = Date.now();
  const entry = floodWindows.get(userId);
  if (!entry || now - entry.start > FLOOD_WINDOW_MS) {
    floodWindows.set(userId, { count: 1, start: now });
    return 1;
  }
  return ++entry.count;
}

// Periodically drop expired flood windows, and clear the deduplication set once it
// passes 10k entries (safe because reactions are processed within seconds).
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of floodWindows) {
    if (now - entry.start > FLOOD_WINDOW_MS) floodWindows.delete(userId);
  }

  if (processedReactions.size <= 10_000) return;

  processedReactions.clear();
  logger.debug("Cleared deduplication set (size > 10000)");
}, 5 * 60 * 1000);

async function sendNotification(user, emoji, message) {
  const embed = new EmbedBuilder()
    .setTitle("Member has added a reaction")
    .setColor(embedColor)
    .setAuthor({
      iconURL: user.displayAvatarURL({ forceStatic: false, size: 128 }),
      name: user.tag,
    })
    .setDescription(
      `${user} added the ${emoji} reaction to this [message](${message.url}) in ${message.channel}.`,
    )
    .setFooter({ text: `ID: ${user.id}` })
    .setTimestamp();

  if (emoji.id) {
    embed.setThumbnail(
      `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=128`,
    );
  }

  await postEmbed(embed);
}

async function sendFloodNotice(user) {
  await postEmbed(
    new EmbedBuilder()
      .setTitle("Reaction notifications paused for member")
      .setColor(embedColor)
      .setAuthor({
        iconURL: user.displayAvatarURL({ forceStatic: false, size: 128 }),
        name: user.tag,
      })
      .setDescription(
        `${user} triggered more than ${FLOOD_LIMIT} notifications within ${FLOOD_WINDOW_MS / 1000}s. Their further reactions are not reported until the window resets.`,
      )
      .setFooter({ text: `ID: ${user.id}` })
      .setTimestamp(),
  );
}

async function postEmbed(embed) {
  // Unset until the ready check passes; reachable only when that check had to fetch the channel.
  if (!notification.channel) {
    logger.warn({ channelId: process.env.CHANNEL_ID }, "Notification channel not verified; dropping notification");
    return;
  }

  try {
    await notification.channel.send({ embeds: [embed] });
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

    const notified = floodCount(user.id);
    if (notified > FLOOD_LIMIT) {
      if (notified === FLOOD_LIMIT + 1) {
        logger.warn({ userId: user.id }, "ReactionAdd: Flood cap reached, suppressing");
        await sendFloodNotice(user);
      } else {
        logger.debug({ userId: user.id }, "ReactionAdd: Flood cap active, skipping");
      }
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
