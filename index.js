const {Client, Intents} = require("discord.js");
const bot = new Client({intents: [Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_MESSAGE_REACTIONS]});
const config = require("./config.json");
bot.login(config.token)

bot.on("ready", () => {
    console.log(bot.user.tag)
    bot.user.setActivity(require("./package.json").version)
})

bot.on("messageReactionAdd", (reaction, user) => {
    if (user.bot) return;
    if (reaction.count == 1) {
        const embed = {
            "title": "Member has added a reaction",
            "description": `${user} added the ${reaction.emoji.name} reaction to this [message](${reaction.message.url}) in ${reaction.message.channel}.`,
            "color": 9442302,
            "timestamp": Date.now(),
            "footer": {
                "text": `ID: ${user.id}`
            },
            "thumbnail": {
                "url": reaction.emoji.url
            },
            "author": {
                "name": user.tag,
                "icon_url": user.avatarURL()
            }
        };

        bot.channels.cache.get(config.channelid).send({ embeds: [embed] })

    }
})
