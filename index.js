const Discord = require("discord.js");
const bot = new Discord.Client();
const config = require("./config.json");
bot.login(config.token)

const version = "1.1";

bot.on("ready", () => {
    console.log(bot.user.tag)
    bot.user.setActivity(version)
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

        bot.channels.cache.get(config.channelid).send({ embed })

    }
})
