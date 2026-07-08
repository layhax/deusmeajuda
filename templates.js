// templates.js
// Define templates para denúncias de hackers e denúncias gerais.
module.exports = {
  hacker: (data) =>
    `• **Usuário(s) do(s) trapaceiro(s):**\nR: ${data.users}\n\n` +
    `• **Trapaça(s) utilizada(s):**\nR: ${data.cheats}\n\n` +
    `• **Data do ocorrido:**\nR: ${data.date}\n\n` +
    `• **Momentos da prova em que a infração ocorre:**\nR: ${data.timestamps}\n\n` +
    `• **Link do vídeo (hospedado no YouTube, Twitch, Lightshot ou Imgur):**\nR: ${data.links}`,
  general: (data) =>
    `• **Usuário(s) do(s) infrator(es):**\nR: ${data.users}\n\n` +
    `• **Motivo(s):**\nR: ${data.reason}\n\n` +
    `• **Data do ocorrido:**\nR: ${data.date}\n\n` +
    `• **Momentos da prova em que a infração ocorre (somente para vídeos):**\nR: ${data.timestamps}\n\n` +
    `• **Provas (hospedadas no YouTube, Twitch, Lightshot ou Imgur):**\nR: ${data.links}`,
};
