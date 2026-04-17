// Bot ready event — currently unused (startup logic is in index.js).
module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
  },
};
