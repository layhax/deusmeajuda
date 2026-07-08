// index.js
// Bot principal para denúncias no fórum Mush via Discord.
// Exemplo simplificado utilizando discord.js v14.

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  Events,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { postReport } = require('./reporter');
const { hacker, general } = require('./templates');
require('dotenv').config();

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

function withTimeout(promise, ms, message) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

// Criação do cliente Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Map para guardar informações das sessões de denúncia até que sejam aprovadas/recusadas
const reportSessions = new Map();

// Armazena contagem de denúncias por usuário (lido de arquivo no início)
let reportCounts = {};
try {
  const json = fs.readFileSync(path.join(__dirname, 'reports.json'), 'utf8');
  reportCounts = JSON.parse(json);
} catch (e) {
  reportCounts = {};
}

client.once(Events.ClientReady, () => {
  console.log(`Bot logado como ${client.user.tag}`);
});

// Registro do comando `/report` quando o bot estiver pronto.  
// A partir da v15 do discord.js, o evento `ready` foi renomeado para `clientReady`.  
// Por compatibilidade e para suprimir avisos de deprecação, usamos `Events.ClientReady` aqui.
client.once(Events.ClientReady, async () => {
  const data = new SlashCommandBuilder()
    .setName('report')
    .setDescription('Abrir formulário para denúncia no fórum.')
    .addSubcommand((sub) =>
      sub.setName('forum').setDescription('Enviar denúncia para o fórum Mush')
    )
    .addSubcommand((sub) =>
      sub.setName('ranking').setDescription('Mostrar ranking de usuários que mais reportaram'));
  await client.application.commands.create(data);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'report') {
    const subCmd = interaction.options.getSubcommand();
    // Subcomando para abrir denúncia
    if (subCmd === 'forum') {
      const userMessages = [];
      const channel = interaction.channel;
      const filter = (m) => m.author.id === interaction.user.id;
      const collector = channel.createMessageCollector({ filter, time: 5 * 60_000 });
      const reportData = {};
      let step = 'type';

      const introMsg = await interaction.reply('Qual o tipo de denúncia? Responda com `hacker` ou `geral`.');

      collector.on('collect', async (msg) => {
        // Guardar mensagens do usuário para excluir depois
        userMessages.push(msg);
        const content = msg.content.trim();
        if (step === 'type') {
          reportData.type = content.toLowerCase();
          await msg.reply('Informe o(s) usuário(s) denunciado(s):');
          step = 'users';
        } else if (step === 'users') {
          reportData.users = content;
          if (reportData.type === 'hacker') {
            await msg.reply('Informe a(s) trapaça(s) utilizada(s):');
            step = 'cheats';
          } else {
            await msg.reply('Informe o(s) motivo(s):');
            step = 'reason';
          }
        } else if (step === 'cheats') {
          reportData.cheats = content;
          await msg.reply('Data do ocorrido (ex: 07/07/2026):');
          step = 'date';
        } else if (step === 'reason') {
          reportData.reason = content;
          await msg.reply('Data do ocorrido (ex: 07/07/2026):');
          step = 'date';
        } else if (step === 'date') {
          reportData.date = content;
          await msg.reply('Momento(s) da prova (timestamps ou descreva):');
          step = 'timestamps';
        } else if (step === 'timestamps') {
          reportData.timestamps = content;
          await msg.reply(
            'Forneça links de prova (YouTube, Twitch, Lightshot, Imgur etc.) ou envie arquivos como anexos.\n' +
              'Você pode enviar somente anexos, somente links ou ambos.\n' +
              'Se não tiver links, deixe em branco ou responda `-` e envie apenas os anexos.'
          );
          step = 'links';
        } else if (step === 'links') {
          // Nesta etapa o usuário pode enviar links de prova ou anexar arquivos (imagens/vídeos).  
          // Se houver anexos, consideramos que ele forneceu provas.  
          // Se ele digitar '-' ou deixar em branco, mas enviar anexos, também finalizamos.  
          // Se ele digitar links sem anexos, também aceitamos.  
          // Se não houver links nem anexos, pedimos que envie ao menos uma prova.
          const hasAttachments = msg.attachments && msg.attachments.size > 0;
          const hasLinks = content && content !== '-' && content.trim().length > 0;
          if (hasAttachments || hasLinks) {
            reportData.links = hasLinks ? content : '-';
            if (hasAttachments) {
              reportData.attachmentUrls = msg.attachments.map((att) => att.url);
            }
            collector.stop('finalizado');
          } else {
            await msg.reply(
              'Por favor, envie pelo menos uma prova (link ou anexo) para prosseguir.'
            );
          }
        }
      });

      collector.on('end', async (collected, reason) => {
        if (reason !== 'finalizado') {
          return interaction.followUp('Tempo esgotado para preenchimento da denúncia.');
        }
        // Download de anexos, se houver
        const downloadedFiles = [];
        if (reportData.attachmentUrls && reportData.attachmentUrls.length) {
          for (const url of reportData.attachmentUrls) {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const filename = path.join(
              __dirname,
              'downloads',
              path.basename(new URL(url).pathname)
            );
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, response.data);
            downloadedFiles.push(filename);
          }
        }

        // Construção do template
        const content =
          reportData.type === 'hacker' ? hacker(reportData) : general(reportData);
        const title =
          reportData.type === 'hacker'
            ? `Denúncia contra ${reportData.users}`
            : `Denúncia Geral: ${reportData.users}`;
        const categoryUrl =
          reportData.type === 'hacker'
            ? 'https://forum.mush.com.br/category/15/den%C3%BAncias-de-hackers'
            : 'https://forum.mush.com.br/category/17/den%C3%BAncias-gerais';

        // Criar botões de revisão
        const sendBtn = new ButtonBuilder()
          .setCustomId('enviar')
          .setLabel('Enviar denúncia')
          .setStyle(ButtonStyle.Success);
        const refuseBtn = new ButtonBuilder()
          .setCustomId('recusar')
          .setLabel('Recusar denúncia')
          .setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(sendBtn, refuseBtn);

        // Enviar para canal de revisão
        // Use REVIEW_CHANNEL_ID para evitar problemas com caracteres especiais em nomes de variáveis.  
        // Mantém compatibilidade com o nome antigo CHANNEL_REVISÃO se presente.
        const reviewChannelId =
          process.env.REVIEW_CHANNEL_ID || process.env.CHANNEL_REVISÃO;
        if (!reviewChannelId) {
          throw new Error(
            'Variável de ambiente REVIEW_CHANNEL_ID/CHANNEL_REVISÃO não definida'
          );
        }
        const reviewChannel = await client.channels.fetch(reviewChannelId);
        const reviewMsg = await reviewChannel.send({
          content: `**Nova denúncia de ${interaction.user.tag}**\nCategoria: ${reportData.type}\nTítulo sugerido: ${title}\n\n${content}`,
          components: [row],
        });
        await interaction.followUp('Sua denúncia foi enviada para revisão.');

        // Armazenar sessão para uso posterior
        reportSessions.set(reviewMsg.id, {
          userMessages,
          originalChannelId: interaction.channel.id,
          reporterId: interaction.user.id,
          downloadedFiles,
          categoryUrl,
          title,
          content,
        });

        // Atualizar contagem de denúncias (independente de aprovação)
        const uid = interaction.user.id;
        reportCounts[uid] = (reportCounts[uid] || 0) + 1;
        fs.writeFileSync(path.join(__dirname, 'reports.json'), JSON.stringify(reportCounts, null, 2));

        // Coletor de botões
        const btnCollector = reviewMsg.createMessageComponentCollector({ time: 24 * 60 * 60_000 });
        btnCollector.on('collect', async (btnInteraction) => {
          const session = reportSessions.get(reviewMsg.id);
          if (!session) return;
          const {
            userMessages: uMsgs,
            originalChannelId,
            downloadedFiles: dFiles,
            categoryUrl: catUrl,
            title: ttl,
            content: cnt,
            reporterId,
          } = session;
          const originalChannel = await client.channels.fetch(originalChannelId);
          if (btnInteraction.customId === 'enviar') {
            // Notificar início de processamento ao canal original
            const thinkingMsg = await originalChannel.send('Felipe: Quebrando códigos...');
            await btnInteraction.reply('Publicando denúncia no fórum, aguarde...');
            try {
              const url = await withTimeout(postReport({
                categoryUrl: catUrl,
                title: ttl,
                content: cnt,
                tags: ['denúncia'],
                attachments: dFiles,
              }), 180000, 'Tempo limite ao tentar publicar no fórum. O navegador travou ou o site bloqueou a automação.');
              await btnInteraction.editReply(`Denúncia publicada com sucesso: ${url}`);
              // Excluir mensagens do usuário
              for (const m of uMsgs) {
                try {
                  await m.delete();
                } catch (e) {}
              }
              // Remover mensagem de pensamento e enviar confirmação
              try {
                await thinkingMsg.delete();
              } catch (e) {}
              await originalChannel.send('Felipe: O usuário foi reportado.');
              // Limpar sessão
              reportSessions.delete(reviewMsg.id);
            } catch (err) {
              await btnInteraction.editReply(`Erro ao publicar denúncia: ${err.message}`);
              // Mesmo em erro, apagar as mensagens do usuário
              for (const m of uMsgs) {
                try {
                  await m.delete();
                } catch (e) {}
              }
              try {
                await thinkingMsg.delete();
              } catch (e) {}
              await originalChannel.send('Felipe: Houve um erro ao reportar.');
              reportSessions.delete(reviewMsg.id);
            }
          } else if (btnInteraction.customId === 'recusar') {
            await btnInteraction.reply('Denúncia recusada.');
            // Excluir mensagens do usuário em caso de recusa
            for (const m of uMsgs) {
              try {
                await m.delete();
              } catch (e) {}
            }
            await originalChannel.send('Felipe: Sua denúncia foi recusada pelos moderadores.');
            reportSessions.delete(reviewMsg.id);
          }
        });
      });
    } else if (subCmd === 'ranking') {
      // Mostrar ranking de denúncias por usuário
      const entries = Object.entries(reportCounts);
      if (entries.length === 0) {
        return interaction.reply('Nenhuma denúncia foi registrada ainda.');
      }
      entries.sort((a, b) => b[1] - a[1]);
      let rankingMsg = '**Ranking de denúncias:**\n';
      const maxShow = Math.min(entries.length, 10);
      const display = [];
      for (let i = 0; i < maxShow; i++) {
        const [uid, count] = entries[i];
        display.push({ uid, count });
      }
      // Fetch user tags asynchronously
      const promises = display.map(async ({ uid, count }) => {
        const userTag = await client.users.fetch(uid).catch(() => null);
        const name = userTag ? userTag.tag : uid;
        return { name, count };
      });
      const resolved = await Promise.all(promises);
      resolved.forEach((entry, idx) => {
        rankingMsg += `${idx + 1}. ${entry.name} - ${entry.count} denúncia(s)\n`;
      });
      if (entries.length > maxShow) {
        rankingMsg += `...e mais ${entries.length - maxShow} usuário(s).`;
      }
      await interaction.reply(rankingMsg);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
